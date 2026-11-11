# ADR-39: Failure transitions from intermediate states

- **Status:** Proposed
- **Implementation:** not implemented
- **Decided:** Pending. Owner: define a failure transition from every non-terminal state with an explicit recovery policy, without arbitrary new edges (review, 2026-11-11)
- **Recorded:** 2026-11-11
- **Related:** [ADR-29](ADR-29.md), [ADR-33](ADR-33.md), [Q-011](../questions.md)

## Context

The architecture's state machine has failure edges only from ANALYZING and SYNTHESIZING (to PERSISTING) and from PERSISTING (to FAILED). An unexpected error while SEARCHING, EXTRACTING, VERIFYING or RESOLVING_BELIEFS has no legal path to a final state; the turn stays `running` until the next restart.

## Options considered

- Allow every non-final state to go to PERSISTING (a change to architecture §4 and migration 004).
- Classify failures: recoverable ones degrade inside the state; terminal ones go to PERSISTING with a failed or partial status that preserves what was already stored.
- Leave it to recovery at restart.

## Decision

None yet. The requirement is decided; the policy and any edge changes are not.

## Consequences and trade-offs

- Until decided, unexpected errors leave a turn running until restart.

## Evidence and implementation references

- Nothing implemented. Snapshots and evidence are meant to be stored incrementally during research, so partial work survives, but no code does this yet.

## Revisit when

- Before the orchestrator (milestone 5).
