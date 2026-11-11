# ADR-08: Search provider: Exa (provisional) behind a port

- **Status:** Proposed
- **Implementation:** not implemented
- **Decided:** Pending. Owner: "Exa is the provisional search provider, subject to a measurable bake-off"
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-09](ADR-09.md), [ADR-14](ADR-14.md)

## Context

One external tool is allowed. The owner confirmed that several calls to one search capability, with inline content and freshness parameters, are acceptable; a separate fetch/extract endpoint and self-fetching are not. The discriminating need is forcing a fresh fetch of a pricing page inside the search call.

## Options considered

- Exa.
- Tavily.
- Perplexity Search.
- Parallel.
- Brave LLM Context.
- SerpAPI, You.com, Linkup and others (rejected on documented grounds in the Stage 2 review).

## Decision

Not final. Exa is provisional because its documentation shows inline text, a fresh-fetch parameter, a large domain allow-list and per-result crawl status.

## Consequences and trade-offs

- Date accuracy and latency are undocumented for the modes we would use.

## Evidence and implementation references

- [research-notes.md](../research-notes.md) §4: official documentation reviewed on 2026-11-11, with unverifiable items marked UNVERIFIED.
- **No bake-off has been run and nothing has been measured.** No provider adapter exists.

## Revisit when

- Bake-off results: official-domain hit rate, date availability and correctness, latency, and whether pricing page text contains the current price.
