import { RuleEvidenceVerifier } from '../../../src/evidence/verifier.js';
import type {
  AuthorityTier,
  EntityContext,
  NormalizedValue,
  RawEvidence,
  SourceSnapshot,
  VerifiedEvidence,
} from '../../../src/shared/index.js';

/** Every vendor, domain and price in these tests is [SYNTHETIC]; domains end in .example. */
export const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

export const ACME: EntityContext = {
  id: 'ent_acme',
  aliases: ['Acme', 'Acme CRM'],
  plans: ['starter', 'pro', 'enterprise'],
  officialDomains: ['acme.example'],
  otherEntityAliases: ['Beta', 'Beta Suite'],
};

/** A bare `$` price: the currency is unknown unless the text declares it. */
export function value(over: Partial<NormalizedValue> = {}): NormalizedValue {
  return {
    amount: 90,
    currency: 'unknown',
    currencySymbol: '$',
    unit: 'per_seat',
    usageUnit: null,
    billingPeriod: 'monthly',
    valueKind: 'exact',
    ...over,
  };
}

export function snapshot(text: string, over: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    id: 'src_1',
    url: 'https://acme.example/pricing',
    urlNorm: 'acme.example/pricing',
    domain: 'acme.example',
    title: 'Acme pricing',
    text,
    contentMode: 'text',
    sha256: 'sha',
    provider: 'test',
    providerPublishedAt: null,
    providerLastUpdatedAt: null,
    observedAt: NOW - 1000,
    freshFetch: true,
    crawlStatus: 'ok',
    origin: 'synthetic',
    ...over,
  };
}

export function raw(
  quote: string,
  over: Partial<RawEvidence> = {},
  v: Partial<NormalizedValue> | null = {},
): RawEvidence {
  return {
    snapshotRef: 'src_1',
    entityRef: 'ent_acme',
    kind: 'price',
    fields: {
      plan: 'Pro',
      planNorm: 'pro',
      attribute: 'price',
      value: v === null ? null : value(v),
      conditions: null,
    },
    quote,
    contextQuote: null,
    polarity: 'affirmed',
    modality: 'current',
    effectiveFromText: null,
    eventDateText: null,
    significance: null,
    significanceReason: null,
    ...over,
  };
}

export function rawWith(
  quote: string,
  fields: Partial<RawEvidence['fields']>,
  over: Partial<RawEvidence> = {},
): RawEvidence {
  const base = raw(quote, over);
  return { ...base, fields: { ...base.fields, ...fields } };
}

let counter = 0;
export function verifier(): RuleEvidenceVerifier {
  return new RuleEvidenceVerifier({ newEvidenceId: () => `ev_${++counter}` });
}

export interface Case {
  text?: string;
  tier?: AuthorityTier;
  entity?: EntityContext;
  snap?: Partial<SourceSnapshot>;
}

/** Verifies `r` against a snapshot whose text is the quote (or `c.text`). */
export function run(r: RawEvidence, c: Case = {}): VerifiedEvidence {
  const s = snapshot(c.text ?? r.quote, c.snap);
  return verifier().verify(r, s, c.entity ?? ACME, c.tier ?? 'A1', NOW);
}

export function outcome(ev: VerifiedEvidence, check: string): string | undefined {
  return ev.verification.checks.find((x) => x.check === check)?.outcome;
}
