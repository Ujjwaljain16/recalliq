# ADR-29: Turn state machine enforced in TypeScript and in the database

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (approved after review); edge list extended by ADR-39, 2026-11-12
- **Recorded:** 2026-11-11
- **Related:** [ADR-01](ADR-01.md), [ADR-30](ADR-30.md), [ADR-39](ADR-39.md)

## Context

Illegal state changes must be impossible even if the orchestrator has a bug, and error messages should still be good.

## Options considered

- Application check only.
- Database trigger only.
- Both, with a test that keeps them identical.

## Decision

Both. `setState` validates the edge and updates only if the state still matches; the database trigger refuses anything else. Migration 004 installed the 19 edges of the architecture diagram; migration 010 replaced that trigger with the 26-edge table (the 19 plus a failure edge to PERSISTING from every non-final state that lacked one, ADR-39). COMPLETED is set by `complete()` and means persistence succeeded (the status carries the outcome); FAILED is set by `fail()` and means persistence itself failed.

## Consequences and trade-offs

- The table exists twice, held together by a test.
- Every non-final state has an edge to PERSISTING, so an unexpected error can always be finalised (ADR-39). The edge list changes only by a new migration that recreates the trigger.

## Evidence and implementation references

- [src/shared/turn-state-machine.ts](../../src/shared/turn-state-machine.ts), [src/db/migrations/004_turn_lifecycle.sql](../../src/db/migrations/004_turn_lifecycle.sql) and [src/db/migrations/010_turn_failure_edges.sql](../../src/db/migrations/010_turn_failure_edges.sql), [src/db/repositories/turns.ts](../../src/db/repositories/turns.ts); transition table in [docs/turn-lifecycle.md](../turn-lifecycle.md).
- T-TRN-01: all 182 ordered state pairs are probed against the database (26 accepted) and compared with the TypeScript table ([tests/integration/db/turn-lifecycle.test.ts](../../tests/integration/db/turn-lifecycle.test.ts)); unit checks in [tests/unit/turn-state-machine.test.ts](../../tests/unit/turn-state-machine.test.ts).

## Revisit when

- A further edge is proposed: it needs a new migration, an updated table and the pair-by-pair test.
