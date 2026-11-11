import type { Belief, BeliefStatus, PendingSignal } from './belief.js';
import type { AuthorityTier, NormalizedValue, VerifiedEvidence } from './evidence.js';
import type { CrawlBasis } from './search.js';
import type {
  AssertionId,
  EntityId,
  EvidenceId,
  FindingId,
  Ms,
  SnapshotId,
  TurnId,
} from './ids.js';
import type { Baseline } from './memory.js';
import type { Intent } from './understanding.js';

export type PriceVerdict =
  | 'changed'
  | 'baseline_incorrect'
  | 'differs_timing_unknown'
  | 'unchanged_confirmed'
  | 'no_evidence_of_change'
  | 'contested'
  | 'unable_to_verify';

export type CoverageFailure =
  'search_timeout' | 'search_unavailable' | 'quota_exhausted' | 'extraction_failed' | 'deadline';

export type PriceVerdictReason =
  | 'unsupported_at_time'
  | 'other_value_in_effect_at_T0'
  | 'timing_conflict'
  | 'same_source_bracketing'
  | 'stated_effective_date'
  | 'listed_differently'
  | CoverageFailure;

export type ReleaseVerdict = 'releases_found' | 'none_found' | 'unable_to_verify';

export interface Coverage {
  searchesOk: number;
  searchesFailed: number;
  extractionFailed: boolean;
  sourcesChecked: number;
  newestDatedSource: Ms | null;
  freshOfficialFetched: boolean;
  failure: CoverageFailure | null;
}

/** The change occurred in (after, notAfter]. */
export interface ChangeWindow {
  after: Ms;
  notAfter: Ms;
}

export interface ChangeDetector {
  price(
    b: Baseline,
    current: Belief | null,
    keyEvidence: VerifiedEvidence[],
    coverage: Coverage,
  ): {
    verdict: PriceVerdict;
    reason: PriceVerdictReason | null;
    window?: ChangeWindow;
    effectiveFrom?: Ms;
    direction?: 'up' | 'down' | 'other';
  };
  releases(
    evidence: VerifiedEvidence[],
    coverage: Coverage,
    t0: Ms,
  ): { verdict: ReleaseVerdict; items: VerifiedEvidence[] };
}

/**
 * currentStatus = state of the current belief (or coverage failure).
 * verdict = comparison against a baseline (audit) or the release interval.
 */
export type FindingCurrentStatus = BeliefStatus | 'unable_to_verify';

export interface Finding {
  /** Rendered as F{ord}. */
  id: FindingId;
  ord: number;
  entityId: EntityId;
  entityName: string;
  intent: Intent;
  beliefKey: string | null;
  currentStatus: FindingCurrentStatus;
  /** null for research-lane price findings with no baseline. */
  verdict: PriceVerdict | ReleaseVerdict | null;
  verdictReason: PriceVerdictReason | null;
  /** changed / differs_timing_unknown only. */
  direction?: 'up' | 'down' | 'other';
  changeWindow?: ChangeWindow;
  effectiveFrom?: Ms;
  current?: {
    value: NormalizedValue | null;
    displayedAt: Ms | null;
    verifiedAt: Ms | null;
    /**
     * What the winning evidence's freshness rests on: the strongest basis among the snapshots it came from.
     * Reported only, so wording can say a result rests on a live crawl that was requested but not confirmed
     * (`requested_live`). It feeds no status and no verdict. Absent when the snapshots carry no basis.
     */
    crawlBasis?: CrawlBasis;
    citations: SnapshotId[];
    contested?: Belief['contestedValues'];
    pendingSignals: PendingSignal[];
  };
  baseline?: {
    value: NormalizedValue;
    presentedAt: Ms;
    citations: SnapshotId[];
    assertionId: AssertionId;
  };
  releases?: Array<{
    title: string;
    kind: 'launch' | 'change' | 'removal';
    eventDate: Ms | null;
    providerPublishedAt: Ms | null;
    significance: 'major' | 'minor' | null;
    announcedBeforeBaseline: boolean;
    citations: SnapshotId[];
  }>;
  derived?: Array<{
    label: string;
    amount: number;
    currency: NormalizedValue['currency'];
    currencySymbol: string | null;
    formula: string;
  }>;
  coverage: Coverage;
  evidenceIds: EvidenceId[];
}

export interface FindingSet {
  turnId: TurnId;
  createdAt: Ms;
  findings: Finding[];
  sources: Record<
    SnapshotId,
    { url: string; title: string | null; domain: string; tier: AuthorityTier; observedAt: Ms }
  >;
}
