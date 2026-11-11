# ADR-22: Observation time kept separate from effective time

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (3.1)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-36](ADR-36.md), [ADR-21](ADR-21.md), [ADR-07](ADR-07.md)

## Context

A fresh fetch proves what a page displayed at retrieval, not when that began.

## Options considered

- A single `as_of`.
- Separate observed, effective, displayed and provider fields.

## Decision

Separate fields and a `differs_timing_unknown` verdict. The rule for when `changed` may be claimed was later tightened by ADR-36.

## Consequences and trade-offs

- Fewer confident "changed" verdicts.

## Evidence and implementation references

- Columns `observed_at`, `effective_from`, `displayed_at`, `displayed_at_basis`, `provider_published_at`, `provider_last_updated_at` in [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql). Logic is not implemented.

## Revisit when

- Not expected: this is a correctness rule.
