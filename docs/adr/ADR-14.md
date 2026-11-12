# ADR-14: Models: Haiku 5.5 and Sonnet 5.5 behind an LLM port (provisional)

- **Status:** Proposed
- **Implementation:** partly implemented
- **Decided:** Pending. Owner: "Haiku + Sonnet is the provisional model configuration, subject to evaluation"
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

- [research-notes.md](../history/research-notes.md) §5: pricing and capabilities from provider documentation; latency figures there are third-party. The recommendation discloses that the author is itself an Anthropic model.
- The port exists: `LlmPort` in [src/shared/llm.ts](../../src/shared/llm.ts), with a Gemini adapter ([src/llm/gemini/](../../src/llm/gemini)), an Anthropic adapter ([src/llm/anthropic/](../../src/llm/anthropic)), a fallback wrapper, a recording and replay adapter and a scripted fake. **The live component set uses Gemini for every role** (default model `gemini-3.5-flash-lite`, fallback `gemini-3.1-flash-lite`, [src/config/env.ts](../../src/config/env.ts)); the Anthropic adapter is not used by any component set and has never been run against the real API.
- Prompts are in [src/llm/prompts/](../../src/llm/prompts) and [src/evidence/prompts/](../../src/evidence/prompts). The model benchmark has not been run ([docs/model-evaluation.md](../model-evaluation.md)), so no latency, quality or cost figure is a result. The per-turn cost is an estimate.

## Revisit when

- Measured time to first token for analysis, extraction quality (Haiku against Sonnet), and cost per turn.
