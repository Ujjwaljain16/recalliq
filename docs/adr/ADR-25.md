# ADR-25: Connection-level PRAGMAs, outside migration transactions

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approved (Q-003), 2026-11-11
- **Recorded:** 2026-11-11
- **Related:** [ADR-04](ADR-04.md), [Q-003](../questions.md)

## Context

The contract's schema begins with `PRAGMA journal_mode = WAL`. On a file database SQLite refuses it inside a transaction ("cannot change into wal mode from within a transaction", reproduced on 2026-11-11), and each migration runs in one.

## Options considered

- Keep the PRAGMAs in the migration SQL and run it without a transaction (loses atomic migrations).
- Apply them when the connection opens.

## Decision

`openDatabase()` sets `foreign_keys = ON`, `busy_timeout = 5000` and `journal_mode = WAL` (failing loudly if WAL cannot be enabled on a file). `001_init.sql` differs from the contract only by the missing PRAGMA lines.

## Consequences and trade-offs

- The contract text still shows the PRAGMAs; a proposed edit is recorded but not made (contracts are normative and untouched).
- A WAL requirement means the data directory must be on a local filesystem.

## Evidence and implementation references

- [src/db/connection.ts](../../src/db/connection.ts), [src/db/migrate.ts](../../src/db/migrate.ts).
- [tests/integration/db/migrations.test.ts](../../tests/integration/db/migrations.test.ts): connection settings, "no shipped migration contains a PRAGMA statement", "each migration runs in its own transaction", rollback of a failing migration. [tests/integration/db/contract-parity.test.ts](../../tests/integration/db/contract-parity.test.ts) compares 001 with the contract apart from comments, whitespace and PRAGMAs.

## Revisit when

- The contract is next edited (apply the recorded edit), or a target platform cannot enable WAL.
