# ADR-33: Recovery: running turns become interrupted at startup

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (M2 approved)
- **Recorded:** 2026-11-11
- **Related:** [ADR-34](ADR-34.md), [ADR-39](ADR-39.md), [Q-016](../questions.md)

## Context

A crash or restart leaves turns `running` forever and blocks the conversation.

## Options considered

- Resume the turn.
- Mark it interrupted and let the client retry.

## Decision

Interrupt. Recovery creates no message, acknowledgement, presented claim or baseline; the client retries with `retryOfTurnId`.

## Consequences and trade-offs

- It interrupts every running turn, unscoped, so it assumes one process per database file (ADR-34).
- It is now the fallback only: an unexpected error finalises the turn as failed (ADR-39), and recovery handles what that could not finalise, such as a crash or a database that refused every write.

## Evidence and implementation references

- `recoverRunning` in [src/db/repositories/turns.ts](../../src/db/repositories/turns.ts); T-TRN-05 in [tests/integration/db/turn-lifecycle.test.ts](../../tests/integration/db/turn-lifecycle.test.ts), including a file database reopened by a new connection.

## Revisit when

- ADR-34 is decided.
