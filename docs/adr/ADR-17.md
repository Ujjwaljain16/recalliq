# ADR-17: A turn runs to completion after the client disconnects

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Default decided; owner open item U14 (observed cost)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-23](ADR-23.md), [ADR-24](ADR-24.md), [ADR-31](ADR-31.md)

## Context

Aborting on disconnect loses research work and complicates what counts as said.

## Options considered

- Abort on disconnect.
- Run to completion (bounded by the deadline).

## Decision

Run to completion. A client disconnect does not abort the turn.

## Consequences and trade-offs

- Money is spent on abandoned turns.

## Evidence and implementation references

- Nothing in the server listens for a client disconnect: the turn keeps running and persists ([src/server/app.ts](../../src/server/app.ts), [src/orchestration/orchestrator.ts](../../src/orchestration/orchestrator.ts)); only server shutdown aborts a turn ([src/orchestration/turn-budget.ts](../../src/orchestration/turn-budget.ts)).
- Tested by "a client that disconnects mid-stream does not stop the turn" in [tests/integration/server/turns.test.ts](../../tests/integration/server/turns.test.ts). Delivery consequences: only acknowledged sentences are presented ([tests/integration/db/delivery.test.ts](../../tests/integration/db/delivery.test.ts), T-DLV-02, T-DLV-03).

## Revisit when

- Observed cost of abandoned turns.
