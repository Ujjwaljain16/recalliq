# ADR-31: Streamed extent and rendered extent are separate and ordered

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (approved after review)
- **Recorded:** 2026-11-11
- **Related:** [ADR-23](ADR-23.md), [ADR-16](ADR-16.md), [ADR-32](ADR-32.md)

## Context

What the server sent and what the browser showed are different facts, and conflating them lets a never-seen claim become history.

## Options considered

- One delivered flag.
- Two extents, with the database refusing an impossible pair.

## Decision

`streamed_through` is fixed when the answer is stored; `rendered_through` only moves forward and never past it. `deliveryState` derives presented, streamed-unacknowledged and not-streamed, and throws on an impossible pair.

## Consequences and trade-offs

- `complete: true` has no specified meaning; it is interpreted as "equals the streamed extent" (Q-013).

## Evidence and implementation references

- [src/shared/delivery.ts](../../src/shared/delivery.ts), [src/db/migrations/005_delivery_acknowledgement.sql](../../src/db/migrations/005_delivery_acknowledgement.sql).
- [tests/unit/turn-state-machine.test.ts](../../tests/unit/turn-state-machine.test.ts) (`deliveryState`), T-DLV-02, 03 and 08 in [tests/integration/db/delivery.test.ts](../../tests/integration/db/delivery.test.ts), and the migration-005 tests there that issue raw SQL.

## Revisit when

- The meaning of `complete` is specified (Q-013).
