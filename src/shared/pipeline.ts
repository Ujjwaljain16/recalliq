import type { SourceSnapshot } from './evidence.js';
import type { FindingSet } from './findings.js';
import type { IanaTz, Ms, SnapshotId, TurnId, UserId } from './ids.js';
import type { TurnBudget } from './infrastructure.js';
import type { ResolvedContext } from './memory.js';
import type { ResearchPlan } from './research.js';
import type { EventSink } from './sse.js';
import type { TurnAnalysis } from './understanding.js';

/**
 * Seams between the research pipeline (milestone 4), the orchestrator and the LLM layer (milestone 5).
 * Owned by the orchestrator: workers implement or consume these types and propose changes instead of
 * editing them. See docs/parallel-execution-plan.md.
 */

/** What a research or audit turn needs. Baselines for an audit arrive inside `ctx`. */
export interface ResearchRequest {
  userId: UserId;
  turnId: TurnId;
  ctx: ResolvedContext;
  analysis: TurnAnalysis;
  plan: ResearchPlan;
  now: Ms;
  budget: TurnBudget;
  emit: EventSink;
}

/**
 * Search, snapshots, extraction, T0 to T3 verification, belief resolution, verdicts and findings.
 *
 * Failures of the *world* become typed outcomes: a search provider error, a timeout, a quota failure, a
 * failed extraction or the turn deadline is recorded in each affected finding's `coverage` and its
 * `currentStatus` is `unable_to_verify`. The caller must never read such a result as "nothing changed".
 *
 * Failures of *our own system* are not coverage: a database persistence failure (including an ownership
 * or immutability trigger rejecting a write) and any programmer error propagate as exceptions. They must
 * never be turned into a research result with incomplete coverage.
 */
export interface ResearchService {
  run(req: ResearchRequest): Promise<FindingSet>;
}

/** Read side of the snapshot store. User-scoped: a snapshot of another user is never returned. */
export interface SnapshotReader {
  getMany(userId: UserId, ids: SnapshotId[]): SourceSnapshot[];
}

/**
 * The `analysis` LLM role. A model failure returns `degraded: true` (and a minimal analysis) rather than
 * throwing, so the orchestrator can fall back deterministically.
 */
export interface TurnAnalyzer {
  analyze(
    input: {
      userMessage: string;
      window: Array<{ role: 'user' | 'assistant'; content: string }>;
      tz: IanaTz;
      now: Ms;
    },
    budget: TurnBudget,
  ): Promise<TurnAnalysis>;
}
