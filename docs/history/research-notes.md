# Stage 2: Technical Investigation

Research date: **2026-11-11**. Every provider fact below comes from official documentation fetched on that date unless marked otherwise. Labels used throughout:

- **[UNVERIFIED]**: not stated in official docs.
- **[3P]**: third-party source, such as Artificial Analysis or news coverage.
- **[HYPOTHESIS]**: my estimate. It must be measured before DESIGN.md can claim it.

> **Bias disclosure.** I am a Claude model, and this document recommends Claude models for some stages. Read §5 as a recommendation that has to earn its place in the Phase-11 eval, not a settled fact. The LLM sits behind a port, so swapping providers is a configuration change.

---

## 0. Requirements carried in from the Stage-1 review

The review added five requirements. Each one changes the design concretely.

| # | Requirement | Where it lands |
|---|---|---|
| R1 | Keep **what we told the user** separate from **what a source said**, from **the evidence held at the time**, and from **what we later learned was wrong** | §1: four-layer claim model, append-only lifecycle |
| R2 | Citation verification has to prove that a source *supports* a claim, not just that it mentions the claim | §2: tiered verification with cost and failure analysis |
| R3 | Realistic latency targets, measured separately for first progress, first token and final answer | §7: latency model and targets |
| R4 | Seeded evaluation data must not contaminate real data | §8: isolation model |
| R5 | Clear rules for memory ownership and integrity under corrections, deletions and disagreement | §9: scenario table |

---

## 1. Claim model: four layers kept apart

The Stage-1 framing ("versioned records of its own claims") was too coarse. In this system, "a claim" can mean four different things. Each has its own provenance, its own lifecycle and its own trust level.

| Layer | What it is | Example | Who creates it | Mutable? |
|---|---|---|---|---|
| **L1: Source snapshot** | The exact text we retrieved from a URL at a given time | Excerpt of hubspot.com/pricing retrieved 2026-11-03T10:14Z, sha256 … | Search adapter (code) | Never |
| **L2: Evidence statement** | An atomic statement *attributed to* one L1 snapshot, with a verbatim quote span | "hubspot.com/pricing **states** Sales Hub Pro = $90/seat/mo (annual)" | Extraction LLM call, then validated by code | Never |
| **L3: Assertion** | What the **agent told the user**, in a specific message, backed by L2 evidence IDs | Message #812 said "Sales Hub Pro is $90/seat/mo [e17]" | Synthesis call, then committed when the message is delivered | Never. Status changes are new rows |
| **L4: Current belief** | The system's present best view of (entity, attribute) | "Sales Hub Pro price: $100/seat/mo, last verified 2026-11-11, status: changed" | **Derived** from L2 and L3 by code | Recomputed, never authored |

Why this separation matters:

- *"What did you tell me on 3 November?"* reads **L3 only**, verbatim. The answer is history, and history is never rewritten.
- *"Is that still correct?"* compares the L3 assertion's evidence (L2/L1 as of 3 Nov) against **new** L2 evidence gathered now.
- *"We were wrong at the time"* is detectable. It means the L3 assertion conflicted with the L2 evidence that was *already available then*, either because the L3 wording didn't match its own evidence or because the L1 snapshot was already stale on its retrieval date. *"The world changed"* means the old L2 evidence matched the old assertion, and new L2 evidence dated after it differs.
- LLM output is never ground truth. L2 is an LLM's *reading* of L1, so code checks it (§2). L3 is an LLM's *summary* of L2, so code checks that too. L4 is never written by an LLM at all.

### Assertion lifecycle (append-only)

```
draft ──(message committed)──▶ presented ──▶ { reaffirmed | superseded_world_changed | retracted_was_wrong | contested | unverifiable_now }
  │
  └──(stream aborted / message not delivered)──▶ not_presented   (never shown in "what did you tell me")
```

- Status changes are stored as `assertion_events(assertion_id, status, reason, evidence_ids, at)`. The original row is never updated.
- "What did I ask/what did you say" queries use only `presented` assertions and the messages they belong to.
- Verdicts about the past name both evidence sets, for example: "On 3 Nov I said $90 (source: hubspot.com/pricing, retrieved 3 Nov). Today the same page shows $100 (retrieved 11 Nov)."

---

## 2. Citation verification: proving support, not just co-occurrence

Mapping citation IDs to known sources stops fabricated URLs. It does **not** stop the classic mistake of citing a real source that mentions HubSpot and "$90" but in a different context (another tier, last year's price, a competitor comparison table). That needs more layers.

### Tier design

| Tier | Mechanism | What it catches | Cost | Failure modes |
|---|---|---|---|---|
| **T0: ID integrity** | Synthesis may cite only evidence IDs (`[e17]`) present in this turn's evidence table. Code maps IDs to URLs, so the model never emits a URL | Fabricated URLs and citations to anything not retrieved | ~0 ms, $0 | None for fabrication. It does nothing for relevance |
| **T1: Quote grounding** | Every L2 evidence statement must carry a `quote` that is a **verbatim substring** of its L1 snapshot text, compared after whitespace and Unicode normalisation (NFKC, collapsed spaces, quote-character folding) | Hallucinated extraction, i.e. the model "reading" text that isn't on the page | <1 ms per item | False rejects when the provider's text differs slightly from what the model saw. Mitigation: fuzzy match within edit distance ≤ 3% of quote length, logged |
| **T2: Field binding** | Each L2 statement has typed fields (`entity`, `attribute`, `qualifier` such as a tier, `value`, `unit`, `effective_date?`). Code checks each typed field appears **inside the quote**, after normalisation: currency (`$90` = `USD 90` = `90 dollars`), numbers, dates, and entity aliases from the entity table | Right page but wrong number, wrong tier or wrong entity. This is the main case ID mapping misses | <1 ms per item | (a) The quote is too short to include the qualifier, for example the tier name sits in a table header. Mitigation: quotes up to ~400 chars and a `context_quote` field. (b) Paraphrased values ("ninety dollars") are partly covered by the normaliser; anything left goes to T3 |
| **T3: Assertion ↔ evidence entailment** | Applies to the L3 sentences in the final answer. Deterministic first: every number, date and entity in a cited sentence must appear in the typed fields of at least one cited evidence item. Sentences that fail, or are **high-stakes** (a change verdict or a price), go into **one batched** small-model judge call: "Does evidence X support sentence Y? supports / partial / no", with structured output | Synthesis drifting from its evidence, such as wrong arithmetic, a merged tier, or an overstated "no change" | Deterministic: ~0. Judge: one extra small-model call, ~1–2 s **[HYPOTHESIS]**, ~$0.001–0.003 | The judge shares failure modes with the generator, so a different model or prompt reduces correlation. It adds latency **after** generation. Mitigation: stream the answer, run T3 in parallel with the tail of the stream, and apply corrections as a final patch event (§7). A judge false negative downgrades the claim to "unverified". It never deletes the claim silently |

### Policy for failures

| Failure | Action |
|---|---|
| T0 fails | Strip the citation. If the sentence is a factual web claim, rewrite it as "(unverified)" |
| T1 fails | Evidence item is discarded before synthesis ever sees it |
| T2 fails | Item is kept but downgraded to `weak`. It **cannot** support a change verdict or a price |
| T3 = `no` | Sentence is marked unverified in the final patch |
| T3 = `partial` | Wording is kept and a confidence note is attached |

**Key design point:** synthesis cites **evidence statements (L2)**, never raw sources. Because L2 items have already passed T1 and T2, the most expensive check (T3) runs on a small surface: only the sentences that carry numbers or verdicts. That keeps verification cheap enough to run on every research turn.

**What this does not prove:** that the *source itself* is correct. A vendor page can be wrong, and a news article can misreport a price. That is handled by source tiers and contradiction handling (§9), not by citation verification. DESIGN.md must say this plainly.

---

## 3. The "one external tool" rule: an interpretation we can defend

| Item | Counts as a second external tool? | Our position |
|---|---|---|
| Several HTTP requests to the same search API (parallel queries, retries) | **No.** One capability, many invocations | Allowed |
| Search parameters that change *how* the search provider retrieves (domain filter, date filter, `maxAgeHours`/live-crawl freshness, inline content/highlights) | **No.** These are parameters of the search capability | Allowed. Document it explicitly in DESIGN.md |
| A separate endpoint of the same vendor that fetches arbitrary URLs (Exa `/contents`, Tavily `/extract`, Tavily `/crawl`) | **Arguably yes.** It is a page-fetch capability, even from the same vendor | **Not used** |
| Our own `fetch()`/scraper of result URLs | **Yes**, and it also brings SSRF risk | **Not used** |
| The LLM API | No. It is the reasoning engine, not a tool the agent invokes | Allowed |
| An embeddings API | Not a "tool", but it is a second external dependency with its own key | Avoid unless the eval demonstrates the value (§6) |
| The LLM vendor's built-in web search (e.g. Claude's `web_search` server tool) | It is web search, so it is not a second tool | **Rejected for other reasons** (below) |

**Why not use the LLM's built-in web search?**

It hands query fan-out, result selection and context assembly to the model provider. We could no longer:
- (a) run deterministic T1/T2 checks on retrieved text we control,
- (b) enforce a search budget per entity,
- (c) record and replay searches for offline tests, or
- (d) swap providers.

It also ties search pricing to the LLM vendor ($10 per 1k searches on Anthropic, per the Anthropic docs bundled with the SDK skill). It is a good tool for a chatbot, but the wrong primitive for an evidence pipeline.

**Consequence:** the chosen search provider **must return usable page text inline in the search response**. This one requirement eliminates SerpAPI and plain Brave Web Search.

---

## 4. Search providers

### 4.1 Comparison matrix

| | **Exa** | **Tavily** | **Perplexity Search** | **Parallel Search** | **Brave LLM Context** | **SerpAPI** | **You.com** | **Linkup** |
|---|---|---|---|---|---|---|---|---|
| Inline page content | ✅ `highlights` / `text` (maxCharacters to 1M), free for the first 10 results | ✅ `content` chunks (~500–800 chars × ≤3) and `raw_content` full page | ✅ `snippet` = extracted text, `max_tokens_per_page` | ✅ `excerpts[]`, `max_chars_per_result` | ✅ `grounding.generic[].snippets`, token budget 1k–32k | ❌ SERP snippet only | ✅ `extraction` highlights/full page | ✅ `content` |
| Publication date | `publishedDate` (reliability undocumented) | `published_date` **beta, "best estimate"**, needs `include_published_date` or `topic:news` | **`date` and `last_updated`** (both nullable) | `publish_date` (nullable) | `age[]` incl. ISO date | Display-text dates, inconsistent | `page_age` | ❌ none per result |
| Date filter | `startPublishedDate`/`endPublishedDate` | `start_date`/`end_date`, `time_range` | recency, plus after/before on **both** publish and last-updated | `after_date` | `freshness` pd/pw/pm/range | `tbs=qdr` | `freshness` | `fromDate`/`toDate` |
| Force fresh fetch | ✅ `contents.maxAgeHours` (0 = live), `livecrawlTimeout` | ✅ `max_age_hours` (0 = live; no extra credits) | [UNVERIFIED] | ✅ `max_age_seconds` ≥ 600 | ❌ | ❌ | [UNVERIFIED] | ❌ |
| Domain allow-list | ✅ 1,200, path prefixes | ✅ 300, `restrict` or `prefer` mode | ✅ **20 max** | ✅ 200 combined | `site:` only | `site:` only | ✅ 500 + boost | ✅ 100 |
| Documented latency | `fast` p50 <425 ms (legacy type); `auto`/`lite` [UNVERIFIED]; `deep` 4–12 s | none (rank order only) | none | turbo ~200 ms, fast ~700 ms, basic ~1 s | vendor claim <500 ms P90 [3P] | 1.97 s avg (status page) | ~0.8 s highlights (doc examples) | 1–3 s (marketing) |
| Price / 1k | `lite` $4, `auto` $7 | $8 basic, $16 advanced | $5 ($1 fast) | $1–5 | ~$5 [UNVERIFIED for LLM Context] | $10–25 | $5 | $5–6 |
| Free tier | $10/mo + $10 bonus | 1,000 credits/mo | [UNVERIFIED] | $5/mo + signup credit | $5 credit/mo (card required) | 250/mo | $10 credit | "4,000 queries" (period unclear) |
| Rate limit | 10 QPS search | 100 RPM free; 1,000 RPM paid | [UNVERIFIED] | 600 RPM | 50 QPS | 50/hr free; 200/hr starter | [UNVERIFIED] | 10 QPS |
| Official TS SDK | `exa-js` 2.28 (active) | `@tavily/core` 1.0 | `@perplexity-ai/perplexity_ai` | `parallel-web` | none | `serpapi` | none (HTTP) | `linkup-sdk` |
| Index | own | own | own [UNVERIFIED] | own [UNVERIFIED] | own | **scrapes Google; Google sued SerpApi Dec 2025** [3P] | own [UNVERIFIED] | [UNVERIFIED] |
| Observability | `costDollars`, `searchTime`, per-result crawl `statuses` | `response_time`, `usage`, `request_id` | – | – | rate headers | – | – | – |

Out of scope: **Bing Search API** (retired 2025-08-11) and **Google PSE JSON API** (closed to new customers, ends 2027-01-01).

### 4.2 What actually discriminates between providers for this task

1. **Freshness on continuously updated pages.** Pricing pages don't get a new "published date" when the price changes. Tavily's docs say outright that date filters may *drop* such pages and recommend `max_age_hours` instead. So the decisive capabilities are a **forced fresh fetch inside search** (Exa, Tavily, Parallel) and a **last-updated** signal (Perplexity is the only one with an explicit `last_updated` field). This is the strongest response to the index-lag problem (Stage 1, H6).
2. **Official-source targeting.** "Search hubspot.com for pricing" needs a native domain allow-list. Perplexity's limit of 20 is enough per query, but it is the tightest.
3. **Usable dates on announcements.** For "shipped something big since Monday", we need publication dates on news and blog results. Every candidate's dates are best-effort. **None of them can be trusted blindly**, so the design (§9, Stage 4) treats provider dates as a *hint* and lets dates found in the text override them.
4. **Determinism and observability for evals.** Per-result crawl status codes and cost reporting (Exa) make failure handling and cost tracking explicit.

### 4.3 Recommendation

**Primary: Exa** (`type: "auto"`, `contents.highlights`, `includeDomains` for official sources, `startPublishedDate` for the news intent, and `contents.maxAgeHours: 0` with `livecrawlTimeout` ≤ 5 s for pricing-page intents).

Reasons:
- It is the only candidate with all four discriminators except an explicit last-updated field.
- Inline contents are free for the first 10 results.
- It has the largest domain allow-list.
- Per-result crawl status lets us tell "page unreachable" apart from "no results" in a 200 response, which feeds directly into the "unable to verify" verdict.

**Runner-up: Tavily.** It is the cleanest API, offers `include_domains_mode: "prefer"`, and `max_age_hours` costs nothing extra. Its dates are labelled beta and it publishes no latency figures.

**Worth a test: Perplexity Search.** `last_updated` plus filtering on last-updated is unique and directly relevant to pricing pages. But live fetch is undocumented and the domain list is capped at 20.

**Confidence: medium.** None of the providers documents date accuracy or latency for the modes we would use. **The decision is provisional and gated by a bake-off in Phase 4**:

- **Set-up:** 15 fixed queries (5 pricing pages, 5 recent launches, 5 historical facts), each run against Exa, Tavily and Perplexity on free tiers. Results are recorded to disk.
- **Metrics:**
  - official-domain hit rate in the top 3
  - share of results with a non-null date
  - date correctness against a manual check (5 items per provider)
  - p50/p95 latency
  - whether the pricing page text actually contains the current price
- **Cost:** roughly an hour of work and under $1 in API spend.
- **Rule:** if Exa loses on official-hit rate or freshness by a clear margin, switch. The adapter boundary makes switching a one-file change.

**Rejected:**
- SerpAPI: no page content, legal and ToS risk, most expensive.
- Brave Web Search: snippets only. Brave LLM Context is viable but has no domain allow-list and its price is unverified.
- Linkup: no per-result dates, which is disqualifying for temporal work.
- Firecrawl and Jina: crawl-first products with weaker date metadata.

---

## 5. LLM providers and configuration

### 5.1 What each stage needs

| Stage | Needs | Doesn't need |
|---|---|---|
| Turn analysis: intent, temporal expressions, entity refs, research plan | Reliable structured output, low TTFT, cheap | Deep reasoning or long output |
| Evidence extraction (§2 L2) | High-precision structured extraction over ~15k tokens of untrusted text; verbatim quoting; refusing to infer | Streaming |
| Synthesis | Streaming prose, citation discipline, honest hedging | Huge context |
| T3 judge | Cheap, structured, *different* from the synthesiser if possible | Streaming |

### 5.2 Candidate matrix (official pricing per 1M tokens, in/out)

| Provider | Small tier | Mid tier | Structured output | Notes |
|---|---|---|---|---|
| **Anthropic** | `claude-haiku-5-5` $0.10 / $0.50 (≤100K prompt) | `claude-sonnet-5-5` $2 / $10; `claude-opus-5-5` $4 / $20 | `output_config.format` JSON schema; `strict: true` on tools | Haiku 5.5 thinking can be disabled at effort ≤ high. Sonnet 5.5 turns thinking off via `{type:"between_tools"}`. Forced `tool_choice` returns 400 on Sonnet/Opus 5.5, so use structured outputs. Prompt caching; 1M context. Built-in citations exist but are **incompatible with `output_config.format`** |
| **OpenAI** | `gpt-6-luna` $0.10 / $0.50 | `gpt-6.1-terra` $1 / $5; `gpt-6.1-sol` $2 / $10 | Strict JSON schema; mechanism not documented as constrained decoding [UNVERIFIED]; streams | Chat Completions lacks function calling on Sol/Astra, so use the Responses API. Cache *writes* cost 1.25× |
| **Google** | `gemini-3.5-flash-lite` $0.30 / $2.50 | `gemini-3.8-flash` $0.75 / $3.75 (**doubles 2027-01-01**); `gemini-4-*` $2→$4 from Dec 1 | **Documented constrained decoding**; streams partial JSON | **Thinking cannot be fully disabled.** Flash at default medium thinking shows ~12 s TTFT [3P]. Announced price increases |
| **Groq / Cerebras** | `gpt-oss-20b/120b`, very fast | – | Constrained decoding | **Groq structured outputs can't stream or use tools; dev tier 8K TPM** blocks our 15k evidence call. Cerebras schema text budget is 5,000 chars |

Latency, all [3P] from Artificial Analysis TTFT including reasoning:
- GPT-6 Luna non-reasoning: 1.6 s
- Terra at low effort: 2.8 s
- Sol at low effort: 2.75 s
- Gemini 3.8 Flash at low: 4.3 s; at medium: 12.3 s

**Claude TTFT was not captured in this research [UNVERIFIED]**, so it must be measured in Phase 4.

### 5.3 Recommendation

| Stage | Model | Settings | Why |
|---|---|---|---|
| Turn analysis (merged with planning, §10) | `claude-haiku-5-5` | thinking disabled, structured output | Cheapest viable tier and latency-critical. It sits on the critical path before any search |
| Evidence extraction | `claude-sonnet-5-5` | effort `low`, structured output | **The quality-critical step.** Every verdict depends on it. ~$0.045 per turn is worth it. Haiku is the eval-gated downgrade path |
| Synthesis | `claude-sonnet-5-5` | effort `low`, streaming | Citation discipline and honest hedging matter more than speed here, and streaming hides the latency |
| T3 judge | `claude-haiku-5-5` | thinking disabled, structured output | Cheap, and a different model from the synthesiser |

- **SDK:** use the native `@anthropic-ai/sdk` behind our own `LlmPort`, which has three methods: `structured<T>(schema, prompt)`, `stream(prompt)` and `judge(...)`. Why not the Vercel AI SDK v7? Our surface is tiny. The abstraction lags new provider features (effort, `between_tools`, structured-output strictness flags), and v6 already deprecated `generateObject`, which is churn. A thin port we own keeps provider swaps possible and keeps the code explainable in an interview.
- **Confidence: medium.**
  - OpenAI (`gpt-6-luna` plus `gpt-6.1-terra`/`sol`) is a near-equivalent alternative at the same price points, with third-party latency data available.
  - Gemini is the weakest fit *for this latency profile* because its thinking can't be turned off and it has announced price rises.
  - The choice of Claude rests on one SDK and one key for all four stages, structured outputs, prompt caching, and my much deeper verified knowledge of its API surface, which lowers implementation risk. It does **not** rest on a measured latency advantage.
  - **Reconsider if** Phase-4 measurement shows Haiku 5.5 TTFT p50 > 2 s for the analysis call.

### 5.4 Cost per research turn (5-entity CRM example)

Assumptions **[HYPOTHESIS]**: 10 searches, 28k input and 3.1k visible output tokens across calls, thinking excluded.

| Item | Cost |
|---|---|
| Turn analysis (Haiku: 2–3k in / 400 out) | ~$0.0005 |
| Evidence extraction (Sonnet: 15k in / 1.5k out) | ~$0.045 |
| Synthesis (Sonnet: 8k in / 800 out) | ~$0.024 |
| T3 judge (Haiku: 3k in / 300 out) | ~$0.0005 |
| **LLM subtotal** | **~$0.07** |
| Exa search, 10 × `auto` at $7/1k | **~$0.07** |
| **Total** | **~$0.14 per heavy research turn** |

A memory-only turn ("what did I ask on 3 Nov?") costs well under $0.01.

**Takeaway:** searches cost as much as the LLM calls, so the search budget is a real cost lever and not just a latency lever.

---

## 6. Persistence and retrieval

### 6.1 Database matrix

| Option | Setup for evaluator | FTS | Temporal queries | Risk | Verdict |
|---|---|---|---|---|---|
| **better-sqlite3 13.0.3** (pin exactly; **13.1.0 is broken on Win-arm64**) | `npm install` only. N-API prebuilds ship in the package; compiles from source if no prebuild matches | **FTS5 compiled in** (bm25, external-content tables, snippet/highlight) | Indexed INTEGER epoch-ms columns | Native module, so an exotic platform could need a compiler. Sync API (fine at this scale) | ✅ **Selected** |
| `node:sqlite` | Zero native install | FTS5 enabled | Same | Experimental on Node 22/24 and Release Candidate only from v25.7. Evaluator may see warnings; immature API | Fallback if better-sqlite3 install fails. The repository layer is the same SQL either way |
| PGlite (wasm Postgres) | Zero install | tsvector [UNVERIFIED in PGlite], pg_trgm | Excellent | **Self-declared Alpha**, single connection | ❌ Too immature for a graded submission |
| Postgres via Docker | Docker required | Full | Excellent | Setup burden breaks the `npm install && npm run dev` contract | ❌ No demonstrated need. This is the evolution path for multi-user production |
| sql.js | Zero install | **No FTS5** | – | No persistence | ❌ |
| libsql | Native deps | FTS5 issue reported in replica mode | – | Turso-oriented | ❌ No benefit over better-sqlite3 |

**Settings:** `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, and `engines: { node: ">=22" }` in package.json.

**Query layer:** hand-written SQL migrations plus a typed repository module using prepared statements, with zod validating rows at the boundary.
- Drizzle was considered. It can't declare FTS5 virtual tables (open issue; community-sourced), so the hardest part of the schema would be raw SQL anyway, and ~10 tables don't justify an ORM.
- **Confidence: medium.** This is reversible and low-stakes. Drizzle would be equally defensible.

**Time representation:** `INTEGER` epoch milliseconds in UTC for every instant, plus `tz TEXT` (IANA) captured on each user message. "Local day" filters are computed in code (UTC instants for local midnight to midnight) and passed as range bounds. The SQL stays index-friendly and the timezone logic lives in one tested module.

### 6.2 Retrieval: do we need embeddings?

Our retrieval questions, in order of importance:

| Query type | Example | Best mechanism |
|---|---|---|
| Date-scoped | "What did I ask on 3 Nov?" | **Structured SQL**: `user_id` + `created_at BETWEEN` on an index. Exact; no ranking needed |
| Date + topic | "Last Tuesday … Postgres hosting" | SQL date filter, then **FTS5 bm25** within the window. The candidate set is tiny (one or two days) |
| Entity-scoped | "the 5 CRM tools we shortlisted" | **Structured SQL** over `decisions`/`entity_mentions` tables populated at write time |
| Topic only, no date | "When we talked about databases…" | FTS5 bm25 over messages, plus **write-time topic tags and aliases** |
| Paraphrase across vocabulary | "managed Postgres" vs "Neon/Supabase pricing" | The only case where embeddings help, and it is the rarest |

**Decision: no embeddings in v1.** The approach is SQL + FTS5 + write-time enrichment + LLM disambiguation over a short candidate list.
- **Write-time enrichment:** when a turn is persisted, the turn-analysis output (already computed, so zero extra calls) stores normalised entities, aliases and topic tags (`postgres`, `managed-database`, `neon`, `supabase`) into an FTS-indexed column. This moves the semantic matching to write time, where it is free, instead of read time, where it would need a vector index.
- **Disambiguation:** the top ≤ 8 candidates (snippet, timestamp, topic tags) go to the turn-analysis call, which is already structured, so it picks the referenced conversation or flags ambiguity. This adds no extra call.
- **Why not embeddings now:**
  - (a) Anthropic has no embeddings endpoint, so embeddings mean a second API key (OpenAI/Voyage) or a local model.
  - (b) A local model (transformers.js) **downloads from Hugging Face at first run**: a hidden network dependency, a ~23 MB model, plus `sharp`/onnxruntime native modules.
  - (c) `sqlite-vec` is pre-v1 with no Windows-arm64 build.
  - (d) With date filters, candidate sets are tiny, so lexical retrieval has little to lose.
- **Reconsideration criterion:** the Phase-11 eval includes a paraphrase-retrieval category (≥ 10 cases). If FTS5 + enrichment recall@5 falls below 90% there, add `sqlite-vec` with a local quantized MiniLM, model vendored or prefetched at `npm install`, behind the existing `RetrievalPort`.
- **Confidence: high** that embeddings are unnecessary for the graded scenarios. **Medium** for open-ended topic recall.

---

## 7. Latency model and targets (R3)

### 7.1 The three clocks

| Metric | Definition | Why it matters |
|---|---|---|
| **TTFP**: time to first progress | Request received → first SSE `progress` event shown | Users stop worrying once they see that the agent understood them |
| **TTFT**: time to first answer token | Request received → first synthesis token | Perceived responsiveness |
| **TTC**: time to complete | Request received → final event (answer, citations verified, patch applied) | Total cost of the turn; evaluator patience |

### 7.2 Critical path of a heavy research turn [HYPOTHESIS, to be measured in Phase 4/12]

```
t=0      request in ─▶ load conversation window + candidate memory (SQL/FTS)          ~10–50 ms
         SSE progress: "Reading your question…"                                       TTFP ≈ 0.1 s
t≈0.05   Turn analysis + plan (Haiku, structured, ~2.5k in / 400 out)                 ~1–2.5 s
         SSE progress: "Found Monday's shortlist: A, B, C, D, E. Checking pricing and releases…"
t≈2      10 searches, concurrency 5, per-query timeout 6 s (live crawl ≤ 5 s)         ~1.5–6 s (p95 bounded by timeout)
         SSE progress per entity as results land
t≈6      Evidence extraction (Sonnet, ~15k in / 1.5k out) — split per entity, parallel ~3–6 s
         T1/T2 checks (code)                                                          <10 ms
t≈10     Synthesis streaming (Sonnet)                                                 TTFT +1–3 s, stream ~4–8 s
         T3 judge runs on completed sentences in parallel with the stream tail        +0–2 s after stream end
t≈18–22  final `verification` patch event; persist (single transaction)               TTC
```

### 7.3 Targets

| Turn type | TTFP p50 | TTFT p50 / p95 | TTC p50 / p95 |
|---|---|---|---|
| Chit-chat / no research ("thanks", clarification) | < 0.3 s | < 2.5 s / 5 s | < 5 s / 9 s |
| Memory-only ("what did I ask on 3 Nov?") | < 0.3 s | < 3.5 s / 6 s | < 7 s / 12 s |
| Single-entity research | < 0.3 s | < 9 s / 15 s | < 15 s / 25 s |
| Multi-entity change audit (5 entities) | < 0.3 s | < 13 s / 22 s | < 25 s / 40 s |

These targets are **commitments to measure, not claims**. DESIGN.md will publish *measured* p50/p95 from the eval run alongside the targets, including any misses.

**Levers ranked by impact:**
1. Merge intent, temporal and planning into one call (saves a full LLM round trip, ~1–2 s).
2. Split extraction per entity and run it in parallel (turns ~5 s serial into ~2–3 s).
3. Strict per-query search timeouts plus partial results ("couldn't verify HubSpot within time budget"). This is better than a slow complete answer.
4. Skip search when turn analysis says memory or conversation alone suffices.
5. A 24-hour search result cache keyed by normalised query and parameters, applied **only** to non-freshness intents. Change audits always bypass it.

---

## 8. Isolating seeded evaluation data (R4)

| Concern | Mechanism |
|---|---|
| Seeds must never touch real data | **Separate database file**: `data/app.db` (real) vs `data/demo.db` (seeded), chosen by `APP_MODE=real` (default) or `demo`. The seed script **refuses** to run against a DB without `meta.mode='demo'` |
| Fixture identity | Seeded users have `users.kind='fixture'` and a scenario ID. Every seeded row carries `origin='fixture'` |
| Fake baselines must not cause fake "changes" | Seeded historical assertions are **real recorded research runs** (record mode on a real date, exported with original timestamps), **not** hand-written prices. If any hand-authored fixture exists, its L1 snapshots are `origin='fixture'`, and the agent's change report states "baseline is seeded test data" |
| Reproducible dates | **Relative backdating**: fixtures are stored as offsets ("now − 8 days, 10:14 local") and materialised at seed time, so "last Tuesday" works whenever the evaluator runs it. A `--anchor=2026-11-11` flag gives exact reproduction |
| Deterministic tests | `Clock` port: real clock in prod, `FixedClock` in tests, **never** a global time override in demo mode, so live search and stored timestamps stay consistent. `SearchPort` has a `RecordReplaySearch` adapter: tests run offline from recorded JSON; `EVAL_LIVE=1` runs against the real APIs |
| Visibility | Demo mode shows a persistent UI banner "Demo data loaded (scenario: crm-shortlist)", and `/api/health` reports the mode |

---

## 9. Memory ownership and integrity (R5)

Guiding rule: **history is immutable and owned by the record; belief is derived and owned by the evidence.**

| Scenario | What happens to history (L1–L3) | What happens to belief (L4) | What the user sees |
|---|---|---|---|
| **A previous claim is corrected** by new evidence | New L2 evidence and a new L3 assertion are appended. The old assertion gets an event: `superseded_world_changed` (old evidence was right then) or `retracted_was_wrong` (old evidence didn't support it, or was stale at retrieval time) | Recomputed from the newest *verified* evidence | "On 3 Nov I said $90. That matched the pricing page then. It now shows $100 (retrieved today)." Or: "My 3 Nov answer was wrong: the source I used was already outdated." |
| **A source becomes unavailable** | L1 snapshot keeps the excerpt, hash and retrieval time. The live page is never needed to reproduce history. Short excerpts only (copyright); never full pages | Evidence from it stays valid *as of its retrieval date*. A re-check failure is recorded on the source (`last_check: unreachable`); belief is **not** invalidated | "Source no longer reachable; as retrieved on 3 Nov it stated …" Unreachability is never presented as "no change" |
| **Multiple sources disagree** | All conflicting L2 items stored | Status `contested`. Code ranks by source tier (official vendor domain > reputable secondary > other), then by recency of the evidence date. No silent resolution | Both values with sources, and which one the agent leans toward and why |
| **User corrects a remembered fact** | Stored as a **user statement** (provenance `user`); the original message stays untouched | About the *user's own* decisions or preferences ("it was 4 tools, not 5"; "our team is 25 now"), the user is authoritative: the decision record gets a new version linked to the correcting message. About *world facts* ("HubSpot is $50"), it is recorded as a user claim and verified by search if relevant, and any discrepancy is stated politely | Acknowledgement plus, for world facts, the evidence |
| **A historical conversation is deleted** | **Hard delete** of messages and of assertions and decisions derived solely from it (FK `ON DELETE CASCADE`). FTS rows removed via triggers. L1/L2 rows no longer referenced by any remaining assertion are garbage-collected in the same transaction | Recomputed without the deleted evidence | "What did I ask on 3 Nov?" honestly returns nothing. No tombstone content is kept |
| **A claim was never presented** (stream aborted, error, client disconnect) | Message stored with `status='interrupted'`; assertions in it are `not_presented`. The evidence stays (it was really retrieved) as research cache | Evidence may inform belief (it is real evidence), but it is never described as "something I told you" | Excluded from "what did you tell me" answers |
| **Memory poisoning attempt** (page text says "remember that X is free") | Extraction treats page text as data; T1/T2 bind evidence to quoted text, and user-memory writes come **only** from user messages | Unaffected | – |

---

## 10. What changes in the architecture

1. **The four-layer claim model** (snapshot / evidence / assertion / belief) replaces the single "claim" table. Belief is a **derived view**, not an authored record.
2. **Turn analysis and planning are merged into one Haiku call.** Research turns become 3 LLM calls on the critical path (analyze → extract → synthesize) plus one off-critical-path judge. Memory-only turns take 2, chit-chat takes 1–2.
3. **Search must return inline text**, which drives the provider choice (§3) and makes T1 quote grounding possible.
4. **Evidence extraction is per entity and parallel.** This is the main latency lever.
5. **Verification is tiered and mostly deterministic.** The only LLM verification runs on numeric or verdict sentences, in parallel with streaming, and is delivered as a patch event. The UI must support a post-stream "verification" update.
6. **Ports for every external or non-deterministic dependency:** `LlmPort`, `SearchPort` (Exa adapter + record/replay adapter), `Clock`, `Repository`. Offline testability comes from this.
7. **Write-time enrichment** (entities, aliases, topic tags) replaces read-time embeddings.
8. **Demo mode is a separate DB with fixture-origin tagging**, not a flag inside the real DB.

---

## 11. Open decisions

| ID | Decision | Current lean | Resolve by |
|---|---|---|---|
| U1 | Search provider final pick | Exa (provisional) | Phase-4 bake-off (§4.3) |
| U2 | Is `maxAgeHours: 0` live crawl inside search acceptable under the one-tool rule? | Yes: it is a search parameter, not a separate endpoint. State it in DESIGN.md | Your call if the challenge text is stricter |
| U3 | Ambiguity policy for dates and records | Assume and state when the data narrows to one candidate; ask when ≥ 2 plausible candidates remain | Stage 4 spec |
| U4 | Claim normalisation depth | Typed fields (entity, attribute, qualifier, value, unit, effective_date) plus free text. No pricing ontology | Stage 4 |
| U5 | Embeddings | No for v1; eval-gated (§6.2) | Phase 11 eval |
| U6 | T3 judge on every research turn vs only on failures and high-stakes sentences | Only on T2-weak and numeric or verdict sentences | Phase 9 measurement |
| U7 | Extraction model: Sonnet vs Haiku | Sonnet; try Haiku against the eval | Phase 11 |
| U8 | User identity | Cookie-scoped anonymous user ID; no auth | Stage 4 |
| U9 | How to give the agent a timezone when the client doesn't send one | Browser `Intl` timezone on every request; default UTC and state it | Stage 4 |
| U10 | Frontend weight | Minimal Vite + React (or plain HTML + SSE) | Stage 6 |
| U11 | Does the transport for streaming patches (SSE event types) need a resumable stream? | No; idempotent final fetch on reconnect | Stage 4 |

---

## 12. Final recommendations with confidence

| Area | Recommendation | Confidence | What would change it |
|---|---|---|---|
| Search provider | **Exa** (`auto`, highlights, includeDomains, startPublishedDate, `maxAgeHours: 0` for pricing intents) behind `SearchPort`; Tavily runner-up | **Medium** | Bake-off: official-hit rate, date accuracy, p95 latency |
| One-tool interpretation | One search API, many calls; no `/contents`/`/extract`; no self-fetching; no LLM built-in search | **High** | Stricter challenge wording |
| LLM | Anthropic: Haiku 5.5 for analysis and judging, Sonnet 5.5 (low effort) for extraction and synthesis; native SDK behind `LlmPort` | **Medium** (provider) / **High** (two-tier split) | Measured TTFT; eval quality of Haiku extraction |
| Database | SQLite via **better-sqlite3 13.0.3 (pinned)**, WAL, FTS5 external-content tables; `node:sqlite` as fallback | **High** | Install failures on evaluator platforms |
| Query layer | Hand-written SQL + typed repository + zod | **Medium** (low-stakes either way) | – |
| Retrieval | SQL time/entity filters + FTS5 bm25 + write-time enrichment + LLM disambiguation over ≤ 8 candidates; **no embeddings** | **High** for graded scenarios | Paraphrase recall@5 < 90% in eval |
| Claim model | Four layers, append-only events, derived belief | **High** | – |
| Citation verification | T0 ID integrity → T1 verbatim quote → T2 field binding → T3 selective judge | **High** (design) / **Medium** (T3 cost-benefit) | Phase-9 measurements |
| Latency targets | §7.3 as measured targets, not claims | **Low–medium** until measured | Phase 4 instrumentation |
| Seed isolation | Separate demo DB, fixture origin tags, relative backdating, Clock + record/replay ports | **High** | – |

---

## Appendix A: Official documentation references

**Search**
- Exa:
  - https://docs.exa.ai/reference/search
  - https://exa.ai/docs/search/best-practices.md
  - https://exa.ai/pricing
  - https://docs.exa.ai/reference/rate-limits
  - https://exa.ai/docs/changelog
  - https://exa.ai/docs/admin/error-codes.md
- Tavily:
  - https://docs.tavily.com/documentation/api-reference/endpoint/search
  - https://docs.tavily.com/documentation/best-practices/best-practices-search
  - https://docs.tavily.com/documentation/rate-limits
  - https://docs.tavily.com/documentation/api-credits
- Perplexity:
  - https://docs.perplexity.ai/docs/search/overview.md
  - https://docs.perplexity.ai/getting-started/pricing
- Parallel:
  - https://docs.parallel.ai/search/modes
  - https://docs.parallel.ai/api-reference/search/search
  - https://parallel.ai/pricing
- Brave:
  - https://api-dashboard.search.brave.com/documentation/services/llm-context
  - https://api-dashboard.search.brave.com/api-reference/web/search/get
  - https://brave.com/search/api/
- SerpAPI:
  - https://serpapi.com/pricing
  - https://serpapi.com/search-api
  - https://serpapi.com/status
- You.com: https://you.com/docs/api-reference/search/v1-search
- Linkup: https://docs.linkup.so/pages/documentation/api-reference/endpoint/post-search
- Bing retirement: https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- Google PSE: https://developers.google.com/custom-search/v1/overview

**LLM**
- Anthropic: model table, structured outputs, thinking/effort, server tools and pricing from the official Claude API skill reference bundled with Claude Code (cached 2026-10-06). Live pricing at https://docs.claude.com (see the Pricing page).
- OpenAI:
  - https://developers.openai.com/api/docs/models
  - https://developers.openai.com/api/docs/pricing
  - https://developers.openai.com/api/docs/guides/structured-outputs
  - https://developers.openai.com/api/docs/guides/reasoning
  - https://developers.openai.com/api/docs/guides/prompt-caching
- Google:
  - https://aistudio.google.com/docs/models
  - https://aistudio.google.com/docs/pricing
  - https://aistudio.google.com/docs/structured-output
  - https://aistudio.google.com/docs/thinking
- Groq:
  - https://console.groq.com/docs/structured-outputs
  - https://console.groq.com/docs/rate-limits
- Cerebras: https://inference-docs.cerebras.ai/capabilities/structured-outputs
- Vercel AI SDK:
  - https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
  - https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0
- Latency [3P]: https://artificialanalysis.ai/leaderboards/models

**Persistence**
- better-sqlite3:
  - https://github.com/WiseLibs/better-sqlite3
  - https://github.com/WiseLibs/better-sqlite3/releases
- https://nodejs.org/api/sqlite.html
- https://www.sqlite.org/fts5.html
- https://github.com/asg017/sqlite-vec
- https://pglite.dev/docs/
- https://orm.drizzle.team/docs/get-started-sqlite
- https://kysely.dev/docs/dialects
- https://huggingface.co/docs/transformers.js/tutorials/node
