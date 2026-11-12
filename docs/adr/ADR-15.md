# ADR-15: Caching policy

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-09](ADR-09.md)

## Context

A cached search result can make a pricing page look unchanged.

## Options considered

- No caching.
- Aggressive caching.
- Caching that never serves freshness-sensitive requests.

## Decision

The third.

## Consequences and trade-offs

- Some repeated cost.

## Evidence and implementation references

- `search_cache` exists in [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql) but no code reads or writes it: the search cache is **not implemented**, and every search goes to the provider. The 24-hour lifetime is an unmeasured default; no hit rate exists.
- Prompt caching is implemented only in the Anthropic adapter (`cache_control` on the system prompt, [src/llm/anthropic/wire.ts](../../src/llm/anthropic/wire.ts)), which the live set does not use; the Gemini adapter does not request it.
- No answer cache exists, as decided.

## Revisit when

- Cost pressure, with measured hit rates.
