# ADR-01: Lane-routed deterministic orchestrator (architecture C)

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3, reconciled in 3.1)
- **Recorded:** 2026-11-11
- **Related:** [ADR-02](ADR-02.md), [ADR-03](ADR-03.md), [ADR-29](ADR-29.md)

## Context

All three example queries compare what was said or known at one time with what is true now. Guarantees such as "an empty search is never reported as no change" must hold by structure, not by prompt, and turns must be replayable in tests. A message such as "thanks" should never trigger a search.

## Options considered

- A: one LLM agent loop with tools.
- B: one fixed pipeline for every turn.
- C: hybrid, a deterministic orchestrator with routed lanes.
- D: an agent loop whose price claims must pass through deterministic guard tools.

## Decision

C. The orchestrator (not the model) chooses the lane and runs a fixed sequence of components for it; the model's lane hint is advisory. LLM work is limited to analysis, extraction, synthesis and an optional judge.

## Consequences and trade-offs

- More modules than option B, and less adaptive on unusual open-ended questions than A or D.
- Turns are deterministic enough to replay offline and to test state by state.

## Evidence and implementation references

- Weighted decision matrix in [stage-3-architecture.md](../stage-3-architecture.md) (Part II). The scores are the author's judgements, **not** measurements.
- Implemented so far: only the persistence and state-machine foundation (ADR-29, ADR-30, ADR-32). The orchestrator, lanes and components are not implemented (milestone 5).

## Revisit when

- If evaluation shows research quality on open-ended questions is the bottleneck, add bounded agentic refinement to the research lane only (option D).
