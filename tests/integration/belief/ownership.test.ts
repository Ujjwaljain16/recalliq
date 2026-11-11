import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/index.js';
import { newId, type EvidenceId, type TurnId } from '../../../src/shared/ids.js';
import {
  insertEntity,
  insertEvidence,
  insertSnapshot,
  openTestDb,
  seedConversation,
  T0,
  type TestDb,
} from '../../helpers/db.js';

/**
 * Ownership consistency for beliefs and belief history (migration 008). Each trigger has a cross-user test
 * that is rejected with its own message, and a same-user test that is accepted. All data is [SYNTHETIC].
 */

function world(t: TestDb = openTestDb()) {
  const make = (name: string) => {
    const userId = t.users.create();
    const { turnId } = seedConversation(t, userId);
    const entityId = insertEntity(t.db, { userId, norm: name });
    const snapshotId = insertSnapshot(t.db, { userId });
    const evidenceId = insertEvidence(t.db, { userId, snapshotId, turnId, entityId });
    return { userId, turnId, entityId, evidenceId };
  };
  return { t, alice: make('alice-co'), bob: make('bob-co') };
}

const KEY = 'price:v1|e=x|p=pro|a=list|c=-|u=per_seat|uu=-|b=monthly|cur=USD|loc=en-GB|vk=exact';

function insertBelief(
  db: Db,
  p: { userId: string; entityId: string; evidence?: string[] | string; key?: string },
): void {
  db.prepare(
    `INSERT INTO beliefs (user_id, belief_key, key_json, entity_id, status, winning_evidence, updated_at)
     VALUES (?, ?, '{}', ?, 'confirmed', ?, ?)`,
  ).run(
    p.userId,
    p.key ?? KEY,
    p.entityId,
    typeof p.evidence === 'string' ? p.evidence : JSON.stringify(p.evidence ?? []),
    T0,
  );
}

function insertHistory(
  db: Db,
  p: { userId: string; turnId?: TurnId | null; evidence?: EvidenceId[] | string },
): void {
  db.prepare(
    `INSERT INTO belief_history (id, user_id, belief_key, prev_json, next_json, reason, evidence_ids, turn_id, at)
     VALUES (?, ?, ?, NULL, '{}', 'initial', ?, ?, ?)`,
  ).run(
    newId('blh'),
    p.userId,
    KEY,
    typeof p.evidence === 'string' ? p.evidence : JSON.stringify(p.evidence ?? []),
    p.turnId ?? null,
    T0,
  );
}

describe('ownership of beliefs (migration 008)', () => {
  it("accepts a belief for the user's own entity and own evidence", () => {
    const { t, alice } = world();
    expect(() =>
      insertBelief(t.db, {
        userId: alice.userId,
        entityId: alice.entityId,
        evidence: [alice.evidenceId],
      }),
    ).not.toThrow();
  });

  it('beliefs_entity_owner: rejects an entity of another user', () => {
    const { t, alice, bob } = world();
    expect(() => insertBelief(t.db, { userId: alice.userId, entityId: bob.entityId })).toThrow(
      'belief entity owner mismatch',
    );
  });

  it('beliefs_user_exists: rejects a user that does not exist', () => {
    const { t, alice } = world();
    expect(() => insertBelief(t.db, { userId: 'usr_ghost', entityId: alice.entityId })).toThrow(
      /belief (user does not exist|entity owner mismatch)/,
    );
  });

  it('beliefs_evidence_owner: rejects winning evidence of another user, and of nothing', () => {
    const { t, alice, bob } = world();
    expect(() =>
      insertBelief(t.db, {
        userId: alice.userId,
        entityId: alice.entityId,
        evidence: [bob.evidenceId],
      }),
    ).toThrow('belief evidence owner mismatch');
    expect(() =>
      insertBelief(t.db, {
        userId: alice.userId,
        entityId: alice.entityId,
        evidence: ['ev_missing'],
      }),
    ).toThrow('belief evidence owner mismatch');
    // one bad id among good ones is still rejected
    expect(() =>
      insertBelief(t.db, {
        userId: alice.userId,
        entityId: alice.entityId,
        evidence: [alice.evidenceId, bob.evidenceId],
      }),
    ).toThrow('belief evidence owner mismatch');
  });

  it('rejects malformed winning-evidence JSON instead of accepting it silently', () => {
    const { t, alice } = world();
    expect(() =>
      insertBelief(t.db, { userId: alice.userId, entityId: alice.entityId, evidence: 'nope' }),
    ).toThrow();
  });

  it("beliefs_evidence_owner_upd: an update cannot point winning evidence at another user's row", () => {
    const { t, alice, bob } = world();
    insertBelief(t.db, {
      userId: alice.userId,
      entityId: alice.entityId,
      evidence: [alice.evidenceId],
    });
    expect(() =>
      t.db
        .prepare('UPDATE beliefs SET winning_evidence = ? WHERE user_id = ?')
        .run(JSON.stringify([bob.evidenceId]), alice.userId),
    ).toThrow('belief evidence owner mismatch');
    expect(() =>
      t.db
        .prepare('UPDATE beliefs SET status = ?, winning_evidence = ? WHERE user_id = ?')
        .run('stale', JSON.stringify([alice.evidenceId]), alice.userId),
    ).not.toThrow();
  });

  it('beliefs_identity_immutable: identity columns cannot change; derived columns can', () => {
    const { t, alice, bob } = world();
    insertBelief(t.db, { userId: alice.userId, entityId: alice.entityId });
    for (const [column, value] of [
      ['user_id', bob.userId],
      ['belief_key', 'other'],
      ['entity_id', bob.entityId],
      ['key_json', '{"x":1}'],
    ] as const) {
      expect(() =>
        t.db.prepare(`UPDATE beliefs SET ${column} = ? WHERE user_id = ?`).run(value, alice.userId),
      ).toThrow('belief identity is immutable');
    }
    expect(() =>
      t.db
        .prepare("UPDATE beliefs SET status = 'contested', value_json = NULL WHERE user_id = ?")
        .run(alice.userId),
    ).not.toThrow();
  });
});

describe('ownership of belief history (migration 008)', () => {
  it("accepts a history row for the user's own turn and evidence, or with no turn", () => {
    const { t, alice } = world();
    expect(() =>
      insertHistory(t.db, {
        userId: alice.userId,
        turnId: alice.turnId,
        evidence: [alice.evidenceId],
      }),
    ).not.toThrow();
    expect(() => insertHistory(t.db, { userId: alice.userId })).not.toThrow();
  });

  it('belief_history_user_exists: rejects a user that does not exist', () => {
    const { t } = world();
    expect(() => insertHistory(t.db, { userId: 'usr_ghost' })).toThrow(
      'belief history user does not exist',
    );
  });

  it('belief_history_turn_owner: rejects a turn of another user', () => {
    const { t, alice, bob } = world();
    expect(() => insertHistory(t.db, { userId: alice.userId, turnId: bob.turnId })).toThrow(
      'belief history turn owner mismatch',
    );
  });

  it('belief_history_evidence_owner: rejects evidence of another user', () => {
    const { t, alice, bob } = world();
    expect(() => insertHistory(t.db, { userId: alice.userId, evidence: [bob.evidenceId] })).toThrow(
      'belief history evidence owner mismatch',
    );
  });

  it('history stays append-only (existing rule)', () => {
    const { t, alice } = world();
    insertHistory(t.db, { userId: alice.userId });
    expect(() => t.db.prepare("UPDATE belief_history SET reason = 'staled'").run()).toThrow(
      'append-only',
    );
  });

  it('the checks apply to the latest schema and are additive to earlier ones', () => {
    const t = openTestDb();
    const triggers = (
      t.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'belief%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(triggers).toEqual([
      'belief_history_evidence_owner',
      'belief_history_immutable',
      'belief_history_turn_owner',
      'belief_history_user_exists',
      'beliefs_entity_owner',
      'beliefs_evidence_owner',
      'beliefs_evidence_owner_upd',
      'beliefs_identity_immutable',
      'beliefs_user_exists',
    ]);
  });
});
