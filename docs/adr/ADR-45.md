# ADR-45: Gemini Flash-Lite for every role, with a fallback model

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner decision, 2026-11-12, after live runs on the free tier
- **Recorded:** 2026-11-12
- **Related:** [ADR-14](ADR-14.md), [ADR-24](ADR-24.md)

## Context

[ADR-14](ADR-14.md) proposed Anthropic models (a small one for analysis and judging, a larger one for extraction
and synthesis) behind an `LlmPort`. The application was then built and run against Gemini, the provider whose key
was available, and the Anthropic adapter was never run live. On the free tier the planned larger Gemini model
(`gemini-3.5-flash`) failed most live turns with 503 and 429 responses.

## Options considered

- Keep a two-tier split (small model for analysis, larger for extraction and synthesis) on Gemini.
- One model for every role, with a second model as a fallback (chosen).
- Wait for a paid key before choosing.

## Decision

Every role (analysis, extraction, synthesis, judge, quick answer) uses `gemini-3.5-flash-lite` by default
(`GEMINI_MODEL`). `FallbackLlm` sends a call to `gemini-3.1-flash-lite` (`GEMINI_FALLBACK_MODEL`, `none` turns it
off) when the main model is rate limited, unavailable or too slow, once per call and never mid-answer. Each model
has its own rolling per-minute budget. The Anthropic adapter was removed unused; it remains in the git history.

## Consequences and trade-offs

- One small model does the hardest job (extraction) too; accuracy on messy pricing pages is the visible cost.
- A turn depends on one provider; the fallback model shares its outages but not its quota.
- The `LlmPort` boundary stays, so a per-role split or another provider is an adapter and a configuration away.

## Evidence and implementation references

- [src/llm/gemini/](../../src/llm/gemini), [src/llm/fallback.ts](../../src/llm/fallback.ts),
  [src/llm/limiter.ts](../../src/llm/limiter.ts), defaults in [src/config/env.ts](../../src/config/env.ts).
- Measured results of this configuration: [docs/benchmarks.md](../benchmarks.md).
- Tests: [tests/unit/llm/fallback.test.ts](../../tests/unit/llm/fallback.test.ts),
  [tests/unit/llm/hedge.test.ts](../../tests/unit/llm/hedge.test.ts),
  [tests/unit/llm/limiter.test.ts](../../tests/unit/llm/limiter.test.ts).

## Revisit when

- A per-role model comparison on the benchmark dev samples shows a larger model is worth its latency for
  extraction.
- A paid tier removes the rate limits that drove the choice.
