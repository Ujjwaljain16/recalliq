# ADR-29: Turn state machine enforced in TypeScript and in the database

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (M2 approved)
- **Recorded:** 2026-11-11
- **Related:** [ADR-01](ADR-01.md), [ADR-30](ADR-30.md), [ADR-39](ADR-39.md)

## Context

Illegal state changes must be impossible even if the orchestrator has a bug, and error messages should still be good.

## Options considered

- Application check only.
- Database trigger only.
- Both, with a test that keeps them identical.

## Decision

Both. `setState` validates the edge and updates only if the state still matches; migration 004 refuses anything else. COMPLETED is set by `complete()` and means persistence succeeded (the status carries the outcome); FAILED is set by `fail()` and means persistence itself failed.

## Consequences and trade-offs

- The table exists twice, held together by a test.
- There is no failure edge from most states: see ADR-39 and Q-011.

## Evidence and implementation references

- [src/shared/turn-state-machine.ts](../../src/shared/turn-state-machine.ts), [src/db/migrations/004_turn_lifecycle.sql](../../src/db/migrations/004_turn_lifecycle.sql), [src/db/repositories/turns.ts](../../src/db/repositories/turns.ts); transition table in [docs/turn-lifecycle.md](../turn-lifecycle.md).
- T-TRN-01: all 182 ordered state pairs are probed against the database and compared with the TypeScript table ([tests/integration/db/turn-lifecycle.test.ts](../../tests/integration/db/turn-lifecycle.test.ts)); unit checks in [tests/unit/turn-state-machine.test.ts](../../tests/unit/turn-state-machine.test.ts).

## Revisit when

- The failure-transition decision (ADR-39) changes the edge list.
