import type { SourceSnapshot } from './evidence.js';
import type { FindingSet } from './findings.js';
import type { IanaTz, Ms, SnapshotId, TurnId, UserId } from './ids.js';
import type { TurnBudget } from './infrastructure.js';
import type { ResolvedContext } from './memory.js';
import type { ResearchPlan } from './research.js';
import type { EventSink } from './sse.js';
import type { TurnAnalysis } from './understanding.js';

/**
 * Seams between the research pipeline, the turn orchestrator and the LLM layer. Each module implements or
 * consumes these types and does not change them on its own: a change affects every module on both sides.
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
  /**
   * Optional. Called once, in a turn that will extract, after the searches of the first round returned and
   * their snapshots were stored, before extraction starts. Receives the turn's sources with their content, in
   * the order of their `source` events (already sent). The service does not wait for what the callback starts and
   * ignores what it throws; the final `FindingSet.sources` keeps these keys first, in this order.
   */
  onSourcesReady?: (sources: FindingSet['sources']) => void;
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
