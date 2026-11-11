# ADR-09: Research planning: templates, bounded fan-out, one fallback round

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-08](ADR-08.md), [ADR-24](ADR-24.md)

## Context

A naive agent loop takes many sequential round trips; a single query misses official sources.

## Options considered

- Model-chosen fan-out.
- Fixed templates with a budget and one fallback round.

## Decision

Fixed templates, a per-turn search budget, per-entity limits, one fallback round, and cache bypass for fresh and recent requests.

## Consequences and trade-offs

- Weaker on unusual open questions.

## Evidence and implementation references

- Design in [architecture.md](../architecture.md) §9. The numeric limits (concurrency 5, 16 searches, 4 per entity) are **unmeasured defaults**. Nothing is implemented.

## Revisit when

- Evaluation shows templates miss official pages, or the budget is too tight or too loose.
