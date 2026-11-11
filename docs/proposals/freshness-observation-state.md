# Proposal: record what a search result's freshness actually rests on

Status: **proposed, not applied.** Nothing in the contracts, the schema or ADR-36 changes until the owner approves.

## What was observed (2026-11-12, real Exa and Gemini calls)

- Exa documents `contents.maxAgeHours: 0` as "always live crawl". A search response carries no per-result crawl status, cache marker, crawl date or last-updated field (see [provider-evaluation.md](../provider-evaluation.md)).
- The adapter therefore never sets `freshFetch`: it requires a per-result marker that does not exist.
- The evidence verifier derives `displayedAt` (the latest instant the source provably showed a statement) only from a confirmed fresh fetch, a provider last-updated time or a provider published time. Pricing pages usually have none of these.
- In a real two-turn run, **no belief reached `confirmed`**: every belief stayed `unknown` because `displayedAt` was null, independently of whether extraction and verification succeeded. So the missing marker blocks more than the `changed` verdict: it blocks every confirmed current price on live data.

## The gap

One boolean, `freshFetch`, is doing two jobs: "we asked the provider for a live crawl" and "the provider confirmed this result came from a live crawl". The provider offers the first and not the second.

## Proposal: two observations, kept apart

Record, per search result and per snapshot, a `crawlBasis`:

| Value | Meaning | How it is set |
|---|---|---|
| `confirmed_live` | The provider reported, for this result, that a live crawl succeeded | Only from a per-result provider marker. Not available from Exa search today |
| `requested_live` | The request asked for a live crawl (`maxAgeHours: 0`) and the provider documents that as always live, but nothing per result confirms it | Request had `maxAgeHours: 0`, the result came back with content, no failure marker |
| `cached` | The request allowed cached content, or the provider marked the result cached | Request had no `maxAgeHours: 0`, or a per-result cached marker |
| `unknown` | None of the above can be told | Default |

`freshFetchRequested` and `freshFetchConfirmed` are the two booleans this implies: `requested = (basis is requested_live or confirmed_live)`, `confirmed = (basis is confirmed_live)`.

### How each rule would use it

| Rule | Uses | Effect on live Exa data |
|---|---|---|
| Current-belief freshness (30-day window, `confirmed` vs `unknown` status) | `requested_live` or `confirmed_live` gives `displayedAt = observedAt` with a distinct basis `fresh_fetch_requested` | Confirmed prices become possible, labelled as resting on the documented request behaviour |
| `unchanged_confirmed` (needs a fresh official observation after the answer) | `confirmed_live` only | Unreachable on Exa today; the verdict stays `no_evidence_of_change` |
| `changed` by re-observation (ADR-36 route 1) | `confirmed_live` only, exactly as ADR-36 and the owner's as-of rule state | Unreachable on Exa today; `differs_timing_unknown` or the effective-date route |
| `changed` by explicit effective date (route 2) | Unchanged | Unchanged |

So **ADR-36 does not change**: its stricter requirement keeps meaning "the provider reported a live crawl". Only the lower-stakes question "is this price current enough to call confirmed" would accept the weaker, documented basis, and the answer would say so.

## What it would touch

- `SearchHit` and `SourceSnapshot`: a `crawlBasis` field (the existing `freshFetch` becomes `crawlBasis === 'confirmed_live'`).
- `source_snapshots`: one additive column and an additive migration; snapshots stay immutable.
- `TimeFields.displayedAtBasis`: one new value, `fresh_fetch_requested`, and the same value in the `evidence_statements` check constraint (a table rebuild, because SQLite cannot alter a check).
- The Exa adapter, the verifier's `displayedAt` derivation, the belief resolver's freshness rule, and the wording of findings that rest on the weaker basis.
- Tests for each row of the table above.

## Risks and open questions

- Whether a failed live crawl under `maxAgeHours: 0` returns an error, drops the result or returns a stale copy is not documented. If it can return stale content silently, `requested_live` would overstate freshness. A probe with a deliberately tiny `livecrawlTimeout` would show it; it has not been run.
- A user reading "confirmed" may assume independent confirmation. The finding text for the weaker basis should say "as of the time we asked the provider to fetch the page".

## Alternatives

- **Keep the single boolean (current behaviour).** Honest, but no live belief is ever confirmed.
- **Set `freshFetch` from the request alone.** Simple, but it silently turns a documented behaviour into a per-result confirmation, which is what the owner asked us not to do.
- **Add a second endpoint that reports crawl status.** Rejected: it would add a page-fetching capability the design excludes.
