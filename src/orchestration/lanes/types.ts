import type { FindingSet } from '../../shared/findings.js';
import type { ConversationId, MessageId, Ms, TurnId, UserId } from '../../shared/ids.js';
import type { TurnBudget } from '../../shared/infrastructure.js';
import type { MemoryRetriever, ResolvedContext } from '../../shared/memory.js';
import type { ResearchPlanner } from '../../shared/research.js';
import type { ResearchService } from '../../shared/pipeline.js';
import type { EventSink } from '../../shared/sse.js';
import type { TemporalResolver } from '../../shared/temporal.js';
import type { TurnState } from '../../shared/turn.js';
import type { IanaTz } from '../../shared/ids.js';
import type { Lane, TurnAnalysis } from '../../shared/understanding.js';
import type { BaselineSource } from '../ports.js';

/** What a lane handler receives. `progress` moves the turn along an existing edge and tells the client. */
export interface LaneInput {
  userId: UserId;
  conversationId: ConversationId;
  turnId: TurnId;
  /** Effective time zone (UTC when the request's was not a valid IANA zone). */
  tz: IanaTz;
  analysis: TurnAnalysis;
  now: Ms;
  budget: TurnBudget;
  emit: EventSink;
  progress(state: TurnState, text: string): void;
}

export interface LaneDeps {
  memory: MemoryRetriever;
  resolver: TemporalResolver;
  baselines: BaselineSource;
  research: ResearchService;
  planner: ResearchPlanner;
  normalize(text: string): string;
}

export type ClarifyReason =
  | 'ambiguous_day'
  | 'ambiguous_conversation'
  | 'unresolved_date'
  | 'no_date'
  | 'ambiguous_entity'
  | 'ambiguous_shortlist'
  | 'missing_referent'
  | 'nothing_to_research'
  | 'analysis_requested';

export type ReplyReason = 'no_record' | 'no_prior_claims';

export type RecallTexts = Map<MessageId, { text: string; localTime: string }>;

/**
 * What a lane handler returns, a discriminated union the orchestrator switches over exhaustively.
 *
 *  - `synthesize`: the inputs of AnswerPipeline. Research and audit handlers have advanced the turn to
 *    RESOLVING_BELIEFS; chat and recall leave it in RESOLVING_CONTEXT.
 *  - `reply`: a fixed, honest answer written in code (no model call): there is no record to talk about.
 *  - `clarify`: a typed question with options. The turn is still in RESOLVING_CONTEXT.
 */
export type LaneOutcome =
  | {
      kind: 'synthesize';
      lane: Exclude<Lane, 'clarify'>;
      ctx: ResolvedContext;
      findings: FindingSet | null;
      recall: RecallTexts;
      /**
       * Sentences written in code that open the answer, before anything the answer model writes: what the user
       * asked on the day they pointed at, and, when nothing earlier can be compared against, that no change
       * since then can be established. Never model output.
       */
      lead?: string[];
    }
  | { kind: 'reply'; lane: Lane; ctx: ResolvedContext; reason: ReplyReason; sentences: string[] }
  | {
      kind: 'clarify';
      lane: 'clarify';
      ctx: ResolvedContext;
      reason: ClarifyReason;
      question: string;
      options: Array<{ label: string; ref: string }>;
    };

export type LaneHandler = (input: LaneInput, deps: LaneDeps) => Promise<LaneOutcome> | LaneOutcome;
