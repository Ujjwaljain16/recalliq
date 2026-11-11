import type {
  CurrencyCode,
  NormalizedValue,
  BillingPeriod,
  Unit,
  VerifiedEvidence,
} from './evidence.js';
import type { EntityId, EvidenceId, Ms } from './ids.js';

// Belief-key functions (encodePriceKey, decodePriceKey, keyForEvidence, comparableKeys) are part
// of the contract but are implemented in src/belief/belief-key.ts in the evidence/belief milestone.

export type Arrangement = 'list' | 'conditional' | 'promotional' | 'planned';

export interface PriceBeliefKey {
  kind: 'price';
  version: 1;
  entityId: EntityId;
  /** planNorm or 'unspecified' */
  plan: string;
  arrangement: Arrangement;
  /** sha1(normalised conditions) for conditional/promotional; else null. */
  conditionHash: string | null;
  unit: Unit;
  usageUnit: string | null;
  billingPeriod: BillingPeriod;
  /**
   * An ISO 4217 code, or `unknown@<registrable domain>` to scope an unstated currency to its
   * source. (The contract writes `CurrencyCode | \`unknown@${string}\``, which is the same type as
   * `string`.)
   */
  currency: CurrencyCode;
  valueKind: NormalizedValue['valueKind'];
}

export interface ReleaseKey {
  kind: 'release';
  version: 1;
  entityId: EntityId;
  titleHash: string;
}

export type BeliefStatus = 'confirmed' | 'contested' | 'stale' | 'unknown';

export interface PendingSignal {
  kind: 'lower_tier_newer' | 'planned_due';
  value: NormalizedValue;
  effectiveFrom: Ms | null;
  evidenceIds: EvidenceId[];
}

export interface Belief {
  key: string;
  entityId: EntityId;
  status: BeliefStatus;
  value: NormalizedValue | null;
  contestedValues?: Array<{ value: NormalizedValue; evidenceIds: EvidenceId[] }>;
  displayedAt: Ms | null;
  /** Latest fresh_fetch winner. */
  verifiedAt: Ms | null;
  winningEvidence: EvidenceId[];
  pendingSignals: PendingSignal[];
}

export type BeliefTransitionReason =
  'initial' | 'reconfirmed' | 'world_changed' | 'corrected' | 'contested' | 'staled';

/** 30 d, 7 d, 2 d by default. */
export interface BeliefPolicy {
  freshnessMs: Record<'price', Ms>;
  contestWindowMs: Ms;
  lowerTierLeadMs: Ms;
}

export interface BeliefResolver {
  resolve(
    key: string,
    evidence: VerifiedEvidence[],
    prev: Belief | null,
    now: Ms,
    policy: BeliefPolicy,
  ): { belief: Belief; transition: { reason: BeliefTransitionReason; prev: Belief | null } | null };
}
