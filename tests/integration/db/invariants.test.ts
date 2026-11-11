import { describe, expect, it } from 'vitest';
import { newId } from '../../../src/shared/ids.js';
import {
  count,
  insertAssertion,
  insertAssistantMessage,
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
    const { conversationId, turnId } = seedConversation(t, user);
    const assistantId = insertAssistantMessage(t, { userId: user, conversationId, turnId });
    const entityId = insertEntity(t.db, { userId: user, norm: 'hubspot' });
    const snapshotId = insertSnapshot(t.db, { userId: user });
    const evidenceId = insertEvidence(t.db, { userId: user, snapshotId, turnId, entityId });
    const findingId = insertFinding(t.db, { turnId, entityId });
    const assertionId = insertAssertion(t.db, {
      userId: user,
      messageId: assistantId,
      turnId,
      findingId,
    });
    // a verdict event needs a presented assertion (migration 005)
    t.db.prepare('UPDATE messages SET rendered_through = 0 WHERE id = ?').run(assistantId);
    t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0, assertionId);
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
    const { conversationId, turnId } = seedConversation(t, user);
    // 3 sentences, 2 streamed (0 and 1); sentence 0 will be acknowledged, sentence 2 never streamed
    const assistantId = insertAssistantMessage(t, {
      userId: user,
      conversationId,
      turnId,
      sentences: 3,
      streamedThrough: 1,
    });
    const entityId = insertEntity(t.db, { userId: user, norm: 'hubspot' });
    const findingId = insertFinding(t.db, { turnId, entityId });
    const assertionId = insertAssertion(t.db, {
      userId: user,
      messageId: assistantId,
      turnId,
      findingId,
      sentenceIndex: 0,
    });
    const neverStreamedId = insertAssertion(t.db, {
      userId: user,
      messageId: assistantId,
      turnId,
      findingId,
      sentenceIndex: 2,
    });
    // the browser acknowledged sentence 0 (migration 005 requires this before presented_at can be set)
    t.db.prepare('UPDATE messages SET rendered_through = 0 WHERE id = ?').run(assistantId);
    return { t, assertionId, neverStreamedId };
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

  it('records at most one presented event, and at most one not_presented event, per assertion', () => {
    const { t, assertionId, neverStreamedId } = world();
    t.db.prepare('UPDATE assertions SET presented_at = ? WHERE id = ?').run(T0 + 1, assertionId);
    insertAssertionEvent(t.db, { assertionId, status: 'presented' });
    expect(() => insertAssertionEvent(t.db, { assertionId, status: 'presented' })).toThrow(
      /UNIQUE/,
    );
    insertAssertionEvent(t.db, { assertionId: neverStreamedId, status: 'not_presented' });
    expect(() =>
      insertAssertionEvent(t.db, { assertionId: neverStreamedId, status: 'not_presented' }),
    ).toThrow(/UNIQUE/);
    // verdict events may repeat on a presented assertion: the history is append-only and a claim can be re-examined
    insertAssertionEvent(t.db, { assertionId, status: 'reaffirmed' });
    insertAssertionEvent(t.db, { assertionId, status: 'reaffirmed' });
  });
});

describe('T-DB-06: rendered_through never decreases', () => {
  function assistantMessage() {
    const t = openTestDb();
    const user = t.users.create();
    const { conversationId, turnId } = seedConversation(t, user);
    // 3 sentences, all streamed, so rendered_through may rise to 2
    const id = insertAssistantMessage(t, { userId: user, conversationId, turnId, sentences: 3 });
    return { t, id };
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

/// Migration 002 (Q-002): the database itself refuses non-live data, and relabelling, in a real database.
describe('T-DB-07: demo data cannot enter a real database', () => {
  type Test = ReturnType<typeof openTestDb>;

  function withConversation(t: Test) {
    const user = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, user);
    return { user, conversationId, userMessageId };
  }
  const insertDecision = (
    t: Test,
    p: { user: string; conversationId: string; messageId: string; origin: string },
  ) =>
    t.db
      .prepare(
        `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote, origin, created_at)
         VALUES (?, ?, ?, ?, 'shortlist', '{}', 'q', ?, ?)`,
      )
      .run(newId('dec'), p.user, p.conversationId, p.messageId, p.origin, T0);
  const insertRawEntity = (t: Test, user: string, origin: string) =>
    t.db
      .prepare(
        "INSERT INTO entities (id, user_id, canonical, norm, origin, created_at) VALUES (?, ?, 'x', 'x', ?, ?)",
      )
      .run(newId('ent'), user, origin, T0);

  it('rejects fixture users, non-live conversations and non-live snapshots', () => {
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

  it('rejects a non-live message, through the repository and through raw SQL', () => {
    const t = openTestDb('real');
    const { user, conversationId } = withConversation(t);
    expect(() =>
      t.messages.insert({
        userId: user,
        conversationId,
        role: 'user',
        content: 'x',
        tz: 'UTC',
        origin: 'recorded',
      }),
    ).toThrow(/non-live message in real db/);
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, tz, origin, created_at)
           VALUES (?, ?, ?, 50, 'user', 'x', 'UTC', 'synthetic', ?)`,
        )
        .run(newId('msg'), conversationId, user, T0),
    ).toThrow(/non-live message in real db/);
    expect(count(t.db, 'messages', "origin <> 'live'")).toBe(0);
  });

  it('rejects a non-live entity on insert and on relabel', () => {
    const t = openTestDb('real');
    const user = t.users.create();
    expect(() => insertRawEntity(t, user, 'synthetic')).toThrow(/non-live entity in real db/);
    const live = insertEntity(t.db, { userId: user, norm: 'acme crm' });
    expect(() =>
      t.db.prepare("UPDATE entities SET origin = 'recorded' WHERE id = ?").run(live),
    ).toThrow(/non-live entity in real db/);
    expect(count(t.db, 'entities', "origin <> 'live'")).toBe(0);
  });

  it('rejects a non-live decision on insert and on relabel', () => {
    const t = openTestDb('real');
    const { user, conversationId, userMessageId } = withConversation(t);
    const base = { user, conversationId, messageId: userMessageId };
    expect(() => insertDecision(t, { ...base, origin: 'recorded' })).toThrow(
      /non-live decision in real db/,
    );
    insertDecision(t, { ...base, origin: 'live' });
    expect(() => t.db.prepare("UPDATE decisions SET origin = 'synthetic'").run()).toThrow(
      /non-live decision in real db/,
    );
    expect(count(t.db, 'decisions', "origin <> 'live'")).toBe(0);
  });

  it('rejects relabelling an existing user or conversation', () => {
    const t = openTestDb('real');
    const user = t.users.create();
    const conversation = t.conversations.create({ userId: user });
    expect(() => t.db.prepare("UPDATE users SET kind = 'fixture' WHERE id = ?").run(user)).toThrow(
      /fixture user in real db/,
    );
    expect(() =>
      t.db
        .prepare("UPDATE conversations SET origin = 'recorded' WHERE id = ?")
        .run(conversation.id),
    ).toThrow(/non-live conversation in real db/);
  });

  it('makes db_mode immutable, so the isolation triggers cannot be switched off', () => {
    const t = openTestDb('real');
    expect(() =>
      t.db.prepare("UPDATE meta SET value = 'demo' WHERE key = 'db_mode'").run(),
    ).toThrow(/db_mode is immutable/);
    expect(() => t.db.prepare("DELETE FROM meta WHERE key = 'db_mode'").run()).toThrow(
      /db_mode is immutable/,
    );
    expect(() => t.users.create('fixture')).toThrow(/fixture user in real db/);
  });

  it('still accepts live data, and still allows schema_version to be updated', () => {
    const t = openTestDb('real');
    const { user, conversationId, userMessageId } = withConversation(t);
    insertEntity(t.db, { userId: user, norm: 'hubspot' });
    insertDecision(t, { user, conversationId, messageId: userMessageId, origin: 'live' });
    expect(() =>
      t.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run(),
    ).not.toThrow();
  });

  it('accepts non-live data in a demo database: the triggers are keyed on db_mode', () => {
    const t = openTestDb('demo');
    const fixtureUser = t.users.create('fixture');
    const conv = t.conversations.create({ userId: fixtureUser, origin: 'recorded' });
    const message = t.messages.insert({
      userId: fixtureUser,
      conversationId: conv.id,
      role: 'user',
      content: 'x',
      tz: 'UTC',
      origin: 'recorded',
    });
    insertRawEntity(t, fixtureUser, 'synthetic');
    insertDecision(t, {
      user: fixtureUser,
      conversationId: conv.id,
      messageId: message.id,
      origin: 'recorded',
    });
    expect(() => insertSnapshot(t.db, { userId: fixtureUser, origin: 'synthetic' })).not.toThrow();
    expect(count(t.db, 'messages', "origin = 'recorded'")).toBe(1);
    expect(count(t.db, 'entities', "origin = 'synthetic'")).toBe(1);
    expect(count(t.db, 'decisions', "origin = 'recorded'")).toBe(1);
  });
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
    t.db
      .prepare("UPDATE turns SET status = 'complete', finished_at = ? WHERE id = ?")
      .run(T0 + 1, running);
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
