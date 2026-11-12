import { describe, expect, it } from 'vitest';
import { findingRow, formatValue, groupedFindingRows } from '../../../web/js/findings.js';
import type { Finding } from '../../../src/shared/findings.js';
import type { NormalizedValue } from '../../../src/shared/evidence.js';

const now = Date.UTC(2026, 10, 12, 12);
const opts = { now, timeZone: 'UTC' };
const day = (d: number) => Date.UTC(2026, 10, d, 12);

const usd = (amount: number, extra: Partial<NormalizedValue> = {}): NormalizedValue => ({
  amount,
  currency: 'USD',
  currencySymbol: 'US$',
  unit: 'per_seat',
  usageUnit: null,
  billingPeriod: 'monthly',
  valueKind: 'exact',
  ...extra,
});

const sources = [
  {
    n: 1,
    sourceId: 'src_a',
    url: 'https://acme.example/pricing',
    domain: 'acme.example',
    title: 'Pricing',
  },
  { n: 2, sourceId: 'src_b', url: 'javascript:alert(1)', domain: 'bad.example', title: null },
];

function finding(patch: Partial<Finding>): Finding {
  return {
    id: 'fnd_1',
    ord: 1,
    entityId: 'ent_1',
    entityName: 'Acme',
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
      freshOfficialFetched: true,
      failure: null,
    },
    evidenceIds: [],
    ...patch,
  };
}

const current = (value: NormalizedValue | null, extra = {}) =>
  ({
    value,
    displayedAt: day(10),
    verifiedAt: day(10),
    citations: ['src_a', 'src_b'],
    pendingSignals: [],
    ...extra,
  }) as unknown as Finding['current'];

const COULD_NOT = "couldn't check";

describe('finding values', () => {
  it('formats amount, currency, unit and billing period', () => {
    expect(formatValue(usd(25))).toBe('US$25 per user per month');
    expect(formatValue(usd(9.5, { unit: 'flat', billingPeriod: 'annual' }))).toBe(
      'US$9.50 per year',
    );
    expect(
      formatValue(
        usd(10, {
          currencySymbol: null,
          currency: 'EUR',
          unit: 'usage',
          usageUnit: 'GB-month',
          valueKind: 'lower_bound',
        }),
      ),
    ).toBe('from EUR 10 per GB-month, per month');
    expect(
      formatValue(
        usd(5, {
          currencySymbol: '$',
          currency: 'unknown',
          unit: 'unspecified',
          billingPeriod: 'unspecified',
        }),
      ),
    ).toBe('$5');
  });
});

describe('finding rows', () => {
  it('shows a verified price with its safe citations only', () => {
    const row = findingRow(finding({ current: current(usd(25)) }), sources, opts);
    expect(row).toMatchObject({
      name: 'Acme',
      value: 'US$25 per user per month',
      verdict: null,
      baseline: null,
    });
    expect(row.status?.label).toBe('verified');
    expect(row.citations).toEqual([
      { n: 1, href: 'https://acme.example/pricing', label: 'acme.example', title: 'Pricing' },
    ]);
  });

  it('describes stale, contested and unverifiable values', () => {
    const stale = findingRow(
      finding({ currentStatus: 'stale', current: current(usd(25)) }),
      sources,
      opts,
    );
    expect(stale.status?.label).toBe('last seen 10 Nov');
    const contested = findingRow(
      finding({
        currentStatus: 'contested',
        current: current(null, {
          contested: [
            { value: usd(10), evidenceIds: [] },
            { value: usd(12), evidenceIds: [] },
          ],
        }),
      }),
      sources,
      opts,
    );
    expect(contested.value).toBe('listed as US$10 / US$12');
    expect(contested.status?.label).toBe('contested');
    const failed = findingRow(
      finding({
        currentStatus: 'unable_to_verify',
        verdict: 'unable_to_verify',
        verdictReason: 'search_unavailable',
      }),
      sources,
      opts,
    );
    expect(failed).toMatchObject({ value: 'no verified price', verdict: null });
    expect(failed.status).toMatchObject({
      label: COULD_NOT,
      title: 'the search was unavailable',
    });
  });

  it('words verdicts plainly, with direction, window and the earlier value', () => {
    const changed = findingRow(
      finding({
        current: current(usd(30)),
        verdict: 'changed',
        direction: 'up',
        changeWindow: { after: day(3), notAfter: day(10) },
        baseline: { value: usd(25), presentedAt: day(3), citations: [], assertionId: 'asr_1' },
      }),
      sources,
      opts,
    );
    expect(changed.verdict?.label).toBe('changed ↑ between 3 Nov and 10 Nov');
    expect(changed.baseline).toBe('earlier: US$25 per user per month on 3 Nov');
    const label = (patch: Partial<Finding>) =>
      findingRow(finding(patch), sources, opts).verdict?.label;
    expect(label({ verdict: 'no_evidence_of_change' })).toBe('no sign of change');
    expect(label({ verdict: 'differs_timing_unknown' })).toBe('differs — timing unknown');
    expect(label({ verdict: 'baseline_incorrect' })).toBe('earlier answer was out of date');
    expect(label({ verdict: 'changed', direction: 'down', effectiveFrom: day(1) })).toBe(
      'changed ↓ from 1 Nov',
    );
  });

  it('lists releases with their dates', () => {
    const row = findingRow(
      finding({
        intent: 'releases',
        currentStatus: 'unknown',
        verdict: 'releases_found',
        releases: [
          {
            title: 'AI assistant',
            kind: 'launch',
            eventDate: day(5),
            providerPublishedAt: null,
            significance: 'major',
            announcedBeforeBaseline: false,
            citations: ['src_a'],
          },
          {
            title: 'New API',
            kind: 'change',
            eventDate: null,
            providerPublishedAt: null,
            significance: null,
            announcedBeforeBaseline: false,
            citations: [],
          },
        ],
      }),
      sources,
      opts,
    );
    expect(row).toMatchObject({ value: '2 releases', status: null });
    expect(row.verdict?.label).toBe('shipped something new');
    expect(row.releases).toEqual([
      { title: 'AI assistant', date: '5 Nov', major: true },
      { title: 'New API', date: null, major: false },
    ]);
    expect(row.citations.map((c) => c.n)).toEqual([1]);
  });
});

describe('one card row per entity', () => {
  const tier = (ord: number, plan: string, amount: number, extra: Partial<Finding> = {}) =>
    finding({
      id: `fnd_${ord}`,
      ord,
      entityId: 'ent_pd',
      entityName: 'Pipedrive',
      beliefKey: `price:v1|e=ent_pd|p=${plan}|a=list|c=-|u=per_seat|uu=-|b=monthly|cur=unknown|loc=en-US|vk=exact`,
      currentStatus: 'stale',
      current: current(usd(amount, { currency: 'unknown', currencySymbol: null }), {
        displayedAt: null,
        verifiedAt: null,
      }),
      ...extra,
    });

  it('lists the four Pipedrive plans in one row with the notes said once', () => {
    const rows = groupedFindingRows(
      [tier(1, 'lite', 19), tier(2, 'growth', 34), tier(3, 'premium', 64), tier(4, 'ultimate', 89)],
      sources,
      opts,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Pipedrive');
    expect(rows[0]?.value).toBe(
      'Lite 19 · Growth 34 · Premium 64 · Ultimate 89 per user per month · currency not stated',
    );
    expect(rows[0]?.status?.label).toBe('not seen recently');
  });

  it('keeps single findings and different entities apart, in order', () => {
    const other = finding({ id: 'fnd_9', ord: 9, entityId: 'ent_x', entityName: 'Other' });
    const rows = groupedFindingRows(
      [other, tier(1, 'lite', 19), tier(2, 'growth', 34)],
      sources,
      opts,
    );
    expect(rows.map((r) => r.name)).toEqual(['Pipedrive', 'Other']);
    expect(rows[1]?.value).toBe('no verified price');
  });
});
