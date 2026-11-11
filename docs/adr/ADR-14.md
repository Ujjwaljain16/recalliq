# ADR-14: Models: Haiku 5.5 and Sonnet 5.5 behind an LLM port (provisional)

- **Status:** Proposed
- **Implementation:** not implemented
- **Decided:** Pending. Owner: "Haiku + Sonnet is the provisional model configuration, subject to evaluation"
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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
- **Claude latency was not measured**, no adapter or prompt exists, and no cost figure is a result. The per-turn cost is an estimate.

## Revisit when

- Measured time to first token for analysis, extraction quality (Haiku against Sonnet), and cost per turn.
