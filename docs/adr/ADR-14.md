# ADR-14: Models: Haiku 5.5 and Sonnet 5.5 behind an LLM port (provisional)

- **Status:** Superseded
- **Implementation:** partly implemented
- **Decided:** Pending, then superseded on 2026-11-12. Superseded by [ADR-45](ADR-45.md): the application runs on Gemini for every role.
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-08](ADR-08.md), [ADR-10](ADR-10.md)

## Context

Analysis sits on the critical path; extraction quality decides verdicts.

## Options considered

- Anthropic Haiku plus Sonnet.
- OpenAI small plus mid tier.
- Gemini Flash tiers (thinking cannot be fully disabled, announced price rises).
- Groq or Cerebras open models (structured output and rate-limit caveats).

## Decision

Not final. Anthropic is provisional.

## Consequences and trade-offs

- Prompts are vendor-coupled even behind a port.

## Evidence and implementation references

- The port exists: `LlmPort` in [src/shared/llm.ts](../../src/shared/llm.ts), with a Gemini adapter ([src/llm/gemini/](../../src/llm/gemini)), a fallback wrapper, a recording and replay adapter and a scripted fake. **The live component set uses Gemini for every role** (default model `gemini-3.5-flash-lite`, fallback `gemini-3.1-flash-lite`, [src/config/env.ts](../../src/config/env.ts)). An Anthropic adapter was written early and removed unused on 2026-11-12; it is in the git history.
- Prompts are in [src/llm/prompts/](../../src/llm/prompts) and [src/evidence/prompts/](../../src/evidence/prompts). No per-role model comparison has been run; the measured results of the live set are in [docs/benchmarks.md](../benchmarks.md). The per-turn cost is an estimate.

## Revisit when

- Measured time to first token for analysis, extraction quality (Haiku against Sonnet), and cost per turn.
