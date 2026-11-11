# ADR-17: A turn runs to completion after the client disconnects

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Default decided; owner open item U14 (observed cost)
- **Recorded:** 2026-11-11
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

- Delivery consequences are implemented and tested: only acknowledged sentences are presented ([tests/integration/db/delivery.test.ts](../../tests/integration/db/delivery.test.ts), T-DLV-02, T-DLV-03).
- The orchestrator behaviour itself is not implemented.

## Revisit when

- Observed cost of abandoned turns.
