# ADR-16: Streaming: findings first, no hold-back, late verification only downgrades

- **Status:** Superseded
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (3.1)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-12](ADR-12.md), [ADR-23](ADR-23.md), [ADR-31](ADR-31.md)

## Context

Unverified numbers must not be shown as confirmed; waiting for verification would hurt responsiveness.

## Options considered

- Buffer the whole answer.
- Stream raw text.
- Findings first, placeholders, sentence-level patches.

## Decision

The third.

**Superseded by [ADR-40](ADR-40.md) on 2026-11-12.** Factual sentences are no longer streamed before validation. The findings-first design and the placeholder rules in this decision still apply.

## Consequences and trade-offs

- The client must restyle a sentence in place.

## Evidence and implementation references

- Contracts ([contracts.md](../contracts.md) §2 `SseEvent`) and the persisted sentence statuses are implemented as types and storage ([src/db/schemas.ts](../../src/db/schemas.ts)). No stream code exists.

## Revisit when

- Users are misled by late downgrades in practice.
