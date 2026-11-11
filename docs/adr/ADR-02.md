# ADR-02: One process with specialised modules; no multi-agent system

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
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

- [src/shared/llm.ts](../../src/shared/llm.ts) defines `LlmRole`. No LLM adapter exists yet.

## Revisit when

- Not planned for v1.
