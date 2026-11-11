# ADR-28: Demo and live data isolation at the database level (not complete)

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approved (Q-002), 2026-11-11
- **Recorded:** 2026-11-11
- **Related:** [ADR-19](ADR-19.md), [ADR-27](ADR-27.md), [Q-002](../questions.md)

## Context

Seeded or recorded data must never mix with real user history. Separating files is not enough, and the first triggers covered only users, conversations and snapshots, on insert.

## Options considered

- Separate files only.
- A `db_mode` stamp read by triggers, plus a startup check.

## Decision

`db_mode` is stamped at creation and checked at startup. Migration 002 rejects non-live messages, entities and decisions on insert, rejects relabelling of users, conversations, entities and decisions, and makes `db_mode` itself immutable (without that, deleting the row switches every trigger off).

## Consequences and trade-offs

- Isolation is still **not complete**: `belief_history`, `search_cache` and a few plain columns have no origin and no guarded parent. Raw SQL by a privileged caller can do anything.

## Evidence and implementation references

- [src/db/migrations/002_demo_isolation.sql](../../src/db/migrations/002_demo_isolation.sql); T-DB-07 and T-DB-10 in [tests/integration/db/invariants.test.ts](../../tests/integration/db/invariants.test.ts) and [tests/integration/db/migrations.test.ts](../../tests/integration/db/migrations.test.ts).
- Rationale and the gaps that were demonstrated: [docs/proposals/q-002-demo-isolation.md](../proposals/q-002-demo-isolation.md).

## Revisit when

- Seeding and recording are built (new origin-bearing tables), or the residual unguarded columns are used.
