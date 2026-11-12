import { describe, expect, it } from 'vitest';
import { quotesOf } from '../../../src/answer/pipeline.js';
import { findingsForAnswer } from '../../../src/orchestration/prepare.js';
import type { Finding, FindingSet } from '../../../src/shared/findings.js';

function price(
  ord: number,
  entity: string,
  amount: number,
  unit: 'per_seat' | 'flat',
  extra: Partial<Finding> = {},
): Finding {
  return {
    id: `fnd_${ord}`,
    ord,
    entityId: entity,
    entityName: entity,
    intent: 'pricing',
    beliefKey: null,
    currentStatus: 'confirmed',
    verdict: null,
    verdictReason: null,
    coverage: {
      searchesOk: 1,
      searchesFailed: 0,
      extractionFailed: false,
      sourcesChecked: 1,
      newestDatedSource: null,
      freshOfficialFetched: false,
      failure: null,
    },
    evidenceIds: [],
    current: {
      value: {
        amount,
        currency: 'USD',
        currencySymbol: '$',
        unit,
        usageUnit: null,
        billingPeriod: 'monthly',
        valueKind: 'exact',
      },
      displayedAt: null,
      verifiedAt: null,
      citations: [],
      pendingSignals: [],
    },
    ...extra,
  } as Finding;
}

const set = (findings: Finding[]): FindingSet =>
  ({ turnId: 't', createdAt: 0, findings, sources: {} }) as unknown as FindingSet;

describe('findings the answer is written from', () => {
  it('keeps at most four plain prices per company, seat prices first, then the cheapest', () => {
    const fs = [
      price(1, 'sf', 395, 'per_seat'),
      price(2, 'sf', 3250, 'flat'),
      price(3, 'sf', 195, 'per_seat'),
      price(4, 'sf', 8000, 'flat'),
      price(5, 'sf', 100, 'per_seat'),
      price(6, 'sf', 25, 'per_seat'),
      price(7, 'sf', 550, 'per_seat'),
      price(8, 'pd', 14, 'flat'),
    ];
    const out = findingsForAnswer(set(fs));
    expect(out?.findings.map((f) => f.ord)).toEqual([1, 3, 5, 6, 8]);
  });

  it('never drops a finding with a verdict or a baseline', () => {
    const fs = [1, 2, 3, 4, 5].map((n) => price(n, 'sf', n * 10, 'per_seat'));
    fs.push(price(6, 'sf', 999, 'flat', { verdict: 'changed' }));
    const out = findingsForAnswer(set(fs));
    expect(out?.findings.map((f) => f.ord)).toContain(6);
    expect(out?.findings).toHaveLength(5);
  });
});

describe('quoted passages', () => {
  it('finds the same quoted message in two sentences regardless of spacing and case', () => {
    const a = quotesOf(
      'On 3 Nov you asked: "What does Neon charge per month for its Postgres plans?"',
    );
    const b = quotesOf(
      'You asked: "what does Neon charge  per month for its Postgres plans?" (Tuesday).',
    );
    expect(a).toEqual(b);
    expect(quotesOf('A "short" quote')).toEqual([]);
  });
});

describe('one plan in several currencies', () => {
  it('keeps the US dollar price of a plan listed in several currencies', () => {
    const key = (cur: string) =>
      `price:v1|e=sf|p=starter|a=list|u=per_seat|b=monthly|cur=${cur}|vk=exact`;
    const fs = [
      price(1, 'sf', 35, 'per_seat', { beliefKey: key('AUD') }),
      price(2, 'sf', 25, 'per_seat', { beliefKey: key('EUR') }),
      price(3, 'sf', 25, 'per_seat', { beliefKey: key('USD') }),
      price(4, 'sf', 100, 'per_seat', { beliefKey: key('USD').replace('starter', 'pro') }),
    ];
    for (const f of fs)
      if (f.current?.value)
        f.current.value.currency = /cur=([A-Z]+)/.exec(f.beliefKey ?? '')?.[1] ?? 'USD';
    expect(findingsForAnswer(set(fs))?.findings.map((f) => f.ord)).toEqual([3, 4]);
  });
});
