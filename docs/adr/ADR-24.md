# ADR-24: One absolute turn deadline with admission control

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- `turns.deadline_at` is stored and the `TurnBudget` interface is the contract ([src/shared/infrastructure.ts](../../src/shared/infrastructure.ts)). The implementation is [src/orchestration/turn-budget.ts](../../src/orchestration/turn-budget.ts) (one absolute deadline, per-stage reserves, admission control for retries, splits, fallback rounds and judge calls); the constants (turn deadline, stage caps, minimum durations) are in [src/orchestration/config.ts](../../src/orchestration/config.ts). All durations are unmeasured defaults.
- Tested by [tests/unit/orchestration/turn-budget.test.ts](../../tests/unit/orchestration/turn-budget.test.ts).

## Revisit when

- Measured latencies show the reserves are wrong.
