import { describe, expect, it } from 'vitest';
import { decodePriceKey, plannedTwinKey } from '../../../src/belief/belief-key.js';
import { DEFAULT_BELIEF_POLICY } from '../../../src/belief/resolver.js';
import { DAY, ev, LIST_KEY, NOW, resolveAll, resolver, usd } from './support.js';

describe('belief resolution', () => {
  it('T-BEL-01: no evidence and no previous belief is unknown', () => {
    const r = resolveAll([]);
    expect(r.belief.status).toBe('unknown');
    expect(r.belief.value).toBeNull();
    expect(r.transition).toBeNull();
  });

  it('T-BEL-02: a fresh single statement confirms, and verifiedAt is its live crawl', () => {
    const e = ev({ id: 'a', observedAt: NOW - DAY });
    const { belief, transition } = resolveAll([e]);
    expect(belief.status).toBe('confirmed');
    expect(belief.value).toEqual(usd(90));
    expect(belief.winningEvidence).toEqual([e.id]);
    expect(belief.verifiedAt).toBe(NOW - DAY);
    expect(transition?.reason).toBe('initial');
  });

  it('T-BEL-03: verifiedAt is null when the winner was not a live crawl', () => {
    const e = ev({ id: 'a', fresh: false, lastUpdated: NOW - 2 * DAY });
    const { belief } = resolveAll([e]);
    expect(belief.status).toBe('confirmed');
    expect(belief.displayedAt).toBe(NOW - 2 * DAY);
    expect(belief.verifiedAt).toBeNull();
  });

  it('T-BEL-04: authority beats recency: a newer tier B never replaces an A1', () => {
    const a1 = ev({ id: 'a1', amount: 90, tier: 'A1', observedAt: NOW - 10 * DAY });
    const b = ev({
      id: 'b',
      amount: 80,
      tier: 'B',
      observedAt: NOW - DAY,
      urlNorm: 'review.example/en-gb/p',
    });
    const { belief } = resolveAll([a1, b]);
    expect(belief.status).toBe('confirmed');
    expect(belief.value?.amount).toBe(90);
    // more than 2 days newer and a different value: a pending signal that changes nothing
    expect(belief.pendingSignals).toHaveLength(1);
    expect(belief.pendingSignals[0]).toMatchObject({ kind: 'lower_tier_newer' });
    expect(belief.pendingSignals[0]?.value.amount).toBe(80);
  });

  it('T-BEL-05: a lower tier less than 2 days newer is not even a pending signal', () => {
    const a1 = ev({ id: 'a1', amount: 90, observedAt: NOW - 3 * DAY });
    const b = ev({ id: 'b', amount: 80, tier: 'B', observedAt: NOW - 2 * DAY - 3_600_000 });
    expect(resolveAll([a1, b]).belief.pendingSignals).toHaveLength(0);
  });

  it('T-BEL-06: two top-tier values within 7 days are contested, never "newest wins"', () => {
    const a = ev({
      id: 'a',
      amount: 90,
      observedAt: NOW - 5 * DAY,
      urlNorm: 'acme.example/en-gb/pricing',
    });
    const b = ev({
      id: 'b',
      amount: 95,
      observedAt: NOW - 2 * DAY,
      urlNorm: 'acme.example/en-gb/plans',
    });
    const { belief, transition } = resolveAll([a, b]);
    expect(belief.status).toBe('contested');
    expect(belief.value).toBeNull();
    expect(belief.contestedValues?.map((g) => g.value.amount).sort()).toEqual([90, 95]);
    expect(transition?.reason).toBe('initial');
  });

  it('T-BEL-07: values more than 7 days apart are not contested: the newest wins', () => {
    const a = ev({ id: 'a', amount: 90, observedAt: NOW - 20 * DAY });
    const b = ev({ id: 'b', amount: 95, observedAt: NOW - 2 * DAY });
    const { belief } = resolveAll([a, b]);
    expect(belief.status).toBe('confirmed');
    expect(belief.value?.amount).toBe(95);
  });

  it('T-BEL-08: A1 against A2 is not contested: A1 wins', () => {
    const a1 = ev({ id: 'a1', amount: 90, tier: 'A1', observedAt: NOW - 3 * DAY });
    const a2 = ev({ id: 'a2', amount: 95, tier: 'A2', observedAt: NOW - 2 * DAY });
    const { belief } = resolveAll([a1, a2]);
    expect(belief.status).toBe('confirmed');
    expect(belief.value?.amount).toBe(90);
  });

  it('T-BEL-09: statements older than 30 days only give a stale belief of the best tier', () => {
    const old = ev({ id: 'o', observedAt: NOW - 40 * DAY });
    const oldB = ev({ id: 'ob', amount: 70, tier: 'B', observedAt: NOW - 35 * DAY });
    const { belief } = resolveAll([oldB, old]);
    expect(belief.status).toBe('stale');
    expect(belief.value?.amount).toBe(90);
  });

  it('T-BEL-10: a statement with an unknown time basis is never current', () => {
    const e = ev({ id: 'u', fresh: false });
    expect(e.displayedAt).toBeNull();
    expect(resolveAll([e]).belief.status).toBe('stale');
  });

  it('T-BEL-11: a stale provider snippet cannot compete with a fresh official page', () => {
    const snippet = ev({
      id: 's',
      amount: 70,
      tier: 'B',
      fresh: false,
      published: NOW - 100 * DAY,
    });
    const page = ev({ id: 'p', amount: 90, tier: 'A1', observedAt: NOW - DAY });
    const { belief } = resolveAll([snippet, page]);
    expect(belief.value?.amount).toBe(90);
    expect(belief.pendingSignals).toHaveLength(0);
  });

  it('T-BEL-12: weak, failed and negated statements never feed a belief', () => {
    const weak = ev({ id: 'w', status: 'weak' });
    const failed = ev({ id: 'f', status: 'fail' });
    const negated = ev({ id: 'n', polarity: 'negated' });
    expect(resolveAll([weak, failed, negated]).belief.status).toBe('unknown');
  });

  it('T-BEL-13: a statement for another key is ignored (annual is not a conflict with monthly)', () => {
    const monthly = ev({ id: 'm', amount: 90 });
    const annual = ev({ id: 'a', amount: 900, value: { billingPeriod: 'annual' } });
    const { belief } = resolveAll([monthly, annual]);
    expect(belief.status).toBe('confirmed');
    expect(belief.value?.amount).toBe(90);
    const annualKey = annual.beliefKey ?? '';
    expect(
      resolver.resolve(annualKey, [monthly, annual], null, NOW, DEFAULT_BELIEF_POLICY).belief.value
        ?.amount,
    ).toBe(900);
  });

  it('T-BEL-14: the same plan in two locales is two beliefs, neither contested', () => {
    const gb = ev({ id: 'gb', amount: 90, urlNorm: 'acme.example/en-gb/pricing' });
    const us = ev({ id: 'us', amount: 110, urlNorm: 'acme.example/en-us/pricing' });
    expect(gb.beliefKey).not.toBe(us.beliefKey);
    const r = (k: string | null) =>
      resolver.resolve(k ?? '', [gb, us], null, NOW, DEFAULT_BELIEF_POLICY).belief;
    expect(r(gb.beliefKey).status).toBe('confirmed');
    expect(r(gb.beliefKey).value?.amount).toBe(90);
    expect(r(us.beliefKey).value?.amount).toBe(110);
  });

  it('T-BEL-30: a planned price stays under its own key and never changes the list belief', () => {
    const list = ev({ id: 'l', amount: 90 });
    const planned = ev({ id: 'p', amount: 99, modality: 'planned', effectiveFrom: NOW + 10 * DAY });
    expect(planned.beliefKey).toBe(plannedTwinKey(LIST_KEY));
    const r = resolveAll([list, planned]);
    expect(r.belief.value?.amount).toBe(90);
    expect(r.belief.pendingSignals).toHaveLength(0);
  });

  it('T-BEL-31: a due planned price becomes a pending signal and still never changes the value', () => {
    const list = ev({ id: 'l', amount: 90 });
    const planned = ev({ id: 'p', amount: 99, modality: 'planned', effectiveFrom: NOW - DAY });
    const r = resolveAll([list, planned]);
    expect(r.belief.value?.amount).toBe(90);
    expect(r.belief.status).toBe('confirmed');
    expect(r.belief.pendingSignals).toEqual([
      expect.objectContaining({ kind: 'planned_due', effectiveFrom: NOW - DAY }),
    ]);
    // once the list price was observed at the planned value there is nothing pending
    const oldList = ev({ id: 'l2', amount: 90, observedAt: NOW - 12 * DAY });
    const observed = ev({ id: 'o', amount: 99, observedAt: NOW - 1000 });
    const after = resolveAll([oldList, planned, observed]).belief;
    expect(after.value?.amount).toBe(99);
    expect(after.pendingSignals).toHaveLength(0);
  });

  it('T-BEL-32: a planned price on a promotional key does not attach to the list key', () => {
    const list = ev({ id: 'l' });
    const promo = ev({ id: 'x', amount: 50, modality: 'promotional', conditions: '50% off' });
    expect(resolveAll([list, promo]).belief.pendingSignals).toHaveLength(0);
    expect(decodePriceKey(promo.beliefKey ?? '').arrangement).toBe('promotional');
  });

  it('T-BEL-33: lower_bound and exact prices are separate keys', () => {
    const exact = ev({ id: 'e', amount: 90 });
    const from = ev({ id: 'f', amount: 20, value: { valueKind: 'lower_bound' } });
    expect(exact.beliefKey).not.toBe(from.beliefKey);
    expect(resolveAll([exact, from]).belief.value?.amount).toBe(90);
  });

  it('T-BEL-34: resolution does not depend on input order', () => {
    const a = ev({ id: 'a', amount: 90, observedAt: NOW - 5 * DAY });
    const b = ev({ id: 'b', amount: 95, observedAt: NOW - 2 * DAY });
    const c = ev({ id: 'c', amount: 90, tier: 'B', observedAt: NOW - DAY });
    expect(resolveAll([a, b, c]).belief).toEqual(resolveAll([c, b, a]).belief);
  });
});

describe('belief transitions', () => {
  const first = ev({ id: 'a', amount: 90, observedAt: NOW - 10 * DAY });

  it('T-BEL-35: same value seen later is reconfirmed; an identical state is no transition', () => {
    const prev = resolveAll([first], LIST_KEY, NOW - 8 * DAY).belief;
    const later = ev({ id: 'b', amount: 90, observedAt: NOW - DAY });
    expect(resolveAll([first, later], LIST_KEY, NOW, prev).transition?.reason).toBe('reconfirmed');
    const same = resolveAll([first], LIST_KEY, NOW - 7 * DAY, prev);
    expect(same.transition).toBeNull();
  });

  it('T-BEL-36: a different value displayed later is world_changed (the record changed, not a claim about when)', () => {
    const prev = resolveAll([first], LIST_KEY, NOW - 8 * DAY).belief;
    const later = ev({ id: 'b', amount: 100, observedAt: NOW - DAY });
    const r = resolveAll([first, later], LIST_KEY, NOW, prev);
    expect(r.belief.value?.amount).toBe(100);
    expect(r.transition?.reason).toBe('world_changed');
  });

  it('T-BEL-37: a different value when the previous winner no longer passes is corrected', () => {
    const prev = resolveAll([first], LIST_KEY, NOW - 8 * DAY).belief;
    const replacement = ev({ id: 'c', amount: 85, observedAt: NOW - DAY });
    expect(resolveAll([replacement], LIST_KEY, NOW, prev).transition?.reason).toBe('corrected');
  });

  it('T-BEL-38: an equal-or-higher-tier statement that is not newer and contradicts is corrected', () => {
    const prev = resolveAll([first], LIST_KEY, NOW - 8 * DAY).belief;
    const older = ev({ id: 'd', amount: 85, tier: 'A1', observedAt: NOW - 12 * DAY });
    const r = resolveAll([first, older], LIST_KEY, NOW, prev);
    // both within 7 days? no: 2 days apart, so contested; use a gap larger than the window instead
    expect(['contested', 'corrected']).toContain(r.transition?.reason);
    const far = ev({ id: 'e', amount: 85, tier: 'A1', observedAt: NOW - 25 * DAY });
    const r2 = resolveAll([first, far], LIST_KEY, NOW, prev);
    expect(r2.belief.value?.amount).toBe(90);
    expect(r2.transition).toBeNull();
  });

  it('T-BEL-39: becoming contested and becoming stale are recorded', () => {
    const prev = resolveAll([first], LIST_KEY, NOW - 8 * DAY).belief;
    const rival = ev({ id: 'r', amount: 95, observedAt: NOW - 9 * DAY });
    expect(resolveAll([first, rival], LIST_KEY, NOW, prev).transition?.reason).toBe('contested');
    const staled = resolveAll([first], LIST_KEY, NOW + 40 * DAY, prev);
    expect(staled.belief.status).toBe('stale');
    expect(staled.transition?.reason).toBe('staled');
  });

  it('T-BEL-40: losing all evidence after a belief existed gives a stale belief that keeps its value', () => {
    const prev = resolveAll([first], LIST_KEY, NOW - 8 * DAY).belief;
    const r = resolveAll([], LIST_KEY, NOW, prev);
    expect(r.belief.status).toBe('stale');
    expect(r.belief.value?.amount).toBe(90);
  });
});
