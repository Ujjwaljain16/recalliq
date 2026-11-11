import type { NormalizedValue } from './evidence.js';
import type { PersistedSentence } from './answer.js';
import type { AckRequest } from './delivery.js';
import type { FindingSet } from './findings.js';
import type {
  AssertionId,
  ConversationId,
  EvidenceId,
  FindingId,
  Ms,
  TurnId,
  UserId,
  MessageId,
} from './ids.js';
import type { ResolvedContext } from './memory.js';
import type { SseEvent } from './sse.js';
import type {
  TerminalTurnStatus,
  TurnMetrics,
  TurnRequest,
  TurnState,
  TurnStatus,
} from './turn.js';
import type { EntityMention, TurnAnalysis, UserFact } from './understanding.js';

/**
 * Contract of the turn repository. Implemented in the conversation-lifecycle milestone; the
 * privacy-deletion procedure it lists is already available as `deleteConversation` in src/db.
 */
export interface TurnRepository {
  begin(
    req: TurnRequest,
    now: Ms,
    deadline: Ms,
  ): { turnId: TurnId; userMessageId: MessageId } | { existing: TurnId; status: TurnStatus };
  setState(u: UserId, t: TurnId, s: TurnState): void;
  /** One transaction. */
  complete(u: UserId, t: TurnId, c: TurnCompletion): void;
  /** Idempotent, monotonic. */
  ack(
    u: UserId,
    t: TurnId,
    req: AckRequest,
    now: Ms,
  ): { renderedThrough: number; newlyPresented: number };
  recoverRunning(now: Ms): number;
  deleteConversation(u: UserId, c: ConversationId): void;
}

export interface TurnCompletion {
  status: TerminalTurnStatus;
  assistant: {
    rendered: string;
    template: string;
    sentences: PersistedSentence[];
    streamedThrough: number;
    messageStatus: 'complete' | 'interrupted';
  } | null;
  findings: FindingSet | null;
  assertions: Array<{
    findingId: FindingId;
    sentenceIndex: number;
    placeholder: string;
    beliefKey: string | null;
    renderedText: string;
    value: NormalizedValue | null;
    evidenceIds: EvidenceId[];
  }>;
  baselineEvents: Array<{
    assertionId: AssertionId;
    status:
      | 'reaffirmed'
      | 'superseded_world_changed'
      | 'retracted_was_wrong'
      | 'contested'
      | 'unverifiable_now'
      | 'differs_timing_unknown';
    reason: string;
    evidenceIds: EvidenceId[];
  }>;
  touchedBeliefKeys: string[];
  enrichment: { tags: string[]; entities: EntityMention[]; decisions: UserFact[] };
  analysis: TurnAnalysis | null;
  context: ResolvedContext | null;
  events: SseEvent[];
  metrics: TurnMetrics;
  errorCode?: string;
}
