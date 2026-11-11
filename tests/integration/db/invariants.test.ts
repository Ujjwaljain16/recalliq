import { describe, expect, it } from 'vitest';
import { newId } from '../../../src/shared/ids.js';
import {
  count,
  insertAssertion,
  insertAssertionEvent,
  insertEntity,
  insertEvidence,
  insertFinding,
  insertMessageSearch,
  insertSnapshot,
  insertTurn,
  openTestDb,
  seedConversation,
  T0,
} from '../../helpers/db.js';

describe('T-DB-01: idempotency keys are scoped per user', () => {
  it('the same key for two users is fine; the same key twice for one user is rejected', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    seedConversation(t, alice, { idempotencyKey: 'key-1' });
    seedConversation(t, bob, { idempotencyKey: 'key-1' });
    expect(() => seedConversation(t, alice, { idempotencyKey: 'key-1' })).toThrow(/UNIQUE/);
  });
});

describe('T-DB-02: ownership', () => {
  it('rejects a message whose user_id differs from its conversation owner', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const { conversationId } = seedConversation(t, alice);
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, tz, created_at)
           VALUES (?, ?, ?, 99, 'user', 'sneaky', 'UTC', ?)`,
        )
        .run(newId('msg'), conversationId, bob, T0),
    ).toThrow(/message owner mismatch/);
  });

  it('rejects a turn whose user_id differs from its conversation owner', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, alice);
    expect(() => insertTurn(t.db, { conversationId, userId: bob, userMessageId })).toThrow(
      /turn owner mismatch/,
    );
  });
});

describe('T-DB-03: append-only tables reject UPDATE', () => {
  function world() {
    const t = openTestDb();
    const user = t.users.create();
    const { turnId, userMessageId } = seedConversation(t, user);
    const entityId = insertEntity(t.db, { userId: user, norm: 'hubspot' });
    const snapshotId = insertSnapshot(t.db, { userId: user });
    const evidenceId = insertEvidence(t.db, { userId: user, snapshotId, turnId, entityId });
    const findingId = insertFinding(t.db, { turnId, entityId });
    const assertionId = insertAssertion(t.db, {
      userId: user,
      messageId: userMessageId,
      turnId,
      findingId,
    });
    const eventId = insertAssertionEvent(t.db, { assertionId, status: 'reaffirmed' });
    t.db
      .prepare(
        `INSERT INTO belief_history (id, user_id, belief_key, next_json, reason, evidence_ids, at)
         VALUES ('h1', ?, 'k', '{}', 'initial', '[]', ?)`,
      )
      .run(user, T0);
    return { t, snapshotId, evidenceId, eventId };
  }

  it('source_snapshots (L1)', () => {
    const { t, snapshotId } = world();
    expect(() =>
      t.db
        .prepare("UPDATE source_snapshots SET content_text = 'edited' WHERE id = ?")
        .run(snapshotId),
    ).toThrow(/append-only/);
  });

  it('evidence_statements (L2)', () => {
    const { t, evidenceId } = world();
    expect(() =>
      t.db.prepare("UPDATE evidence_statements SET quote = 'edited' WHERE id = ?").run(evidenceId),
    ).toThrow(/append-only/);
  });

  it('assertion_events', () => {
    const { t, eventId } = world();
    expect(() =>
      t.db.prepare("UPDATE assertion_events SET status = 'contested' WHERE id = ?").run(eventId),
    ).toThrow(/append-only/);
  });

  it('belief_history', () => {
    const { t } = world();
    expect(() => t.db.prepare("UPDATE belief_history SET reason = 'corrected'").run()).toThrow(
      /append-only/,
    );
  });

  it('DELETE stays possible, because privacy deletion and rebuilds need it', () => {
    const { t, snapshotId } = world();
    // evidence references the snapshot, so remove that first (a real deletion does the same)
    t.db.prepare('DELETE FROM evidence_statements').run();
    expect(() =>
      t.db.prepare('DELETE FROM source_snapshots WHERE id = ?').run(snapshotId),
    ).not.toThrow();
  });
});

describe('T-DB-04: message content is immutable', () => {
  it('rejects UPDATE of every protected message column', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { userMessageId } = seedConversation(t, user);
    for (const [column, value] of [
      ['content', "'edited'"],
      ['content_template', "'edited'"],
      ['sentences_json', "'[]'"],
      ['role', "'assistant'"],
      ['seq', '42'],
      ['status', "'interrupted'"],
      ['streamed_through', '3'],
      ['tz', "'UTC'"],
      ['origin', "'recorded'"],
      ['created_at', '1'],
    ] as const) {
      expect(
        () =>
          t.db.prepare(`UPDATE messages SET ${column} = ${value} WHERE id = ?`).run(userMessageId),
        column,
      ).toThrow(/immutable/);
    }
  });

  it('cannot be re-parented to another user or conversation', () => {
    const t = openTestDb();
    const alice = t.users.create();
    const bob = t.users.create();
    const { userMessageId } = seedConversation(t, alice);
    expect(() =>
      t.db.prepare('UPDATE messages SET user_id = ? WHERE id = ?').run(bob, userMessageId),
    ).toThrow(/immutable/);
  });

  it('the message repository exposes no way to update, delete or replace a message', () => {
    // Deleting and re-inserting a row under the same id would sidestep the immutability triggers.
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(openTestDb().messages) as object,
    ).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['getOwned', 'insert', 'listByConversation']);
    expect(methods.filter((m) => /update|delete|remove|replace|upsert|set|ack/i.test(m))).toEqual(
      [],
    );
  });
});

describe('T-DB-05: an assertion can be presented once, and nothing else about it changes', () => {
  function world() {
    const t = openTestDb();
    const user = t.users.create();
    const { turnId, userMessageId } = seedConversation(t, user);
    const entityId = insertEntity(t.db, { userId: user, norm: 'hubspot' });
    const findingId = insertFinding(t.db, { turnId, entityId });
    const assertionId = insertAssertion(t.db, {
      userId: user,
      messageId: userMessageId,
      turnId,
      findingId,
    });
    return { t, assertionId };
  }

  it('allows presented_at to be set from NULL', () => {
    const { t, assertionId } = world();
    expect(() =>
      t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0 + 1, assertionId),
    ).not.toThrow();
  });

  it('rejects changing presented_at a second time', () => {
    const { t, assertionId } = world();
    t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0 + 1, assertionId);
    expect(() =>
      t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0 + 2, assertionId),
    ).toThrow(/immutable except presented_at once/);
  });

  it('rejects clearing presented_at', () => {
    const { t, assertionId } = world();
    t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0 + 1, assertionId);
    expect(() =>
      t.db.prepare('UPDATE assertions SET presented_at = NULL WHERE id = ?').run(assertionId),
    ).toThrow(/immutable except presented_at once/);
  });

  it('rejects editing any other column, even together with presented_at', () => {
    const { t, assertionId } = world();
    expect(() =>
      t.db.prepare("UPDATE assertions SET rendered_text = '$1 [1]' WHERE id = ?").run(assertionId),
    ).toThrow(/immutable except presented_at once/);
    expect(() =>
      t.db
        .prepare("UPDATE assertions SET presented_at = ?, rendered_text = '$1 [1]' WHERE id = ?")
        .run(T0 + 1, assertionId),
    ).toThrow(/immutable except presented_at once/);
  });

  it('records at most one presented and one not_presented event per assertion', () => {
    const { t, assertionId } = world();
    insertAssertionEvent(t.db, { assertionId, status: 'presented' });
    expect(() => insertAssertionEvent(t.db, { assertionId, status: 'presented' })).toThrow(
      /UNIQUE/,
    );
    insertAssertionEvent(t.db, { assertionId, status: 'not_presented' });
    expect(() => insertAssertionEvent(t.db, { assertionId, status: 'not_presented' })).toThrow(
      /UNIQUE/,
    );
    // other statuses may repeat: the history is append-only and a claim can be re-examined
    insertAssertionEvent(t.db, { assertionId, status: 'reaffirmed' });
    insertAssertionEvent(t.db, { assertionId, status: 'reaffirmed' });
  });
});

describe('T-DB-06: rendered_through never decreases', () => {
  function assistantMessage() {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId } = seedConversation(t, user);
    const message = t.messages.insert({
      userId: user,
      conversationId,
      role: 'assistant',
      content: 'a. b. c.',
      template: 'a. b. c.',
      sentences: [],
      status: 'complete',
      streamedThrough: 2,
      tz: 'UTC',
    });
    return { t, id: message.id };
  }

  it('starts at -1 and can move forward or stay put', () => {
    const { t, id } = assistantMessage();
    const read = () =>
      (
        t.db.prepare('SELECT rendered_through AS r FROM messages WHERE id = ?').get(id) as {
          r: number;
        }
      ).r;
    expect(read()).toBe(-1);
    t.db.prepare('UPDATE messages SET rendered_through = 1 WHERE id = ?').run(id);
    t.db.prepare('UPDATE messages SET rendered_through = 1 WHERE id = ?').run(id);
    t.db.prepare('UPDATE messages SET rendered_through = 2 WHERE id = ?').run(id);
    expect(read()).toBe(2);
  });

  it('rejects a decrease', () => {
    const { t, id } = assistantMessage();
    t.db.prepare('UPDATE messages SET rendered_through = 2 WHERE id = ?').run(id);
    expect(() =>
      t.db.prepare('UPDATE messages SET rendered_through = 1 WHERE id = ?').run(id),
    ).toThrow(/must not decrease/);
  });

  it('still allows last_ack_at to be written alongside an acknowledgement', () => {
    const { t, id } = assistantMessage();
    expect(() =>
      t.db
        .prepare('UPDATE messages SET rendered_through = 0, last_ack_at = ? WHERE id = ?')
        .run(T0, id),
    ).not.toThrow();
  });
});

// Partial by design of the shipped schema: only users, conversations and snapshots are guarded, and only on
// INSERT. See docs/questions.md Q-002 and demo-isolation-gap.test.ts for what is NOT covered.
describe('T-DB-07: a real database rejects fixture users, non-live conversations and non-live snapshots (partial: Q-002)', () => {
  it('rejects fixture users, non-live conversations and non-live snapshots in real mode', () => {
    const t = openTestDb('real');
    const user = t.users.create('real');
    expect(() => t.users.create('fixture')).toThrow(/fixture user in real db/);
    expect(() => t.conversations.create({ userId: user, origin: 'recorded' })).toThrow(
      /non-live conversation in real db/,
    );
    expect(() => t.conversations.create({ userId: user, origin: 'synthetic' })).toThrow(
      /non-live conversation in real db/,
    );
    expect(() => insertSnapshot(t.db, { userId: user, origin: 'synthetic' })).toThrow(
      /non-live snapshot in real db/,
    );
    expect(count(t.db, 'users')).toBe(1);
  });

  it('accepts the same data in a demo database', () => {
    const t = openTestDb('demo');
    const fixtureUser = t.users.create('fixture');
    const conv = t.conversations.create({ userId: fixtureUser, origin: 'recorded' });
    expect(conv.origin).toBe('recorded');
    expect(() => insertSnapshot(t.db, { userId: fixtureUser, origin: 'synthetic' })).not.toThrow();
  });

  // Open, not passing: the shipped schema does not enforce this. See docs/questions.md Q-002.
  it.todo(
    'Q-002 (open): messages, entities and decisions with non-live origin are rejected in real mode',
  );
});

describe('T-DB-09: rebuild after deletion equals a fresh rebuild', () => {
  // Needs BeliefResolver and rebuildBeliefs (evidence/belief milestone).
  it.todo(
    'beliefs and belief_history after deleteConversation equal a rebuild from the remaining evidence',
  );
});

describe('schema invariants without a contract test ID', () => {
  it('allows only one running turn per conversation, and a new one once it finishes', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, user);
    const running = insertTurn(t.db, {
      conversationId,
      userId: user,
      userMessageId,
      status: 'running',
    });
    expect(() =>
      insertTurn(t.db, { conversationId, userId: user, userMessageId, status: 'running' }),
    ).toThrow(/UNIQUE/);
    t.db.prepare("UPDATE turns SET status = 'complete' WHERE id = ?").run(running);
    expect(() =>
      insertTurn(t.db, { conversationId, userId: user, userMessageId, status: 'running' }),
    ).not.toThrow();
  });

  it('keeps message order unique per conversation', () => {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId } = seedConversation(t, user);
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, tz, created_at)
           VALUES (?, ?, ?, 1, 'user', 'dup', 'UTC', ?)`,
        )
        .run(newId('msg'), conversationId, user, T0),
    ).toThrow(/UNIQUE/);
  });

  it('keeps every observation of the same page, but not an exact duplicate', () => {
    const t = openTestDb();
    const user = t.users.create();
    const url = 'https://vendor.example/pricing';
    insertSnapshot(t.db, { userId: user, url, sha: 'same', observedAt: T0 });
    insertSnapshot(t.db, { userId: user, url, sha: 'same', observedAt: T0 + 1000 });
    expect(() => insertSnapshot(t.db, { userId: user, url, sha: 'same', observedAt: T0 })).toThrow(
      /UNIQUE/,
    );
  });
});

describe('message_search FTS5 index stays in step with its table', () => {
  function indexed() {
    const t = openTestDb();
    const user = t.users.create();
    const { userMessageId } = seedConversation(t, user);
    insertMessageSearch(t.db, {
      messageId: userMessageId,
      userId: user,
      body: 'Which managed Postgres hosting is cheapest?',
      tags: 'postgres neon supabase',
    });
    return { t, userMessageId };
  }
  const hits = (t: ReturnType<typeof openTestDb>, query: string) =>
    count(t.db, 'message_fts', 'message_fts MATCH ?', query);

  it('finds inserted text, using stemming, in body and tags', () => {
    const { t } = indexed();
    expect(hits(t, 'host')).toBe(1);
    expect(hits(t, 'neon')).toBe(1);
    expect(hits(t, 'mongodb')).toBe(0);
  });

  it('follows updates', () => {
    const { t, userMessageId } = indexed();
    t.db
      .prepare("UPDATE message_search SET body = 'something else entirely' WHERE message_id = ?")
      .run(userMessageId);
    expect(hits(t, 'postgres')).toBe(1); // still present in tags
    expect(hits(t, 'cheapest')).toBe(0);
    expect(hits(t, 'entirely')).toBe(1);
  });

  it('follows deletes', () => {
    const { t, userMessageId } = indexed();
    t.db.prepare('DELETE FROM message_search WHERE message_id = ?').run(userMessageId);
    expect(hits(t, 'postgres')).toBe(0);
  });
});
