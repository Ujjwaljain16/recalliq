/** A row the caller asked for does not exist or is not visible to this user (the two are never distinguished). */
export class NotFoundError extends Error {
  constructor(public readonly what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** The database file was created in a different APP_MODE than the one requested. */
export class DbModeMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Database was created in "${actual}" mode but the application is running in "${expected}" mode. ` +
        'Refusing to continue so that demo and real data cannot mix.',
    );
    this.name = 'DbModeMismatchError';
  }
}

/** Another turn is already running in this conversation. The API maps this to 409. */
export class TurnInProgressError extends Error {
  constructor(public readonly existingTurnId: string) {
    super(`A turn is already running in this conversation (${existingTurnId})`);
    this.name = 'TurnInProgressError';
  }
}

/** The idempotency key was reused with a different request. */
export class IdempotencyConflictError extends Error {
  constructor(public readonly existingTurnId: string) {
    super(`The idempotency key was already used for a different request (turn ${existingTurnId})`);
    this.name = 'IdempotencyConflictError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly reason: string,
  ) {
    super(`Invalid turn transition ${from} -> ${to}: ${reason}`);
    this.name = 'InvalidTransitionError';
  }
}

/** The turn has no assistant message yet, so there is nothing to acknowledge. */
export class TurnNotFinishedError extends Error {
  constructor(
    public readonly turnId: string,
    public readonly status: string,
  ) {
    super(`Turn ${turnId} is ${status} and has no stored answer to acknowledge yet`);
    this.name = 'TurnNotFinishedError';
  }
}

/** An acknowledgement that cannot be true, e.g. rendering beyond what was streamed. */
export class InvalidAckError extends Error {
  constructor(
    public readonly reason: 'beyond_streamed_extent' | 'complete_flag_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidAckError';
  }
}

/** A TurnCompletion that is inconsistent, or asks for something that is not supported yet. */
export class InvalidCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCompletionError';
  }
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}
