import { ZodError } from 'zod';
import {
  IdempotencyConflictError,
  InvalidAckError,
  NotFoundError,
  TurnInProgressError,
  TurnNotFinishedError,
} from '../db/errors.js';
import { isDatabaseBusy, TurnStillRunningError } from '../orchestration/errors.js';
import { HttpError } from './http.js';

/**
 * Maps a failure from the repositories or the orchestrator to an HTTP error. Anything not listed is a defect:
 * it becomes a generic 500 and the caller logs the real error. Messages never carry stored text or secrets.
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof NotFoundError) {
    // Missing and foreign rows are the same answer (a 404, never a 403).
    return new HttpError(404, 'not_found', 'Not found');
  }
  if (error instanceof TurnStillRunningError) {
    return new HttpError(409, 'turn_in_progress', 'That request is still running', {
      turnId: error.turnId,
    });
  }
  if (error instanceof TurnInProgressError) {
    return new HttpError(
      409,
      'turn_in_progress',
      'A turn is already running in this conversation',
      {
        turnId: error.existingTurnId,
      },
    );
  }
  if (error instanceof IdempotencyConflictError) {
    return new HttpError(
      409,
      'idempotency_conflict',
      'That idempotency key was already used for a different request',
      { turnId: error.existingTurnId },
    );
  }
  if (error instanceof InvalidAckError) {
    return new HttpError(400, 'invalid_ack', error.message, { reason: error.reason });
  }
  if (error instanceof TurnNotFinishedError) {
    return new HttpError(409, 'turn_not_finished', 'The answer for this turn is not stored yet', {
      status: error.status,
    });
  }
  if (error instanceof ZodError) {
    return new HttpError(400, 'invalid_request', 'The request is not valid');
  }
  if (isDatabaseBusy(error)) {
    return new HttpError(503, 'database_busy', 'The database is busy, try again');
  }
  return new HttpError(500, 'internal_error', 'Something went wrong');
}
