# ADR-13: Deterministic belief resolution

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3, 3.1)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-06](ADR-06.md), [ADR-21](ADR-21.md), [ADR-22](ADR-22.md)

## Context

"Latest retrieved wins" lets a stale or low-authority source overrule an official one.

## Options considered

- Latest wins.
- Authority, freshness and recency with explicit contested and stale states.

## Decision

The second, as a pure function over `pass` evidence using `displayedAt`, rebuildable from evidence.

## Consequences and trade-offs

- A curated tier list to maintain.

## Evidence and implementation references

- [stage-3-architecture.md](../stage-3-architecture.md) R3. Types: [src/shared/belief.ts](../../src/shared/belief.ts). The `beliefs` tables exist; the resolver does not (milestone 4).

## Revisit when

- Misclassification of sources in evaluation.
