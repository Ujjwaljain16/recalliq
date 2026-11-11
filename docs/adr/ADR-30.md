# ADR-30: At most one running turn per conversation

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approved (Q-006), 2026-11-11
- **Recorded:** 2026-11-11
- **Related:** [ADR-29](ADR-29.md), [Q-006](../questions.md)

## Context

Concurrent requests must not run two turns over one conversation, whether from one process or several connections.

## Options considered

- An in-memory lock.
- The contract's partial unique index plus an explicit check in an immediate transaction.

## Decision

The second. The same idempotency key returns the existing turn; the same key with a different request is an `IdempotencyConflictError`.

## Consequences and trade-offs

- Reusing a key for a different request fails instead of silently answering the wrong thing (behaviour beyond the contract, recorded as Q-017).

## Evidence and implementation references

- [src/db/repositories/turns.ts](../../src/db/repositories/turns.ts); the index is in [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql).
- Six worker threads, each with its own connection, race on one file: exactly one winner, five `TurnInProgressError`, nothing left behind ([tests/integration/db/concurrency.test.ts](../../tests/integration/db/concurrency.test.ts); repeated eight times without a failure, which shows no flakiness in those runs, not that there is none).
- Testing found that SQLite reports a partial-unique-index violation by column (`turns.conversation_id`), not index name, so the first backstop could never match; fixed and pinned by a test against the real error.

## Revisit when

- Several concurrent turns per conversation are ever wanted.
