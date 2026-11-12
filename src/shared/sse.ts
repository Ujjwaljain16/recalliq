import type { PersistedSentence, SentenceIssue, SentenceKind, SentenceStatus } from './answer.js';
import type { AuthorityTier } from './evidence.js';
import type { Finding } from './findings.js';
import type { DecisionId, MessageId, Ms, SnapshotId, TurnId } from './ids.js';
import type { TerminalTurnStatus, TurnMetrics, TurnState } from './turn.js';
import type { Intent, Lane } from './understanding.js';

export type SseEvent =
  | { event: 'turn.started'; data: { turnId: TurnId; userMessageId: MessageId } }
  | { event: 'progress'; data: { stage: TurnState; text: string } }
  | {
      event: 'context';
      data: {
        lane: Lane;
        resolvedDates: Array<{ text: string; localDates: string[] }>;
        memoryHits: Array<{ messageId: MessageId; localTime: string; excerpt: string }>;
        decisionIds: DecisionId[];
      };
    }
  | {
      event: 'clarification';
      data: { question: string; options: Array<{ label: string; ref: string }> };
    }
  | { event: 'plan'; data: { entities: string[]; intents: Intent[]; plannedSearches: number } }
  | {
      event: 'source';
      data: {
        sourceId: SnapshotId;
        url: string;
        domain: string;
        title: string | null;
        tier: AuthorityTier;
        freshFetch: boolean;
        observedAt: Ms;
        providerPublishedAt: Ms | null;
      };
    }
  | { event: 'finding'; data: Finding }
  | { event: 'answer.delta'; data: { sentenceIndex: number; text: string } }
  | {
      event: 'answer.sentence_end';
      data: {
        index: number;
        status: SentenceStatus | 'pending_judge';
        issues: SentenceIssue[];
        /** Optional and additive: what the sentence rests on (see SentenceKind). */
        kind?: SentenceKind;
      };
    }
  | {
      event: 'verification';
      data: { index: number; status: SentenceStatus; issues: SentenceIssue[] };
    }
  | {
      event: 'answer.completed';
      data: {
        assistantMessageId: MessageId;
        sentences: Array<Pick<PersistedSentence, 'index' | 'status' | 'issues' | 'kind'>>;
        citations: SnapshotId[];
      };
    }
  | {
      event: 'warning';
      data: {
        code:
          | 'search_partial'
          | 'deadline_compacted'
          | 'analysis_degraded'
          | 'judge_skipped'
          | 'entity_cap'
          | 'sentence_withheld';
        text: string;
      };
    }
  | { event: 'error'; data: { code: string; text: string; recoverable: boolean } }
  | {
      event: 'turn.completed';
      data: {
        status: TerminalTurnStatus;
        metrics: Pick<TurnMetrics, 'ttfpMs' | 'ttftMs' | 'ttcMs'>;
      };
    };

export type EventSink = (e: SseEvent) => void;
