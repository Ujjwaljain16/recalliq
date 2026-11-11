import { describe, expect, it } from 'vitest';
import { RuleChangeDetector } from '../../../src/belief/detector.js';
import type { Baseline, Belief, Coverage, VerifiedEvidence } from '../../../src/shared/index.js';
import { baseline, DAY, ev, LIST_KEY, NOW, OK_COVERAGE, resolveAll, T0, usd } from './support.js';

const detector = new RuleChangeDetector();
const H = 3_600_000;

/** The detector as the research service uses it: the belief is resolved from every stored statement. */
function detect(b: Baseline, extra: VerifiedEvidence[], coverage: Coverage = OK_COVERAGE) {
  const all = [...b.evidence, ...extra];
  const current = resolveAll(all).belief;
  return { current, result: detector.price(b, current, all, coverage) };
}

/**
 * The detector against a confirmed current belief of , bypassing the resolver. Two official values
 * within 7 days of each other would make a real belief contested (a different rule, tested above); these
 * cases isolate the timing proofs.
 */
function detectConfirmed(b: Baseline, extra: VerifiedEvidence[], amount = 100) {
  const all = [...b.evidence, ...extra];
  const current: Belief = {
    key: LIST_KEY,
    entityId: 'ent_acme',
    status: 'confirmed',
    value: usd(amount),
    displayedAt: NOW - DAY,
    verifiedAt: NOW - DAY,
    winningEvidence: extra.filter((e) => e.fields.value?.amount === amount).map((e) => e.id),
    pendingSignals: [],
  };
  return { current, result: detector.price(b, current, all, OK_COVERAGE) };
}

/** An older new-value page that was displayed before the answer (the starting condition of most cases). */
const newPage = (o: Partial<Parameters<typeof ev>[0]> = {}) =>
  ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY, ...o });

describe('price verdicts: observed against effective time (T-BEL-20..28)', () => {
  it('T-BEL-20: a different value with nothing about timing is differs_timing_unknown', () => {
    const { result } = detectConfirmed(baseline(), [newPage()]);
    expect(result.verdict).toBe('differs_timing_unknown');
    expect(result.direction).toBe('up');
    expect(result.window).toBeUndefined();
  });

  it('T-BEL-21: the old value re-observed after the answer, then the new value, on the same page, is changed with a window', () => {
    const old = ev({ id: 'old', amount: 90, observedAt: T0 + 2 * DAY });
    const nu = ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY });
    const { result } = detectConfirmed(baseline(), [old, nu]);
    expect(result).toMatchObject({
      verdict: 'changed',
      reason: 'same_source_bracketing',
      direction: 'up',
      window: { after: T0 + 2 * DAY, notAfter: T0 + 10 * DAY },
    });
  });

  it('T-BEL-22: a fresh fetch never invents an effective date', () => {
    const nu = newPage({ fresh: true });
    expect(nu.effectiveFrom).toBeNull();
    expect(detectConfirmed(baseline(), [nu]).result.verdict).toBe('differs_timing_unknown');
  });

  it("T-BEL-23: the baseline's own fetch never counts as the old-value observation", () => {
    const own = baseline().evidence[0] as VerifiedEvidence;
    const nu = newPage();
    expect(detectConfirmed(baseline(), [own, nu]).result.verdict).toBe('differs_timing_unknown');
    // an old-value snapshot retrieved at exactly T0 is not after the answer either
    const atT0 = ev({ id: 'at0', amount: 90, observedAt: T0 });
    expect(detectConfirmed(baseline(), [atT0, nu]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-24: a different page (url_norm) cannot bracket', () => {
    const old = ev({
      id: 'old',
      amount: 90,
      observedAt: T0 + 2 * DAY,
      urlNorm: 'acme.example/en-gb/plans',
    });
    const nu = ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY });
    expect(detectConfirmed(baseline(), [old, nu]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-25: an unknown locale cannot establish changed by bracketing', () => {
    const url = 'acme.example/pricing';
    const own = ev({ id: 'b0', urlNorm: url, observedAt: T0 - H });
    const old = ev({ id: 'old', amount: 90, urlNorm: url, observedAt: T0 + 2 * DAY });
    const nu = ev({ id: 'new', amount: 100, urlNorm: url, observedAt: T0 + 10 * DAY });
    const key = ev({ id: 'k', urlNorm: url }).beliefKey ?? '';
    const base: Baseline = { ...baseline(), beliefKey: key, key: decode(key), evidence: [own] };
    const all = [own, old, nu];
    const current = resolveAll(all, key).belief;
    const out = detector.price(base, current, all, OK_COVERAGE);
    expect(base.key.locale).toBe('und');
    expect(out.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-26: the same plan in another locale is neither contested nor changed', () => {
    const us = ev({
      id: 'us',
      amount: 120,
      urlNorm: 'acme.example/en-us/pricing',
      observedAt: T0 + 10 * DAY,
    });
    const { current, result } = detectConfirmed(baseline(), [us]);
    // the en-US statement is a different key: the en-GB belief is unchanged
    expect(current.status).not.toBe('contested');
    expect(result.verdict).not.toBe('changed');
    expect(result.verdict).not.toBe('contested');
  });

  it('T-BEL-26b: old and new values bracketed on a page of another locale do not count', () => {
    const us = 'acme.example/en-us/pricing';
    const old = ev({ id: 'old', amount: 90, observedAt: T0 + 2 * DAY, urlNorm: us });
    const nu = ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY, urlNorm: us });
    expect(detectConfirmed(baseline(), [old, nu]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-27: an A1 or A2 effective date after the answer establishes changed from that date', () => {
    for (const tier of ['A1', 'A2'] as const) {
      const nu = ev({
        id: `n${tier}`,
        amount: 100,
        tier,
        observedAt: T0 + 10 * DAY,
        effectiveFrom: T0 + 3 * DAY,
      });
      const { result } = detectConfirmed(baseline(), [nu]);
      expect(result).toMatchObject({
        verdict: 'changed',
        reason: 'stated_effective_date',
        effectiveFrom: T0 + 3 * DAY,
      });
    }
  });

  it('T-BEL-28: an effective date from a tier B source, or on or before the answer, does not establish changed', () => {
    const lowTier = ev({
      id: 'b',
      amount: 100,
      tier: 'B',
      observedAt: T0 + 10 * DAY,
      effectiveFrom: T0 + 3 * DAY,
    });
    expect(detectConfirmed(baseline(), [lowTier]).result.verdict).toBe('differs_timing_unknown');
    const before = ev({ id: 'e', amount: 100, observedAt: T0 + 10 * DAY, effectiveFrom: T0 - DAY });
    expect(detectConfirmed(baseline(), [before]).result.verdict).toBe('baseline_incorrect');
    const atT0 = ev({ id: 'f', amount: 100, observedAt: T0 + 10 * DAY, effectiveFrom: T0 });
    expect(detectConfirmed(baseline(), [atT0]).result.verdict).toBe('baseline_incorrect');
  });

  it('T-BEL-29: a publication date alone never establishes timing', () => {
    const nu = ev({ id: 'n', amount: 100, fresh: false, published: T0 + DAY, lastUpdated: null });
    expect(detectConfirmed(baseline(), [nu]).result.verdict).toBe('differs_timing_unknown');
  });
});

describe('observations from the provider cache (content as-of)', () => {
  const old = (o: Partial<Parameters<typeof ev>[0]>) =>
    ev({ id: 'old', amount: 90, observedAt: T0 + 2 * DAY, ...o });
  const nu = (o: Partial<Parameters<typeof ev>[0]>) =>
    ev({ id: 'new', amount: 100, observedAt: T0 + 10 * DAY, ...o });

  it('T-BEL-50: cached copies with last-updated times after the answer can bracket', () => {
    const o = old({ fresh: false, lastUpdated: T0 + 2 * DAY - H });
    const n = nu({ fresh: false, lastUpdated: T0 + 10 * DAY - H });
    const { result } = detectConfirmed(baseline(), [o, n]);
    expect(result.verdict).toBe('changed');
    expect(result.window).toEqual({ after: T0 + 2 * DAY, notAfter: T0 + 10 * DAY });
  });

  it('T-BEL-51: a cached old-value copy with no last-updated time has an unknown as-of time and cannot bracket', () => {
    const o = old({ fresh: false, lastUpdated: null });
    expect(detectConfirmed(baseline(), [o, nu({})]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-52: a cached new-value copy with no as-of time cannot close the bracket', () => {
    const n = nu({ fresh: false, lastUpdated: null });
    expect(detectConfirmed(baseline(), [old({}), n]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-53: an old-value copy retrieved after the answer but as of before it does not count', () => {
    const o = old({ fresh: false, lastUpdated: T0 - DAY });
    expect(detectConfirmed(baseline(), [o, nu({})]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-54: an old-value copy as of exactly the answer time does not count', () => {
    const o = old({ fresh: false, lastUpdated: T0 });
    expect(detectConfirmed(baseline(), [o, nu({})]).result.verdict).toBe('differs_timing_unknown');
  });

  it("T-BEL-55: a new-value copy whose as-of time is not later than the old-value observation's does not count", () => {
    const o = old({});
    const sameAsOf = nu({ fresh: false, lastUpdated: T0 + 2 * DAY });
    expect(detectConfirmed(baseline(), [o, sameAsOf]).result.verdict).toBe(
      'differs_timing_unknown',
    );
    const earlier = nu({ fresh: false, lastUpdated: T0 + DAY });
    expect(detectConfirmed(baseline(), [o, earlier]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-56: a failed crawl flagged fresh is treated as a cached copy', () => {
    const o = old({ fresh: true, crawl: 'failed', lastUpdated: null });
    expect(detectConfirmed(baseline(), [o, nu({})]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-57: retrieval after the answer is also required: a late as-of time on an early retrieval is not enough', () => {
    const o = old({ observedAt: T0 - DAY, fresh: false, lastUpdated: T0 + DAY });
    expect(detectConfirmed(baseline(), [o, nu({})]).result.verdict).toBe('differs_timing_unknown');
  });

  it('T-BEL-58: a weak statement is not an observation', () => {
    const o = old({ status: 'weak' });
    expect(detectConfirmed(baseline(), [o, nu({})]).result.verdict).toBe('differs_timing_unknown');
  });
});

describe('price verdicts: the other rows', () => {
  it('T-BEL-10: a coverage failure wins over everything', () => {
    const failure: Coverage = { ...OK_COVERAGE, failure: 'search_timeout' };
    expect(detect(baseline(), [newPage()], failure).result).toEqual({
      verdict: 'unable_to_verify',
      reason: 'search_timeout',
    });
    const ex: Coverage = { ...OK_COVERAGE, extractionFailed: true };
    expect(detect(baseline(), [], ex).result.reason).toBe('extraction_failed');
  });

  it('T-BEL-11: a contested current belief is contested', () => {
    const a = ev({
      id: 'a',
      amount: 100,
      observedAt: NOW - 3 * DAY,
      urlNorm: 'acme.example/en-gb/plans',
    });
    const b = ev({ id: 'b', amount: 110, observedAt: NOW - 2 * DAY });
    expect(detect(baseline(), [a, b]).result.verdict).toBe('contested');
  });

  it('T-BEL-12: a baseline whose own evidence failed re-verification, or never stated its value, is baseline_incorrect', () => {
    const failed = baseline({ evidence: [ev({ id: 'b0', observedAt: T0 - H, status: 'fail' })] });
    expect(detect(failed, []).result).toEqual({
      verdict: 'baseline_incorrect',
      reason: 'unsupported_at_time',
    });
    const other = baseline({ evidence: [ev({ id: 'b0', amount: 80, observedAt: T0 - H })] });
    expect(detect(other, []).result.reason).toBe('unsupported_at_time');
    expect(
      detect(baseline({ evidenceStatusAtT0: 'missing', evidence: [] }), []).result.reason,
    ).toBe('unsupported_at_time');
    expect(detect(baseline({ evidenceStatusAtT0: 'weak' }), []).result.reason).toBe(
      'unsupported_at_time',
    );
  });

  it('T-BEL-13: other evidence in effect at the answer time is baseline_incorrect', () => {
    const effective = ev({
      id: 'e',
      amount: 100,
      observedAt: T0 + 10 * DAY,
      effectiveFrom: T0 - 10 * DAY,
    });
    expect(detectConfirmed(baseline(), [effective]).result).toEqual({
      verdict: 'baseline_incorrect',
      reason: 'other_value_in_effect_at_T0',
      direction: undefined,
    });
    const displayedBefore = ev({ id: 'd', amount: 100, observedAt: T0 - 2 * DAY });
    expect(detectConfirmed(baseline(), [displayedBefore]).result.verdict).toBe(
      'baseline_incorrect',
    );
  });

  it('T-BEL-14: a time basis of unknown, or a lower tier than the baseline, is no prior-effect proof', () => {
    const unknownBasis = ev({ id: 'u', amount: 100, fresh: false, effectiveFrom: null });
    expect(unknownBasis.displayedAt).toBeNull();
    // keep it current so the belief is the new value: use a second statement
    const current = ev({ id: 'c', amount: 100, observedAt: T0 + 10 * DAY });
    expect(detectConfirmed(baseline(), [unknownBasis, current]).result.verdict).toBe(
      'differs_timing_unknown',
    );
    const lowTier = ev({ id: 'l', amount: 100, tier: 'B', observedAt: T0 - 2 * DAY });
    expect(detectConfirmed(baseline(), [lowTier, current]).result.verdict).toBe(
      'differs_timing_unknown',
    );
  });

  it('T-BEL-15: both proofs at once is contested with a timing conflict', () => {
    const prior = ev({ id: 'p', amount: 100, observedAt: T0 - 2 * DAY });
    const dated = ev({
      id: 'd',
      amount: 100,
      observedAt: T0 + 10 * DAY,
      effectiveFrom: T0 + 3 * DAY,
    });
    expect(detectConfirmed(baseline(), [prior, dated]).result).toMatchObject({
      verdict: 'contested',
      reason: 'timing_conflict',
    });
  });

  it('T-BEL-16: the same value with a live A1 observation after the answer is unchanged_confirmed', () => {
    const same = ev({ id: 's', amount: 90, observedAt: T0 + 10 * DAY });
    expect(detect(baseline(), [same]).result.verdict).toBe('unchanged_confirmed');
  });

  it('T-BEL-17b: a live A2 observation is not enough for unchanged_confirmed', () => {
    const a2 = ev({ id: 'a2', amount: 90, tier: 'A2', observedAt: T0 + 10 * DAY });
    expect(detectConfirmed(baseline(), [a2], 90).result.verdict).toBe('no_evidence_of_change');
    const a1 = ev({ id: 'a1', amount: 90, tier: 'A1', observedAt: T0 + 10 * DAY });
    expect(detectConfirmed(baseline(), [a1], 90).result.verdict).toBe('unchanged_confirmed');
  });

  it('T-BEL-17: the same value without a live A1 observation after the answer is only no_evidence_of_change', () => {
    const cached = ev({
      id: 's',
      amount: 90,
      observedAt: T0 + 10 * DAY,
      fresh: false,
      lastUpdated: T0 + 10 * DAY,
    });
    expect(detect(baseline(), [cached]).result.verdict).toBe('no_evidence_of_change');
    const tierB = ev({ id: 't', amount: 90, tier: 'B', observedAt: T0 + 10 * DAY });
    expect(detect(baseline(), [tierB]).result.verdict).toBe('no_evidence_of_change');
    const before = ev({ id: 'x', amount: 90, observedAt: T0 - 1000 });
    expect(detect(baseline(), [before]).result.verdict).toBe('no_evidence_of_change');
  });

  it('T-BEL-18: a stale or unknown current belief is no_evidence_of_change', () => {
    const b = baseline({
      presentedAt: NOW - 50 * DAY,
      evidence: [ev({ id: 'b0', observedAt: NOW - 51 * DAY })],
    });
    expect(detect(b, []).current.status).toBe('stale');
    expect(detect(b, []).result.verdict).toBe('no_evidence_of_change');
    const none = detector.price(b, null, [], OK_COVERAGE);
    expect(none.verdict).toBe('no_evidence_of_change');
  });

  it('T-BEL-19: the direction follows the amounts and is other across units or currencies', () => {
    const down = ev({ id: 'd', amount: 80, observedAt: T0 + 10 * DAY });
    expect(detectConfirmed(baseline(), [down], 80).result.direction).toBe('down');
  });

  it('T-BEL-59: evidence for another key is not consulted', () => {
    const annual = ev({
      id: 'a',
      amount: 90,
      value: { billingPeriod: 'annual' },
      observedAt: T0 + 2 * DAY,
    });
    const nu = ev({ id: 'n', amount: 100, observedAt: T0 + 10 * DAY });
    const { result } = detectConfirmed(baseline(), [annual, nu]);
    expect(result.verdict).toBe('differs_timing_unknown');
    expect(LIST_KEY).toContain('b=monthly');
  });
});

describe('release verdicts', () => {
  const rel = (id: string, over: Partial<VerifiedEvidence> = {}): VerifiedEvidence => ({
    ...ev({ id }),
    kind: 'release',
    beliefKey: null,
    fields: {
      plan: null,
      planNorm: null,
      attribute: 'release',
      value: null,
      conditions: null,
      releaseTitle: id,
      releaseKind: 'launch',
    },
    ...over,
  });

  it('T-BEL-60: releases dated at or after the answer are found, oldest first; earlier ones never count', () => {
    const items = [
      rel('later', { eventDate: T0 + 3 * DAY }),
      rel('at', { eventDate: T0 }),
      rel('before', { eventDate: T0 - DAY }),
      rel('fallback', { eventDate: null, providerPublishedAt: T0 + DAY }),
      rel('undated', { eventDate: null, providerPublishedAt: null }),
      rel('weak', { eventDate: T0 + DAY, verification: { status: 'weak', checks: [] } }),
    ];
    const out = detector.releases(items, OK_COVERAGE, T0);
    expect(out.verdict).toBe('releases_found');
    expect(out.items.map((i) => i.id)).toEqual(['ev_at', 'ev_fallback', 'ev_later']);
  });

  it('T-BEL-61: none found when searches succeeded and nothing is dated in the interval', () => {
    expect(detector.releases([rel('old', { eventDate: T0 - DAY })], OK_COVERAGE, T0).verdict).toBe(
      'none_found',
    );
  });

  it('T-BEL-62: a coverage failure is unable_to_verify, never none_found', () => {
    const out = detector.releases([], { ...OK_COVERAGE, failure: 'deadline' }, T0);
    expect(out).toEqual({ verdict: 'unable_to_verify', items: [] });
  });
});

import { decodePriceKey } from '../../../src/belief/belief-key.js';
function decode(k: string) {
  return decodePriceKey(k);
}
