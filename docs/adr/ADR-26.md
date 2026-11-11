# ADR-26: Immutability enforced by database triggers

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (M1 and M2 approved)
- **Recorded:** 2026-11-11
- **Related:** [ADR-06](ADR-06.md), [ADR-27](ADR-27.md), [ADR-32](ADR-32.md)

## Context

The product's correctness depends on history not being rewritten. Application code is not a sufficient guarantee.

## Options considered

- Repository discipline only.
- Triggers in the database plus repositories that offer no update path.

## Decision

Triggers abort UPDATE on the append-only tables; `DELETE` stays possible for privacy deletion and rebuilds. The message repository has no update, delete or replace method.

## Consequences and trade-offs

- A caller holding the connection can still delete and re-insert a row; the triggers protect the application's own write paths.
- Derived tables (beliefs, belief history) are rebuilt by delete and replay, not by update.

## Evidence and implementation references

- Migrations [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql), [src/db/migrations/004_turn_lifecycle.sql](../../src/db/migrations/004_turn_lifecycle.sql) (finished turns are final), [src/db/migrations/005_delivery_acknowledgement.sql](../../src/db/migrations/005_delivery_acknowledgement.sql).
- Tests T-DB-03, T-DB-04, T-DB-05, T-TRN-02 ([tests/integration/db/invariants.test.ts](../../tests/integration/db/invariants.test.ts), [tests/integration/db/turn-lifecycle.test.ts](../../tests/integration/db/turn-lifecycle.test.ts)). Hand-run mutation checks are summarised in [docs/testing.md](../testing.md); they are a spot check, not a proof of completeness.

## Revisit when

- An update path is genuinely needed for a table (record why, and add a new trigger rule rather than removing the guard).
