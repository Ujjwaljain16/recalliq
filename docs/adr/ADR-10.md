# ADR-10: Evidence extraction: adaptive batches

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- [architecture.md](../architecture.md) R1. The wall-time figures behind the choice are **hypotheses, not measurements**. Nothing is implemented. Which model extracts (Haiku or Sonnet) is open (ADR-14).

## Revisit when

- Measured latency or quality points to per-entity calls or a single call.
