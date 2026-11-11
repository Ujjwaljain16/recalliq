# ADR-06: Four-layer claim model with derived belief

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner confirmed, 2026-11-11
- **Recorded:** 2026-11-11
- **Related:** [ADR-13](ADR-13.md), [ADR-21](ADR-21.md), [ADR-22](ADR-22.md), [ADR-26](ADR-26.md), [ADR-32](ADR-32.md)

## Context

A claim can mean what a source said, what we extracted, what we told the user, or what we now believe. Conflating them hides whether an earlier answer was wrong or the world changed.

## Options considered

- One claims table.
- Four layers with an append-only history for assertions and a derived belief.

## Decision

Four layers. L1 and L2 are immutable, L3 is append-only apart from one write-once field, and L4 can be rebuilt from L2.

## Consequences and trade-offs

- More tables and joins.
- Every layer needs its own consistency rules (ADR-26, ADR-27).

## Evidence and implementation references

- Tables and constraints: [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql); ER diagram [docs/diagrams/er.mmd](../diagrams/er.mmd).
- L3 is implemented and tested end to end: [src/db/repositories/turn-completion.ts](../../src/db/repositories/turn-completion.ts), [tests/integration/db/turn-completion.test.ts](../../tests/integration/db/turn-completion.test.ts).
- L2 rows can be inserted (and are constrained) but no extractor exists. The `beliefs` tables exist; the resolver that fills them does not (milestone 4).

## Revisit when

- If rebuilding beliefs from evidence proves too slow or too complex, materialise more state, keeping evidence as the source of truth.
