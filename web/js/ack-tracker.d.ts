export interface AckBody {
  renderedThrough: number;
  complete: boolean;
}

export class AckTracker {
  sentenceStreamed(turnId: string, index: number): void;
  sentenceRendered(turnId: string, index: number): void;
  answerStored(turnId: string): void;
  restore(turnId: string, extents: { streamedThrough: number; renderedThrough: number }): void;
  renderedThrough(turnId: string): number;
  next(turnId: string): AckBody | null;
  acknowledged(turnId: string, body: AckBody, storedThrough?: number): void;
  pending(): string[];
}

export interface AckSchedulerOptions {
  tracker: AckTracker;
  send: (turnId: string, body: AckBody) => Promise<{ renderedThrough: number } | void>;
  delayMs?: number;
  maxAttempts?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface AckScheduler {
  notify(turnId: string): void;
  flush(turnId: string): Promise<void>;
  cancel(turnId: string): void;
  due(): Array<{ turnId: string; body: AckBody }>;
}

export function createAckScheduler(options: AckSchedulerOptions): AckScheduler;
