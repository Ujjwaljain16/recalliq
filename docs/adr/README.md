# Architecture decision records

One page per decision, recorded 2026-11-11 after milestones 1 and 2. ADR-01 to ADR-24 are the original register from
[architecture.md](../architecture.md), restated against what is actually implemented. ADR-25 to ADR-40 record decisions made
during implementation, and open decisions raised since; they were never in the original register.

**Provenance.** ADR-01 to ADR-24 were reconstructed on 2026-11-11 from the architecture §20 register (one summary row each) and the Stage 3 / 3.1 design documents. They are **not** recovered original ADR text; no earlier pages existed, and each page says so. Where a page cites a rationale, it comes from those documents. **Status** records whether the decision was made; **Implementation** records, separately, what the code and tests do today. ADR-25 to ADR-39 record decisions made


## Statuses

| Status | Meaning |
|---|---|
| **Accepted** | The decision has been made (by the owner, or by an owner-approved design). It does **not** mean it is implemented: see the Implementation column |
| **Proposed** | Not yet decided, or contingent on measurement or review. Nothing here is a settled fact |
| **Superseded** | Replaced by a later ADR, which the page names |

| Implementation | Meaning |
|---|---|
| implemented | Code, migrations and tests exist and pass |
| partly implemented | Some of it exists; the page says exactly what |
| not implemented | A design or a decision only |

Counts: 40 ADRs. Accepted 36, Proposed 3, Superseded 1.
Implemented 14, partly 14, not implemented 12.

**What is not claimed.** The search provider (ADR-08) and the models (ADR-14) are measurement-dependent and remain Proposed: no bake-off has been run and no
latency, accuracy or cost has been measured. The weighted scores behind ADR-01 are the author's judgements. Numeric limits in ADR-09, ADR-10, ADR-15 and ADR-24 are
unmeasured defaults. Ownership (ADR-27) and demo isolation (ADR-28) are enforced only for the tables and columns each page lists.

## Index

| ADR | Title | Status | Implementation | Decision | Related |
|---|---|---|---|---|---|
| [ADR-01](ADR-01.md) | Lane-routed deterministic orchestrator (architecture C) | Accepted | partly implemented | A deterministic coordinator routes each turn into chat, recall, research, audit or clarify; LLMs only understand, extract and write. | [ADR-02](ADR-02.md), [ADR-03](ADR-03.md), [ADR-29](ADR-29.md) |
| [ADR-02](ADR-02.md) | One process with specialised modules; no multi-agent system | Accepted | not implemented | At most four LLM roles (analysis, extraction, synthesis, judge) inside one process; no agent-to-agent coordination. | [ADR-01](ADR-01.md), [ADR-03](ADR-03.md) |
| [ADR-03](ADR-03.md) | Modular monolith; no queues, workers or services | Accepted | partly implemented | One Node process, SQLite in-process, module boundaries as TypeScript interfaces. | [ADR-01](ADR-01.md), [ADR-04](ADR-04.md) |
| [ADR-04](ADR-04.md) | SQLite via better-sqlite3 (pinned), WAL, FTS5 | Accepted | implemented | A local SQLite file through better-sqlite3 13.0.3, with write-ahead logging and FTS5 for text search. | [ADR-05](ADR-05.md), [ADR-25](ADR-25.md), [ADR-26](ADR-26.md) |
| [ADR-05](ADR-05.md) | Retrieval: SQL, FTS5 and write-time enrichment; no embeddings | Accepted | partly implemented | Date-interval SQL first, then FTS5 bm25 within the interval, with entities and topic tags stored when each turn is saved. | [ADR-04](ADR-04.md), [ADR-07](ADR-07.md) |
| [ADR-06](ADR-06.md) | Four-layer claim model with derived belief | Accepted | partly implemented | Source snapshot, evidence statement, assertion, and a belief that is derived by code and never authored by an LLM. | [ADR-13](ADR-13.md), [ADR-21](ADR-21.md), [ADR-22](ADR-22.md), [ADR-26](ADR-26.md), [ADR-32](ADR-32.md) |
| [ADR-07](ADR-07.md) | Temporal resolution in code; ask when several candidates remain | Accepted | implemented | The model extracts a structured date expression; code resolves local-day intervals; exactly one matching candidate is used, several lead to a question. | [ADR-05](ADR-05.md), [ADR-22](ADR-22.md), [ADR-36](ADR-36.md) |
| [ADR-08](ADR-08.md) | Search provider: Exa (provisional) behind a port | Proposed | not implemented | Exa is the working choice; a measured comparison with Tavily and Perplexity must confirm or replace it. | [ADR-09](ADR-09.md), [ADR-14](ADR-14.md) |
| [ADR-09](ADR-09.md) | Research planning: templates, bounded fan-out, one fallback round | Accepted | not implemented | Query plans come from per-intent templates run with bounded concurrency; one fallback round only for keys with no usable evidence. | [ADR-08](ADR-08.md), [ADR-24](ADR-24.md) |
| [ADR-10](ADR-10.md) | Evidence extraction: adaptive batches | Accepted | not implemented | Pack snapshots into batches of at most about 9,000 tokens and 3 entities, retry once, then split per entity. | [ADR-11](ADR-11.md), [ADR-14](ADR-14.md) |
| [ADR-11](ADR-11.md) | Evidence verification tiers T0 to T3 | Accepted | not implemented | Citations come from stored IDs; quotes must appear verbatim; typed fields must bind inside the quote; only comparative sentences go to an LLM judge. | [ADR-12](ADR-12.md) |
| [ADR-12](ADR-12.md) | Code renders facts into answers through placeholders | Accepted | partly implemented | Prices, dates and verdicts reach the user only as placeholders the server fills from checked records. | [ADR-11](ADR-11.md), [ADR-16](ADR-16.md), [ADR-32](ADR-32.md) |
| [ADR-13](ADR-13.md) | Deterministic belief resolution | Accepted | not implemented | Authority tier, then freshness, then recency; disagreement within a window is `contested`, not resolved silently. | [ADR-06](ADR-06.md), [ADR-21](ADR-21.md), [ADR-22](ADR-22.md) |
| [ADR-14](ADR-14.md) | Models: Haiku 5.5 and Sonnet 5.5 behind an LLM port (provisional) | Proposed | not implemented | Haiku for analysis and judging, Sonnet for extraction and synthesis, behind `LlmPort`; to be confirmed by measurement. | [ADR-08](ADR-08.md), [ADR-10](ADR-10.md) |
| [ADR-15](ADR-15.md) | Caching policy | Accepted | not implemented | A search cache that is bypassed for fresh-fetch and recent-date requests; prompt caching on fixed system prompts; no answer cache. | [ADR-09](ADR-09.md) |
| [ADR-16](ADR-16.md) | Streaming: findings first, no hold-back, late verification only downgrades | Superseded | partly implemented | Checked findings are sent before any prose; sentences stream immediately; a late judge result may confirm or downgrade a sentence, never upgrade it. | [ADR-12](ADR-12.md), [ADR-23](ADR-23.md), [ADR-31](ADR-31.md) |
| [ADR-17](ADR-17.md) | A turn runs to completion after the client disconnects | Accepted | partly implemented | The server finishes the turn; what the user was told is decided by acknowledgements, not by completion. | [ADR-23](ADR-23.md), [ADR-24](ADR-24.md), [ADR-31](ADR-31.md) |
| [ADR-18](ADR-18.md) | Test strategy: ports, recorded replay, fixed clock, offline by default | Accepted | partly implemented | External services sit behind ports; tests are offline and deterministic; live runs are separate and explicit. | [ADR-19](ADR-19.md) |
| [ADR-19](ADR-19.md) | Evaluation data classes: recorded, synthetic, live | Accepted | partly implemented | Recorded real runs, synthetic edge cases on fictional `.example` entities, and live runs graded on invariants only, kept apart. | [ADR-18](ADR-18.md), [ADR-28](ADR-28.md) |
| [ADR-20](ADR-20.md) | Identity: signed anonymous cookie | Accepted | not implemented | A signed, httpOnly cookie carries an anonymous user id; no accounts. | [ADR-27](ADR-27.md) |
| [ADR-21](ADR-21.md) | Typed canonical belief key | Accepted | partly implemented | A versioned key encoding entity, plan, arrangement, condition, unit, usage unit, billing period, currency and value kind. | [ADR-13](ADR-13.md), [ADR-37](ADR-37.md), [ADR-22](ADR-22.md) |
| [ADR-22](ADR-22.md) | Observation time kept separate from effective time | Accepted | partly implemented | When we observed a page, when it says a fact took effect, and what the provider reports are separate fields; a fresh fetch never dates a change. | [ADR-36](ADR-36.md), [ADR-21](ADR-21.md), [ADR-07](ADR-07.md) |
| [ADR-23](ADR-23.md) | Sentence-level delivery acknowledgement | Accepted | implemented | The browser acknowledges how far it rendered, per sentence; a claim counts as told only after that. | [ADR-31](ADR-31.md), [ADR-32](ADR-32.md), [ADR-17](ADR-17.md), [ADR-38](ADR-38.md) |
| [ADR-24](ADR-24.md) | One absolute turn deadline with admission control | Accepted | not implemented | Every call and retry inherits one turn deadline; a retry or split starts only if enough time remains. | [ADR-09](ADR-09.md), [ADR-17](ADR-17.md) |
| [ADR-25](ADR-25.md) | Connection-level PRAGMAs, outside migration transactions | Accepted | implemented | WAL, foreign keys and the busy timeout are set when a connection opens; migrations carry no PRAGMA and run in their own transactions. | [ADR-04](ADR-04.md), [Q-003](../questions.md) |
| [ADR-26](ADR-26.md) | Immutability enforced by database triggers | Accepted | implemented | Snapshots, evidence, assertion events, belief history and message content cannot be updated; assertions may only gain `presented_at`, once. | [ADR-06](ADR-06.md), [ADR-27](ADR-27.md), [ADR-32](ADR-32.md) |
| [ADR-27](ADR-27.md) | Ownership consistency enforced by database triggers (partial) | Accepted | partly implemented | A row may only reference rows of the same user as its owning turn; covered for messages, turns, evidence, findings and assertions. | [ADR-20](ADR-20.md), [ADR-26](ADR-26.md), [ADR-28](ADR-28.md), [Q-007](../questions.md) |
| [ADR-28](ADR-28.md) | Demo and live data isolation at the database level (not complete) | Accepted | partly implemented | A database stamped `real` rejects non-live data and relabelling; a demo database accepts it. | [ADR-19](ADR-19.md), [ADR-27](ADR-27.md), [Q-002](../questions.md) |
| [ADR-29](ADR-29.md) | Turn state machine enforced in TypeScript and in the database | Accepted | implemented | The 26 edges (the 19 of architecture §4 plus the failure edges of ADR-39) are a TypeScript table and a database trigger, and a test compares them pair by pair. | [ADR-01](ADR-01.md), [ADR-30](ADR-30.md), [ADR-39](ADR-39.md) |
| [ADR-30](ADR-30.md) | At most one running turn per conversation | Accepted | implemented | A partial unique index guarantees it; `begin` checks inside a `BEGIN IMMEDIATE` transaction and throws `TurnInProgressError`. | [ADR-29](ADR-29.md), [Q-006](../questions.md) |
| [ADR-31](ADR-31.md) | Streamed extent and rendered extent are separate and ordered | Accepted | implemented | Rendered may never exceed streamed; an acknowledgement beyond what was streamed is rejected, never clamped. | [ADR-23](ADR-23.md), [ADR-16](ADR-16.md), [ADR-32](ADR-32.md) |
| [ADR-32](ADR-32.md) | Assertions, findings and events are persisted atomically at completion | Accepted | implemented | One transaction stores the answer, findings, assertions (born unpresented), evidence links and events, or nothing. | [ADR-06](ADR-06.md), [ADR-12](ADR-12.md), [ADR-23](ADR-23.md), [ADR-31](ADR-31.md) |
| [ADR-33](ADR-33.md) | Recovery: running turns become interrupted at startup | Accepted | implemented | Turns still running at startup are marked interrupted in whatever state they reached; nothing is resumed or invented. | [ADR-34](ADR-34.md), [ADR-39](ADR-39.md), [Q-016](../questions.md) |
| [ADR-34](ADR-34.md) | Single-instance guard for a database file | Proposed | not implemented | Prevent a second application process from opening the same database file; the mechanism is not chosen. | [ADR-33](ADR-33.md), [Q-016](../questions.md) |
| [ADR-35](ADR-35.md) | Privacy deletion with an injected belief rebuilder | Accepted | partly implemented | Deleting a conversation is an explicit procedure; derived beliefs are rebuilt by a dependency passed in, with no default. | [ADR-06](ADR-06.md), [ADR-13](ADR-13.md), [Q-005](../questions.md) |
| [ADR-36](ADR-36.md) | Stricter proof for a post-baseline change | Accepted | implemented | `changed` needs the old value re-observed after the previous answer then the new value observed later, same `url_norm`, `comparableKeys` equal with a known locale, or an explicitly associated reliable effective date; publication and fetch dates alone never; otherwise `differs_timing_unknown`. | [ADR-22](ADR-22.md), [ADR-37](ADR-37.md), [Q-001](../questions.md) |
| [ADR-37](ADR-37.md) | Locale as a dimension of the belief key | Accepted | implemented | Locale (canonical BCP-47, `und` if unknown) is part of the belief key; different locales are incomparable. Applied to the contract and shared type; not implemented. | [ADR-21](ADR-21.md), [ADR-36](ADR-36.md), [Q-001](../questions.md) |
| [ADR-38](ADR-38.md) | Which assertions may become historical baselines | Accepted | implemented | Recall needs presentation; baseline eligibility also needs the current-value placeholder, a verified sentence and passing evidence links. Only presentation gating exists in code. | [ADR-23](ADR-23.md), [ADR-32](ADR-32.md), [Q-015](../questions.md) |
| [ADR-39](ADR-39.md) | Failure transitions from intermediate states | Accepted | implemented | Every non-final state may move to PERSISTING; an unexpected error or replay miss finalises the turn as failed with an error code and no answer. | [ADR-29](ADR-29.md), [ADR-33](ADR-33.md), [Q-011](../questions.md) |
| [ADR-40](ADR-40.md) | Factual sentences are released only after validation | Accepted | not implemented | Received, validated and presented are separate states: only validated sentences are sent, one at a time; a sentence that fails a check is withheld, never shown and later downgraded. | [ADR-16](ADR-16.md), [ADR-23](ADR-23.md), [ADR-38](ADR-38.md) |

## How these relate to other documents

- Open questions stay in [docs/questions.md](../questions.md); each question that has been resolved links to its ADR there.
- The test inventory is [docs/testing.md](../testing.md); turn lifecycle and delivery are described in [docs/turn-lifecycle.md](../turn-lifecycle.md).
- The database schema is drawn in [docs/diagrams/er.mmd](../diagrams/er.mmd).
- DESIGN.md section 15 ("Decisions and trade-offs") should be written from this index: each narrative takes its problem, alternatives, choice, trade-off and
  revisit condition from the ADR, and repeats its status and implementation honestly.
- The normative contracts ([contracts.md](../contracts.md)) were not modified. Where an ADR says the contract text should change, the edit is
  proposed in [docs/questions.md](../questions.md) and is not made.
