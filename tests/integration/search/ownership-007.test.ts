import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/index.js';
import {
  newId,
  type EntityId,
  type SnapshotId,
  type TurnId,
  type UserId,
} from '../../../src/shared/ids.js';
import {
  insertEntity,
  insertSnapshot,
  openTestDb,
  seedConversation,
  T0,
  type TestDb,
} from '../../helpers/db.js';

/**
 * Q-007 for search_requests and search_results (migration 007). Opened at version 7 so the error comes from
 * that migration; the pre-007 test shows the rule is not enforced without it.
 */

function insertRequest(
  db: Db,
  p: { userId: UserId; turnId: TurnId; entityId?: EntityId | null; id?: string },
): string {
  const id = p.id ?? newId('srq');
  db.prepare(
    `INSERT INTO search_requests (id, turn_id, user_id, entity_id, intent, round, provider, request_json,
       status, started_at) VALUES (?, ?, ?, ?, 'pricing', 1, 'fake', '{}', 'ok', ?)`,
  ).run(id, p.turnId, p.userId, p.entityId ?? null, T0);
  return id;
}

const link = (db: Db, requestId: string, snapshotId: SnapshotId) =>
  db
    .prepare('INSERT INTO search_results (search_request_id, snapshot_id, rank) VALUES (?, ?, 0)')
    .run(requestId, snapshotId);

function world(t: TestDb = openTestDb('real', 7)) {
  const make = () => {
    const userId = t.users.create();
    const { turnId } = seedConversation(t, userId);
    const entityId = insertEntity(t.db, { userId, norm: `acme-${userId}` });
    return { userId, turnId, entityId };
  };
  return { t, a: make(), b: make() };
}

describe('migration 007: search_requests', () => {
  it('accepts a same-user request, with and without an entity', () => {
    const { t, a } = world();
    expect(() => insertRequest(t.db, { ...a })).not.toThrow();
    expect(() => insertRequest(t.db, { userId: a.userId, turnId: a.turnId })).not.toThrow();
  });

  it("rejects a request on another user's turn", () => {
    const { t, a, b } = world();
    expect(() => insertRequest(t.db, { userId: a.userId, turnId: b.turnId })).toThrow(
      /search request turn owner mismatch/,
    );
  });

  it("rejects another user's entity, and a nonexistent entity", () => {
    const { t, a, b } = world();
    expect(() =>
      insertRequest(t.db, { userId: a.userId, turnId: a.turnId, entityId: b.entityId }),
    ).toThrow(/search request entity owner mismatch/);
    expect(() =>
      insertRequest(t.db, {
        userId: a.userId,
        turnId: a.turnId,
        entityId: 'ent_missing',
      }),
    ).toThrow(/search request entity owner mismatch/);
  });

  it('identity columns are immutable; outcome columns are not', () => {
    const { t, a, b } = world();
    const id = insertRequest(t.db, { ...a });
    for (const [col, value] of [
      ['user_id', b.userId],
      ['turn_id', b.turnId],
      ['entity_id', b.entityId],
      ['intent', 'releases'],
      ['request_json', '{"x":1}'],
      ['provider', 'other'],
    ] as const) {
      expect(() =>
        t.db.prepare(`UPDATE search_requests SET ${col} = ? WHERE id = ?`).run(value, id),
      ).toThrow(/search request identity is immutable/);
    }
    expect(() =>
      t.db.prepare("UPDATE search_requests SET status = 'failed' WHERE id = ?").run(id),
    ).not.toThrow();
  });

  it('is not enforced at version 6 (the regression the migration fixes)', () => {
    const { t, a, b } = world(openTestDb('real', 6));
    expect(() => insertRequest(t.db, { userId: a.userId, turnId: b.turnId })).not.toThrow();
  });
});

describe('migration 007: search_results and snapshot links', () => {
  it('accepts a same-user link', () => {
    const { t, a } = world();
    const req = insertRequest(t.db, { ...a });
    const snap = insertSnapshot(t.db, { userId: a.userId });
    expect(() => link(t.db, req, snap)).not.toThrow();
  });

  it("rejects linking a request to another user's snapshot, in both directions", () => {
    const { t, a, b } = world();
    const reqA = insertRequest(t.db, { ...a });
    const snapB = insertSnapshot(t.db, { userId: b.userId });
    expect(() => link(t.db, reqA, snapB)).toThrow(/search result owner mismatch/);
    const reqB = insertRequest(t.db, { ...b });
    const snapA = insertSnapshot(t.db, { userId: a.userId });
    expect(() => link(t.db, reqB, snapA)).toThrow(/search result owner mismatch/);
  });

  it('rejects a link to a missing request or snapshot', () => {
    const { t, a } = world();
    const req = insertRequest(t.db, { ...a });
    const snap = insertSnapshot(t.db, { userId: a.userId });
    expect(() => link(t.db, 'srq_missing', snap)).toThrow(/search result owner mismatch/);
    expect(() => link(t.db, req, 'src_missing')).toThrow(/search result owner mismatch/);
  });

  it('links are append-only', () => {
    const { t, a } = world();
    const req = insertRequest(t.db, { ...a });
    const snap = insertSnapshot(t.db, { userId: a.userId });
    link(t.db, req, snap);
    expect(() => t.db.prepare('UPDATE search_results SET rank = 5').run()).toThrow(/append-only/);
  });

  it('a request deletion still cascades to its links', () => {
    const { t, a } = world();
    const req = insertRequest(t.db, { ...a });
    link(t.db, req, insertSnapshot(t.db, { userId: a.userId }));
    t.db.prepare('DELETE FROM search_requests WHERE id = ?').run(req);
    expect(t.db.prepare('SELECT count(*) AS n FROM search_results').get()).toEqual({ n: 0 });
  });

  it('is not enforced at version 6', () => {
    const { t, a, b } = world(openTestDb('real', 6));
    const reqA = insertRequest(t.db, { ...a });
    expect(() => link(t.db, reqA, insertSnapshot(t.db, { userId: b.userId }))).not.toThrow();
  });
});

describe('source_snapshots (no new trigger needed)', () => {
  it('every column is already immutable, so ownership cannot be rewritten', () => {
    const { t, a, b } = world();
    const snap = insertSnapshot(t.db, { userId: a.userId });
    expect(() =>
      t.db.prepare('UPDATE source_snapshots SET user_id = ? WHERE id = ?').run(b.userId, snap),
    ).toThrow(/append-only/);
  });
});
