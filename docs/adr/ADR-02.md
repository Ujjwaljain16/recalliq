# ADR-02: One process with specialised modules; no multi-agent system

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-01](ADR-01.md), [ADR-03](ADR-03.md)

## Context

Multi-agent designs add coordination cost and failure modes. No accuracy mechanism that this product needs requires them.

## Options considered

- Multi-agent specialists.
- One process, specialised modules, a small fixed set of LLM roles.

## Decision

One process, specialised modules. The four roles are typed in the contract (`LlmRole`).

## Consequences and trade-offs

- No parallel autonomous agents; parallelism is limited to bounded search and extraction calls.

## Evidence and implementation references

- [src/shared/llm.ts](../../src/shared/llm.ts) defines `LlmRole`. Each role is used by one module: analysis in [src/llm/analysis/analyzer.ts](../../src/llm/analysis/analyzer.ts), extraction in [src/evidence/extractor.ts](../../src/evidence/extractor.ts), synthesis and the judge in [src/answer/pipeline.ts](../../src/answer/pipeline.ts) (the evidence judge is in [src/evidence/entailment.ts](../../src/evidence/entailment.ts)). Everything runs in one Node process started by [src/main.ts](../../src/main.ts); there is no agent-to-agent coordination.
- Tested through the orchestrator and pipeline tests, for example [tests/unit/orchestration/orchestrator.test.ts](../../tests/unit/orchestration/orchestrator.test.ts) and [tests/integration/answer/pipeline.test.ts](../../tests/integration/answer/pipeline.test.ts).

## Revisit when

- Not planned for v1.
