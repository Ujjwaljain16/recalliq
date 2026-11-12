# ADR-16: Streaming: findings first, no hold-back, late verification only downgrades

- **Status:** Superseded
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- Contracts ([contracts.md](../contracts.md) §2 `SseEvent`), the persisted sentence statuses ([src/db/schemas.ts](../../src/db/schemas.ts)) and the SSE writer ([src/server/sse.ts](../../src/server/sse.ts)) are implemented. Findings are sent before prose and placeholder rules apply ([src/answer/pipeline.ts](../../src/answer/pipeline.ts)).
- The part that was superseded is not what the code does: the pipeline releases a sentence only after validation (ADR-40) rather than streaming immediately and downgrading late. The `unverified`, `unchecked` and `truncated` statuses remain in the type for defects found after release.

## Revisit when

- Users are misled by late downgrades in practice.
