# ADR-15: Caching policy

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- `search_cache` exists in [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql) but nothing reads or writes it. The 24-hour lifetime is an unmeasured default; no hit rate exists.

## Revisit when

- Cost pressure, with measured hit rates.
