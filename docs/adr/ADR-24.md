# ADR-24: One absolute turn deadline with admission control

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (3.1)
- **Recorded:** 2026-11-11
- **Related:** [ADR-09](ADR-09.md), [ADR-17](ADR-17.md)

## Context

Per-call timeouts add up under retries and can run past the turn.

## Options considered

- Per-call timeouts only.
- One deadline with reserves and admission rules.

## Decision

One deadline. Only local persistence may run after it.

## Consequences and trade-offs

- More `unable_to_verify (deadline)` outcomes near the limit.

## Evidence and implementation references

- `turns.deadline_at` is stored and the `TurnBudget` interface exists as a contract ([src/shared/infrastructure.ts](../../src/shared/infrastructure.ts)). The budget implementation and its constants are not implemented; all durations are unmeasured defaults.

## Revisit when

- Measured latencies show the reserves are wrong.
