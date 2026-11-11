# Test documentation

How the tests map to the invariants they protect. Statuses come from an actual run of the suite on 2026-11-11
(`npx vitest run --reporter=json`). A throw-away script compared every count and status stated below with that run; it is not part of
the repository, so re-run the suite before relying on these numbers.

Run everything: `npm run check` (typecheck, lint, format check, tests). Tests only: `npm test`. Every test is offline and
deterministic: in-memory SQLite or a temporary file, a fixed clock, no network, no live provider.

**Last run** (on the milestone 3 integration branch, `m3/integration`, before merging to `main`): 20 files, 411 passed, 1 `todo`, 0 failed, 0 skipped (377 code tests across milestones 1 to 3, 17 documentation checks, and the new milestone 3 groups below). The milestone 2 counts further down describe the state at the end of milestone 2.

Test IDs: those named in the contract documents are used as given. IDs the documents list without numbers were enumerated here
(Q-004, Q-018). `T-TRN-*` and `T-ASR-*` are new IDs from Milestone 2 and do not exist in the contract documents.

## Milestone 1 groups (database foundation)

Test files are under `tests/integration/db/`. The test case is the test's full name with the group title first.

| ID | Invariant | File | Status | Not proved by these tests |
|---|---|---|---|---|
| **T-DB-01** | An idempotency key is unique per user, not globally | `invariants.test.ts` | passed | |
| **T-DB-02** | A message or turn cannot belong to a different user than its conversation | `invariants.test.ts`; repository half in `repositories.test.ts` | passed | |
| **T-DB-03** | L1 snapshots, L2 evidence, assertion events and belief history reject UPDATE; DELETE stays possible | `invariants.test.ts` | passed | That nothing deletes these rows outside the deletion procedure |
| **T-DB-04** | Message content is immutable; the message repository has no update/delete/replace | `invariants.test.ts` | passed | Raw-SQL delete then insert under the same id is possible for a caller holding the connection |
| **T-DB-05** | An assertion's `presented_at` is set once and nothing else changes; one `presented` and one `not_presented` event at most | `invariants.test.ts` | passed | |
| **T-DB-06** | `rendered_through` never decreases | `invariants.test.ts` | passed | |
| **T-DB-07** | A real database rejects non-live users, conversations, snapshots, messages, entities, decisions; relabelling; `db_mode` is immutable. Demo databases accept them | `invariants.test.ts` | passed (since migration 002) | Complete isolation is **not** claimed: `belief_history`, `search_cache` and some plain columns are unguarded (Q-002) |
| **T-DB-08** | Evidence an assertion in another conversation still cites survives conversation deletion | `privacy-deletion.test.ts` | passed | Belief rebuilding |
| **T-DB-09** | After deletion, beliefs and belief history equal a fresh rebuild | `invariants.test.ts` | **todo: not implemented, not tested** | Everything. Blocked on the belief resolver (Milestone 4). Deletion and rebuilding are **not** fully tested |
| **T-DB-10** | The application refuses to open a database created in a different `APP_MODE` | `migrations.test.ts` | passed | The same guard for the seed script (not written yet) |
| **T-MEM-08** | A deleted conversation cannot be recalled | `memory-recall.test.ts` | passed (milestone 3) | Recalled by date, topic and tag on the real write path |

Other M1 tests: privacy deletion mechanics (with a recording fake rebuilder, so rebuild *correctness* is untested), repositories, config,
contract parity of migration 001, and the migration runner. `migrations.test.ts` now also checks that migrations 001 to 009 load
contiguously, that the installed triggers equal exactly those the migrations declare, that a version-1 database upgrades to the latest
schema without losing data, and the Q-003 rules (connection PRAGMAs, no PRAGMA in a migration, each migration transactional).

## Milestone 2 groups

### T-TRN: turn lifecycle (`turn-lifecycle.test.ts`, `tests/unit/turn-state-machine.test.ts`)

| ID | Invariant | Test cases | Status |
|---|---|---|---|
| **T-TRN-01** | The database enforces the state machine and agrees with the TypeScript table | "accepts exactly the 26 edges and rejects every other ordered pair (182 probes)"; "rejects a state value that is not part of the state machine"; "every non-final state can move to PERSISTING (failure edges), and the turn can then be finalised". Unit: the 26 edges, every non-final state has a direct edge to PERSISTING and only PERSISTING reaches a final state, 196-pair agreement, no dead ends, all states reachable | passed |
| **T-TRN-02** | Finished turns are final; turn identity is immutable; turn rows keep their shape; one running turn per conversation | the five tests of that group | passed |
| **T-TRN-03** | `setState` validates every transition; final states only via `complete()`/`fail()`; owner scoping | the seven tests of that group (valid path, invalid jumps, failure edges to PERSISTING from every non-final state, final states refused, finished turns refused, ownership, `fail`) | passed |
| **T-TRN-04** | `begin`: creation, idempotent replay, key conflict, per-user keys, in-progress refusal (Q-006), retry validation, ownership, input validation | the eight tests of that group; plus "violatesOneRunningTurn recognises the real SQLite error, and only that one" | passed |
| **T-TRN-05** | Recovery of running turns invents no answer, acknowledgement, presented claim or baseline; idempotent; survives a restart | the five tests of that group, including a file database reopened by a new connection | passed |

### T-FAIL: failure edges and terminal states (ADR-39)

| ID | Invariant | Test cases | Status |
|---|---|---|---|
| **T-FAIL-01** | An unexpected error in any non-final state (RECEIVED, ANALYZING, RESOLVING_CONTEXT, CLARIFYING, PLANNING, SEARCHING, EXTRACTING, VERIFYING, RESOLVING_BELIEFS, SYNTHESIZING, POST_VERIFYING) ends in a terminal failed turn: status `failed`, error code recorded, no assistant message, no findings or assertions, one SSE error event, no completion event, the original error rethrown and logged, the next turn in the conversation accepted, nothing left for restart recovery | one parametrised test per state in `tests/integration/orchestration/failure-edges.test.ts` (real SQLite and migrations, failing doubles for analyzer, memory, research service, answer pipeline and the turn store); a failure after the PERSISTING transition was applied | passed |
| **T-FAIL-02** | The error code names the class: `replay_miss` (model or search fixture miss), `internal_error`, `contract_violation`, `persistence:<code>` (not shown to the client), `external_error` | the six tests of "the error code names the class" | passed |
| **T-FAIL-03** | When the finalising write fails the coordinator falls back to `fail()`, and to restart recovery when the turn cannot reach PERSISTING or `fail()` is refused; the original error is the one reported | the three tests of "when the finalising write fails" | passed |
| **T-FAIL-04** | Typed outcomes are unchanged: clarify, interrupted, partial, and a provider outage in the analyzer or the answer pipeline still produce their stored reply | the four tests of "normal typed outcomes are unchanged" | passed |
| **T-FAIL-05** | Replay fixture misses (analysis, search, fewer search calls than made, synthesis) through the HTTP server: error event with `replay_miss`, a failed finished turn, no assistant message, no running turn, the next turn accepted; a database failure while storing evidence leaves a failed turn with a `persistence:` code | `tests/integration/e2e/replay-misses.test.ts`, `tests/integration/e2e/failures.test.ts` | passed |
| **T-FAIL-06** | Migration 010 replaces only the transition trigger of migration 004, installs exactly the triggers the migrations declare (a trigger is recreated only after a DROP), and upgrades a populated version-8 database: rows kept, the new edges apply to a turn already in flight, the finality triggers survive | three tests in `tests/integration/db/migrations.test.ts` | passed |

### T-ASR: assertion persistence (`turn-completion.test.ts`)

| ID | Invariant | Test cases | Status |
|---|---|---|---|
| **T-ASR-01** | Completion stores message, findings, assertions, links and events in one transaction; assertions are born unpresented; never-streamed claims get `not_presented` | the five tests of that group (full answer, interrupted answer with exact extent, outcome without an answer, state requirement, ownership) | passed |
| **T-ASR-02** | Completion is atomic: a failure part-way writes nothing and the same completion can be retried | two fault-injection tests (temporary triggers) | passed |
| **T-ASR-03** | Inconsistent or premature completions are refused before any write | 18 cases (the unmodified control, 14 inconsistencies, 3 malformed shapes) | passed |
| **T-ASR-04** | Cross-user ownership violations are refused by the database and roll the completion back | other user's evidence; other user's entity; nonexistent entity | passed |
| **T-ASR-05** | Only presented claims can be judged or used as a baseline | verdict on a presented claim in a later turn (recorded); on a streamed-but-unacknowledged claim (refused); finding baseline never presented (refused); other user's claim (refused, nothing written); verdict event on an unpresented claim refused by the database itself | passed |

### T-DLV: delivery and acknowledgement (`delivery.test.ts`)

| ID | Invariant | Test case | Status |
|---|---|---|---|
| **T-DLV-01** | A fully rendered answer presents every claim once | "presents all four claims with exactly one presented event each" | passed |
| **T-DLV-02** | A partly rendered answer stays partly presented | "after acknowledging sentences 0-3 and then disconnecting, only claims in 0-3 are presented" | passed |
| **T-DLV-03** | A streamed-but-never-rendered answer presents nothing; never-streamed claims are `not_streamed` and cannot be acknowledged | two tests | passed |
| **T-DLV-04** | A repeated acknowledgement changes nothing (not even `last_ack_at`) | "reports the stored extent, presents nothing new, and does not even touch last_ack_at" | passed |
| **T-DLV-05** | Acknowledgements are monotonic, so out-of-order ones are harmless | two tests (lower after higher; `-1`) | passed |
| **T-DLV-06** | A reconnect that re-renders the stored answer completes the acknowledgement | "presents the rest later, without disturbing what was presented earlier" | passed |
| **T-DLV-07** | Acknowledging a retry never touches the original turn's assertions | "the interrupted original stays unpresented while its retry is fully presented" | passed |
| **T-DLV-08** | An interrupted turn keeps the exact acknowledged extent and cannot be acknowledged beyond what was streamed | "cannot be acknowledged beyond what was streamed, and its truncated claims stay not_presented" | passed |

Also in `delivery.test.ts`, without an ID: acknowledgement before the answer is stored; ownership; malformed requests; atomicity (a temporary
trigger makes the presented event fail, and extent plus `presented_at` roll back); and eight tests that issue raw SQL to show migration 005
refuses each delivery violation on its own, whatever the application does. `tests/unit/turn-state-machine.test.ts` also covers
`deliveryState` (including that impossible extents throw).

### Q-007 ownership (`ownership.test.ts`)

16 tests, run on a database stopped at migration 003 so each error comes from that migration alone: evidence (turn, snapshot, entity, missing turn),
findings (other user's entity, missing entity, immutable references), assertions (turn, message, finding, finding from another turn),
assertion evidence (other user's evidence, links immutable), plus a check that the latest schema still carries those triggers.

### Concurrency (`concurrency.test.ts`)

Real contention: each contender is a worker thread with its own SQLite connection to one file, released together at a barrier.

| Test | Result |
|---|---|
| same idempotency key from six connections | exactly one turn and one message created; five receive the existing turn |
| six different keys in one conversation | one winner, five `TurnInProgressError`, one running turn, one message |
| four conversations of one user | all four succeed |
| same key, different text, two connections | one created, one `IdempotencyConflictError` |
| eight racing acknowledgements | final extent 6; four claims presented, each exactly once; four presented events |
| valid and impossible acknowledgements together | impossible ones rejected, valid ones land, nothing beyond the streamed extent presented |

The concurrency file was repeated eight times in a row without a failure. That shows no flakiness in those runs; it is not a proof.

## Milestone 3 groups (memory and recall)

Written by three parallel workers and an integration pass; the worker mutation results below are their reports, and the
orchestrator re-ran only the full suite after merging.

| Group | Test file | Tests | What it covers |
|---|---|---|---|
| T-TEMP-01..12 | `tests/unit/temporal.test.ts` | 81 | Today, yesterday, `days_ago`; `last <weekday>` gives two candidates; every weekday x modifier across a full week; calendar dates and impossible dates; `last_week` and `since`; untrusted values; zone boundaries (half-hour and 45-minute zones); DST days of 23, 25, 23.5 and 24.5 hours; skipped midnight (Beirut, Havana, Asuncion); a skipped day (Samoa, 2011); year and leap-day boundaries; local date of "now" |
| Retriever | `tests/integration/db/memory-retriever.test.ts` | 26 | Cross-user isolation, half-open intervals, DST-length days, the 8-candidate cap, ordering and ties, no-terms listing, inert hostile FTS input, deleted conversation |
| Enrichment | `tests/integration/db/enrichment.test.ts` | 25 | Atomic persistence in `complete()`, FTS consistency, decisions and corrections, 15 invalid inputs write nothing, rollback |
| Baseline loader (ADR-38) | `tests/integration/db/baseline-loader.test.ts` | 24 | One test per eligibility rule (six rules), recall of unverified claims, same-turn exclusion, cross-user isolation |
| Migration 006 | `tests/integration/db/decision-ownership.test.ts` | 24 | Cross-user rejection per trigger, identity immutability, upgrade of a version-5 database |
| Recall lane | `tests/integration/db/recall.test.ts` | 12 | Answer, clarify (two days, several conversations, unresolved date) or none, over the real resolver and retriever |
| M3 on the real write path | `tests/integration/db/memory-recall.test.ts` | 4 | Recall by body, tag and date after `complete()` with enrichment; T-MEM-08 |

Mutation spot checks reported by the workers, each restored afterwards: resolver 11 breaks (10 caught; one was an equivalent change); retriever 8 breaks (7 caught; unquoting FTS tokens
survives because `sanitizeTerms` already strips everything but letters and digits); baseline loader and enrichment 6 breaks plus the 8 migration-006 triggers dropped one at a time and the
quote check, all caught; recall layer 5 breaks, all caught. Limits: a conversation that fills all eight retrieved messages can hide a second matching conversation (`truncated` is reported, no question is asked yet); the loader and the recall layer have no caller until milestone 5.

## Milestone 4 groups, search and source evidence (Agent A)

All fixtures are hand-authored and labelled `[SYNTHETIC]`: no live provider call has been made, so nothing below shows that the adapter matches the real Exa responses.

| Group | Test files | Tests | What it covers |
|---|---|---|---|
| URL and structure | `tests/unit/sources/url.test.ts`, `structure.test.ts` | 25 | Tracking vs meaningful query parameters, credentials, ports, IDN, IPv6, unsafe schemes, very long URLs; headings, tables, fences, CRLF, linear time |
| Search adapter and replay | `tests/unit/search/*.test.ts` | 44 | Normalisation, the `freshFetch` rules, malformed items, every HTTP status mapping, Retry-After, timeout vs cancel, key never in errors, replay hit and miss |
| Executor and store | `tests/integration/search/executor.test.ts`, `tests/integration/sources/snapshot-store.test.ts` | 36 | Persistence, rounds, concurrency bound, typed failures, retry gated by the budget, deadline, cancellation, database errors propagate, atomic rollback |
| Crawl basis (migration 009) | `tests/unit/search/crawl-basis.test.ts`, `tests/integration/sources/crawl-basis-store.test.ts`, `tests/unit/belief/crawl-basis-neutral.test.ts` | 42 | The content-sufficiency rule and its boundaries (the probed 87, 131 and 186 characters fail); the four states mapped from Exa-shaped fixtures; store round trip, user scoping, the consistency trigger, immutability; a populated version-8 database upgraded to 9; a stale-dated page keeps `observedAt` as retrieval time; belief status, time fields and verdicts identical for `requested_live`, `cached` and `unknown`; the basis reaches the finding without changing it |
| Migration 007 | `tests/integration/search/ownership-007.test.ts` | 12 | Cross-user rejection per trigger, identity immutability, and a test showing the pre-007 gap |
| Bake-off harness | `tests/unit/search/bakeoff.test.ts` | 6 | Scoring and summary arithmetic on fake data. This is **not** a benchmark result: the bake-off has not been run |

Counts are from a full run (123 tests across these files; the worker reported a smaller figure). Reported mutation checks (Agent A): 17 deliberate breaks caught, two surviving mutants explained (a trigger rename; a redundant rethrow).

## Evidence verification, beliefs and the research service

All evidence in these tests is synthetic (`.example` vendors) and the model is a fake `LlmPort` returning fixture JSON: nothing here shows how a real model or a real provider behaves, and the weak and fail rates on real pages are unmeasured.

| Group | Test files | What it covers |
|---|---|---|
| Verification T0 to T2 | `tests/unit/evidence/verifier.test.ts` | Citation integrity, verbatim quotes and context, subject and competitor attribution, plan binding, currency (bare `$`, `¥`), unit (flat vs seat, metered needs a usage unit), billing period, negation, historical, conditional, planned and promotional cues, effective-date cues, adversarial prompt-injection text |
| Extraction and batching | `tests/unit/evidence/extraction.test.ts` | Adaptive batching, bounded concurrency, failure isolation, retry and split only when the budget admits |
| Authority and entailment | `tests/unit/evidence/authority-entailment.test.ts` | Authority tiers; the judge may confirm or downgrade, never upgrade |
| Belief keys | `tests/unit/belief/belief-key.test.ts` | Encoding, locale, comparability |
| Resolver | `tests/unit/belief/resolver.test.ts` | Tier, freshness, recency, contested, modality, pending signals |
| Change detector | `tests/unit/belief/detector.test.ts`, `as-of.test.ts` | Both proofs of `changed`, every way each can fail, the as-of rule, prior-effect, coverage failure, releases |
| Findings | `tests/unit/belief/assembler.test.ts` | Status and verdict combinations that are allowed |
| Repositories and rebuild | `tests/integration/belief/repository.test.ts` | Incremental beliefs equal a rebuild, including after privacy deletion with the real rebuilder |
| Ownership (migration 008) | `tests/integration/belief/ownership.test.ts` | Cross-user rejection per trigger, same-user acceptance |
| Research service | `tests/integration/evidence/research-service.test.ts` | Research and audit on a real database; provider, extraction and deadline failures become coverage and `unable_to_verify`; database errors propagate; user isolation |

Reported mutation checks: 25 deliberate breaks in the verifier, resolver, detector, key encoding and three triggers, all caught after four tests were added for early survivors.

## Extraction calibration

The data, the labels and the method are in [extraction-calibration.md](extraction-calibration.md). All of these tests are offline. The pages are real public pages captured through the search adapter; the gold labels were made by an AI reading them and have not been checked by a human. **No model is called by any of these tests and none of them measures extraction quality.**

| Group | Test file | What it covers |
|---|---|---|
| Data set | `tests/unit/evidence/calibration-dataset.test.ts` | At least 14 pages and 8 vendors; every category present; at least two negative controls; the manifest; each page is at most 6,000 characters with a normalised URL and an official host; every gold quote and context is verbatim, within its limit and above the quote; the amount is in the quote; reasons for non-passing claims; no gold claim satisfies a trap |
| Oracle | `tests/unit/evidence/calibration-oracle.test.ts` | The ideal extraction (every gold claim as labelled) through the real T0 to T2 verifier gives the labelled outcome for every claim, so a verifier change that moves one is noticed; the best-achievable contexts pass |
| Cue binding | `tests/unit/evidence/billing-binding.test.ts` | In a quote with several prices, the period and unit cues are those attached to the claimed amount (or shared by all): the Close permutations (annual rate as monthly fails, as monthly billed annually passes), comma, "or" and billing-clause separators, label-first and value-first table rows, an unclear layout or a repeated amount is weak, an amount with no cue of its own while another has one is weak, one-price quotes unchanged, and a seat marker on another price does not decide the unit |
| Scoring | `tests/unit/evidence/eval-scoring.test.ts` | Match rules, duplicates, ignorable and trap statements, verified precision and recall, false-pass kinds, negative controls, field accuracy, supporting-quote accuracy, aggregation and null rates, on synthetic data |
| Prompt | `tests/unit/evidence/extraction-prompt.test.ts` | v1 unchanged and still the default, v2 selectable, every v2 rule present, no vendor or gold quote in v2, the extractor sends the selected prompt with the same message, schema name and token cap |
| Explicit currency code | `tests/unit/evidence/currency-explicit-code.test.ts` | `$ 25 USD` resolves to USD; a bare `# Test documentation

How the tests map to the invariants they protect. Statuses come from an actual run of the suite on 2026-11-11
(`npx vitest run --reporter=json`). A throw-away script compared every count and status stated below with that run; it is not part of
the repository, so re-run the suite before relying on these numbers.

Run everything: `npm run check` (typecheck, lint, format check, tests). Tests only: `npm test`. Every test is offline and
deterministic: in-memory SQLite or a temporary file, a fixed clock, no network, no live provider.

**Last run** (on the milestone 3 integration branch, `m3/integration`, before merging to `main`): 20 files, 411 passed, 1 `todo`, 0 failed, 0 skipped (377 code tests across milestones 1 to 3, 17 documentation checks, and the new milestone 3 groups below). The milestone 2 counts further down describe the state at the end of milestone 2.

Test IDs: those named in the contract documents are used as given. IDs the documents list without numbers were enumerated here
(Q-004, Q-018). `T-TRN-*` and `T-ASR-*` are new IDs from Milestone 2 and do not exist in the contract documents.

## Milestone 1 groups (database foundation)

Test files are under `tests/integration/db/`. The test case is the test's full name with the group title first.

| ID | Invariant | File | Status | Not proved by these tests |
|---|---|---|---|---|
| **T-DB-01** | An idempotency key is unique per user, not globally | `invariants.test.ts` | passed | |
| **T-DB-02** | A message or turn cannot belong to a different user than its conversation | `invariants.test.ts`; repository half in `repositories.test.ts` | passed | |
| **T-DB-03** | L1 snapshots, L2 evidence, assertion events and belief history reject UPDATE; DELETE stays possible | `invariants.test.ts` | passed | That nothing deletes these rows outside the deletion procedure |
| **T-DB-04** | Message content is immutable; the message repository has no update/delete/replace | `invariants.test.ts` | passed | Raw-SQL delete then insert under the same id is possible for a caller holding the connection |
| **T-DB-05** | An assertion's `presented_at` is set once and nothing else changes; one `presented` and one `not_presented` event at most | `invariants.test.ts` | passed | |
| **T-DB-06** | `rendered_through` never decreases | `invariants.test.ts` | passed | |
| **T-DB-07** | A real database rejects non-live users, conversations, snapshots, messages, entities, decisions; relabelling; `db_mode` is immutable. Demo databases accept them | `invariants.test.ts` | passed (since migration 002) | Complete isolation is **not** claimed: `belief_history`, `search_cache` and some plain columns are unguarded (Q-002) |
| **T-DB-08** | Evidence an assertion in another conversation still cites survives conversation deletion | `privacy-deletion.test.ts` | passed | Belief rebuilding |
| **T-DB-09** | After deletion, beliefs and belief history equal a fresh rebuild | `invariants.test.ts` | **todo: not implemented, not tested** | Everything. Blocked on the belief resolver (Milestone 4). Deletion and rebuilding are **not** fully tested |
| **T-DB-10** | The application refuses to open a database created in a different `APP_MODE` | `migrations.test.ts` | passed | The same guard for the seed script (not written yet) |
| **T-MEM-08** | A deleted conversation cannot be recalled | `memory-recall.test.ts` | passed (milestone 3) | Recalled by date, topic and tag on the real write path |

Other M1 tests: privacy deletion mechanics (with a recording fake rebuilder, so rebuild *correctness* is untested), repositories, config,
contract parity of migration 001, and the migration runner. `migrations.test.ts` now also checks that migrations 001 to 007 load
contiguously, that the installed triggers equal exactly those the migrations declare, that a version-1 database upgrades to the latest
schema without losing data, and the Q-003 rules (connection PRAGMAs, no PRAGMA in a migration, each migration transactional).

## Milestone 2 groups

### T-TRN: turn lifecycle (`turn-lifecycle.test.ts`, `tests/unit/turn-state-machine.test.ts`)

| ID | Invariant | Test cases | Status |
|---|---|---|---|
| **T-TRN-01** | The database enforces the state machine and agrees with the TypeScript table | "accepts exactly the 19 edges and rejects every other ordered pair (182 probes)"; "rejects a state value that is not part of the state machine". Unit: 19 edges, 196-pair agreement, no dead ends, all states reachable | passed |
| **T-TRN-02** | Finished turns are final; turn identity is immutable; turn rows keep their shape; one running turn per conversation | the five tests of that group | passed |
| **T-TRN-03** | `setState` validates every transition; final states only via `complete()`/`fail()`; owner scoping | the seven tests of that group (valid path, invalid jumps, two PERSISTING shortcuts, final states refused, finished turns refused, ownership, `fail`) | passed |
| **T-TRN-04** | `begin`: creation, idempotent replay, key conflict, per-user keys, in-progress refusal (Q-006), retry validation, ownership, input validation | the eight tests of that group; plus "violatesOneRunningTurn recognises the real SQLite error, and only that one" | passed |
| **T-TRN-05** | Recovery of running turns invents no answer, acknowledgement, presented claim or baseline; idempotent; survives a restart | the five tests of that group, including a file database reopened by a new connection | passed |

### T-ASR: assertion persistence (`turn-completion.test.ts`)

| ID | Invariant | Test cases | Status |
|---|---|---|---|
| **T-ASR-01** | Completion stores message, findings, assertions, links and events in one transaction; assertions are born unpresented; never-streamed claims get `not_presented` | the five tests of that group (full answer, interrupted answer with exact extent, outcome without an answer, state requirement, ownership) | passed |
| **T-ASR-02** | Completion is atomic: a failure part-way writes nothing and the same completion can be retried | two fault-injection tests (temporary triggers) | passed |
| **T-ASR-03** | Inconsistent or premature completions are refused before any write | 18 cases (the unmodified control, 14 inconsistencies, 3 malformed shapes) | passed |
| **T-ASR-04** | Cross-user ownership violations are refused by the database and roll the completion back | other user's evidence; other user's entity; nonexistent entity | passed |
| **T-ASR-05** | Only presented claims can be judged or used as a baseline | verdict on a presented claim in a later turn (recorded); on a streamed-but-unacknowledged claim (refused); finding baseline never presented (refused); other user's claim (refused, nothing written); verdict event on an unpresented claim refused by the database itself | passed |

### T-DLV: delivery and acknowledgement (`delivery.test.ts`)

| ID | Invariant | Test case | Status |
|---|---|---|---|
| **T-DLV-01** | A fully rendered answer presents every claim once | "presents all four claims with exactly one presented event each" | passed |
| **T-DLV-02** | A partly rendered answer stays partly presented | "after acknowledging sentences 0-3 and then disconnecting, only claims in 0-3 are presented" | passed |
| **T-DLV-03** | A streamed-but-never-rendered answer presents nothing; never-streamed claims are `not_streamed` and cannot be acknowledged | two tests | passed |
| **T-DLV-04** | A repeated acknowledgement changes nothing (not even `last_ack_at`) | "reports the stored extent, presents nothing new, and does not even touch last_ack_at" | passed |
| **T-DLV-05** | Acknowledgements are monotonic, so out-of-order ones are harmless | two tests (lower after higher; `-1`) | passed |
| **T-DLV-06** | A reconnect that re-renders the stored answer completes the acknowledgement | "presents the rest later, without disturbing what was presented earlier" | passed |
| **T-DLV-07** | Acknowledging a retry never touches the original turn's assertions | "the interrupted original stays unpresented while its retry is fully presented" | passed |
| **T-DLV-08** | An interrupted turn keeps the exact acknowledged extent and cannot be acknowledged beyond what was streamed | "cannot be acknowledged beyond what was streamed, and its truncated claims stay not_presented" | passed |

Also in `delivery.test.ts`, without an ID: acknowledgement before the answer is stored; ownership; malformed requests; atomicity (a temporary
trigger makes the presented event fail, and extent plus `presented_at` roll back); and eight tests that issue raw SQL to show migration 005
refuses each delivery violation on its own, whatever the application does. `tests/unit/turn-state-machine.test.ts` also covers
`deliveryState` (including that impossible extents throw).

### Q-007 ownership (`ownership.test.ts`)

16 tests, run on a database stopped at migration 003 so each error comes from that migration alone: evidence (turn, snapshot, entity, missing turn),
findings (other user's entity, missing entity, immutable references), assertions (turn, message, finding, finding from another turn),
assertion evidence (other user's evidence, links immutable), plus a check that the latest schema still carries those triggers.

### Concurrency (`concurrency.test.ts`)

Real contention: each contender is a worker thread with its own SQLite connection to one file, released together at a barrier.

| Test | Result |
|---|---|
| same idempotency key from six connections | exactly one turn and one message created; five receive the existing turn |
| six different keys in one conversation | one winner, five `TurnInProgressError`, one running turn, one message |
| four conversations of one user | all four succeed |
| same key, different text, two connections | one created, one `IdempotencyConflictError` |
| eight racing acknowledgements | final extent 6; four claims presented, each exactly once; four presented events |
| valid and impossible acknowledgements together | impossible ones rejected, valid ones land, nothing beyond the streamed extent presented |

The concurrency file was repeated eight times in a row without a failure. That shows no flakiness in those runs; it is not a proof.

## Milestone 3 groups (memory and recall)

Written by three parallel workers and an integration pass; the worker mutation results below are their reports, and the
orchestrator re-ran only the full suite after merging.

| Group | Test file | Tests | What it covers |
|---|---|---|---|
| T-TEMP-01..12 | `tests/unit/temporal.test.ts` | 81 | Today, yesterday, `days_ago`; `last <weekday>` gives two candidates; every weekday x modifier across a full week; calendar dates and impossible dates; `last_week` and `since`; untrusted values; zone boundaries (half-hour and 45-minute zones); DST days of 23, 25, 23.5 and 24.5 hours; skipped midnight (Beirut, Havana, Asuncion); a skipped day (Samoa, 2011); year and leap-day boundaries; local date of "now" |
| Retriever | `tests/integration/db/memory-retriever.test.ts` | 26 | Cross-user isolation, half-open intervals, DST-length days, the 8-candidate cap, ordering and ties, no-terms listing, inert hostile FTS input, deleted conversation |
| Enrichment | `tests/integration/db/enrichment.test.ts` | 25 | Atomic persistence in `complete()`, FTS consistency, decisions and corrections, 15 invalid inputs write nothing, rollback |
| Baseline loader (ADR-38) | `tests/integration/db/baseline-loader.test.ts` | 24 | One test per eligibility rule (six rules), recall of unverified claims, same-turn exclusion, cross-user isolation |
| Migration 006 | `tests/integration/db/decision-ownership.test.ts` | 24 | Cross-user rejection per trigger, identity immutability, upgrade of a version-5 database |
| Recall lane | `tests/integration/db/recall.test.ts` | 12 | Answer, clarify (two days, several conversations, unresolved date) or none, over the real resolver and retriever |
| M3 on the real write path | `tests/integration/db/memory-recall.test.ts` | 4 | Recall by body, tag and date after `complete()` with enrichment; T-MEM-08 |

Mutation spot checks reported by the workers, each restored afterwards: resolver 11 breaks (10 caught; one was an equivalent change); retriever 8 breaks (7 caught; unquoting FTS tokens
survives because `sanitizeTerms` already strips everything but letters and digits); baseline loader and enrichment 6 breaks plus the 8 migration-006 triggers dropped one at a time and the
quote check, all caught; recall layer 5 breaks, all caught. Limits: a conversation that fills all eight retrieved messages can hide a second matching conversation (`truncated` is reported, no question is asked yet); the loader and the recall layer have no caller until milestone 5.

## Milestone 4 groups, search and source evidence (Agent A)

All fixtures are hand-authored and labelled `[SYNTHETIC]`: no live provider call has been made, so nothing below shows that the adapter matches the real Exa responses.

| Group | Test files | Tests | What it covers |
|---|---|---|---|
| URL and structure | `tests/unit/sources/url.test.ts`, `structure.test.ts` | 25 | Tracking vs meaningful query parameters, credentials, ports, IDN, IPv6, unsafe schemes, very long URLs; headings, tables, fences, CRLF, linear time |
| Search adapter and replay | `tests/unit/search/*.test.ts` | 44 | Normalisation, the `freshFetch` rules, malformed items, every HTTP status mapping, Retry-After, timeout vs cancel, key never in errors, replay hit and miss |
| Executor and store | `tests/integration/search/executor.test.ts`, `tests/integration/sources/snapshot-store.test.ts` | 36 | Persistence, rounds, concurrency bound, typed failures, retry gated by the budget, deadline, cancellation, database errors propagate, atomic rollback |
| Migration 007 | `tests/integration/search/ownership-007.test.ts` | 12 | Cross-user rejection per trigger, identity immutability, and a test showing the pre-007 gap |
| Bake-off harness | `tests/unit/search/bakeoff.test.ts` | 6 | Scoring and summary arithmetic on fake data. This is **not** a benchmark result: the bake-off has not been run |

Counts are from a full run (123 tests across these files; the worker reported a smaller figure). Reported mutation checks (Agent A): 17 deliberate breaks caught, two surviving mutants explained (a trigger rename; a redundant rethrow).

## Evidence verification, beliefs and the research service

All evidence in these tests is synthetic (`.example` vendors) and the model is a fake `LlmPort` returning fixture JSON: nothing here shows how a real model or a real provider behaves, and the weak and fail rates on real pages are unmeasured.

| Group | Test files | What it covers |
|---|---|---|
| Verification T0 to T2 | `tests/unit/evidence/verifier.test.ts` | Citation integrity, verbatim quotes and context, subject and competitor attribution, plan binding, currency (bare `$`, `¥`), unit (flat vs seat, metered needs a usage unit), billing period, negation, historical, conditional, planned and promotional cues, effective-date cues, adversarial prompt-injection text |
| Extraction and batching | `tests/unit/evidence/extraction.test.ts` | Adaptive batching, bounded concurrency, failure isolation, retry and split only when the budget admits |
| Authority and entailment | `tests/unit/evidence/authority-entailment.test.ts` | Authority tiers; the judge may confirm or downgrade, never upgrade |
| Belief keys | `tests/unit/belief/belief-key.test.ts` | Encoding, locale, comparability |
| Resolver | `tests/unit/belief/resolver.test.ts` | Tier, freshness, recency, contested, modality, pending signals |
| Change detector | `tests/unit/belief/detector.test.ts`, `as-of.test.ts` | Both proofs of `changed`, every way each can fail, the as-of rule, prior-effect, coverage failure, releases |
| Findings | `tests/unit/belief/assembler.test.ts` | Status and verdict combinations that are allowed |
| Repositories and rebuild | `tests/integration/belief/repository.test.ts` | Incremental beliefs equal a rebuild, including after privacy deletion with the real rebuilder |
| Ownership (migration 008) | `tests/integration/belief/ownership.test.ts` | Cross-user rejection per trigger, same-user acceptance |
| Research service | `tests/integration/evidence/research-service.test.ts` | Research and audit on a real database; provider, extraction and deadline failures become coverage and `unable_to_verify`; database errors propagate; user isolation |

Reported mutation checks: 25 deliberate breaks in the verifier, resolver, detector, key encoding and three triggers, all caught after four tests were added for early survivors.

, a code the symbol cannot stand for, and a code not next to the amount stay unknown |
| Evaluation path | `tests/integration/evidence/extraction-eval.test.ts` | The real extractor and verifier over the gold pages with an oracle model, an empty model, a scripted fake and a recorded-then-replayed one; failures recorded; prompt and token cap reach the model; the command refuses a live run without `--confirm-live-calls`, without `--max-calls`, with a cap below the page count, or without the key and model in the environment, and never prints a key |

## Scenario routing (audit lane, shortlist resolution, analysis roles), added 2026-11-12

Driven through the real coordinator with real SQLite, the real temporal resolver, memory retriever and baseline source; the analyzer, research service and answer pipeline are doubles with canned output, so these tests show what is retrieved, whom is researched and what the code writes, not model quality. The analysis used for the first question is the one the real analyzer returned, verbatim, plus a corrected variant (the role of "Monday" fixed).

| File | What it covers |
|---|---|
| `tests/integration/orchestration/scenario-routing.test.ts` | First question: Monday message and shortlist retrieved, all five tools researched in shortlist order, reply opens with what was written and when, then the no-earlier-answer statement, then the findings; model sentences numbered after the code-written ones in the stream and in storage; `unable_to_verify` findings; the captured (uncorrected) analysis still reaches the five; cap of 6 with a warning; a name with no stored entity researched by name; two shortlists on one day clarify; none stored gives the fixed reply; research lane routing. Second and third question: reply says what was asked and when (user's zone), that no earlier answer is on record, and offers a lookup, with no research and no answer-model call; no stored message means no claim that one existed; the old reply fails the expectation. Years: a year the user did not write is gone before the research request, one the user wrote stays |
| `tests/unit/llm/analyzer.test.ts` | Year stripping: unwritten years removed and the query tidied, a written year kept and only that year, numbers that are not years untouched |
| `tests/unit/llm/prompts.test.ts` | Prompt version `analysis.v3`, the three role definitions with examples, the no-year rule |
| `tests/unit/orchestration/lanes.test.ts` | Audit with no baseline: researches when there is a company, fixed reply when there is none |

Existing end-to-end tests that expected the fixed reply for an audit with a named company and no baseline now expect the research to run and the plain statement (`acknowledgement.test.ts`, `isolation.test.ts`).

Mutation checks, each restored afterwards and each made at least one test fail: shortlist resolution removed (10 failed); audit falling back to the fixed reply despite companies (10); the recalled question left out of the reply (8); year stripping removed (3); role instructions removed from the prompt (1, the prompt version test).

### Research lane recall (added 2026-11-12, after a live rerun)

Helpers shared by the scenario files are in `tests/integration/orchestration/scenario-world.ts` (real coordinator, SQLite, resolver, retriever and baseline source; recording doubles that log the order recall, plan, research, answer).

| File | What it covers |
|---|---|
| `scenario-research-recall.test.ts` | The first and third questions as the real analyzer returned them in the live rerun (lane research): the Monday message recalled and quoted, the five tools researched; the Tuesday message recalled, Neon and Supabase taken from its tags or from stored entities, never the category; several conversations (with and without topic terms) a question; nothing derivable keeps the clarification and quotes what was found; another user's tagged message and entities never used |
| `scenario-owner-properties.test.ts` | (a) recall before plan and search, by call order; (b) tags, categories never vendors; (c) several conversations: one option each, no research, no answer call; (d) the lead equals the retrieved excerpt, is absent when nothing was retrieved or the message is from another day; (e) 30 Tuesday cases (6 topic-term sets, including none, times 5 phrasings of the day, including "earlier today" and "yesterday") and 12 Monday cases; (f) zero analysed entities, both vendors researched from tags alone or from stored entities alone; (g) the lead is present when every finding is `unable_to_verify` (research lane, shortlist, audit lane, three failure codes); retrieval is not the whole day (other topics, the other candidate Tuesday, another user, an unrelated stored entity) |

Mutation checks, each restored afterwards and each made at least one test fail: recall skipped in the research lane (73 failed); tags ignored (49); category filter removed (6); one of several conversations picked (1); lead sentence omitted (56); topic filter ignored so the whole day is returned (7); another user's messages included (9, three of them in the retriever's own tests); companies taken from all stored entities instead of the recalled message (4).

## Documentation checks (`tests/integration/docs.test.ts`)

Added in the post-M2 documentation pass. They check the documents against each other and against the code; they do not test application behaviour.

| Group | What it enforces |
|---|---|
| ADRs (9 tests) | numbers contiguous from 01 and unique; each has a title, a valid status (Proposed, Accepted, Superseded) and implementation value, and every required section in order; a Superseded ADR names its replacement; an ADR marked "implemented" links at least one test; the search-provider and model ADRs stay Proposed; the single-instance-guard ADR (34) stays Proposed; ADR-01 to ADR-24 and the index carry the reconstructed-not-recovered provenance statement; no ADR contains latency-percentile or millisecond figures; the index lists every ADR with the same title, status and implementation, and its counts are right |
| Links (3 tests) | every relative link in the README, `docs/questions.md`, `docs/testing.md`, `docs/turn-lifecycle.md`, the proposals and the ADRs resolves to a file; every ADR or question referred to by number exists; Q-001, Q-007, Q-011, Q-015 and Q-016 stay in the question log, and every question keeps its row in the summary table |
| ER diagram (5 tests) | `docs/diagrams/er.mmd` draws exactly the tables of the schema the migrations create (the FTS5 virtual table excluded), with every column, type, primary-key and foreign-key flag; every foreign key appears once as a solid relationship with its ON DELETE action; dotted relationships are only for columns with no foreign key; nothing planned is drawn |

What these do **not** check: that an ADR's prose is true, that its status is right, or that "no unmeasured claims" holds beyond the narrow millisecond/percentile pattern.
The Mermaid syntax of the diagram was validated once with the real Mermaid parser (11.x, in a scratch folder, not a project dependency): it parses as an `er` diagram, and a
deliberately broken copy is rejected. That validation is not part of the test suite, because adding the parser would add a heavy dependency.

## Mutation checks

The M2 code and migrations were checked by hand against 21 deliberately broken versions (begin without `BEGIN IMMEDIATE`; ack without the monotonic
shortcut, without the streamed-extent check, presenting every claim, without the `complete` check; recovery marking turns complete; `setState`
without the edge check; no `not_presented` events; no baseline check; and 11 migration changes: a dropped transition edge, finished turns not final,
mutable identity, presented without acknowledgement, render beyond streamed, `not_presented` for a streamed sentence, verdict on an unpresented claim,
three ownership triggers, two isolation triggers). Every one made at least one test fail, and the sources were restored byte-identical. This is a manual
spot check, not an automated mutation-testing run, and it does not show the tests are complete. The documentation checks were mutated the same way (16 breaks: a removed or added table or column,
a wrong ON DELETE label, a bad status, a missing section, a broken link, an unknown ADR, a measurement decision marked Accepted, an unsupported "implemented" claim, an invented latency figure,
a disagreeing or missing index row, a dropped open question or summary row); every one made a test fail and the documents were restored identical. The two gates added in the final documentation pass (provenance statement, ADR-34 staying Proposed) were each mutated once (a provenance line removed from ADR-12; ADR-34 set to Accepted) and each failed as expected.

The failure edges (ADR-39) were mutated four times, each restored identical: an edge removed from the migration trigger only (15 tests failed: the pair-by-pair comparison, the migration tests and the per-state failure tests), an edge removed from the TypeScript table only (5 failed), the failure path made a no-op so an unexpected error leaves the turn running (32 failed), and the failure path writing status `complete` instead of `failed` (29 failed).

## Known gaps in the tests

- T-DB-09 (above), and anything about belief correctness.
- The bare `deliveryState` consistency check in `AssertionRepository.listForMessage` (a stored `presented_at` that disagrees with the derived state throws) has
  no test, because the triggers make that state unreachable through SQL.
- Findings, metrics and completion shapes are validated by zod; their full contents are exercised through one realistic finding, not exhaustively.
