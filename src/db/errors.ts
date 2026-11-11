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

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}
