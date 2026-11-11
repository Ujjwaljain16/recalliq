import type { ZodType } from 'zod';

export type LlmRole = 'analysis' | 'extraction' | 'synthesis' | 'judge';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredRequest<T> {
  role: LlmRole;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  schema: ZodType<T>;
  schemaName: string;
  maxTokens: number;
  /** From TurnBudget. */
  signal: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
}

export interface StreamRequest {
  role: 'synthesis';
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  signal: AbortSignal;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: LlmUsage; model: string; ttftMs: number; latencyMs: number };

export type LlmErrorCode =
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'refused'
  | 'invalid_output'
  | 'bad_request';

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmPort {
  structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>>;
  /** Throws LlmError. */
  stream(r: StreamRequest): AsyncIterable<StreamEvent>;
}
