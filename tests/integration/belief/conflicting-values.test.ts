import { describe, expect, it } from 'vitest';
import { ev } from '../../unit/belief/support.js';
import { NOW, makeWorld, storeSnapshot } from '../evidence/support.js';

/** A contested belief is stored and read back with its values, evidence ids and condition texts. [SYNTHETIC] */
describe('contested beliefs in the repository', () => {
  it('T-REPO-20: three untimed values for one plan are stored as contested and read back whole', () => {
    const w = makeWorld();
    const conditions = ['in Starter', 'in Professional', 'in Enterprise'];
    const stored = [20, 50, 75].map((amount, i) => {
      const snapshotId = storeSnapshot(w.t.db, w.userId, {
        text: 'Acme Pro catalog',
        observedAt: NOW - 1000,
        fresh: false,
      });
      const e = ev({
        id: `k${i}`,
        amount,
        tier: 'A2',
        fresh: false,
        observedAt: NOW - 1000,
        snapshotId,
        entityId: w.acme.id,
        conditions: conditions[i] ?? null,
      });
      w.evidence.insert(w.userId, w.turnId, e, NOW);
      return e;
    });
    const key = stored[0]?.beliefKey ?? '';
    const result = w.beliefs.updateKeys(w.userId, [key], NOW, w.turnId).get(key);
    expect(result?.belief.status).toBe('contested');
    const back = w.beliefs.get(w.userId, key);
    expect(back?.status).toBe('contested');
    expect(back?.value).toBeNull();
    expect(
      back?.contestedValues?.map((g) => [g.value.amount, g.evidenceIds, g.conditions]),
    ).toEqual(stored.map((e, i) => [e.fields.value?.amount, [e.id], [conditions[i]]]));
    expect(w.beliefs.historyReasons(w.userId, key)).toEqual(['initial']);
  });
});
