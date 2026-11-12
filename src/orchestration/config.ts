import type { BudgetOp, BudgetStage } from '../shared/infrastructure.js';
import type { Ms } from '../shared/ids.js';

/**
 * Budget constants of architecture section 4 / H and the comment in src/shared/infrastructure.ts.
 * Configuration is injected: nothing in this module reads the environment.
 */
export interface TurnBudgetConfig {
  /** TURN_DEADLINE_MS: the single absolute deadline, measured from the start of the turn. */
  deadlineMs: Ms;
  /**
   * Upper bounds of a single call. `synthesis` runs until the deadline, so it has no cap. `quick` is the sourced
   * answer that streams while extraction runs: it ends by its cap whatever else is happening.
   */
  capMs: Record<Exclude<BudgetStage, 'synthesis'>, Ms>;
  /** Time set aside for the stages still to come, subtracted before a stage may start. */
  reserveMs: Record<BudgetStage, Ms>;
  /** A retry, split, fallback round or judge call starts only if this much time is left after the reserve. */
  minDurationMs: Record<BudgetOp, Ms>;
  /** Synthesis runs in compact mode below this much remaining time. */
  synthCompactBelowMs: Ms;
}

export const DEFAULT_TURN_BUDGET_CONFIG: TurnBudgetConfig = {
  deadlineMs: 60_000,
  capMs: { analysis: 8_000, search: 9_000, extraction: 25_000, judge: 4_000, quick: 8_000 },
  // search: 12 s synthesis + 1 s persistence; judge must end by deadline - 500 ms.
  // quick: like search, it leaves the time the verified synthesis and persistence need.
  reserveMs: {
    analysis: 0,
    search: 13_000,
    // extraction: the evidence judge, the verified synthesis and persistence still need time after it.
    extraction: 14_000,
    judge: 500,
    synthesis: 0,
    quick: 13_000,
  },
  minDurationMs: {
    search_retry: 2_000,
    extraction_retry: 8_000,
    extraction_split: 8_000,
    // a second search round costs a search and an extraction (15-25 s on a free-tier model), so it runs only
    // when the first round finished early enough to leave that and the answer.
    fallback_round: 25_000,
    judge: 2_000,
  },
  synthCompactBelowMs: 12_000,
};

/** The stage whose reserve applies to an operation. A fallback round is a search round. */
export const STAGE_OF_OP: Record<BudgetOp, BudgetStage> = {
  search_retry: 'search',
  extraction_retry: 'extraction',
  extraction_split: 'extraction',
  fallback_round: 'search',
  judge: 'judge',
};

/** Limits of one turn (architecture section 4, budgets table, and section 9). */
export const TURN_LIMITS = {
  maxSearches: 16,
  maxPerEntity: 4,
  maxEntities: 6,
  concurrency: 5,
  windowMessages: 6,
  windowMessageChars: 1_500,
  maxUnverifiedClaims: 5,
  /** Database busy: retry once, then give up (architecture section 14). */
  persistenceAttempts: 2,
} as const;
