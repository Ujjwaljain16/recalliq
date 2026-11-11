# ADR-32: Assertions, findings and events are persisted atomically at completion

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (M2 approved)
- **Recorded:** 2026-11-11
- **Related:** [ADR-06](ADR-06.md), [ADR-12](ADR-12.md), [ADR-23](ADR-23.md), [ADR-31](ADR-31.md)

## Context

A half-written answer could leave claims that look told without a message, or findings without assertions.

## Options considered

- Write as the stream progresses.
- Write everything in one transaction when the turn completes.

## Decision

One transaction in `complete()`. Assertions are created unpresented; claims in never-streamed sentences get a `not_presented` event; verdict events may only target assertions presented to the same user in an earlier turn. Inconsistent completions are refused before any write.

## Consequences and trade-offs

- If the process dies before completion, no answer exists (the turn is only recoverable as interrupted).
- `enrichment` and `touchedBeliefKeys` are rejected until milestones 3 and 4 (Q-014); `complete()` never ignores them.

## Evidence and implementation references

- [src/db/repositories/turn-completion.ts](../../src/db/repositories/turn-completion.ts).
- T-ASR-01 to 05 in [tests/integration/db/turn-completion.test.ts](../../tests/integration/db/turn-completion.test.ts), including fault injection (a temporary trigger makes a later write fail and the message, findings and earlier assertions roll back, and the same completion then succeeds).

## Revisit when

- Enrichment and belief recomputation are added to the same transaction (milestones 3 and 4).
