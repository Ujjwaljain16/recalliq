# DESIGN.md Blueprint

This file plans `DESIGN.md` as a deliverable in its own right. It covers how the document will tell the story, how it labels claims, which evidence each claim needs, and how the implementation produces that evidence.

Part 7 contains draft prose for the sections that don't depend on implementation results.

---

## 1. The story the document tells

The story moves through **problem, insight, design, trade-offs, evidence, limitations.** One idea runs through all of it, and the reader should reach it naturally rather than be told it as a slogan:

> All three example questions compare what was said or known at one time with what is true now. Search isn't the hard part. The hard part is keeping trustworthy records of past claims, knowing exactly when things were said and observed, and refusing to report a difference or a non-difference that the evidence doesn't establish.

Each later section should read as a consequence of that idea:

| Section | Is a consequence of... |
|---|---|
| Memory | We have to find the record. |
| Temporal reasoning | We have to place the record in time, and place new evidence in time too. |
| Research | We have to gather evidence that can actually show a change. |
| Evidence and citations | We have to prove the evidence says what we claim it says. |
| Belief and change | We have to decide what is true now, and whether it differs from what we said then. |
| Streaming | We must not show unverified claims as verified. |
| Evaluation | We have to show that all of the above works, and where it doesn't. |

A reader who stops after section 1 should already understand why the system has more structure than a chatbot, and why that structure is in proportion to the problem.

---

## 2. How claims are labelled

### Status vocabulary

Every capability or performance statement in DESIGN.md falls into one of these categories. Section 13 holds one **capability status table**. Elsewhere, the wording carries the label, so the prose doesn't fill up with bracketed tags.

| Status | Meaning | Wording in prose |
|---|---|---|
| Designed | Specified, not built | "The design calls for…", "is not implemented" |
| Implemented | Code exists, with no dedicated test | "is implemented" (rare; we try to avoid this state) |
| Tested (unit) | Pure-function or module tests | "unit-tested" |
| Tested (replay) | End-to-end through the orchestrator, with recorded or synthetic search and LLM responses and a fixed clock | "in our replay suite" (always say these are recorded or mocked) |
| Tested (live) | Run against the real Exa and Anthropic APIs on a stated date | "in a live run on <date>" |
| Measured | A number taken from instrumentation, with the sample size and date | "p50 of N s over M turns (live, <date>)" |
| Hypothesis | Our expectation, not measured | "we expect", "we have not measured" |

### Language rules

- Never write "verified" about a citation unless T1 and T2 actually ran on it. "Validated URL" means only T0.
- Never write "changed since X" unless the verdict is `changed`, and give the change window or the stated effective date. When the value differs but the timing is unknown, say exactly that.
- Keep "when we observed it" separate from "when it took effect". A fresh fetch shows what a page said on that day. It doesn't show when the page started saying it.
- Say "shown to the user" only for sentences the client confirmed it rendered. Streamed-but-unconfirmed sentences are described as such.
- Never write "no change" without the coverage that supports it: how many sources were checked, whether the official page was freshly fetched, and the newest date seen.
- Every number comes with its source: which run, the sample size, the date, and whether it was live or replay.
- Each target sits next to the measured value, including any target we missed.
- "Comprehensive", "robust", "production-ready" and "scalable" appear only with evidence attached, so in practice not at all.

---

## 3. Outline and plan for each section

Each entry lists what the section has to answer, the evidence it relies on, and its approximate length. The sequence matches the outline given in the brief, with one change: **Belief and change detection** becomes its own section (between Evidence and Data model), because it is the most important argument in the document.

| # | Section | Must answer | Evidence it relies on | Length |
|---|---|---|---|---|
| 1 | Introduction | What we built, the problem, the insight. A three-sentence walkthrough of "Last Tuesday I asked about Postgres hosting…" | Link to the demo scenario | ~350 words |
| 2 | Understanding the challenge | Why search-and-summarize fails each example; the hidden requirements (dates and timezones, baselines captured when written, three-way "still correct", index lag, knowing when not to search, user identity) | — | ~600 |
| 3 | Design principles | Six principles, each with *one* concrete consequence in the system | — | ~350 |
| 4 | Architecture overview | Context diagram, the five lanes, component responsibilities, lifecycle sequence, state machine. **Why not a single agent loop, and why not multi-agent** (compact matrix of 4 options, top 5 criteria only; the full matrix is in `docs/adr/`) | Diagrams; LLM-call counts per lane from metrics | ~900 + 3 diagrams |
| 5 | Conversational memory | Finding records by exact date, by date plus topic, and by entity; the clarify policy; write-time enrichment; why FTS5 rather than embeddings; user isolation; corrections and deletion | Memory eval category results; the paraphrase-recall measurement | ~700 + 1 diagram |
| 6 | Temporal reasoning | The timestamp taxonomy, centred on observed time vs effective time (table); resolution rules; DST and timezones; **how "the world changed", "we were wrong" and "it's different, but we can't tell when" are told apart** (decision diagram); why the third answer is common, and that this is honest | Temporal unit table count; T-BEL-20..27; verdict distribution from live runs | ~850 + 1 diagram |
| 7 | Research orchestration | Lane routing, query templates, fresh fetch of official pages, fallback ladder, budgets, stopping rules; how "one tool" was interpreted | Search counts per turn (measured); bake-off summary | ~600 |
| 8 | Evidence and citation integrity | The four layers; snapshots; extraction batching (why adaptive); T0–T3, with what each **catches and misses**; subject binding (a page title proves nothing, worked through on a comparison-article example); explicit currency and unit evidence (a bare `$` stays unknown); placeholders ("code writes the facts"); streaming verification and sentence-level delivery | Verifier test table; adversarial evidence cases; measured weak rate by check; T3 flag rates | ~1,100 + 1 diagram |
| 9 | Belief and change detection | Typed belief keys (why a promotion never overwrites a list price); authority, then freshness, then recency; contested; the verdict taxonomy, including `differs_timing_unknown`; why "nothing found" is never "unchanged" | Belief and verdict unit tests; recorded audit example | ~700 |
| 10 | Data model and persistence | SQLite rationale; ER diagram (core tables only); append-only rules; derived beliefs (rebuild command); key indexes; transactions | `beliefs:rebuild` equivalence test | ~500 + 1 diagram |
| 11 | Reliability and failure handling | Compact failure matrix; partial results; disconnects and the presentation ack; crash recovery; idempotency | Fault-injection replay cases | ~500 |
| 12 | Security | Untrusted content boundary; memory-poisoning defence; key handling; isolation; abuse limits | Injection and poisoning eval cases | ~450 |
| 13 | Performance and cost | Calls per lane; the latency budget; **measured p50/p95 next to targets**; tokens and dollars per turn; cache hit rate | `eval/results/perf-<date>.json` | ~450 + 1 table |
| 14 | Evaluation | Methodology; the three data classes; categories and severity; **capability status table**; latest replay and live results, including failures; reproduce commands | Eval reports | ~800 |
| 15 | Decisions and trade-offs | 8–10 short decision narratives (problem, alternatives, choice, trade-off, when we'd revisit). Prose, not a list of ADRs | Links to `docs/adr/` | ~900 |
| 16 | Known limitations | What we can't establish (exact change dates, index lag, vendor errors); heuristic limits (English-only T2, domain detection); untested areas | Limitations register (§5) | ~450 |
| 17 | Running locally | Prerequisites, `.env`, install, dev, tests, eval, demo mode | Commands verified on a clean clone | ~300 |
| 18 | Future improvements | Only items that trace back to a limitation in §16 | — | ~200 |

The total target is about 10,000–11,000 words. The **upper limit is 12,000 words**, and anything past it moves to `docs/`.

### Decision narratives for §15

Each narrative is roughly 80–120 words of prose. Section 15 ends with links to the full ADRs.

| Decision | One-line framing for the narrative |
|---|---|
| Single agent vs multi-agent | Where the agent gets autonomy and where it doesn't: routing and verification are code, and language understanding is the model's job |
| Planner-executor with lanes | Why "thanks!" and "what did I ask on 3 Nov?" should never trigger a search |
| Search provider | Why the decisive feature was fresh fetching of pricing pages, plus the bake-off numbers |
| Model selection | Splitting into two model tiers, measured latency, and the bias disclosure |
| SQLite vs Postgres | The `npm install` requirement and single-writer reality, and when we'd move |
| FTS5 vs embeddings | Write-time enrichment, and the measured paraphrase recall that would change our mind |
| Four-layer claim model | The bug it prevents: describing a source's claim as our own, or describing our own past error as a change in the world |
| Citation verification | ID mapping is necessary but not sufficient; the tier-confusion example |
| Batched vs parallel extraction | Measured wall time, and how far a single failure spreads |
| Streaming verification | Findings first, placeholders, and sentence-level patches. Why we chose not to hold back sentences |
| Observation vs effective time | How design review showed that a fresh fetch can't date a change, and the verdict that came out of it |
| Delivery acknowledgement | Why "what did I tell you" depends on what the browser rendered, sentence by sentence |
| One turn deadline | Why per-call timeouts weren't enough once retries entered the picture |
| Demo data isolation | Why seeded baselines must never be invented prices, and the database trigger that enforces the separation |

### Diagrams to maintain

Each diagram lives in `docs/diagrams/*.mmd` and is embedded in DESIGN.md. Each one is checked against the code in the doc-drift review (§6).

1. System context.
2. Lanes and components (one diagram, not two).
3. Audit-turn sequence.
4. Turn state machine.
5. Memory read/write paths.
6. Evidence pipeline.
7. Change-verdict decision flow.
8. Core ER diagram (about 8 tables).

These eight are the only diagrams. Anything decorative is cut.

---

## 4. Documentation evidence checklist

These are the claims DESIGN.md will make, and the artifact that has to exist for each one. Nothing gets written into DESIGN.md without its artifact.

### 4.1 Metrics to instrument

All metrics are captured in `TurnMetrics`, stored in `turns.metrics_json`, and aggregated by `npm run report:perf`.

| Metric | Where it's captured | Used in |
|---|---|---|
| TTFP, TTFT and TTC per turn, split by lane | Orchestrator timestamps | §13 |
| LLM calls per turn by role; input, output and cache tokens; latency per call; model ID | LlmPort wrapper | §4, §13 |
| Searches per turn (ok, failed, cached, round 2 used); provider latency; cost | SearchPort wrapper | §7, §13 |
| Cache hit rate (search cache; prompt cache read tokens) | Adapters | §13 |
| Extraction batches per turn; retries; splits | Batcher and extractor | §8 |
| T1/T2 outcome counts (pass, weak, fail by check); T3a flags; T3b calls and verdicts | Verifier | §8 |
| Verdict distribution per audit turn | ChangeDetector | §9, §14 |
| Error and degradation counts by code | Orchestrator | §11 |
| Weak and fail counts per T2 check (subject, competitor, currency, unit, …); share of price statements with unknown currency | Verifier (`metrics.verification.byCheck`) | §8, §16 (supports U15) |
| Deadline hits; operations refused admission (retries, splits, fallback rounds, judge calls) | TurnBudget | §11, §13 |
| Sentence status counts (verified, no_claims, unverified, unchecked, truncated); ack coverage (rendered_through vs streamed_through) | AnswerPipeline, ack handler | §8, §11 |
| Turns that ended `partial`, `interrupted` or `failed` | Turns table | §11, §14 |

### 4.2 Decisions to record

- `docs/adr/ADR-01..20.md`, one page each. These are short, and they are the source for the §15 narratives.
- **When a decision changes**, the ADR gets a "Superseded" note plus the evidence that changed it. Examples: a bake-off result, or the Haiku extraction eval.

### 4.3 Fixtures to keep

| Fixture | Purpose | Location |
|---|---|---|
| Recorded `crm-shortlist` scenario (Monday shortlist and a later audit) | Demo, §1 walkthrough, regression | `eval/fixtures/recorded/crm-shortlist/<date>/` |
| Recorded `postgres-hosting` scenario (Tuesday question and a later "has pricing changed?") | Example 3, regression | `eval/fixtures/recorded/postgres-hosting/<date>/` |
| Recorded `nov-3-recall` (several conversations on one day) | Example 2, the clarify policy | `eval/fixtures/recorded/nov-3-recall/` |
| Synthetic: conflicting official sources; earlier answer was already wrong; silent pricing-page change; stale snippet next to a fresh page; injection page; fake announcement; ambiguous tier table; promotion and planned price; per-seat vs flat | Evidence and belief edge cases | `eval/fixtures/synthetic/*` |
| Bake-off raw responses | Justifies the provider choice | `eval/results/bakeoff/<date>/` |
| Live eval runs (dated) | §14 live results | `eval/results/live/<date>/` |

### 4.4 Acceptance tests that back specific claims

The rule is simple: **if DESIGN.md states it, a test with an ID backs it.** Test IDs are cited in the document (for example, "covered by `T-TEMP-07`").

| Claim in DESIGN.md | Test(s) | Kind |
|---|---|---|
| "Last Tuesday" yields two candidates, the data decides between them, and we ask when both match | T-TEMP-01..06 | Unit + replay |
| Local-day boundaries are correct across timezones and DST | T-TEMP-07..12 | Unit |
| Exact-date recall lists every question asked that day, verbatim | T-MEM-01, 02 | Replay |
| Ambiguous topic within a day leads to a clarify question, never an arbitrary pick | T-MEM-03, 04 | Replay |
| A deleted conversation can't be recalled and leaves no orphaned evidence behind | T-MEM-08 | Integration |
| T1 rejects quotes that don't appear in the page | T-EV-T1-* | Unit |
| T2 catches tier, currency, billing-period, negation, promotion and planned-price errors | T-EV-T2-* (≥ 80 cases) | Unit |
| Synthesis never states a web fact outside a placeholder (in persisted messages) | INV-02 across all replay cases | Invariant |
| Every citation resolves to a snapshot retrieved in that turn | INV-01 | Invariant |
| "Unchanged" requires a fresh official fetch | INV-03, T-BEL-* | Invariant + unit |
| A failed search never produces "none found" or "no evidence of change" | INV-04, T-REL-02 | Invariant + replay |
| `baseline_incorrect` is told apart from `changed` | T-BEL-10..14, synthetic `already-wrong` | Unit + replay |
| Beliefs are derived data | T-DB-REBUILD (rebuild equals incremental) | Integration |
| Claims that were never presented aren't recalled as "told" | T-REL-07 (disconnect), T-REL-09 (interrupted) | Replay |
| An injected page can't create memory or override official beliefs | T-SEC-01..04 | Replay (critical) |
| Duplicate POSTs don't create duplicate turns | T-API-IDEMP | Integration |
| A follow-up answered from earlier findings makes zero searches | T-CONV-05 | Replay |
| A bare `$` is never assumed to be USD; explicit markers resolve correctly | T-EV-CUR-01..12 | Unit |
| A page title can't attribute a price; a competitor's price is never attributed to our entity | T-EV-SUBJ-01..10, INV-09, synthetic `comparison-article` | Unit + replay |
| No seat language doesn't mean "flat"; usage pricing needs a metered unit | T-EV-UNIT-01..10 | Unit |
| Promotional, conditional and planned prices never overwrite the list price; planned prices never become current early | T-KEY-01..10, T-BEL-30..36 | Unit |
| A fresh fetch never invents a change date; a value that differs with unknown timing gives `differs_timing_unknown` | T-BEL-20..27, INV-08, synthetic `silent-change-no-date` | Unit + replay |
| Placeholders survive split deltas; malformed or unknown placeholders are dropped and flagged; rendered values aren't flagged as free numbers | T-ANS-01..14 | Unit |
| A partly displayed answer is recorded as partly presented | T-DLV-01..08, INV-05 | Integration |
| Nothing runs past the turn deadline except local persistence | T-BUD-01..08 | Unit + replay |
| Append-only, owner and demo-isolation rules hold at the database level | T-DB-01..10 | Integration |
| Offline replay never calls a live service, and a missing recording fails loudly | T-EVAL-01..03, INV-10 | Integration |

### 4.5 Limitations register

This register lives in `docs/limitations.md`. Each entry has an ID, a description, the evidence that shows it (a test or an observation), and any mitigation. Section 16 of DESIGN.md is drawn from it. Starting entries:

- L-01: Search-index lag. A change can be invisible until the page is re-crawled. This is partly mitigated by fetching official pricing pages fresh.
- L-02: Provider publication dates are best estimates. We treat them as hints and count how often they are missing.
- L-03: When a change happened can only be bracketed between two of our own observations of the same page, or taken from a date stated in the text. Otherwise the answer is "different now, timing unknown". We expect this to be common [HYPOTHESIS; measured as the verdict distribution in live runs].
- L-04: The T2 cue lists are English only and heuristic. Ambiguous cases are downgraded to `weak`, not passed.
- L-05: Official-domain detection is heuristic. It can fail for rebranded products or products whose domain doesn't match their name.
- L-06: A vendor's own pricing page can be wrong or region-specific. Verification proves a source says something, not that it's true.
- L-07: Keyword search misses some paraphrased topics. The measured recall figure goes here.
- L-08: Coverage of open research questions is limited by the fixed query templates.
- L-09: A single-writer database and anonymous cookie identity.
- L-10: Whatever the final adversarial audit finds that we didn't fix.
- L-11: Pages may show regional prices. The search provider's crawler location isn't documented, so a price we observe may not be the one the user sees.
- L-12: A process crash mid-answer loses the streamed text that wasn't persisted. The turn is marked interrupted.
- L-13: Many pricing pages show a bare `$`. Those values stay "currency not stated", and they are only comparable with values from the same vendor domain.
- L-14: A delivery acknowledgement proves the browser rendered a sentence, not that the user read it.
- L-15: Strict subject binding turns some genuine official-page prices into `weak` when the section doesn't name the product. The measured rate goes here (U15).

### 4.6 Generated content, so the document doesn't drift

- `npm run report:eval` and `npm run report:perf` write markdown fragments to `docs/generated/eval-summary.md` and `perf-summary.md`. DESIGN.md §13 and §14 paste these fragments in and cite the file and date. **Nobody types numbers by hand.**
- `npm run docs:check` does three things. It confirms that every test ID cited in DESIGN.md exists in the test suite. It confirms that every linked file exists. And it fails if DESIGN.md contains any banned word (`revolutionary`, `cutting-edge`, `world-class`, `seamless`, `robust`, `production-ready`) outside a quotation. This takes a few lines of script and stops the document drifting from the code.

---

## 5. Writing guide for DESIGN.md

- **Lead with the problem, not the component.** Write "To answer 'has it changed since Monday?' we need what we said on Monday, not just what we remember about it", not "The BaselineLoader loads baselines".
- **One idea per paragraph.** Keep most paragraphs to five sentences or fewer.
- **Each concept is explained once,** in the section where it first matters. Later mentions link back to it.
- **Use real examples from recorded runs.** The CRM and Postgres scenarios do this. Synthetic examples are labelled as synthetic.
- **Tables are for comparisons and taxonomies.** Use one only when a reader would otherwise have to hold more than three items in their head.
- **Call out trade-offs sparingly,** at most one per section, as a short blockquote that starts "Trade-off:".
- **Show code only where it settles something:**
  - the belief-resolution pseudocode
  - the placeholder grammar
  - one event-stream excerpt
- **Name the costs of our own decisions.** A reviewer trusts a design more when it says where the design is weak.
- **Use "we" for decisions, and the passive voice or the system's name for behaviour.** Don't force either.
- **End sections with a fact or a limitation,** never a summary of what was just said.

---

## 6. Doc gates per phase in the roadmap

Every phase's definition of done now includes its documentation slice, so the document is never written all at the end.

| Phase | Doc gate before the phase counts as done |
|---|---|
| 0–1 | §17 draft (commands checked on a clean clone); ER diagram; ADR-04 |
| 2 | ADR-14 and ADR-08 drafts; adapter behaviour described in §7 and §10 |
| 3 | Lifecycle diagram matches the code; §4 skeleton |
| 4 | Bake-off results in `eval/results/bakeoff/`; §7 provider paragraph and ADR-08 finalised; measured TTFT in ADR-14 |
| 5 | §5 and §6 written; T-TEMP and T-MEM IDs exist |
| 6 | §7 finished (budgets, stopping rules) |
| 7 | §8 verification table, including "misses" for each tier |
| 8 | §9 written; verdict diagram matches `ChangeDetector` |
| 9 | Streaming section; SSE excerpt taken from a real recorded turn |
| 10 | Demo mode in §17; data-classes paragraph in §14 |
| 11 | §14 generated summary; capability status table filled in |
| 12 | §13 generated performance table, with targets next to measured values; §11 failure matrix checked by fault tests |
| 13 | Full read-through: `docs:check` passes; word count ≤ 12k; every number traced to an artifact |
| 14 | Limitations register updated with audit findings; §16 and §18 finalised |

**Final review step:** someone who hasn't seen the design reads DESIGN.md and then the code, and tries to answer the nine Staff-Engineer questions from the brief. A question they can't answer is a documentation bug. The same check is done with a fresh Claude session given only the repository.

---

## 7. Draft prose for the sections that don't depend on results

These sections are written in the final voice. Bracketed notes mark facts that must be filled in from evidence later.

### 1. Introduction

This is a chat assistant that answers questions using web search. Most of its design, though, goes into a narrower job: telling you whether something it told you before is still true.

That job comes straight from the challenge. Take *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"* Answering it takes four steps:

1. Work out which day "last Tuesday" means for you.
2. Find what we actually said that day, and which sources it rested on.
3. Find out what those prices are today.
4. Decide whether any difference is a real change, an error in our earlier answer, or something we can't establish.

Search covers only step 3. The other three steps depend on records we have to keep at the moment we answer, because they can't be reconstructed afterwards.

So the system keeps receipts. It stores every source excerpt it reads, every statement it extracts from those excerpts (each tied to a verbatim quote), and every sentence your browser confirmed it displayed. Its view of what's true now is computed from that evidence. Nothing writes it directly.

When you ask whether something changed, the system compares two sets of evidence with known dates, not two paragraphs of prose. Even that comparison has a limit, and it took us a while to state it plainly. Looking at a pricing page today tells you what it says today. It doesn't tell you when it started saying it. So "the price is different now" and "the price changed after we last spoke" are two separate answers. The system gives the second one only when the evidence actually supports it.

Most of the rest of the design follows from taking records seriously. Each turn is routed into a path that fits it, dates are worked out in code, extracted statements are checked against the text they came from, and the model writes the prose while code writes the prices.

[Add one sentence on the measured headline results once available, e.g. replay-suite pass rate and live audit latency, with dates.]

### 2. Understanding the challenge (opening)

The obvious reading of the brief is "a chatbot with a search tool and some memory". That reading handles questions about the present well. It fails on all three examples, for different reasons:

- **"Has any of them changed pricing since Monday?"** You can't answer this by searching the question. The system has to know which five tools were shortlisted, which is in a past conversation and not on the web. It has to know what their prices were then. And it has to look for evidence dated after Monday, which search indexes often don't have yet.
- **"What did I ask you on 3 November? Is your answer still correct?"** The first half needs no search at all, just an exact lookup by date in your timezone. The second half asks something a stateless system can't even express: whether *our own earlier claim* holds up. That claim might fail because the world changed, or because it was wrong when we made it. Sometimes we can't tell which. Those are three different answers, and folding them into one is misleading even when every individual sentence is technically true.
- **"Last Tuesday I asked you about Postgres hosting."** "Last Tuesday" is ambiguous when today is Wednesday. We resolve it by checking which candidate day actually has a matching conversation, and we ask when both do.

A thread runs through all three. The system has to remember what it said, in a form it can check. It has to know when each thing was said and when each piece of evidence was observed. And it has to keep "I found no evidence of a change" separate from "there was no change".

### 3. Design principles

**Correctness over confident guessing.** When the evidence is thin, the answer says so specifically: "I couldn't check Zoho; the search timed out", not "no significant changes found". An empty search result is never reported as "no change", and a different price is never reported as a change after a given date unless we can show when it happened.

**Evidence before synthesis.** Prices and change verdicts are computed and checked before the model writes a single word of the answer. The model writes the narrative. Code inserts the facts through placeholders, so a price in an answer always comes from a checked source.

**Historical records are immutable.** What we told you on 3 November stays exactly as it was. Later corrections are new records that point back to the old one. This is what makes "was I wrong, or did it change?" answerable at all.

**Use deterministic code wherever the decision can be deterministic.** That covers date arithmetic, routing, source ranking, belief resolution and change verdicts. They are ordinary functions with table-driven tests. The model is used for understanding language, extracting statements from pages, and writing prose.

**Bounded autonomy.** The model doesn't decide how many searches to run or when to stop. A plan made from templates, a fixed budget, and one fallback round do. We give up some adaptability on open-ended questions, and we explain that trade-off in §15.

**Simplicity unless complexity pays for itself.** The system is one process, uses one SQLite file, and has no vector index and no agent framework. Each of those was considered, and §15 records what measurement would make us add it.
