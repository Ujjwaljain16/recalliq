# ADR-08: Search provider: Exa (provisional) behind a port

- **Status:** Proposed
- **Implementation:** partly implemented
- **Decided:** Pending. Owner: "Exa is the provisional search provider, subject to a measurable bake-off"
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-09](ADR-09.md), [ADR-14](ADR-14.md)

## Context

One external tool is allowed. The owner confirmed that several calls to one search capability, with inline content and freshness parameters, are acceptable; a separate fetch/extract endpoint and self-fetching are not. The discriminating need is forcing a fresh fetch of a pricing page inside the search call.

## Options considered

- Exa.
- Tavily.
- Perplexity Search.
- Parallel.
- Brave LLM Context.
- SerpAPI, You.com, Linkup and others (rejected on documented grounds in the technology review).

## Decision

Not final. Exa is provisional because its documentation shows inline text, a fresh-fetch parameter, a large domain allow-list and per-result crawl status.

## Consequences and trade-offs

- Date accuracy and latency are undocumented for the modes we would use.

## Evidence and implementation references

- Implemented: the `SearchPort` adapter for Exa ([src/search/exa-adapter.ts](../../src/search/exa-adapter.ts), with [exa-request.ts](../../src/search/exa-request.ts) and [exa-schema.ts](../../src/search/exa-schema.ts)), recording and replay ([src/search/recording.ts](../../src/search/recording.ts), [src/search/replay.ts](../../src/search/replay.ts)). The live component set uses Exa ([src/app/live.ts](../../src/app/live.ts)). Adapter tests: [tests/unit/search/exa-adapter.test.ts](../../tests/unit/search/exa-adapter.test.ts).
- **No provider comparison was run** (a bake-off harness was written and removed unused on 2026-11-12; it is in the git history). Exa is measured only as part of the live benchmarks ([docs/benchmarks.md](../benchmarks.md)). That is why the decision stays Proposed.

## Revisit when

- Bake-off results: official-domain hit rate, date availability and correctness, latency, and whether pricing page text contains the current price.
