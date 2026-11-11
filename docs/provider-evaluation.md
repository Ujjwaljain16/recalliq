# Search provider evaluation (ADR-08)

**Status: NOT RUN.** The bake-off harness and benchmark are built and unit-tested against fake data. No live provider has been called, no API key was available, and this document contains **no** measured latency, cost, hit rate or score. ADR-08 stays **Proposed**. Nothing here may be read as a result.

## What exists

| Item | Path |
|---|---|
| Provider port adapter (Exa, Node `fetch`, zod-validated) | `src/search/exa-adapter.ts`, `exa-request.ts`, `exa-schema.ts` |
| Replay and recording | `src/search/replay.ts`, `recording.ts`, `request-key.ts` |
| Harness and fixed benchmark | `scripts/bakeoff.ts` |
| Harness tests (fake data only) | `tests/unit/search/bakeoff.test.ts` |
| Synthetic fixtures (all hand-authored, labelled `[SYNTHETIC]`) | `tests/fixtures/search/` |

## Benchmark design

Fixed cases (`BENCHMARK_CASES`): six pricing queries restricted to the vendor's official domains (`freshness: live`, `contentMode: text`, 5 results, 6000 characters) and one release query (`highlights`). Each case runs once, sequentially, per provider, through the same `SearchPort`.

Mechanically scored per case, from the response alone:

- **Official-domain hit:** a result's host equals or is a subdomain of a listed official domain (look-alike hosts do not count).
- **Date availability:** share of hits with a provider `publishedAt`.
- **Price-text presence:** share of pricing hits whose text contains a currency-and-number pattern. This shows the page text carries a price, not that it is the current or correct one.
- **Structure survival:** share of hits whose text still contains a heading or table.
- **Fresh-fetch share:** share of hits for which the provider reported a successful live crawl (live-mode cases only).
- **Latency and cost:** as reported through the port; p50 and p95 over the run.
- **Failures:** provider errors as typed codes, counted separately.

Not scored (needs a human label, to be added before any claim is made): whether a date is correct, whether the price shown is the current price, whether the page is the right regional variant. Sample size is small (7 cases) and a single run each; any result must be reported with that limitation and with run date and request parameters.

Candidates to compare behind the same port: Exa (adapter built), Tavily, Perplexity Search, Parallel, Brave LLM Context (adapters not built). ADR-08 names the decision criteria: official-domain hit rate, date availability and correctness, latency, and whether pricing page text contains the current price.

## How it would be run (not done)

1. The owner puts `EXA_API_KEY` in an ignored `.env` and approves the spend (D3).
2. `npx tsx scripts/bakeoff.ts --mode=live --confirm-spend` (refuses without the flag and a key). Record exchanges with `ExaSearchAdapter`'s `record` option, including the provider's raw body.
3. Results go under `eval/results/live/<date>/` and are never imported. Replay runs (`--mode=replay --recording=<file>`) use recordings only and cannot reach the network.

## Observed against the real API (2026-11-12, one request pair, not a benchmark)

Two real searches ("Neon Postgres pricing per month", 3 results, text mode, 2,500 characters), one direct and one through the adapter, with the owner's key:

- **Response keys:** `requestId`, `resolvedSearchType`, `results`, `searchTime`, `costDollars`. There is **no** `statuses` array in a search response.
- **Per-result keys:** `id`, `title`, `url`, `text`; sometimes `publishedDate`, `author`, `image`, `favicon`. **No** crawl status, cache marker, crawl date or last-updated field was returned.
- **Cost:** `costDollars` was `{"total":0.007,"search":{"neural":0.007}}` for each request.
- **Timing (single observations):** with a live crawl requested (`maxAgeHours: 0`) the adapter's call took about 4.8 s; the cached request took about 0.3 s. The size of the gap suggests a fetch happened, but the response does not say so.
- **The adapter** parsed both responses with no dropped items.
- **Failed live crawl (one probe each):** with `maxAgeHours: 0` and `livecrawlTimeout: 1` the response was HTTP 200 with three results of only 186, 131 and 87 characters, no error and no marker; with `livecrawlTimeout: 8000` the same query returned 1,500 characters per result in about 1.6 s; with `maxAgeHours: -1` (cache only) it returned 1,500 characters in about 0.26 s. An unfinished live crawl is therefore silent.
- **Consequence:** the adapter sets `freshFetch` only when a per-result marker says a live crawl succeeded. No such marker exists, so `freshFetch` is false for every real result and `crawlStatus` is unknown. With the owner's as-of rule, a `changed` verdict from re-observation therefore cannot be reached on real Exa data; `differs_timing_unknown` and the effective-date route remain available. Whether to treat a documented `maxAgeHours: 0` request as evidence of a live crawl is an open decision (see the question log entry on provider capture time).

## Cache and freshness metadata

Read from the public Exa documentation on 2026-11-12 (search reference and the contents-retrieval guide). Not verified against a live response.

| Question | What the documentation says |
|---|---|
| Is there a way to force a fresh crawl? | Yes: `contents.maxAgeHours`. `0` returns content fetched within the last 60 seconds ("live"); omitted uses cache and fetches when needed; a positive integer uses cache newer than that many hours, otherwise fetches, and **a failed fetch may return the latest cached copy instead**; `-1` uses cache only. `contents.livecrawlTimeout` (ms, default 10000, max 90000) caps a fresh fetch. The older `livecrawl` option is deprecated. |
| How is a cached result marked? | Per-URL `statuses[]` entries carry `id`, `status` and `source`; the documented example shows `status: "success"` and `source: "cached"`. Other `source` values and failure `status` values are **not documented**. |
| Is `statuses` returned by `/search`? | Documented for `/contents`. For `/search` it is **unverified**. |
| Per-result crawl or capture date? | **None documented.** No `lastCrawled`, capture date or cache age field. |
| `publishedDate` | Optional ISO date-time on a result; the contents guide does not describe it. It is the page's published date as the provider infers it, not a crawl date. |
| `lastUpdated` | Not documented. |
| Fallback when a live crawl fails | Documented only for the positive `maxAgeHours` case (stale cache may be returned). For `0` not described, so a result could in principle be older than requested without a documented marker other than `statuses[].source`. |

What the adapter maps (existing `SearchHit` fields only; no contract field was added):

- `publishedAt` from `publishedDate` (null if absent or unparseable); `lastUpdatedAt` always null (no source).
- `crawlStatus`: `ok` when `statuses[].status` is `success`, `failed` when it names an error or failure, otherwise `unknown` (also when `statuses` is absent).
- `freshFetch`: true **only** when a live fetch was requested, the crawl status is `ok` **and** the provider's `source` is exactly `"live"`. The value `"live"` is an assumption (only `"cached"` is documented); if the real value differs, `freshFetch` is never true, which is the safe direction. Nothing is inferred from `maxAgeHours: 0` alone.
- The raw `statuses` (including `source`) are kept by the validated schema (`src/search/exa-schema.ts`, loose objects) and stored unmodified in recordings (`providerRaw`) so a later contract change can use them.

For the orchestrator's Q-019 decision: with the documented API, the provider's cache age or capture time is **not available** as a field; the only available signal is the per-result `source` marker, and only if `/search` returns `statuses`. A cached result therefore cannot be dated better than `publishedAt` (a hint, never ground truth).

## Known limits

- Exa response shape assumptions are isolated in `src/search/exa-schema.ts`.
- All fixtures are synthetic; there is no real recording.
- Search-result caching (`search_cache`) is not implemented, so no outcome has status `cached`.
