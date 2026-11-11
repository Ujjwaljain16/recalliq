# Proposal: record what a search result's freshness actually rests on

Status: **approved for implementation with constraints (2026-11-12).** The constraints below override the table further down where they differ.

## Approved constraints

- The four states `confirmed_live`, `requested_live`, `cached` and `unknown` are implemented as distinct states.
- A successful HTTP response, or a request made with `maxAgeHours: 0`, never establishes `confirmed_live` on its own. Only a per-result provider marker can (Exa search returns none).
- Incomplete or insufficiently structured crawl content cannot establish confirmed freshness: such a result is recorded as `unknown`, not `requested_live`.
- `requested_live` cannot independently establish confirmed current pricing, nor a historical `changed` or `unchanged_confirmed` verdict. It is recorded and reported, and it changes no belief status and no verdict.
- The ADR-36 two-observation proof and the effective-date requirement are unchanged.
- Retrieval time stays separate from source effective and publication time.
- No existing invariant is weakened.

Consequence for the table below: the `fresh_fetch_requested` displayed-at basis is **not** introduced, and the evidence table is not rebuilt. The new state is stored on the snapshot and reported; it does not feed the resolver or the detector.

## What was observed (2026-11-12, real Exa and Gemini calls)

- Exa documents `contents.maxAgeHours: 0` as "always live crawl". A search response carries no per-result crawl status, cache marker, crawl date or last-updated field (see [provider-evaluation.md](../provider-evaluation.md)).
- The adapter therefore never sets `freshFetch`: it requires a per-result marker that does not exist.
- The evidence verifier derives `displayedAt` (the latest instant the source provably showed a statement) only from a confirmed fresh fetch, a provider last-updated time or a provider published time. Pricing pages usually have none of these.
- **Correction (2026-11-12):** an earlier version of this note said the missing marker blocked every confirmed price. That was wrong for the run it described. In that run no belief existed at all, because all 47 extracted statements failed or were weak at verification (currency, plan binding, subject binding), so there was nothing to resolve. For statements that do pass, the resolver treats a statement with no displayed-at time as not current and reports the belief as `stale` with its value, not as `unknown`. So the missing marker limits a live price to `stale` (value shown, not confirmed) and makes `changed` unreachable; it does not remove the value.

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

- **Probed (2026-11-12, one request each, same query, 3 results):** with `maxAgeHours: 0` and `livecrawlTimeout: 1` the API answered HTTP 200 with three results whose text was only 186, 131 and 87 characters, with no error and no marker; with `livecrawlTimeout: 8000` the same query returned the full 1,500 characters per result in about 1.6 s; cache-only (`maxAgeHours: -1`) returned the full text in about 0.26 s. So a live crawl that does not finish is **not reported**: the response silently carries short content. This confirms that a request for a live crawl cannot be read as a confirmed one. A cheap guard that follows from it: treat a result whose text is far shorter than the requested budget as insufficient content (it could not support a price statement) rather than as a fresh page.
- A user reading "confirmed" may assume independent confirmation. The finding text for the weaker basis should say "as of the time we asked the provider to fetch the page".

## Alternatives

- **Keep the single boolean (current behaviour).** Honest, but no live belief is ever confirmed.
- **Set `freshFetch` from the request alone.** Simple, but it silently turns a documented behaviour into a per-result confirmation, which is what the owner asked us not to do.
- **Add a second endpoint that reports crawl status.** Rejected: it would add a page-fetching capability the design excludes.
