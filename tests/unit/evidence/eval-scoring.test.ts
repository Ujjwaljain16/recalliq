import { describe, expect, it } from 'vitest';
import {
  matchesSpec,
  normUsageUnit,
  rate,
  scorePage,
  summarize,
  type PageScore,
} from '../../../src/evidence/eval/scoring.js';
import type { GoldClaim, GoldFile } from '../../../src/evidence/eval/gold.js';
import type { NormalizedValue, VerifiedEvidence } from '../../../src/shared/index.js';

/** Everything here is [SYNTHETIC]: a made-up vendor and page. */
const TEXT = [
  '# Acme pricing',
  '',
  '### Pro',
  '$90 per user per month, billed annually',
  '',
  '### Team',
  '$12 per GB-month of storage',
  '',
  'Beta Suite costs $40 per user per month',
].join('\n');

const PAGE = 'p1';

function value(over: Partial<NormalizedValue> = {}): NormalizedValue {
  return {
    amount: 90,
    currency: 'unknown',
    currencySymbol: '$',
    unit: 'per_seat',
    usageUnit: null,
    billingPeriod: 'monthly_billed_annually',
    valueKind: 'exact',
    ...over,
  };
}

function goldClaim(over: Partial<GoldClaim> = {}): GoldClaim {
  return {
    id: 'pro',
    plan: 'Pro',
    planNorm: 'pro',
    value: value(),
    modality: 'current',
    conditions: null,
    quote: '$90 per user per month, billed annually',
    contextQuote: '### Pro',
    expected: { status: 'pass' },
    confidence: 'high',
    ...over,
  };
}

function gold(over: Partial<GoldFile> = {}): GoldFile {
  return {
    pageId: PAGE,
    vendor: 'Acme',
    categories: ['per_seat'],
    entity: {
      name: 'Acme',
      aliases: ['Acme'],
      knownPlans: ['pro', 'team'],
      officialDomains: ['acme.example'],
      otherEntityAliases: ['Beta Suite'],
    },
    pageConfidence: 'high',
    claims: [
      goldClaim(),
      goldClaim({
        id: 'team-storage',
        plan: 'Team',
        planNorm: 'team',
        value: value({
          amount: 12,
          unit: 'usage',
          usageUnit: 'gb-month',
          billingPeriod: 'unspecified',
        }),
        quote: '$12 per GB-month of storage',
        contextQuote: '### Team',
        confidence: 'low',
        expected: { status: 'fail', reason: 'unit: fail' },
        bestAchievable: {
          quote: '$12 per GB-month of storage',
          contextQuote: '### Team',
          status: 'weak',
        },
      }),
    ],
    traps: [
      {
        id: 'competitor',
        kind: 'competitor',
        description: 'Beta Suite price',
        match: { amount: 40 },
      },
    ],
    ignorable: [{ id: 'free', description: 'free plan', match: { amount: 0 } }],
    ...over,
  };
}

let n = 0;
function evidence(
  over: {
    amount?: number;
    plan?: string | null;
    value?: Partial<NormalizedValue>;
    status?: 'pass' | 'weak' | 'fail';
    quote?: string;
    modality?: VerifiedEvidence['modality'];
    conditions?: string | null;
    entityId?: VerifiedEvidence['entityId'];
    kind?: VerifiedEvidence['kind'];
    nullValue?: boolean;
    checks?: VerifiedEvidence['verification']['checks'];
  } = {},
): VerifiedEvidence {
  n += 1;
  const plan = over.plan === undefined ? 'Pro' : over.plan;
  const status = over.status ?? 'pass';
  return {
    id: `ev_${n}`,
    snapshotId: `src_${PAGE}`,
    urlNorm: 'acme.example/pricing',
    entityId: over.entityId ?? `ent_${PAGE}`,
    kind: over.kind ?? 'price',
    beliefKey: null,
    fields: {
      plan,
      planNorm: plan === null ? null : plan.toLowerCase(),
      attribute: 'price',
      value: over.nullValue ? null : value({ amount: over.amount ?? 90, ...over.value }),
      conditions: over.conditions ?? null,
    },
    quote: over.quote ?? '$90 per user per month, billed annually',
    contextQuote: '### Pro',
    polarity: 'affirmed',
    modality: over.modality ?? 'current',
    authorityTier: 'A1',
    verification: {
      status,
      checks:
        over.checks ??
        (status === 'pass'
          ? [{ check: 'unit', outcome: 'pass' }]
          : [{ check: 'unit', outcome: status }]),
    },
    significance: null,
    observedAt: 0,
    freshFetch: false,
    providerPublishedAt: null,
    providerLastUpdatedAt: null,
    effectiveFrom: null,
    eventDate: null,
    displayedAt: null,
    displayedAtBasis: 'unknown',
  };
}

function score(statements: VerifiedEvidence[], g: GoldFile = gold(), failure?: string): PageScore {
  return scorePage({
    pageId: PAGE,
    categories: g.categories,
    text: TEXT,
    gold: g,
    statements,
    ...(failure ? { extractionFailure: failure } : {}),
  });
}

const STORAGE = {
  amount: 12,
  plan: 'Team',
  quote: '$12 per GB-month of storage',
  value: { unit: 'usage' as const, usageUnit: 'GB / month', billingPeriod: 'unspecified' as const },
};

describe('claim-level precision and recall', () => {
  it('a perfect extraction scores 1 on both', () => {
    const s = score([evidence(), evidence(STORAGE)]);
    expect(s.truePositives).toBe(2);
    expect(s.matchedGold).toBe(2);
    const sum = summarize([s]);
    expect(sum.precision.value).toBe(1);
    expect(sum.recall.value).toBe(1);
  });

  it('a statement with a wrong amount is a false positive and the gold claim is missed', () => {
    const s = score([evidence({ amount: 95 })]);
    expect(s.truePositives).toBe(0);
    expect(s.missedGoldIds).toEqual(['pro', 'team-storage']);
    expect(s.statements[0]?.klass).toBe('unmatched');
    expect(summarize([s]).precision.value).toBe(0);
  });

  it('every one of plan, currency, unit, usage unit and billing period must match', () => {
    const wrongs: Array<Parameters<typeof evidence>[0]> = [
      { plan: 'Team' },
      { value: { currency: 'USD' } },
      { value: { unit: 'unspecified' } },
      { value: { billingPeriod: 'monthly' } },
    ];
    for (const w of wrongs) expect(score([evidence(w)]).truePositives).toBe(0);
    expect(
      score([evidence({ ...STORAGE, value: { ...STORAGE.value, usageUnit: 'GB' } })]).truePositives,
    ).toBe(0);
  });

  it('a usage unit is compared on letters and digits only', () => {
    expect(normUsageUnit('GB-month')).toBe('gbmonth');
    expect(normUsageUnit('gb / month')).toBe('gbmonth');
    expect(normUsageUnit('  ')).toBeNull();
    expect(score([evidence(STORAGE)]).truePositives).toBe(1);
  });

  it('a second statement for a matched claim is a duplicate and does not count against precision', () => {
    const s = score([evidence(), evidence({ status: 'weak' })]);
    expect(s.truePositives).toBe(1);
    expect(s.duplicates).toBe(1);
    expect(s.predicted).toBe(1);
  });

  it('the strongest duplicate is credited with the claim', () => {
    const s = score([evidence({ status: 'fail' }), evidence({ status: 'pass' })]);
    expect(s.verifiedMatchedGold).toBe(1);
    expect(s.verifiedTruePositives).toBe(1);
  });

  it('statements that match an ignorable entry count neither way', () => {
    const s = score([evidence(), evidence({ amount: 0, plan: 'Free' })]);
    expect(s.ignored).toBe(1);
    expect(s.predicted).toBe(1);
    expect(s.falsePasses).toBe(0);
  });

  it('non-price statements are not scored as prices', () => {
    const s = score([evidence(), evidence({ kind: 'release', nullValue: true })]);
    expect(s.priceStatements).toBe(1);
    expect(s.nonPriceStatements).toBe(1);
  });

  it('a gold claim without a plan accepts any plan', () => {
    const g = gold({ claims: [goldClaim({ plan: null, planNorm: null })] });
    expect(score([evidence({ plan: 'Whatever' })], g).truePositives).toBe(1);
  });

  it('rates have no value when there is nothing to measure', () => {
    expect(rate(0, 0).value).toBeNull();
    const none = score([], gold({ claims: [] }));
    expect(summarize([none]).precision.value).toBeNull();
    expect(summarize([none]).recall.value).toBeNull();
  });
});

describe('verified (pass) restriction', () => {
  it('counts only pass statements for verified precision and recall', () => {
    const s = score([evidence({ status: 'weak' }), evidence({ ...STORAGE, status: 'pass' })]);
    const sum = summarize([s]);
    expect(sum.recall.value).toBe(1);
    expect(sum.verifiedRecall.value).toBe(0.5);
    expect(sum.verifiedPrecision.value).toBe(1);
  });

  it('measures verified recall against the claims verification can ever pass', () => {
    // "pro" is labelled pass (passable); "team-storage" tops out at weak (not passable).
    const s = score([evidence({ status: 'pass' })]);
    expect(s.goldPassable).toBe(1);
    expect(summarize([s]).verifiedRecallOfPassable.value).toBe(1);
  });

  it('a claim whose best-achievable form passes is passable', () => {
    const g = gold();
    const claim = g.claims[1];
    if (!claim) throw new Error('fixture');
    claim.bestAchievable = { quote: claim.quote, contextQuote: null, status: 'pass' };
    expect(score([], g).goldPassable).toBe(2);
  });
});

describe('false passes', () => {
  it('a pass that matches a trap is a false pass of kind trap', () => {
    const s = score([evidence({ amount: 40, plan: 'Beta' })]);
    expect(s.falsePasses).toBe(1);
    expect(s.falsePassByClass).toEqual({ trap: 1 });
    expect(s.statements[0]?.trapId).toBe('competitor');
  });

  it('a pass that matches nothing is a false pass; a weak one is not', () => {
    expect(score([evidence({ amount: 7 })]).falsePassByClass).toEqual({ unmatched: 1 });
    expect(score([evidence({ amount: 7, status: 'weak' })]).falsePasses).toBe(0);
  });

  it('a pass with the right plan, amount and currency that left the unit and period unspecified is underspecified', () => {
    const s = score([evidence({ value: { unit: 'unspecified', billingPeriod: 'unspecified' } })]);
    expect(s.falsePassByClass).toEqual({ underspecified: 1 });
  });

  it('a pass that contradicts a gold claim (another period) is contradicts', () => {
    const s = score([evidence({ value: { billingPeriod: 'monthly' } })]);
    expect(s.falsePassByClass).toEqual({ contradicts: 1 });
  });

  it('the same amount under another plan or currency contradicts', () => {
    expect(score([evidence({ plan: 'Team' })]).falsePassByClass).toEqual({ contradicts: 1 });
    expect(score([evidence({ value: { currency: 'USD' } })]).falsePassByClass).toEqual({
      contradicts: 1,
    });
  });

  it('every price statement on a negative control is a false positive, and a pass is a false pass', () => {
    const g = gold({
      claims: [],
      traps: [{ id: 'any', kind: 'other', description: 'no price', match: {} }],
    });
    const s = score([evidence(), evidence({ status: 'weak', amount: 3 })], g);
    expect(s.negativeControl).toBe(true);
    expect(s.truePositives).toBe(0);
    expect(s.predicted).toBe(2);
    expect(s.falsePasses).toBe(1);
    const sum = summarize([s]);
    expect(sum.negativeControls).toEqual({
      pages: 1,
      pagesWithPriceStatements: 1,
      priceStatements: 2,
      passStatements: 1,
    });
    expect(sum.falsePassRate.value).toBe(1);
  });

  it('a trap can test the modality and period of a statement', () => {
    const g = gold({
      traps: [
        {
          id: 'promo-as-current',
          kind: 'promotional',
          description: 'x',
          match: { amount: 50, modality: ['current'] },
        },
      ],
    });
    expect(score([evidence({ amount: 50, modality: 'current' })], g).falsePassByClass).toEqual({
      trap: 1,
    });
    expect(score([evidence({ amount: 50, modality: 'promotional' })], g).falsePassByClass).toEqual({
      unmatched: 1,
    });
  });

  it('matchesSpec requires every given condition and treats lists as any-of', () => {
    const view = {
      ev: evidence({ quote: 'The Quick price' }),
      amount: 90,
      planNorm: 'pro',
      currency: 'unknown',
      unit: 'per_seat',
      usageUnit: null,
      billingPeriod: 'monthly',
      valueKind: 'exact',
      modality: 'current',
      hasConditions: false,
    };
    expect(matchesSpec({}, view)).toBe(true);
    expect(matchesSpec({ amount: 90, planNorm: 'PRO', quoteContains: ['quick'] }, view)).toBe(true);
    expect(matchesSpec({ amount: 91 }, view)).toBe(false);
    expect(matchesSpec({ billingPeriod: ['annual', 'monthly'] }, view)).toBe(true);
    expect(matchesSpec({ billingPeriod: ['annual'] }, view)).toBe(false);
    expect(matchesSpec({ quoteContains: ['quick', 'missing'] }, view)).toBe(false);
  });
});

describe('field-level accuracy', () => {
  it('scores each field over the gold claims aligned to a statement on the amount', () => {
    const s = score([
      evidence({
        plan: 'Team',
        value: { unit: 'unspecified', billingPeriod: 'monthly' },
        modality: 'promotional',
      }),
    ]);
    expect(s.alignedGold).toBe(1);
    expect(s.fields.entity).toEqual({ correct: 1, total: 1 });
    expect(s.fields.plan).toEqual({ correct: 0, total: 1 });
    expect(s.fields.subject).toEqual({ correct: 0, total: 1 });
    expect(s.fields.unit).toEqual({ correct: 0, total: 1 });
    expect(s.fields.billingPeriod).toEqual({ correct: 0, total: 1 });
    expect(s.fields.currency).toEqual({ correct: 1, total: 1 });
    expect(s.fields.modality).toEqual({ correct: 0, total: 1 });
  });

  it('checks the usage unit only for usage claims', () => {
    const s = score([
      evidence(),
      evidence({ ...STORAGE, value: { ...STORAGE.value, usageUnit: 'GB' } }),
    ]);
    expect(s.fields.usageUnit).toEqual({ correct: 0, total: 1 });
  });

  it('an entity other than the page entity is a wrong entity', () => {
    const s = score([evidence({ entityId: 'ent_other' })]);
    expect(s.fields.entity).toEqual({ correct: 0, total: 1 });
    expect(s.fields.subject).toEqual({ correct: 0, total: 1 });
  });

  it('conditions are right when present exactly when the gold claim has them', () => {
    const g = gold({
      claims: [goldClaim({ modality: 'promotional', conditions: 'limited-time' })],
    });
    expect(
      score([evidence({ modality: 'promotional', conditions: 'limited-time' })], g).fields
        .conditions,
    ).toEqual({ correct: 1, total: 1 });
    expect(score([evidence({ modality: 'promotional' })], g).fields.conditions).toEqual({
      correct: 0,
      total: 1,
    });
  });

  it('a gold claim with no statement on its amount is not aligned', () => {
    expect(score([evidence({ amount: 1 })]).alignedGold).toBe(0);
  });

  it('picks the statement closest in fields when several share the amount', () => {
    const s = score([
      evidence({ plan: 'Team', value: { billingPeriod: 'monthly' } }),
      evidence({ value: { billingPeriod: 'monthly' } }),
    ]);
    expect(s.fields.plan).toEqual({ correct: 1, total: 1 });
  });
});

describe('supporting quote accuracy', () => {
  it('requires the quote to be verbatim in the page and to contain the claimed value', () => {
    const s = score([
      evidence(),
      evidence({ amount: 91, quote: '$91 per user per month, billed annually' }),
      evidence({ amount: 90, quote: 'billed annually' }),
      evidence({ amount: 90, quote: '$90 per user per month, billed monthly' }),
    ]);
    const byQuote = s.statements.map((x) => [x.quoteVerbatim, x.quoteContainsValue]);
    expect(byQuote).toEqual([
      [true, true],
      [false, true],
      [true, false],
      [false, true],
    ]);
    expect(s.quoteAccurate).toBe(1);
    expect(summarize([s]).quote.accurate.value).toBe(0.25);
  });

  it('ignores whitespace differences in a quote, like the verifier', () => {
    const s = score([evidence({ quote: '$90   per user\nper month, billed annually' })]);
    expect(s.statements[0]?.quoteVerbatim).toBe(true);
  });
});

describe('checks and aggregation', () => {
  it('counts the checks that did not pass', () => {
    const s = score([
      evidence({
        status: 'fail',
        checks: [
          { check: 'unit', outcome: 'fail' },
          { check: 'subject_binding', outcome: 'weak' },
        ],
      }),
      evidence({
        status: 'weak',
        amount: 12,
        checks: [{ check: 'subject_binding', outcome: 'weak' }],
      }),
    ]);
    expect(s.checkFailures).toEqual({
      unit: { weak: 0, fail: 1 },
      subject_binding: { weak: 2, fail: 0 },
    });
    expect(s.statements[0]?.failingChecks).toEqual(['unit:fail', 'subject_binding:weak']);
  });

  it('sums counts across pages and slices by category', () => {
    const a = score([evidence()]);
    const b = scorePage({
      pageId: 'p2',
      categories: ['usage_based'],
      text: TEXT,
      gold: gold({ pageId: 'p2', categories: ['usage_based'] }),
      statements: [],
    });
    const sum = summarize([a, b]);
    expect(sum.goldClaims).toBe(4);
    expect(sum.recall).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
    expect(sum.byCategory.per_seat?.recall.value).toBe(0.5);
    expect(sum.byCategory.usage_based?.recall.value).toBe(0);
    expect(sum.byCategory.usage_based?.pages).toBe(1);
  });

  it('can leave out gold claims labelled low confidence', () => {
    const s = score([evidence()]);
    const sum = summarize([s]);
    // one low-confidence claim (team-storage) is excluded from the denominator
    expect(sum.recallExcludingLowConfidence).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(sum.recall.value).toBe(0.5);
  });

  it('keeps the extraction failure of a page', () => {
    expect(score([], gold(), 'timeout: slow').extractionFailure).toBe('timeout: slow');
  });
});
