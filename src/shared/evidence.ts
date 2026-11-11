import type { EntityId, EvidenceId, Ms, Origin, SnapshotId } from './ids.js';
import type { TurnBudget } from './infrastructure.js';
import type { CrawlBasis } from './search.js';

export type AuthorityTier = 'A1' | 'A2' | 'B' | 'C';
export type Modality = 'current' | 'planned' | 'historical' | 'conditional' | 'promotional';
export type Unit = 'per_seat' | 'flat' | 'usage' | 'unspecified';
export type BillingPeriod =
  'monthly' | 'annual' | 'monthly_billed_annually' | 'one_time' | 'unspecified';
/**
 * An ISO 4217 code, or the literal `'unknown'`. The contract writes this as `CurrencyCode |
 * 'unknown'`, which is the same type as `string`; it is spelled `string` here so the lint rule
 * against redundant union members stays on.
 */
export type CurrencyCode = string;

export interface NormalizedValue {
  amount: number;
  /** `'unknown'` unless the source states the currency explicitly. A bare `$` or `¥` is unknown. */
  currency: CurrencyCode;
  /** As displayed, e.g. "$". */
  currencySymbol: string | null;
  unit: Unit;
  /** Required iff unit = 'usage', e.g. "gb-month". */
  usageUnit: string | null;
  billingPeriod: BillingPeriod;
  valueKind: 'exact' | 'lower_bound' | 'upper_bound';
}

export interface EvidenceFields {
  plan: string | null;
  planNorm: string | null;
  attribute: 'price' | 'release' | 'plan_change' | 'other';
  /** Price only. */
  value: NormalizedValue | null;
  releaseTitle?: string;
  releaseKind?: 'launch' | 'change' | 'removal';
  /** Verbatim cue text for conditional/promotional. */
  conditions: string | null;
}

/** Extractor output, unverified. */
export interface RawEvidence {
  snapshotRef: string;
  entityRef: string;
  kind: EvidenceFields['attribute'];
  fields: EvidenceFields;
  /** ≤ 400, verbatim. */
  quote: string;
  /** ≤ 200, verbatim, nearest heading/table header ABOVE the quote. */
  contextQuote: string | null;
  polarity: 'affirmed' | 'negated';
  modality: Modality;
  /** Parsed by code, never by the model. */
  effectiveFromText: string | null;
  eventDateText: string | null;
  significance: 'major' | 'minor' | null;
  significanceReason: string | null;
}

export type VerificationCheck =
  | 'quote_verbatim'
  | 'context_verbatim'
  | 'context_association'
  | 'subject_binding'
  | 'competitor_attribution'
  | 'plan_binding'
  | 'intervening_tier'
  | 'value_presence'
  | 'currency'
  | 'unit'
  | 'billing_period'
  | 'date_presence'
  | 'negation'
  | 'historical_cue'
  | 'conditional_cue'
  | 'planned_cue';

export interface CheckResult {
  check: VerificationCheck;
  outcome: 'pass' | 'weak' | 'fail' | 'n/a';
  detail?: string;
}

export interface VerificationReport {
  status: 'pass' | 'weak' | 'fail';
  checks: CheckResult[];
}

/** All time fields, kept distinct (ADR-22). */
export interface TimeFields {
  /** Snapshot retrieval. */
  observedAt: Ms;
  freshFetch: boolean;
  /** Provenance: snapshot.provider. */
  providerPublishedAt: Ms | null;
  providerLastUpdatedAt: Ms | null;
  /** Stated in the text. */
  effectiveFrom: Ms | null;
  /** Stated in the text (releases). */
  eventDate: Ms | null;
  /** Derived: latest instant the source provably displayed this statement. */
  displayedAt: Ms | null;
  displayedAtBasis: 'fresh_fetch' | 'provider_last_updated' | 'provider_published' | 'unknown';
}

export interface VerifiedEvidence extends TimeFields {
  id: EvidenceId;
  snapshotId: SnapshotId;
  urlNorm: string;
  entityId: EntityId;
  kind: EvidenceFields['attribute'];
  beliefKey: string | null;
  fields: EvidenceFields;
  quote: string;
  contextQuote: string | null;
  polarity: 'affirmed' | 'negated';
  modality: Modality;
  authorityTier: AuthorityTier;
  verification: VerificationReport;
  significance: 'major' | 'minor' | null;
}

export interface SourceSnapshot {
  id: SnapshotId;
  url: string;
  urlNorm: string;
  domain: string;
  title: string | null;
  text: string;
  contentMode: 'text' | 'highlights';
  sha256: string;
  provider: string;
  providerPublishedAt: Ms | null;
  providerLastUpdatedAt: Ms | null;
  observedAt: Ms;
  freshFetch: boolean;
  /** Equals `confirmed_live` exactly when `freshFetch` is true. Absent only on hand-built snapshots. */
  crawlBasis?: CrawlBasis;
  crawlStatus: 'ok' | 'failed' | 'unknown';
  origin: Origin;
}

export interface ExtractionBatch {
  id: string;
  entityIds: EntityId[];
  snapshotIds: SnapshotId[];
  estTokens: number;
  trimmed: SnapshotId[];
}

export interface ExtractionBatcher {
  pack(byEntity: Map<EntityId, SourceSnapshot[]>): ExtractionBatch[];
}

export interface EvidenceExtractor {
  extract(batch: ExtractionBatch, budget: TurnBudget): Promise<RawEvidence[]>;
}

export interface EntityContext {
  id: EntityId;
  aliases: string[];
  plans: string[];
  officialDomains: string[];
  /**
   * Domains the owner's registry explicitly maps to this entity (never a name match, never a model guess, never
   * a domain listed for two entities). Provenance is kept apart from `officialDomains`, which may also carry
   * domains from earlier sources. Absent means no explicit ownership is known (ADR-41).
   */
  ownedDomains?: string[];
  otherEntityAliases: string[];
}

/** Pure. */
export interface EvidenceVerifier {
  verify(
    raw: RawEvidence,
    s: SourceSnapshot,
    e: EntityContext,
    tier: AuthorityTier,
    now: Ms,
  ): VerifiedEvidence;
}

export interface AuthorityClassifier {
  classify(s: SourceSnapshot, officialDomains: string[]): AuthorityTier;
}
