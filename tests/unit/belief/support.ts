import { keyForEvidence, decodePriceKey } from '../../../src/belief/belief-key.js';
import { RuleBeliefResolver, DEFAULT_BELIEF_POLICY } from '../../../src/belief/resolver.js';
import { timeFields } from '../../../src/evidence/verifier.js';
import type {
  AuthorityTier,
  Baseline,
  Belief,
  Coverage,
  CrawlBasis,
  Modality,
  Ms,
  NormalizedValue,
  VerifiedEvidence,
} from '../../../src/shared/index.js';
import { snapshot } from '../evidence/support.js';

/** [SYNTHETIC] data throughout. */
export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);
export const NOW = T0 + 20 * DAY;
export const GB_URL = 'acme.example/en-gb/pricing';

export function usd(amount: number, over: Partial<NormalizedValue> = {}): NormalizedValue {
  return {
    amount,
    currency: 'USD',
    currencySymbol: 'US$',
    unit: 'per_seat',
    usageUnit: null,
    billingPeriod: 'monthly',
    valueKind: 'exact',
    ...over,
  };
}

export interface EvOpts {
  id: string;
  amount?: number;
  value?: Partial<NormalizedValue>;
  tier?: AuthorityTier;
  observedAt?: Ms;
  fresh?: boolean;
  /** Recorded on the snapshot; it must change nothing the evidence says. */
  basis?: CrawlBasis;
  crawl?: 'ok' | 'failed' | 'unknown';
  lastUpdated?: Ms | null;
  published?: Ms | null;
  effectiveFrom?: Ms | null;
  urlNorm?: string;
  snapshotId?: string;
  status?: 'pass' | 'weak' | 'fail';
  modality?: Modality;
  polarity?: 'affirmed' | 'negated';
  planNorm?: string | null;
  conditions?: string | null;
  domain?: string;
  entityId?: `ent_${string}`;
}

export function ev(o: EvOpts): VerifiedEvidence {
  const urlNorm = o.urlNorm ?? GB_URL;
  const snap = snapshot('x', {
    id: (o.snapshotId ?? `src_${o.id}`) as `src_${string}`,
    urlNorm,
    url: `https://${urlNorm}`,
    domain: o.domain ?? 'acme.example',
    observedAt: o.observedAt ?? NOW - DAY,
    freshFetch: o.fresh ?? true,
    ...(o.basis !== undefined ? { crawlBasis: o.basis } : {}),
    crawlStatus: o.crawl ?? 'ok',
    providerLastUpdatedAt: o.lastUpdated ?? null,
    providerPublishedAt: o.published ?? null,
  });
  const time = timeFields(snap, o.effectiveFrom ?? null, null);
  const base: Omit<VerifiedEvidence, 'beliefKey'> = {
    id: `ev_${o.id}`,
    snapshotId: snap.id,
    urlNorm,
    entityId: o.entityId ?? 'ent_acme',
    kind: 'price',
    fields: {
      plan: 'Pro',
      planNorm: o.planNorm === undefined ? 'pro' : o.planNorm,
      attribute: 'price',
      value: usd(o.amount ?? 90, o.value),
      conditions: o.conditions ?? null,
    },
    quote: 'Acme Pro US$90 per user per month',
    contextQuote: null,
    polarity: o.polarity ?? 'affirmed',
    modality: o.modality ?? 'current',
    authorityTier: o.tier ?? 'A1',
    verification: { status: o.status ?? 'pass', checks: [] },
    significance: null,
    ...time,
  };
  const key = keyForEvidence(base, { domain: snap.domain, urlNorm });
  return { ...base, beliefKey: (o.status ?? 'pass') === 'pass' ? key : null };
}

export const LIST_KEY = (() => {
  const k = ev({ id: 'probe' }).beliefKey;
  if (k === null) throw new Error('probe has no key');
  return k;
})();

export const OK_COVERAGE: Coverage = {
  searchesOk: 2,
  searchesFailed: 0,
  extractionFailed: false,
  sourcesChecked: 2,
  newestDatedSource: null,
  freshOfficialFetched: true,
  failure: null,
};

export const resolver = new RuleBeliefResolver();

export function resolveAll(
  evidence: VerifiedEvidence[],
  key = LIST_KEY,
  now = NOW,
  prev: Belief | null = null,
) {
  return resolver.resolve(key, evidence, prev, now, DEFAULT_BELIEF_POLICY);
}

/** A baseline of $90 presented at T0, backed by its own fetch an hour earlier. */
export function baseline(over: Partial<Baseline> = {}): Baseline {
  const own = ev({ id: 'b0', observedAt: T0 - 3_600_000 });
  return {
    assertionId: 'asr_1',
    beliefKey: LIST_KEY,
    key: decodePriceKey(LIST_KEY),
    entityId: 'ent_acme',
    value: usd(90),
    presentedAt: T0,
    evidence: [own],
    evidenceStatusAtT0: 'pass_current',
    ...over,
  };
}
