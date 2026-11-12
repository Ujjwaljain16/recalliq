# ADR-09: Research planning: templates, bounded fan-out, one fallback round

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-08](ADR-08.md), [ADR-24](ADR-24.md)

## Context

A naive agent loop takes many sequential round trips; a single query misses official sources.

## Options considered

- Model-chosen fan-out.
- Fixed templates with a budget and one fallback round.

## Decision

Fixed templates, a per-turn search budget, per-entity limits, one fallback round, and cache bypass for fresh and recent requests.

## Consequences and trade-offs

- Weaker on unusual open questions.

## Evidence and implementation references

- Planner: `DefaultResearchPlanner` in [src/orchestration/planner.ts](../../src/orchestration/planner.ts) (per-intent query templates, plus general questions searched without an entity). Execution with bounded concurrency and the one fallback round for keys with no usable evidence: [src/research/executor.ts](../../src/research/executor.ts) and [src/research/service.ts](../../src/research/service.ts); the fallback round is admitted only if the turn budget allows it (ADR-24).
- The limits (concurrency 5, 16 searches, 4 per entity, 6 entities) are `TURN_LIMITS` in [src/orchestration/config.ts](../../src/orchestration/config.ts) and are **unmeasured defaults**.
- Tested by [tests/unit/orchestration/routing-planner.test.ts](../../tests/unit/orchestration/routing-planner.test.ts), [tests/integration/search/executor.test.ts](../../tests/integration/search/executor.test.ts) and [tests/integration/evidence/research-service.test.ts](../../tests/integration/evidence/research-service.test.ts).

## Revisit when

- Evaluation shows templates miss official pages, or the budget is too tight or too loose.
