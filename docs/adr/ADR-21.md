# ADR-21: Typed canonical belief key

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (3.1)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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
- The key has no locale dimension: see ADR-37 and Q-001.

## Evidence and implementation references

- Types: [src/shared/belief.ts](../../src/shared/belief.ts). The encode, decode and comparison functions are **not implemented**.

## Revisit when

- Real pages produce many near-duplicate keys.
