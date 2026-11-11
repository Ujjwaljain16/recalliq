import { describe, expect, it } from 'vitest';
import { defaultRenderer, formatLocalTime, keyHints } from '../../../src/answer/render.js';
import { resolveRef } from '../../../src/answer/records.js';
import { parsePlaceholderBody } from '../../../src/answer/placeholders.js';
import type { Finding } from '../../../src/shared/findings.js';
import { SRC_1, SRC_2, T_NOV_3, USD, finding, recordsFor } from './builders.js';

function render(f: Finding, body: string, extra: Finding[] = []): string {
  const records = recordsFor([f, ...extra]);
  const ref = parsePlaceholderBody(body);
  if (!ref) throw new Error('bad body');
  const res = resolveRef(ref, records);
  if (!res.ok) throw new Error(`not authorised: ${res.issue}`);
  return defaultRenderer.render(res.record, records);
}

describe('rendering of findings by code', () => {
  it('current value: symbol, unit and period, plan, citation', () => {
    expect(render(finding(1), 'F1')).toBe('US$90 per user per month (pro) [1]');
  });

  it('notes arrangement when it is not the list price, and an unstated currency', () => {
    const f = finding(1, {
      beliefKey:
        'price:v1|e=e|p=team|a=promotional|c=abc|u=per_seat|uu=-|b=annual|cur=USD|loc=en-US|vk=exact',
      current: {
        value: { ...USD, currency: 'unknown', currencySymbol: '$', billingPeriod: 'annual' },
        displayedAt: T_NOV_3,
        verifiedAt: T_NOV_3,
        citations: [SRC_2],
        pendingSignals: [],
      },
    });
    expect(render(f, 'F1')).toBe(
      '$90 per user per year (team, promotional, currency not stated) [2]',
    );
  });

  it('lower and upper bounds, fractional amounts, usage units', () => {
    const v = (over: object) =>
      finding(1, { current: { ...finding(1).current!, value: { ...USD, ...over } } });
    expect(render(v({ valueKind: 'lower_bound' }), 'F1')).toMatch(/^from US\$90 /);
    expect(
      render(
        v({ amount: 0.0015, unit: 'usage', usageUnit: 'token', billingPeriod: 'unspecified' }),
        'F1',
      ),
    ).toMatch(/^US\$0\.0015 per token/);
    expect(render(v({ amount: 9.5 }), 'F1')).toMatch(/^US\$9\.50 /);
  });

  it('contested values name both, each with its own citation', () => {
    const f = finding(1, {
      currentStatus: 'contested',
      current: {
        value: null,
        displayedAt: null,
        verifiedAt: null,
        citations: [SRC_1, SRC_2],
        pendingSignals: [],
        contested: [
          { value: USD, evidenceIds: [] },
          { value: { ...USD, amount: 100 }, evidenceIds: [] },
        ],
      },
    });
    expect(render(f, 'F1')).toBe(
      'listed as US$90 per user per month (pro) [1] and US$100 per user per month (pro) [2] — official sources disagree',
    );
  });

  it('stale values say when they were last seen', () => {
    const f = finding(1, { currentStatus: 'stale' });
    expect(render(f, 'F1')).toBe('US$90 per user per month (pro) (last seen 3 Nov 2026) [1]');
  });

  it('a finding with no value says so instead of inventing one', () => {
    const f = finding(1, { currentStatus: 'unknown', current: undefined });
    expect(render(f, 'F1')).toBe('I could not confirm a price through my checks');
  });

  it('baseline: value as of the local date of presentedAt', () => {
    const f = finding(1, {
      baseline: {
        value: USD,
        presentedAt: Date.UTC(2026, 10, 3, 23, 30),
        citations: [SRC_1],
        assertionId: 'asr_1',
      },
    });
    expect(render(f, 'F1:baseline')).toBe('US$90 per user per month (pro) as of 3 Nov 2026 [1]');
  });

  it('a tiered listing names each value with its condition and does not call it a disagreement', () => {
    const contested = (conds: Array<string[] | undefined>) =>
      finding(1, {
        currentStatus: 'contested',
        current: {
          value: null,
          displayedAt: null,
          verifiedAt: null,
          citations: [SRC_1, SRC_2],
          pendingSignals: [],
          contested: [
            { value: USD, evidenceIds: [], ...(conds[0] ? { conditions: conds[0] } : {}) },
            {
              value: { ...USD, amount: 100 },
              evidenceIds: [],
              ...(conds[1] ? { conditions: conds[1] } : {}),
            },
          ],
        },
      });
    expect(
      render(contested([['Starter subscriptions'], ['Professional subscriptions']]), 'F1'),
    ).toBe(
      'listed as US$90 per user per month (pro) (Starter subscriptions) [1] and US$100 per user per month (pro) (Professional subscriptions) [2] depending on the conditions shown',
    );
    // One value without a condition: still a disagreement between sources.
    expect(render(contested([['Starter subscriptions'], undefined]), 'F1')).toMatch(
      / — official sources disagree$/,
    );
    const long = 'x'.repeat(200);
    expect(render(contested([[long], ['  ']]), 'F1')).toContain(`(${'x'.repeat(87)}...)`);
  });

  it('release coverage too thin to support a negative says so in words', () => {
    const f = finding(1, {
      intent: 'releases',
      currentStatus: 'unable_to_verify',
      verdict: 'unable_to_verify',
      verdictReason: 'insufficient_coverage',
    });
    expect(render(f, 'F1')).toBe(
      "couldn't be checked this time (too few recent release sources were found to say there were none)",
    );
  });

  it('derived values: amount with its formula', () => {
    const f = finding(1, {
      derived: [
        {
          label: 'team',
          amount: 1800,
          currency: 'USD',
          currencySymbol: '$',
          formula: '20 seats × $90',
        },
      ],
    });
    expect(render(f, 'F1:derived:0')).toBe('$1,800 (20 seats × $90)');
  });

  it.each([
    [
      { verdict: 'unable_to_verify', verdictReason: 'search_timeout' },
      "couldn't be checked this time (the search timed out)",
    ],
    [{ verdict: 'contested', verdictReason: null }, 'official sources disagree'],
    [
      { verdict: 'contested', verdictReason: 'timing_conflict' },
      'sources disagree about when this changed',
    ],
    [
      { verdict: 'baseline_incorrect', verdictReason: 'unsupported_at_time' },
      "my earlier answer wasn't supported by its own source",
    ],
    [
      { verdict: 'baseline_incorrect', verdictReason: 'other_value_in_effect_at_T0' },
      'my earlier answer was already out of date',
    ],
    [
      { verdict: 'unchanged_confirmed' },
      'the official page still showed the same price when checked on 3 Nov 2026',
    ],
    [{ verdict: 'no_evidence_of_change' }, 'no sign of a change in what I could check'],
    [
      { verdict: 'no_evidence_of_change', currentStatus: 'stale' },
      'no current evidence either way (latest: 3 Nov 2026)',
    ],
    [
      { verdict: 'changed', changeWindow: { after: Date.UTC(2026, 9, 1), notAfter: T_NOV_3 } },
      'changed between 1 Oct 2026 and 3 Nov 2026',
    ],
    [{ verdict: 'changed', effectiveFrom: Date.UTC(2026, 10, 1) }, 'changed from 1 Nov 2026'],
    [
      { verdict: 'differs_timing_unknown' },
      "is different now; I can't tell whether it changed after my answer or my answer was already out of date",
    ],
  ] as const)('verdict phrase %j', (over, text) => {
    expect(render(finding(1, over as Partial<Finding>), 'F1:verdict')).toBe(text);
  });

  it('release findings render their items, and a none_found verdict states the coverage', () => {
    const f = finding(1, {
      intent: 'releases',
      verdict: 'none_found',
      releases: [],
    });
    expect(render(f, 'F1')).toBe('no releases were found');
    expect(render(f, 'F1:verdict')).toBe(
      'no releases found among 3 sources checked (newest dated source: 3 Nov 2026)',
    );
  });
});

describe('a finding that could not be checked says so, with the reason', () => {
  const reasons = [
    ['search_timeout', 'the search timed out'],
    ['search_unavailable', 'the search service was unavailable'],
    ['quota_exhausted', 'the search quota was used up'],
    ['extraction_failed', 'the pages could not be read'],
    ['deadline', 'time ran out'],
  ] as const;

  it.each(reasons)('current value, no verdict, coverage failure %s', (failure, text) => {
    const f = finding(1, {
      currentStatus: 'unable_to_verify',
      current: undefined,
      verdict: null,
      coverage: { ...finding(1).coverage, failure },
    });
    expect(render(f, 'F1')).toBe(`couldn't be checked this time (${text})`);
  });

  it.each(reasons)('verdict and current value use the same wording for %s', (failure, text) => {
    const f = finding(1, {
      currentStatus: 'unable_to_verify',
      current: undefined,
      verdict: 'unable_to_verify',
      verdictReason: failure,
      coverage: { ...finding(1).coverage, failure },
    });
    const want = `couldn't be checked this time (${text})`;
    expect(render(f, 'F1:verdict')).toBe(want);
    expect(render(f, 'F1')).toBe(want);
  });

  it('with no recorded reason it says so, and a release finding is treated the same way', () => {
    const f = finding(1, { currentStatus: 'unable_to_verify', current: undefined, verdict: null });
    expect(render(f, 'F1')).toBe("couldn't be checked this time (reason not recorded)");
    const r = finding(2, {
      intent: 'releases',
      currentStatus: 'unable_to_verify',
      verdict: null,
      coverage: { ...finding(2).coverage, failure: 'deadline' },
    });
    expect(render(r, 'F2')).toBe("couldn't be checked this time (time ran out)");
  });

  it('a finding that was checked and has no value is still not described as a failed check', () => {
    const f = finding(1, { currentStatus: 'unknown', current: undefined });
    expect(render(f, 'F1')).toBe('I could not confirm a price through my checks');
  });
});

describe('authorisation', () => {
  it('refuses unknown findings, inapplicable variants, and unlisted messages or sources', () => {
    const records = recordsFor([finding(1)]);
    const refs = (b: string) => resolveRef(parsePlaceholderBody(b)!, records);
    expect(refs('F2')).toEqual({ ok: false, issue: 'unknown_ref' });
    expect(refs('F1:baseline')).toEqual({ ok: false, issue: 'inapplicable_variant' });
    expect(refs('F1:verdict')).toEqual({ ok: false, issue: 'inapplicable_variant' });
    expect(refs('F1:derived:0')).toEqual({ ok: false, issue: 'inapplicable_variant' });
    expect(refs('M:msg_zzz')).toEqual({ ok: false, issue: 'unknown_ref' });
    expect(refs('S:src_zzz')).toEqual({ ok: false, issue: 'unknown_ref' });
    expect(refs('S:src_one').ok).toBe(true);
  });
});

describe('small helpers', () => {
  it('formats a recalled local time and reads plan hints from a belief key', () => {
    expect(formatLocalTime('2026-11-03 14:05')).toBe('Tuesday 3 Nov, 14:05');
    expect(formatLocalTime('yesterday')).toBe('yesterday');
    expect(keyHints('price:v1|e=ent_7|p=professional|a=list|c=-')).toEqual({
      plan: 'professional',
      arrangement: 'list',
    });
    expect(keyHints('price:v1|p=unspecified')).toEqual({ plan: null, arrangement: null });
    expect(keyHints(null)).toEqual({ plan: null, arrangement: null });
  });
});
