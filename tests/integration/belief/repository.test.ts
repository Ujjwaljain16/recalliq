import { describe, expect, it } from 'vitest';
import { plannedTwinKey } from '../../../src/belief/belief-key.js';
import { deleteConversation } from '../../../src/db/index.js';
import type { Ms, VerifiedEvidence } from '../../../src/shared/index.js';
import { count, seedConversation } from '../../helpers/db.js';
import { ev, type EvOpts } from '../../unit/belief/support.js';
import { DAY, NOW, makeWorld, storeSnapshot, type World } from '../evidence/support.js';

/** Evidence and belief repositories on the latest schema. Data is [SYNTHETIC]. */

let n = 0;
/** A snapshot row and the evidence row for it, both owned by the world's user. */
function persist(
  w: World,
  o: Omit<EvOpts, 'id' | 'entityId' | 'snapshotId'> & { createdAt?: Ms; turnId?: typeof w.turnId },
): VerifiedEvidence {
  const id = `r${++n}`;
  const urlNorm = o.urlNorm ?? 'acme.example/en-gb/pricing';
  const snapshotId = storeSnapshot(w.t.db, w.userId, {
    text: 'Acme Pro US$90 per user per month',
    observedAt: o.observedAt ?? NOW - DAY,
    url: `https://${urlNorm}`,
    urlNorm,
    fresh: o.fresh ?? true,
    crawl: o.crawl ?? 'ok',
    lastUpdated: o.lastUpdated ?? null,
    published: o.published ?? null,
  });
  const e = ev({
    ...o,
    id,
    snapshotId,
    entityId: w.acme.id,
    observedAt: o.observedAt ?? NOW - DAY,
  });
  w.evidence.insert(w.userId, o.turnId ?? w.turnId, e, o.createdAt ?? NOW);
  return e;
}

describe('evidence repository', () => {
  it('T-REPO-01: stores every status and reads back the same statement with its snapshot time fields', () => {
    const w = makeWorld();
    const pass = persist(w, { amount: 90, lastUpdated: null });
    const weak = persist(w, { amount: 91, status: 'weak' });
    const failed = persist(w, { amount: 92, status: 'fail' });
    expect(count(w.t.db, 'evidence_statements')).toBe(3);
    const back = w.evidence.getMany(w.userId, [pass.id, weak.id, failed.id]);
    expect(back.map((e) => e.verification.status).sort()).toEqual(['fail', 'pass', 'weak']);
    const got = back.find((e) => e.id === pass.id);
    expect(got).toEqual(pass);
    expect(
      w.evidence.passForKeys(w.userId, [pass.beliefKey ?? '']).map((s) => s.evidence.id),
    ).toEqual([pass.id]);
  });

  it('T-REPO-02: a failed crawl is read back as not fresh whatever the flag says', () => {
    const w = makeWorld();
    const e = persist(w, { fresh: true, crawl: 'failed', lastUpdated: NOW - 3 * DAY });
    const [back] = w.evidence.getMany(w.userId, [e.id]);
    expect(back?.freshFetch).toBe(false);
    expect(back?.displayedAtBasis).toBe('provider_last_updated');
  });

  it('T-REPO-03: only pass evidence may carry a belief key', () => {
    const w = makeWorld();
    const pass = ev({
      id: 'x',
      entityId: w.acme.id,
      snapshotId: storeSnapshot(w.t.db, w.userId, { text: 'x', observedAt: NOW }),
    });
    expect(() =>
      w.evidence.insert(
        w.userId,
        w.turnId,
        { ...pass, verification: { status: 'weak', checks: [] } },
        NOW,
      ),
    ).toThrow('only pass evidence may carry a belief key');
  });

  it('T-REPO-04: reads are scoped to the user, and evidence of another user cannot be written', () => {
    const w = makeWorld();
    const mine = persist(w, {});
    const bob = w.t.users.create();
    expect(w.evidence.getMany(bob, [mine.id])).toEqual([]);
    expect(w.evidence.passForKeys(bob, [mine.beliefKey ?? ''])).toEqual([]);
    const bobSnapshot = storeSnapshot(w.t.db, bob, { text: 'x', observedAt: NOW });
    const stray = ev({ id: 'stray', entityId: w.acme.id, snapshotId: bobSnapshot });
    expect(() => w.evidence.insert(w.userId, w.turnId, stray, NOW)).toThrow(
      'evidence snapshot owner mismatch',
    );
  });

  it('T-REPO-05: statements are immutable', () => {
    const w = makeWorld();
    const e = persist(w, {});
    expect(() =>
      w.t.db.prepare('UPDATE evidence_statements SET quote = ? WHERE id = ?').run('x', e.id),
    ).toThrow('append-only');
  });
});

describe('belief repository', () => {
  it('T-REPO-10: writes a belief and its history; an unchanged state writes nothing more', () => {
    const w = makeWorld();
    const e = persist(w, { amount: 90 });
    const key = e.beliefKey ?? '';
    const first = w.beliefs.updateKeys(w.userId, [key], NOW, w.turnId);
    expect(first.get(key)?.belief.status).toBe('confirmed');
    expect(w.beliefs.get(w.userId, key)).toMatchObject({
      status: 'confirmed',
      value: { amount: 90 },
    });
    expect(w.beliefs.historyReasons(w.userId, key)).toEqual(['initial']);
    w.beliefs.updateKeys(w.userId, [key], NOW, w.turnId);
    expect(w.beliefs.historyReasons(w.userId, key)).toEqual(['initial']);
    expect(w.beliefs.forEntity(w.userId, w.acme.id)).toHaveLength(1);
  });

  it('T-REPO-11: a later reconfirmation and a later change are recorded in order', () => {
    const w = makeWorld();
    const key =
      persist(w, { amount: 90, observedAt: NOW - 20 * DAY, createdAt: NOW - 20 * DAY }).beliefKey ??
      '';
    w.beliefs.updateKeys(w.userId, [key], NOW - 20 * DAY, w.turnId);
    persist(w, { amount: 90, observedAt: NOW - 9 * DAY, createdAt: NOW - 9 * DAY });
    w.beliefs.updateKeys(w.userId, [key], NOW - 9 * DAY, w.turnId);
    persist(w, { amount: 100, observedAt: NOW - DAY, createdAt: NOW - DAY });
    w.beliefs.updateKeys(w.userId, [key], NOW - DAY, w.turnId);
    expect(w.beliefs.historyReasons(w.userId, key)).toEqual([
      'initial',
      'reconfirmed',
      'world_changed',
    ]);
    expect(w.beliefs.get(w.userId, key)?.value?.amount).toBe(100);
  });

  it('T-REPO-12: a due planned price is attached to the list belief as a pending signal', () => {
    const w = makeWorld();
    const list = persist(w, { amount: 90 });
    const planned = persist(w, { amount: 99, modality: 'planned', effectiveFrom: NOW - DAY });
    expect(planned.beliefKey).toBe(plannedTwinKey(list.beliefKey ?? ''));
    w.beliefs.updateKeys(w.userId, [list.beliefKey ?? ''], NOW, w.turnId);
    expect(w.beliefs.get(w.userId, list.beliefKey ?? '')?.pendingSignals).toHaveLength(1);
  });

  it('T-REPO-13: beliefs are per user', () => {
    const w = makeWorld();
    const e = persist(w, {});
    w.beliefs.updateKeys(w.userId, [e.beliefKey ?? ''], NOW, w.turnId);
    const bob = w.t.users.create();
    expect(w.beliefs.get(bob, e.beliefKey ?? '')).toBeNull();
    expect(w.beliefs.forEntity(bob, w.acme.id)).toEqual([]);
  });
});

describe('rebuild (T-DB-REBUILD)', () => {
  function history(w: World, key: string) {
    return {
      belief: w.t.db
        .prepare(
          'SELECT status, value_json, contested_json, pending_signals_json, displayed_at, verified_at, winning_evidence FROM beliefs WHERE belief_key = ?',
        )
        .get(key),
      history: w.t.db
        .prepare(
          'SELECT reason, next_json, at FROM belief_history WHERE belief_key = ? ORDER BY at, rowid',
        )
        .all(key),
    };
  }

  it('T-DB-REBUILD-01: replaying the evidence reproduces the incremental belief and history', () => {
    const w = makeWorld();
    const steps: Array<{ amount: number; at: Ms; tier?: 'A1' | 'B' }> = [
      { amount: 90, at: NOW - 25 * DAY },
      { amount: 90, at: NOW - 14 * DAY },
      { amount: 100, at: NOW - 4 * DAY },
      { amount: 95, at: NOW - 2 * DAY },
      { amount: 70, at: NOW - 1 * DAY, tier: 'B' },
    ];
    let key = '';
    for (const s of steps) {
      const e = persist(w, {
        amount: s.amount,
        tier: s.tier ?? 'A1',
        observedAt: s.at,
        createdAt: s.at,
      });
      key = e.beliefKey ?? '';
      w.beliefs.updateKeys(w.userId, [key], s.at, w.turnId);
    }
    w.beliefs.updateKeys(w.userId, [key], NOW, w.turnId);
    const incremental = history(w, key);
    expect(incremental.history.length).toBeGreaterThan(1);

    w.beliefs.rebuildKeys(w.userId, [key], NOW);
    expect(history(w, key)).toEqual(incremental);
  });

  it('T-DB-REBUILD-02: rebuild of every key matches the incremental state of all of them', () => {
    const w = makeWorld();
    const a = persist(w, { amount: 90, observedAt: NOW - 3 * DAY, createdAt: NOW - 3 * DAY });
    const b = persist(w, {
      amount: 900,
      value: { billingPeriod: 'annual' },
      observedAt: NOW - 3 * DAY,
      createdAt: NOW - 3 * DAY,
    });
    w.beliefs.updateKeys(w.userId, [a.beliefKey ?? '', b.beliefKey ?? ''], NOW - 3 * DAY, w.turnId);
    w.beliefs.updateKeys(w.userId, [a.beliefKey ?? '', b.beliefKey ?? ''], NOW, w.turnId);
    const before = [a, b].map((e) => history(w, e.beliefKey ?? ''));
    w.beliefs.rebuildAll(w.userId, NOW);
    expect([a, b].map((e) => history(w, e.beliefKey ?? ''))).toEqual(before);
  });

  it('T-DB-REBUILD-03: after a conversation is deleted, derived beliefs are recomputed from what remains', () => {
    const w = makeWorld();
    const keep = seedConversation(w.t, w.userId);
    const drop = seedConversation(w.t, w.userId);
    const old = persist(w, {
      amount: 90,
      observedAt: NOW - 20 * DAY,
      createdAt: NOW - 20 * DAY,
      turnId: keep.turnId,
    });
    const key = old.beliefKey ?? '';
    w.beliefs.updateKeys(w.userId, [key], NOW - 20 * DAY, keep.turnId);
    persist(w, {
      amount: 100,
      observedAt: NOW - 2 * DAY,
      createdAt: NOW - 2 * DAY,
      turnId: drop.turnId,
    });
    w.beliefs.updateKeys(w.userId, [key], NOW - 2 * DAY, drop.turnId);
    expect(w.beliefs.get(w.userId, key)?.value?.amount).toBe(100);

    deleteConversation(w.t.db, { beliefs: w.beliefs }, w.userId, drop.conversationId);
    expect(count(w.t.db, 'evidence_statements', 'turn_id = ?', drop.turnId)).toBe(0);
    const after = w.beliefs.get(w.userId, key);
    expect(after?.value?.amount).toBe(90);
    expect(after?.winningEvidence).toEqual([old.id]);
    expect(w.beliefs.historyReasons(w.userId, key)).toEqual(['initial']);
  });

  it('T-DB-REBUILD-04: a belief whose every statement was deleted disappears', () => {
    const w = makeWorld();
    const conv = seedConversation(w.t, w.userId);
    const e = persist(w, { amount: 90, turnId: conv.turnId });
    w.beliefs.updateKeys(w.userId, [e.beliefKey ?? ''], NOW, conv.turnId);
    deleteConversation(w.t.db, { beliefs: w.beliefs }, w.userId, conv.conversationId);
    expect(count(w.t.db, 'beliefs', 'user_id = ?', w.userId)).toBe(0);
    expect(count(w.t.db, 'belief_history', 'user_id = ?', w.userId)).toBe(0);
  });
});
