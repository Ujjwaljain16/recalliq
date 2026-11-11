import type { FindingSet } from './findings.js';
import type { FindingId, IanaTz, MessageId, SnapshotId } from './ids.js';
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
  /** A sourced sentence quotes more than the per-sentence or per-answer cap. */
  | 'sourced_too_long';

/**
 * What a released sentence rests on. `verified`: it renders at least one finding placeholder, so its facts were
 * verified by code (T0 to T3) and only it may become an assertion. `sourced`: it cites sources of this turn and
 * passed the grounding check against one cited excerpt; it reports what a page says, never a verified value or a
 * change. Absent on sentences that rest on neither (conversation, quoted messages) and on older stored sentences.
 */
export type SentenceKind = 'verified' | 'sourced';

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

export interface AnswerPipeline {
  run(
    input: {
      findings: FindingSet | null;
      recall: Map<MessageId, { text: string; localTime: string }>;
      ctx: ResolvedContext;
      userMessage: string;
      window: Array<{ role: 'user' | 'assistant'; content: string }>;
      /** The user's time zone: recalled times and dates are rendered in it. */
      tz: IanaTz;
    },
    budget: TurnBudget,
    emit: EventSink,
  ): Promise<{
    sentences: PersistedSentence[];
    streamedThrough: number;
    interrupted: boolean;
    template: string;
    rendered: string;
  }>;
}
