import type { FindingSet } from './findings.js';
import type { FindingId, IanaTz, MessageId, Ms, SnapshotId, TurnId } from './ids.js';
import type { TurnBudget } from './infrastructure.js';
import type { ResolvedContext } from './memory.js';
import type { EventSink } from './sse.js';

export type PlaceholderRef =
  | { kind: 'finding'; ord: number; variant: 'current' | 'baseline' | 'verdict' }
  | { kind: 'finding_derived'; ord: number; index: number }
  | { kind: 'message'; messageId: MessageId }
  | { kind: 'source'; snapshotId: SnapshotId };

/** `pending` / `pending_judge` exist only on the client and in SSE; they are never persisted. */
export type SentenceStatus = 'verified' | 'no_claims' | 'unverified' | 'unchecked' | 'truncated';

export type SentenceIssue =
  | 'malformed_placeholder'
  | 'unknown_ref'
  | 'inapplicable_variant'
  | 'render_mismatch'
  | 'free_number'
  | 'free_currency'
  | 'free_percent'
  | 'free_date'
  | 'unsupported_verdict_word'
  | 'unsupported_global_negative'
  | 'duplicate_text'
  | 'judge_unsupported'
  | 'judge_partial'
  | 'judge_unavailable'
  /** A sourced sentence states a number, amount, percentage, version or date its cited sources do not contain. */
  | 'ungrounded_number'
  /** A sourced sentence names something (a capitalised name) its cited sources, the user and the entities do not. */
  | 'ungrounded_name'
  /** A sourced sentence cites a source that was not shown with an excerpt in this turn (fail closed). */
  | 'ungrounded_source'
  /** A sourced sentence contains a link or an email address. */
  | 'sourced_link'
  | 'off_topic'
  /** A sourced sentence quotes more than the per-sentence or per-answer cap. */
  | 'sourced_too_long'
  /** A verified or sourced sentence with fewer than three words once citations and attribution are removed. */
  | 'empty_sentence';

/**
 * What a released sentence rests on. `verified`: it renders at least one finding placeholder, so its facts were
 * verified by code (T0 to T3) and only it may become an assertion. `sourced`: it cites sources of this turn and
 * passed the grounding check against one cited excerpt; it reports what a page says, never a verified value or a
 * change. `unconfirmed`: it renders findings only to say there is no verified value or that the check could not
 * run, so it carries no verified fact. Absent on sentences that rest on neither (conversation, quoted messages) and on older stored sentences.
 */
export type SentenceKind = 'verified' | 'sourced' | 'unconfirmed';

export interface PersistedSentence {
  index: number;
  text: string;
  template: string;
  status: SentenceStatus;
  issues: SentenceIssue[];
  kind?: SentenceKind;
  placeholders: Array<{
    token: string;
    findingId?: FindingId;
    messageId?: MessageId;
    snapshotId?: SnapshotId;
    rendered: string;
  }>;
}

/** What a pipeline call returns: the released sentences and how far the client was sent them. */
export interface AnswerResult {
  sentences: PersistedSentence[];
  streamedThrough: number;
  interrupted: boolean;
  template: string;
  rendered: string;
}

/**
 * The sourced answer that streams while extraction and verification still run. It rests only on the excerpts of
 * the sources the searches returned.
 */
export interface QuickAnswerInput {
  turnId: TurnId;
  createdAt: Ms;
  /** The turn's sources with their content, in the order their `source` events were sent. */
  sources: FindingSet['sources'];
  ctx: ResolvedContext;
  /** The names the question is about; a quick sentence must name one of them when there are any. */
  entities?: readonly string[];
  userMessage: string;
  tz: IanaTz;
  /** Aborted by the caller when the verified section is ready: the stream stops and the open sentence is dropped. */
  cut: AbortSignal;
}

export interface AnswerPipeline {
  /**
   * Optional. Writes 2 to 4 short sourced sentences from the excerpts alone, each passing the sourced-sentence
   * validation, opened by one sentence written in code. Never throws and never emits `error`: a failure,
   * a cut or a timeout leaves what was released and nothing else. Sentences are numbered from 0.
   */
  quick?(input: QuickAnswerInput, budget: TurnBudget, emit: EventSink): Promise<AnswerResult>;
  run(
    input: {
      findings: FindingSet | null;
      recall: Map<MessageId, { text: string; localTime: string }>;
      ctx: ResolvedContext;
      userMessage: string;
      window: Array<{ role: 'user' | 'assistant'; content: string }>;
      /** The user's time zone: recalled times and dates are rendered in it. */
      tz: IanaTz;
      /**
       * The sentences already released before this call (the quick section), in order. The model is shown them
       * and told to confirm, add or correct, never to repeat or silently contradict them.
       */
      earlier?: readonly string[];
      /** The names the question is about (the quick section's sentences must name one of them). */
      entities?: readonly string[];
    },
    budget: TurnBudget,
    emit: EventSink,
  ): Promise<AnswerResult>;
}
