# ADR-01: Lane-routed deterministic orchestrator (architecture C)

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- Weighted decision matrix in [architecture.md](../architecture.md) (Part II). The scores are the author's judgements, **not** measurements.
- Implemented: the coordinator [src/orchestration/orchestrator.ts](../../src/orchestration/orchestrator.ts), the deterministic lane rules [src/orchestration/routing.ts](../../src/orchestration/routing.ts) and the five lane handlers (chat, recall, research, audit, clarify) in [src/orchestration/lanes/](../../src/orchestration/lanes). Tested by [tests/unit/orchestration/orchestrator.test.ts](../../tests/unit/orchestration/orchestrator.test.ts), [tests/unit/orchestration/routing-planner.test.ts](../../tests/unit/orchestration/routing-planner.test.ts) and [tests/integration/orchestration/scenario-routing.test.ts](../../tests/integration/orchestration/scenario-routing.test.ts).
- Persistence and the state machine are in ADR-29, ADR-30 and ADR-32.

## Revisit when

- If evaluation shows research quality on open-ended questions is the bottleneck, add bounded agentic refinement to the research lane only (option D).
