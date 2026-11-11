# Stage 3.1 Review: Reconciliation Log

Date: 2026-11-11.

Documents in scope:
- [stage-3-architecture.md](stage-3-architecture.md) (abbreviated **ARCH** below)
- [stage-3-contracts.md](stage-3-contracts.md) (**CON**)
- [design-doc-blueprint.md](design-doc-blueprint.md) (**BP**)

The approved architecture is unchanged: architecture C, five lanes, a modular monolith. The changes in this pass are the smallest ones that remove ambiguity or contradiction. Each new rule names who owns it and which test covers it.

---

## 1. Mandatory issues

| # | Issue found | Decision | Changed sections |
|---|---|---|---|
| A | A bare `$` was normalised to USD, so CAD, AUD or SGD prices could be silently mislabelled | An explicit marker table maps symbols and codes to currencies (`US$`, `A$`, `C$`, `NZ$`, `S$`, `€`, `£`, `₹`, `CHF`). A bare `$` or `¥` maps to `unknown` unless an explicit currency declaration appears in the quote or its associated header. An unknown currency is scoped to the source domain in the belief key (`unknown@domain`), so values are compared only across the same vendor domain. The renderer adds "currency not stated". Extraction must report `unknown` rather than guess | ARCH R2 (normalisation, currency row); CON `NormalizedValue.currency`/`currencySymbol`, `PriceBeliefKey.currency`, §3 rendering; tests T-EV-CUR-01..12 |
| B | A single `as_of` field mixed up observation time and effective time. A fresh fetch was treated as proof of when a change happened, and Stage 3 scenario 2 reported `changed` with a caveat | `observedAt`, `effectiveFrom`, `providerPublishedAt` and `providerLastUpdatedAt` are now separate fields. A derived `displayedAt` with an explicit basis replaces `as_of`. **New verdict: `differs_timing_unknown`.** `changed` now needs a post-baseline proof: a stated effective date after T0, or same-source bracketing (a fresh observation near T0 followed by a later different observation). `baseline_incorrect` needs a prior-effect proof or a baseline that wasn't supported. If both proofs hold, the verdict is `contested` with reason `timing_conflict` | ARCH R3 (time fields, resolution), §8 (verdict table and diagram), Part IV scenarios 2–3, ADR-22; CON `TimeFields`, `PriceVerdict`, `PriceVerdictReason`, `ChangeWindow`, SQL `observed_at`/`effective_from`/`displayed_at*`; tests T-BEL-20..27, INV-08 |
| C | Subject binding could pass on the snapshot title, which risked attributing a competitor's price to our entity in comparison articles | Title, URL and domain never establish the subject. The entity alias must appear in the value's segment, or in an **associated header**, which code checks for position: the header comes before the quote, within 1,500 characters, with no other entity's heading in between. A new **competitor attribution** check fails when another entity's alias is closer to the value. An official domain with no alias gives `weak`, never `pass` | ARCH R2 (segmentation/association, subject and competitor rows); CON `VerificationCheck`, `EntityContext.otherEntityAliases`, `RawEvidence.contextQuote`; pricing intents use `contentMode: 'text'` so headings survive (ARCH §7, §9; CON `SearchRequest`); tests T-EV-SUBJ-01..10, INV-09 |
| D | `flat` was inferred whenever seat language was missing, and the `usage` unit had no rule | `flat` needs a positive marker. `usage` needs a metered marker plus a `usageUnit` that appears in the segment. Anything else is `unspecified` | ARCH R2 (unit row); CON `NormalizedValue.usageUnit`, `PriceBeliefKey.usageUnit`; tests T-EV-UNIT-01..10 |
| E | The belief-key string didn't encode arrangement (list, promotional, conditional, planned), so the "never overwrite" rule had no mechanism behind it | A typed `PriceBeliefKey` with a canonical, versioned encoding covering arrangement, condition hash, unit, usage unit, billing period, currency and value kind. Historical and negated statements get no key. Planned prices stay under `planned`, and become only a `pendingSignal` on the list key once due. A "comparable but not equal" key yields `no_evidence_of_change` with the note `listed_differently` | ARCH R3 (key table, planned rule, comparable keys), ADR-21; CON `PriceBeliefKey`, `encodePriceKey`, `keyForEvidence`, `comparableKeys`, SQL `beliefs.key_json`, `pending_signals_json`; tests T-KEY-01..10, T-BEL-30..36 |
| F | It was unclear what T3a inspects (rendered text or template), how rendered values avoid false flags, what happens to late verification, and how sentences are persisted after an interruption | T3a runs on the **template with valid placeholders removed**. A separate **render-integrity check** compares each rendered placeholder to its authorised record. Malformed, unknown and inapplicable placeholders are dropped and flagged. The rules for numbers, dates, percentages, verdict words and global negatives are written out, with an allowlist. There is no hold-back: `answer.sentence_end` carries the T3a result and late T3b results arrive as `verification` events that can only confirm or downgrade. Persisted statuses are `verified`, `no_claims`, `unverified`, `unchecked` and `truncated`, with defined values for every interruption case | ARCH R4 (pipeline, statuses, timing, interruption), §13, ADR-16; CON `SentenceStatus`, `SentenceIssue`, `PersistedSentence`, `AnswerPipeline`, SSE `answer.delta.sentenceIndex`, `answer.sentence_end`, §3 grammar and compatible sets; tests T-ANS-01..14 |
| G | Acknowledging presentation for the whole message turned a partly seen answer into either "seen" or "unseen" | The unit of acknowledgement is the **sentence**. The server tracks `streamed_through` and the client acks `renderedThrough`, which is monotonic. An assertion's delivery state (`presented`, `streamed_unacknowledged`, `not_streamed`) is derived from those two values. Only `presented` assertions can be baselines. Acks are idempotent: `max()` on the value, a partial unique index on `presented` events, and a trigger that blocks decreases. The client acks on completion, on `pagehide` via `sendBeacon`, and on reconnect re-render | ARCH R4 (delivery boundary), §3 sequence, §16, Part IV scenario 7, ADR-23; CON SQL `messages.streamed_through/rendered_through`, `assertions.sentence_index`, triggers and indexes, `AckRequest`, `DeliveryState`, `TurnRepository.ack`; tests T-DLV-01..08, INV-05 |
| H | Per-call timeouts plus retries could run past the turn budget | One absolute `deadline` per turn. `TurnBudget` provides `timeoutFor`, `signalFor` (built with `AbortSignal.any`), reserves for later stages, and admission rules for retries, splits, the fallback round and the judge. Synthesis switches to compact mode below 12 s. Only local persistence may run after the deadline. A client disconnect doesn't abort the turn | ARCH §H, R1, §4 budgets, ADR-24; CON `TurnBudget`, constants, `signal` on every port request, `SearchErrorCode`/`LlmErrorCode` `cancelled`, `metrics.deadlineHit`/`notAdmitted`, SQL `turns.deadline_at`; tests T-BUD-01..08 |

## 2. Contract and database reconciliation

| Mismatch or gap | Resolution |
|---|---|
| `turn.started` used `messageId` in ARCH and `userMessageId` in CON | `userMessageId` everywhere |
| `answer.completed` used `messageId` in places | `assistantMessageId` everywhere |
| Turn status sets differed across `TurnResult`, the SQL check and `turn.completed` | One `TurnStatus` type; `TerminalTurnStatus = Exclude<…, 'running'>` is used by `TurnResult` and `turn.completed`; SQL CHECK uses the same six values |
| Finding `confidence` was mixed up with verdict | Renamed to `currentStatus` (belief state or `unable_to_verify`), kept separate from `verdict`. Allowed combinations are tabulated in CON and enforced by T-FND-01 |
| Placeholder examples (`[[M12]]`, `[[S5]]`, `[[F:contested]]`) didn't match the grammar | Grammar is `M:<id>`, `S:<id>`, plus a new `F<n>:derived:<k>`. Contested values render through `[[F<n>]]`. Examples fixed in ARCH R4, Part IV and CON §3 |
| `as_of`, `effective_date` and `retrieved_at` were named inconsistently | Replaced by `observed_at`, `effective_from`, `event_date`, `displayed_at`, `displayed_at_basis` and `provider_*` in SQL and TypeScript |
| Snapshot uniqueness `(user, url_norm, sha)` collapsed repeated observations, which broke same-source bracketing | `observed_at` added to the unique key, so every observation is kept |
| Idempotency was unique globally | `UNIQUE(user_id, idempotency_key)` |
| A message's `user_id` could differ from its conversation's owner | `BEFORE INSERT` owner triggers on `messages` and `turns`. Other user-scoped tables derive `user_id` from the turn inside repositories, covered by T-DB-02 |
| Append-only was stated as policy only | Triggers block UPDATE on snapshots, evidence, assertion events and belief history. Assertions may only have `presented_at` set once. Message content columns are immutable. DELETE is still allowed so privacy deletion and rebuilds work |
| Deletion cascades through `evidence_statements.turn_id` would delete evidence that another conversation's assertion still cited, and FK `SET NULL` would fight the append-only triggers | `evidence_statements.turn_id` is no longer a foreign key. Deletion is an explicit procedure (CON §1.1) that keeps evidence still referenced elsewhere, garbage-collects snapshots and entities, and rebuilds beliefs and history for the affected keys. `assertions.finding_id` changed to CASCADE |
| `belief_history` was described as both append-only and rebuildable | It is derived. Rows can't be updated, but a rebuild deletes and replays them. T-DB-REBUILD and T-DB-09 check this |
| Demo data isolation relied only on file separation | Added triggers that reject fixture users and non-live conversations or snapshots when `db_mode = 'real'`, plus a startup check that `APP_MODE` matches `db_mode` |
| T2 needed a list of an entity's known plans for the intervening-tier rule, and nothing stored it | Added an `entity_plans` table |
| SSE field names (`decisionRefs`, `searches`) were inconsistent | Now `decisionIds` and `plannedSearches` |
| Release items had no type for the "discontinued" verdict words | Added `releaseKind: launch | change | removal` |

## 3. Failure and evaluation model

The new invariants are INV-08 (`changed` needs a proof and a window), INV-09 (no subject binding from title alone) and INV-10 (no live adapter in replay). INV-02, INV-04 and INV-05 are reworded. The regression suites for each issue are listed in ARCH §17. Specific checks:

| Requirement | Covered by |
|---|---|
| A missing replay recording fails loudly | T-EVAL-01; `ReplayMissError` is never retried |
| Offline replay never calls a live service | T-EVAL-02, INV-10; replay adapters are built without credentials |
| One entity failing doesn't block the others | Existing T-REL-02, plus T-BUD-02 for the deadline case |
| Incomplete search coverage can't produce a global "no change" | INV-04, T-ANS-08 |
| A fresh fetch doesn't fabricate a change date | T-BEL-22, INV-08 |
| A page title can't bind a competitor's price | T-EV-SUBJ-03, synthetic `comparison-article`, INV-09 |
| A partial display is recorded accurately | T-DLV-02, INV-05 |

No evaluation results are claimed. Every latency, weak-rate and verdict-distribution figure is still a hypothesis.

## 4. Blueprint changes

- **Language rules (BP §2):** the word "changed" is reserved for the `changed` verdict; observation and effect are always kept apart; "shown to the user" is used only for acknowledged sentences.
- **Section plans:** §6 now covers the three-way timing answer; §8 covers subject binding, currency and delivery; §9 covers typed keys and `differs_timing_unknown`.
- **Decision narratives:** four added (observation vs effective time, delivery acknowledgement, one turn deadline, and DB-enforced demo isolation).
- **Evidence checklist:** new metrics (weak rate per check, deadline hits and admission refusals, sentence statuses, ack coverage) and ten new claim-to-test rows.
- **Limitations:** L-11 to L-15 added (regional prices, crash loss, bare `$`, ack ≠ reading, strict binding cost); L-03 rewritten.
- **Draft prose:** the introduction now states the observed-versus-effective limit in plain words, and the bulleted "everything follows" list became prose. §2 now names three possible answers instead of two. One sentence in the correctness principle now covers timing claims.

## 5. Unresolved issues

These cannot be settled from the design alone.

| ID | Issue | Why it's still open | How it gets resolved |
|---|---|---|---|
| U15 | How often real pricing pages produce `weak` (section has no product name) or unknown currency (bare `$`) | Depends on real page structure and on what the search provider returns. If the rate is high, many audits will land on `no_evidence_of_change` | Measure in the Phase-4 bake-off. If too high, loosen only the association window. **Title binding and bare-`$` handling won't be relaxed** |
| U16 | Whether Exa `text` content keeps headings and table structure well enough for header association | Undocumented | Phase-4 spot check on 10 pricing pages |
| U17 | Whether the crawler's location changes the prices it sees | Undocumented | Phase-4 spot check, otherwise recorded as limitation L-11 |
| U18 | Whether `sendBeacon` acks on `pagehide` are reliable across browsers | Browser behaviour varies, and the fallback is a re-render ack on the next visit | Manual check in Chrome, Firefox and Safari during Phase 9. Whatever is found gets documented |
| U19 | The 48 h tolerance for same-source bracketing and the other windows (U12) | These are judgement calls, with no data yet | Tune against recorded scenarios. Any change is an ADR note |

---

## 6. Final consistency checklist

Checked by reading the three documents side by side on 2026-11-11. This is a document review, not an executed check, because no code exists yet.

| # | Check | Result |
|---|---|---|
| 1 | Every SSE event in ARCH §13 exists in CON `SseEvent` with the same name and fields (`turn.started.userMessageId`, `answer.delta.sentenceIndex`, `answer.sentence_end`, `verification.issues`, `answer.completed.assistantMessageId`, `turn.completed.status: TerminalTurnStatus`) | ✅ |
| 2 | Turn statuses are the same in SQL CHECK, `TurnStatus`, `TurnResult`, `turn.completed` and ARCH §4 | ✅ |
| 3 | Price verdicts are the same in ARCH §8, CON `PriceVerdict`, SQL `findings.verdict` (free text, validated by zod), the T3a compatible sets, and the assertion-event mapping | ✅ |
| 4 | Release verdicts are the same in ARCH §8 and CON | ✅ |
| 5 | `currentStatus` values are the same in CON `FindingCurrentStatus` and SQL `findings.current_status` | ✅ |
| 6 | Time fields line up across ARCH R3, CON `TimeFields`/`SourceSnapshot`/`VerifiedEvidence` and the SQL snapshot and evidence columns. `as_of` appears only in the ADR text that records its removal | ✅ (checked with a grep for `as_of`, old placeholder forms, `retrieved_at`, `delivered_at` and `confidence`) |
| 7 | Belief-key fields are the same in ARCH R3, CON `PriceBeliefKey` and its encoding, and SQL `beliefs.key_json` | ✅ |
| 8 | Placeholder grammar in CON §3 matches every example in ARCH R4, Part IV and the BP draft prose | ✅ |
| 9 | Sentence statuses are the same in ARCH R4, CON `SentenceStatus` and `PersistedSentence`; `pending`/`pending_judge` appear only on the client or in SSE, never persisted | ✅ |
| 10 | Delivery columns (`streamed_through`, `rendered_through`, `sentence_index`, `presented_at`) appear in SQL, CON `deliveryState`/`AckRequest` and ARCH R4 | ✅ |
| 11 | Every append-only claim in ARCH §6 has a trigger in CON §1, and no protected table relies on an FK `SET NULL` | ✅ |
| 12 | The privacy deletion steps in CON §1.1 match ARCH §12 and the ARCH §6 mutability table | ✅ |
| 13 | Demo isolation: triggers, the startup check and the seed guard in CON §1 match ARCH R5 and the blueprint | ✅ |
| 14 | Deadline constants in CON `TurnBudget` match ARCH §H and §4 | ✅ |
| 15 | Every 3.1 mandatory issue has a regression suite ID in ARCH §17 and a claim row in BP §4.4 | ✅ |
| 16 | Every new invariant (INV-08..10) is marked critical in ARCH §17 | ✅ |
| 17 | The blueprint makes no claim of implementation, testing or measurement; all figures are marked hypothesis or are placeholders | ✅ |
| 18 | Open decisions U15–U19 are listed in both ARCH Part VII and this review | ✅ |
