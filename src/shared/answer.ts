import type { FindingSet } from './findings.js';
import type { FindingId, MessageId, SnapshotId } from './ids.js';
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
  | 'judge_unsupported'
  | 'judge_partial'
  | 'judge_unavailable';

export interface PersistedSentence {
  index: number;
  text: string;
  template: string;
  status: SentenceStatus;
  issues: SentenceIssue[];
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
