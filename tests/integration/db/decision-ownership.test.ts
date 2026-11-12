import { describe, expect, it } from 'vitest';
import {
  initializeDatabase,
  IN_MEMORY,
  loadMigrations,
  openDatabase,
  type Db,
} from '../../../src/db/index.js';
import {
  newId,
  type ConversationId,
  type MessageId,
  type UserId,
} from '../../../src/shared/ids.js';
import { FixedClock } from '../../../src/temporal/clock.js';
import { insertEntity, openTestDb, seedConversation, T0, type TestDb } from '../../helpers/db.js';

/**
 * Ownership consistency for `decisions` and `decision_entities`, resolved by migration 006. The database is opened at version 6
 * (the migration under test is the newest), and the upgrade test starts from version 5.
 */

function insertDecision(
  db: Db,
  p: {
    userId: UserId;
    conversationId: ConversationId;
    messageId: MessageId;
    supersedesId?: string | null;
  },
): string {
  const id = newId('dec');
  db.prepare(
    `INSERT INTO decisions (id, user_id, conversation_id, message_id, kind, payload_json, user_quote,
       version, supersedes_id, created_at) VALUES (?, ?, ?, ?, 'choice', '{}', 'quote', 1, ?, ?)`,
  ).run(id, p.userId, p.conversationId, p.messageId, p.supersedesId ?? null, T0);
  return id;
}

const link = (db: Db, decisionId: string, entityId: string) =>
  db
    .prepare('INSERT INTO decision_entities (decision_id, entity_id) VALUES (?, ?)')
    .run(decisionId, entityId);

function world(t: TestDb = openTestDb('real', 6)) {
  const make = (name: string) => {
    const userId = t.users.create();
    const { conversationId, userMessageId } = seedConversation(t, userId);
    return {
      userId,
      conversationId,
      messageId: userMessageId,
      entityId: insertEntity(t.db, { userId, norm: name }),
    };
  };
  return { t, alice: make('alice-co'), bob: make('bob-co') };
}
type World = ReturnType<typeof world>;

describe('ownership: decisions (migration 006)', () => {
  it('accepts a decision whose conversation and message belong to its user', () => {
    const { t, alice } = world();
    expect(() => insertDecision(t.db, alice)).not.toThrow();
  });

  const OWNER_ERROR =
    /decision (conversation owner mismatch|message owner mismatch|message belongs to another conversation)/;

  it('rejects a decision for another user conversation', () => {
    const { t, alice, bob } = world();
    expect(() => insertDecision(t.db, { ...alice, conversationId: bob.conversationId })).toThrow(
      OWNER_ERROR,
    );
  });

  it('rejects a decision on another user message', () => {
    const { t, alice, bob } = world();
    expect(() => insertDecision(t.db, { ...alice, messageId: bob.messageId })).toThrow(OWNER_ERROR);
  });

  it('rejects a decision whose message is in another conversation of the same user', () => {
    const { t, alice } = world();
    const second = seedConversation(t, alice.userId);
    expect(() => insertDecision(t.db, { ...alice, messageId: second.userMessageId })).toThrow(
      /decision message belongs to another conversation/,
    );
  });

  // The three insert checks overlap (a message of another user is also in another user conversation), so each
  // is shown to work on its own by dropping the other two on a throwaway database.
  const alone: Array<[string, RegExp, (w: World) => Parameters<typeof insertDecision>[1]]> = [
    [
      'decisions_conversation_owner',
      /decision conversation owner mismatch/,
      (w) => ({ ...w.alice, conversationId: w.bob.conversationId }),
    ],
    [
      'decisions_message_owner',
      /decision message owner mismatch/,
      (w) => ({ ...w.alice, messageId: w.bob.messageId }),
    ],
    [
      'decisions_message_conversation',
      /decision message belongs to another conversation/,
      (w) => ({ ...w.alice, messageId: w.bob.messageId }),
    ],
  ];
  it.each(alone)('%s rejects on its own', (name, error, args) => {
    const w = world();
    for (const other of alone.map((a) => a[0]).filter((n) => n !== name)) {
      w.t.db.exec(`DROP TRIGGER ${other}`);
    }
    expect(() => insertDecision(w.t.db, args(w))).toThrow(error);
  });

  it('rejects a decision that supersedes another user decision', () => {
    const { t, alice, bob } = world();
    const theirs = insertDecision(t.db, bob);
    expect(() => insertDecision(t.db, { ...alice, supersedesId: theirs })).toThrow(
      /supersedes another user's decision/,
    );
  });

  it('accepts a decision that supersedes the same user decision', () => {
    const { t, alice } = world();
    const first = insertDecision(t.db, alice);
    expect(() => insertDecision(t.db, { ...alice, supersedesId: first })).not.toThrow();
  });

  it('rejects re-pointing supersedes_id at another user decision, but allows it to be cleared', () => {
    const { t, alice, bob } = world();
    const theirs = insertDecision(t.db, bob);
    const first = insertDecision(t.db, alice);
    const second = insertDecision(t.db, { ...alice, supersedesId: first });
    expect(() =>
      t.db.prepare('UPDATE decisions SET supersedes_id = ? WHERE id = ?').run(theirs, second),
    ).toThrow(/supersedes another user's decision/);
    expect(() =>
      t.db.prepare('UPDATE decisions SET supersedes_id = NULL WHERE id = ?').run(second),
    ).not.toThrow();
  });

  it('keeps ON DELETE SET NULL working: deleting a superseded decision clears the pointer', () => {
    const { t, alice } = world();
    const first = insertDecision(t.db, alice);
    const second = insertDecision(t.db, { ...alice, supersedesId: first });
    t.db.prepare('DELETE FROM decisions WHERE id = ?').run(first);
    expect(t.db.prepare('SELECT supersedes_id FROM decisions WHERE id = ?').get(second)).toEqual({
      supersedes_id: null,
    });
  });

  const identity: Array<[string, (w: World) => string | number]> = [
    ['user_id', (w) => w.bob.userId],
    ['conversation_id', (w) => w.bob.conversationId],
    ['message_id', (w) => w.bob.messageId],
    ['user_quote', () => 'rewritten'],
    ['created_at', () => T0 + 1],
    ['id', () => 'dec_other'],
  ];
  it.each(identity)('rejects changing the identity column %s', (column, value) => {
    const w = world();
    const id = insertDecision(w.t.db, w.alice);
    expect(() =>
      w.t.db.prepare(`UPDATE decisions SET ${column} = ? WHERE id = ?`).run(value(w), id),
    ).toThrow(/decision identity is immutable/);
  });

  it('still lets the versioned, non-identity fields be updated', () => {
    const { t, alice } = world();
    const id = insertDecision(t.db, alice);
    expect(() =>
      t.db
        .prepare('UPDATE decisions SET payload_json = \'{"a":1}\', version = 2 WHERE id = ?')
        .run(id),
    ).not.toThrow();
  });
});

describe('ownership: decision_entities (migration 006)', () => {
  it('accepts a link between a decision and an entity of the same user', () => {
    const { t, alice } = world();
    expect(() => link(t.db, insertDecision(t.db, alice), alice.entityId)).not.toThrow();
  });

  it('rejects a link to another user entity', () => {
    const { t, alice, bob } = world();
    expect(() => link(t.db, insertDecision(t.db, alice), bob.entityId)).toThrow(
      /decision entity owner mismatch/,
    );
  });

  it('rejects a link for a decision that does not exist', () => {
    const { t, alice } = world();
    expect(() => link(t.db, 'dec_missing', alice.entityId)).toThrow();
  });

  it('is append-only: a link cannot be re-pointed', () => {
    const { t, alice } = world();
    const decision = insertDecision(t.db, alice);
    link(t.db, decision, alice.entityId);
    const other = insertEntity(t.db, { userId: alice.userId, norm: 'another' });
    expect(() =>
      t.db
        .prepare('UPDATE decision_entities SET entity_id = ? WHERE decision_id = ?')
        .run(other, decision),
    ).toThrow(/append-only/);
  });
});

describe('migration 006 on an existing database', () => {
  it('applies on a version-5 database that already holds decisions, then enforces ownership', () => {
    const w = world(openTestDb('real', 5));
    const { t, alice, bob } = w;
    link(t.db, insertDecision(t.db, alice), alice.entityId);
    // At version 5 nothing stops a cross-user decision: this is the gap migration 006 closes.
    insertDecision(t.db, { ...alice, conversationId: bob.conversationId });

    const result = initializeDatabase(t.db, { mode: 'real', clock: new FixedClock(T0) });
    expect(result).toEqual({ schemaVersion: loadMigrations().length, created: false });
    expect(t.db.prepare('SELECT count(*) AS n FROM decisions').get()).toEqual({ n: 2 });
    expect(() => insertDecision(t.db, { ...alice, messageId: bob.messageId })).toThrow(
      /decision (message owner mismatch|message belongs to another conversation)/,
    );
  });

  it('creates every trigger it declares on a fresh database', () => {
    const db = openDatabase(IN_MEMORY);
    initializeDatabase(db, { mode: 'real', clock: new FixedClock(T0) });
    const sql = loadMigrations().find((m) => m.version === 6)?.sql ?? '';
    const declared = [...sql.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1] ?? '');
    expect(declared).toHaveLength(8);
    const installed = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(installed).toEqual(expect.arrayContaining(declared));
  });
});
