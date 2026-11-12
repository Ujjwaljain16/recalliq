# ADR-21: Typed canonical belief key

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-13](ADR-13.md), [ADR-37](ADR-37.md), [ADR-22](ADR-22.md)

## Context

Promotional, conditional, planned and list prices must never overwrite one another.

## Options considered

- A free-form string.
- A typed key with a canonical encoding.

## Decision

Typed. Historical and negated statements get no price key.

## Consequences and trade-offs

- More keys; "comparable but not equal" listings need a rule.
- Locale is a dimension of the key (decided in ADR-37, implemented).

## Evidence and implementation references

- Types: [src/shared/belief.ts](../../src/shared/belief.ts). Encode, decode, normalisation and comparison (`encodePriceKey`, `decodePriceKey`, `comparableKeys`) are in [src/belief/belief-key.ts](../../src/belief/belief-key.ts); the locale dimension is in [src/belief/locale.ts](../../src/belief/locale.ts) (ADR-37). Tested by [tests/unit/belief/belief-key.test.ts](../../tests/unit/belief/belief-key.test.ts).

## Revisit when

- Real pages produce many near-duplicate keys.
