# ADR-13: Deterministic belief resolution

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- [architecture.md](../architecture.md) R3. Types: [src/shared/belief.ts](../../src/shared/belief.ts). Resolver: `RuleBeliefResolver` in [src/belief/resolver.ts](../../src/belief/resolver.ts) (authority tier, then freshness, then recency; `contested` inside the contest window), with the curated tier list in [src/evidence/authority.ts](../../src/evidence/authority.ts). Rebuilding from evidence and writing beliefs and belief history: [src/belief/repository.ts](../../src/belief/repository.ts), called by [src/research/service.ts](../../src/research/service.ts).
- Tested by [tests/unit/belief/resolver.test.ts](../../tests/unit/belief/resolver.test.ts), [tests/unit/belief/conflicting-values.test.ts](../../tests/unit/belief/conflicting-values.test.ts) and [tests/integration/belief/repository.test.ts](../../tests/integration/belief/repository.test.ts). The 30-day, 7-day and 2-day windows are unmeasured defaults.

## Revisit when

- Misclassification of sources in evaluation.
