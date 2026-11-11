# ADR-16: Streaming: findings first, no hold-back, late verification only downgrades

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (3.1)
- **Recorded:** 2026-11-11
- **Related:** [ADR-12](ADR-12.md), [ADR-23](ADR-23.md), [ADR-31](ADR-31.md)

## Context

Unverified numbers must not be shown as confirmed; waiting for verification would hurt responsiveness.

## Options considered

- Buffer the whole answer.
- Stream raw text.
- Findings first, placeholders, sentence-level patches.

## Decision

The third.

## Consequences and trade-offs

- The client must restyle a sentence in place.

## Evidence and implementation references

- Contracts ([stage-3-contracts.md](../stage-3-contracts.md) §2 `SseEvent`) and the persisted sentence statuses are implemented as types and storage ([src/db/schemas.ts](../../src/db/schemas.ts)). No stream code exists.

## Revisit when

- Users are misled by late downgrades in practice.
