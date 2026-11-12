# ADR-11: Evidence verification tiers T0 to T3

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- Verifier: [src/evidence/verifier.ts](../../src/evidence/verifier.ts) (T0 citation integrity, T1 verbatim quote and context, T2 relational binding), with [binding.ts](../../src/evidence/binding.ts), [currency.ts](../../src/evidence/currency.ts), [dates.ts](../../src/evidence/dates.ts) and [ownership.ts](../../src/evidence/ownership.ts) (ADR-41). T3, the LLM judge for comparative sentences only, is in [src/evidence/entailment.ts](../../src/evidence/entailment.ts) and the answer pipeline.
- Tested by [tests/unit/evidence/verifier.test.ts](../../tests/unit/evidence/verifier.test.ts) and the calibration set ([tests/unit/evidence/calibration-oracle.test.ts](../../tests/unit/evidence/calibration-oracle.test.ts)).
- [architecture.md](../architecture.md) R2 gives the design. The weak-rate on real pages is measured on a small labelled set only ([docs/extraction-calibration.md](../extraction-calibration.md)); open item U15 stays open.

## Revisit when

- A false pass is found in evaluation.
