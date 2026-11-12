# ADR-10: Evidence extraction: adaptive batches

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-11](ADR-11.md), [ADR-14](ADR-14.md)

## Context

One call per entity costs repeated prompt tokens; one giant call is slow and takes every entity down on failure.

## Options considered

- One batched call.
- One call per entity in parallel.
- Adaptive packing.

## Decision

Adaptive packing with a deterministic algorithm, bounded concurrency and per-entity isolation of failures.

## Consequences and trade-offs

- A packing algorithm to maintain.

## Evidence and implementation references

- Batching: `AdaptiveBatcher` in [src/evidence/batcher.ts](../../src/evidence/batcher.ts) (about 9,000 evidence tokens and 3 entities per batch). Extraction, one retry and the split into one call per entity, each admitted only if the turn budget allows it: [src/evidence/extractor.ts](../../src/evidence/extractor.ts); prompt in [src/evidence/prompts/extraction.ts](../../src/evidence/prompts/extraction.ts).
- Tested by [tests/unit/evidence/extraction.test.ts](../../tests/unit/evidence/extraction.test.ts). The wall-time figures behind the choice are **hypotheses, not measurements**; accuracy on real pages is in [docs/extraction-calibration.md](../extraction-calibration.md). The live set extracts with the same Gemini model as every other role (ADR-14).

## Revisit when

- Measured latency or quality points to per-entity calls or a single call.
