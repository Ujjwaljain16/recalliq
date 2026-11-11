# ADR-11: Evidence verification tiers T0 to T3

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3, 3.1)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-12](ADR-12.md)

## Context

Mapping citation IDs prevents invented URLs but not "right page, wrong tier or competitor".

## Options considered

- ID mapping only.
- An LLM judge for everything.
- Deterministic tiers first, a judge only where needed.

## Decision

The tiers. A page title, URL or domain never establishes which entity a price belongs to; a bare `$` stays currency-unknown; missing seat language is never "flat".

## Consequences and trade-offs

- English-only heuristic cue lists; ambiguous cases become `weak` and never confirm a price or change.

## Evidence and implementation references

- [stage-3-architecture.md](../stage-3-architecture.md) R2 and [docs/stage-3.1-review.md](../stage-3.1-review.md). Nothing is implemented; the weak-rate on real pages is unknown (open item U15).

## Revisit when

- A false pass is found in evaluation.
