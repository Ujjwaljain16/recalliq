# ADR-19: Evaluation data classes: recorded, synthetic, live

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-18](ADR-18.md), [ADR-28](ADR-28.md)

## Context

Seeded data must not contaminate real history, and synthetic data must never read as real-world accuracy.

## Options considered

- Mixed fixtures.
- Three labelled classes.

## Decision

Three classes, each row tagged by `origin`, demo data in a separate database.

## Consequences and trade-offs

- Recorded scenarios must be captured on real dates; nothing may be backdated.

## Evidence and implementation references

- `origin` columns and the real-database isolation triggers exist (ADR-28). Fixtures, the recorder and the evaluation runner do not.

## Revisit when

- Not planned.
