import type { VerificationCheck } from './evidence.js';
import type { ConversationId, MessageId, TurnId, UserId, IanaTz } from './ids.js';
import type { LlmErrorCode, LlmRole, LlmUsage } from './llm.js';
import type { SentenceStatus } from './answer.js';
import type { EventSink } from './sse.js';

export type TurnState =
  | 'RECEIVED'
  | 'ANALYZING'
  | 'RESOLVING_CONTEXT'
  | 'CLARIFYING'
  | 'PLANNING'
  | 'SEARCHING'
  | 'EXTRACTING'
  | 'VERIFYING'
  | 'RESOLVING_BELIEFS'
  | 'SYNTHESIZING'
  | 'POST_VERIFYING'
  | 'PERSISTING'
  | 'COMPLETED'
  | 'FAILED';

export type TurnStatus = 'running' | 'complete' | 'partial' | 'clarify' | 'interrupted' | 'failed';
export type TerminalTurnStatus = Exclude<TurnStatus, 'running'>;

export interface TurnRequest {
  userId: UserId;
  conversationId: ConversationId;
  text: string;
  tz: IanaTz;
  idempotencyKey: string;
  retryOfTurnId?: TurnId;
}

export interface TurnMetrics {
  ttfpMs: number | null;
  ttftMs: number | null;
  ttcMs: number;
  deadlineHit: boolean;
  llmCalls: Array<{
    role: LlmRole;
    model: string;
    usage: LlmUsage;
    latencyMs: number;
    ok: boolean;
    errorCode?: LlmErrorCode;
  }>;
  searches: {
    total: number;
    ok: number;
    failed: number;
    cached: number;
    notAdmitted: number;
    costUsd: number;
  };
  extraction: { batches: number; retries: number; splits: number };
  verification: {
    pass: number;
    weak: number;
    fail: number;
    byCheck: Partial<Record<VerificationCheck, { weak: number; fail: number }>>;
  };
  sentences: Record<SentenceStatus, number>;
  judgeCalls: number;
  statesVisited: TurnState[];
}

export interface TurnResult {
  turnId: TurnId;
  status: TerminalTurnStatus;
  assistantMessageId: MessageId | null;
  metrics: TurnMetrics;
}

/** The budget is created inside `run`. */
export interface TurnOrchestrator {
  run(req: TurnRequest, emit: EventSink): Promise<TurnResult>;
}
