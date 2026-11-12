# ADR-06: Four-layer claim model with derived belief

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner confirmed, 2026-11-11
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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
- L1 and L2: snapshots are stored by [src/sources/snapshot-store.ts](../../src/sources/snapshot-store.ts) and evidence statements by [src/evidence/extractor.ts](../../src/evidence/extractor.ts) and [src/evidence/repository.ts](../../src/evidence/repository.ts). L3: [src/db/repositories/turn-completion.ts](../../src/db/repositories/turn-completion.ts), tested by [tests/integration/db/turn-completion.test.ts](../../tests/integration/db/turn-completion.test.ts). L4: the derived belief is computed by [src/belief/resolver.ts](../../src/belief/resolver.ts) and stored by [src/belief/repository.ts](../../src/belief/repository.ts), tested by [tests/integration/belief/repository.test.ts](../../tests/integration/belief/repository.test.ts).

## Revisit when

- If rebuilding beliefs from evidence proves too slow or too complex, materialise more state, keeping evidence as the source of truth.
