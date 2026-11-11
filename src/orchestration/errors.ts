import {
  IdempotencyConflictError,
  InvalidAckError,
  InvalidCompletionError,
  InvalidTransitionError,
  NotFoundError,
  TurnInProgressError,
  TurnNotFinishedError,
} from '../db/errors.js';
import type { TurnId } from '../shared/ids.js';
import { LlmError } from '../shared/llm.js';
import { SearchError } from '../shared/search.js';
import { DeadlineExceededError } from './turn-budget.js';

/**
 * What a failure means for the turn. The classes decide the policy, nothing else does:
 *
 *   deadline            the turn deadline passed: degrade, never retry
 *   cancelled           shutdown or an abort that is not the deadline: stop, never retry
 *   external_retryable  a provider failure that may succeed again (rate limit, outage, timeout)
 *   external_permanent  a provider failure retrying cannot fix (quota, refusal, bad request, bad output)
 *   persistence         our own database failed (or refused a write): propagates, never an answer
 *   programmer          a bug or a broken contract: propagates, never an answer
 */
export type ErrorClass =
  | 'deadline'
  | 'cancelled'
  | 'external_retryable'
  | 'external_permanent'
  | 'persistence'
  | 'programmer';

const PERSISTENCE_ERRORS = [
  IdempotencyConflictError,
  InvalidAckError,
  InvalidCompletionError,
  InvalidTransitionError,
  NotFoundError,
  TurnInProgressError,
  TurnNotFinishedError,
];

function sqliteCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
  }
  return null;
}

/** SQLITE_BUSY / SQLITE_LOCKED: another writer holds the database. The one persistence failure worth one retry. */
export function isDatabaseBusy(error: unknown): boolean {
  const code = sqliteCode(error);
  return code !== null && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function classifyError(error: unknown, signal?: AbortSignal): ErrorClass {
  if (error instanceof DeadlineExceededError) return 'deadline';
  if (signal?.aborted && signal.reason instanceof DeadlineExceededError) {
    if (isAbort(error) || isCancelledCode(error)) return 'deadline';
  }
  if (isAbort(error) || isCancelledCode(error)) return 'cancelled';
  if (error instanceof LlmError) {
    return error.code === 'rate_limited' || error.code === 'unavailable' || error.code === 'timeout'
      ? 'external_retryable'
      : 'external_permanent';
  }
  if (error instanceof SearchError) {
    return error.code === 'rate_limited' || error.code === 'unavailable' || error.code === 'timeout'
      ? 'external_retryable'
      : 'external_permanent';
  }
  if (sqliteCode(error) !== null) return 'persistence';
  if (PERSISTENCE_ERRORS.some((c) => error instanceof c)) return 'persistence';
  return 'programmer';
}

function isCancelledCode(error: unknown): boolean {
  return (error instanceof LlmError || error instanceof SearchError) && error.code === 'cancelled';
}

/** An error is "our own system" when retrying or answering around it would hide a defect. */
export function propagates(cls: ErrorClass): boolean {
  return cls === 'persistence' || cls === 'programmer';
}

/** The stable error code stored on a failed turn. */
export function errorCodeFor(error: unknown): string {
  const code = sqliteCode(error);
  if (code !== null) return `persistence:${code.toLowerCase()}`;
  if (error instanceof Error) return `persistence:${error.name}`;
  return 'persistence:unknown';
}

/** A component broke its contract (for example a finding set that contradicts itself). A bug, never a result. */
export class ContractViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolationError';
  }
}

/** begin() found the same idempotency key on a turn that is still running: the caller answers 409 (architecture 16). */
export class TurnStillRunningError extends Error {
  constructor(public readonly turnId: TurnId) {
    super(`turn ${turnId} is still running`);
    this.name = 'TurnStillRunningError';
  }
}

export interface RetryOptions {
  /** Total attempts, including the first. Always finite. */
  maxAttempts: number;
  shouldRetry: (error: unknown) => boolean;
}

/**
 * Bounded retry for the synchronous SQLite calls: at most maxAttempts calls, never an unbounded loop. The
 * last error is rethrown unchanged. The coordinator uses it only for a busy database (retry once, then give
 * up); it is not used for provider calls, whose retries belong to the search and LLM layers and are gated by
 * TurnBudget.admit.
 */
export function withBoundedRetry<T>(op: () => T, o: RetryOptions): T {
  const attempts = Math.max(1, Math.floor(o.maxAttempts));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return op();
    } catch (error) {
      if (attempt >= attempts || !o.shouldRetry(error)) throw error;
    }
  }
}
