# ADR-22: Observation time kept separate from effective time

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-36](ADR-36.md), [ADR-21](ADR-21.md), [ADR-07](ADR-07.md)

## Context

A fresh fetch proves what a page displayed at retrieval, not when that began.

## Options considered

- A single `as_of`.
- Separate observed, effective, displayed and provider fields.

## Decision

Separate fields and a `differs_timing_unknown` verdict. The rule for when `changed` may be claimed was later tightened by ADR-36.

## Retrieval time and crawl basis (2026-11-12)

Retrieval time stays separate from source time: `observedAt` is when we retrieved the page and is never replaced by, or blended with, `providerPublishedAt` or `providerLastUpdatedAt`. Each snapshot also records a `crawl_basis` (`confirmed_live`, `requested_live`, `cached`, `unknown`) saying what its freshness rests on. Only `confirmed_live`, a per-result provider marker, equals `freshFetch` and feeds `displayedAt`. `requested_live` (a live crawl was requested and the content is sufficient) is recorded and reported but is not confirmation: no new `displayedAtBasis` exists and no time field changes. Sufficiency rule: A text-mode result of a live request is sufficient when its trimmed length is at least 400 characters and at least `min(ceil(0.5 × requested budget), 1,500)` characters, and it is either structured (at least one heading or table found by `parseSourceStructure`) or at least 1,200 characters long. Highlights-mode results are never sufficient, because their length says nothing about whether a crawl finished. The rule exists because a live crawl that does not finish is not reported: the provider answers HTTP 200 with no error and no marker, and the text is silently short (observed: 87, 131 and 186 characters for a 1,500-character budget, all of which fail the rule). It can only make a result `unknown`; it never upgrades one. It lives in [src/search/crawl-basis.ts](../../src/search/crawl-basis.ts). See [ADR-36](ADR-36.md) for the full table.

## Consequences and trade-offs

- Fewer confident "changed" verdicts.

## Evidence and implementation references

- Columns `observed_at`, `effective_from`, `displayed_at`, `displayed_at_basis`, `provider_published_at`, `provider_last_updated_at` in [src/db/migrations/001_init.sql](../../src/db/migrations/001_init.sql) and `crawl_basis` in [src/db/migrations/009_snapshot_crawl_basis.sql](../../src/db/migrations/009_snapshot_crawl_basis.sql).
- Logic: the as-of rule ([src/belief/as-of.ts](../../src/belief/as-of.ts)), the change detector with `differs_timing_unknown` ([src/belief/detector.ts](../../src/belief/detector.ts)) and the crawl-basis rule ([src/search/crawl-basis.ts](../../src/search/crawl-basis.ts)). Tested by [tests/unit/belief/detector.test.ts](../../tests/unit/belief/detector.test.ts), [tests/unit/belief/as-of.test.ts](../../tests/unit/belief/as-of.test.ts) and [tests/unit/search/crawl-basis.test.ts](../../tests/unit/search/crawl-basis.test.ts), with synthetic evidence only.

## Revisit when

- Not expected: this is a correctness rule.
