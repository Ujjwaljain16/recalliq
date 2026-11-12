# Open questions and deviations

Raised during implementation. An entry means the specification was silent, contradictory, or narrower
than what the code needed. Nothing here was resolved by silently inventing a design: each entry says what
the code does meanwhile.

Status values: **open** (needs a decision), **decided** (owner decision recorded, implementation pending),
**applied** (implemented as described).

The normative contracts (`contracts.md`) were **not** modified by the database foundation and turn lifecycle work. The final documentation pass (2026-11-12) added a correction note and §1.2 to contracts §1 and corrected architecture §8; contracts §2 (including the locale change) is still unedited.
Proposed contract edits are written here for review instead. Decisions are recorded in [adr/README.md](adr/README.md); this file keeps the
questions, including resolved ones and their history.

| ID | Topic | Status | Blocks | ADR |
|---|---|---|---|---|
| Q-001 | Temporal proof for `changed`; missing `locale` dimension | **applied**: rule, definitions, locale in the key, content as-of time and the change detector are implemented and tested (2026-11-12) | — | [ADR-36](adr/ADR-36.md), [ADR-37](adr/ADR-37.md), [ADR-22](adr/ADR-22.md) |
| Q-002 | Demo isolation covers only some tables | **applied** (migration 002); complete isolation still not claimed | — | [ADR-28](adr/ADR-28.md) |
| Q-003 | PRAGMAs outside migrations | **applied**, approved | — | [ADR-25](adr/ADR-25.md) |
| Q-004 | Test IDs T-DB-01..10 | **applied** → [testing.md](testing.md) | — | — |
| Q-005 | Deletion and the belief rebuilder | **applied**, rebuild equivalence (T-DB-09) still not asserted | T-DB-09 | [ADR-35](adr/ADR-35.md) |
| Q-006 | `begin` while a different key is running | **applied** | — | [ADR-30](adr/ADR-30.md) |
| Q-007 | `user_id` consistency beyond messages and turns | **applied** (migrations 003, 006, 007, 008); plan recorded (2026-11-12); `search_requests`, `search_results` (migration 007) and `beliefs`, `belief_history` (migration 008); only snapshots-by-turn (no such column) remain, protected at their links | — | [ADR-27](adr/ADR-27.md) |
| Q-008 | Declared-only contract functions | applied | — | — |
| Q-009 | Type-identical lint edits | applied | — | — |
| Q-010 | Small implementation choices | applied | — | — |
| Q-011 | No failure edge from most states | **applied** (migration 010, failure policy in the coordinator, 2026-11-12) | — | [ADR-39](adr/ADR-39.md), [ADR-29](adr/ADR-29.md) |
| Q-012 | Acknowledgement before the answer is stored | open | — | [ADR-23](adr/ADR-23.md) |
| Q-013 | Meaning of `AckRequest.complete` | open | — | [ADR-31](adr/ADR-31.md) |
| Q-014 | JSON columns only partly validated | open | — | [ADR-32](adr/ADR-32.md), [ADR-05](adr/ADR-05.md) |
| Q-015 | Which assertions may become baselines | **applied** (rules, loader and the audit lane that calls it) | — | [ADR-38](adr/ADR-38.md) |
| Q-016 | `recoverRunning` assumes one process | open | — | [ADR-34](adr/ADR-34.md), [ADR-33](adr/ADR-33.md) |
| Q-017 | Behaviour added beyond the contract | applied | — | [ADR-30](adr/ADR-30.md), [ADR-32](adr/ADR-32.md) |
| Q-018 | Test IDs introduced with the turn lifecycle | applied → [testing.md](testing.md) | — | — |
| Q-019 | Provider cache age or capture time is not in the contract | open | change detector | [ADR-36](adr/ADR-36.md) |

---

## Owner review of the documentation (2026-11-12)

The 39-ADR structure and numbering were accepted, with these decisions. Docs only: no application code changed.

- **Provenance.** ADR-01..24 are reconstructed from the architecture register (§20) and the design documents, not recovered original text; each page and the index say so. Decision status and implementation status are separate fields.
- **Q-015 / ADR-38 decided:** historical *recall* and *baseline eligibility* are different. Rules in [ADR-38](adr/ADR-38.md). The loader has since been implemented.
- **Q-001:** the effective-date distinction is decided; locale is a required comparability dimension ([ADR-37](adr/ADR-37.md)); the change detector is implemented ([ADR-36](adr/ADR-36.md)).
- **Q-007:** a table-by-table plan with timing is recorded below; ownership was not fully enforced at the time of this note; migrations 006 to 008 have since added the missing triggers.
- **ADR-34 stays Proposed**, no mechanism chosen. **ADR-39 was later accepted and implemented** (see Q-011). **Q-012, Q-013, Q-014 and Q-016 stay open.**
- **Corrections to normative text:** contracts §1 (PRAGMAs, migrations 002–005) and architecture §8, §12, Part IV scenarios 2–3, the scenario matrix, U12 and U19.

## Owner review of the turn lifecycle work (2026-11-11)

The turn lifecycle work was approved, with these qualifications. They are recorded here and in the ADRs; none of the questions below is closed by them.

- **Q-011 (failure transitions), resolve before the orchestrator.** Define a failure transition from every non-terminal state with an explicit recovery policy, but do **not** add arbitrary
  failure edges: decide which failures are recoverable, which are terminal, and how partial work is preserved. → [ADR-39](adr/ADR-39.md), now Accepted and implemented.
- **Q-007 (ownership), still open.** Evidence, findings and assertions are protected; `search_requests`, `decisions`, snapshots and beliefs are not. Ownership integrity must not be
  described as fully enforced. Add the constraints and cross-user regression tests before those tables are used heavily. → [ADR-27](adr/ADR-27.md).
- **Q-015 (historical baselines), resolve before memory and recall.** Only presented assertions can become baselines: a presented assertion can be retrieved as previously communicated; a
  streamed-but-unacknowledged one cannot; an unverified sentence cannot become a factual baseline merely because it was rendered; a baseline must retain its original evidence
  references and verification status. → [ADR-38](adr/ADR-38.md), Proposed until the details (placeholder variants, qualifying sentence statuses) are finalised.
- **Q-016 (recovery assumption), document explicitly.** One Node process per database file is acceptable, but startup must prevent accidental concurrent instances: SQLite
  transactions alone do not establish the assumption. → [ADR-34](adr/ADR-34.md), Proposed; no mechanism chosen or implemented.
- **Documentation debt.** The missing `docs/adr/` and `docs/diagrams/` directories were created in a later documentation pass: [docs/adr/README.md](adr/README.md), [docs/diagrams/er.mmd](diagrams/er.mmd).

## Q-001: temporal proof for `changed`, and the missing `locale` dimension

**ADR:** [ADR-36](adr/ADR-36.md), [ADR-37](adr/ADR-37.md), [ADR-22](adr/ADR-22.md)  
**History:** Raised during the database foundation work (conflict between the kickoff and architecture §8) → owner decided the rule on 2026-11-11 → on 2026-11-12 the owner settled the effective-date question (d), accepted locale (canonical BCP-47, `und` when unknown) and approved the definitions of observation, source identity and comparability. Contracts §2 and `src/shared/belief.ts` were updated. The change detector is now implemented ([ADR-36](adr/ADR-36.md)).

### Owner decision (2026-11-11): the exact proof requirements

A 48-hour window is **not independently sufficient** to establish that a price changed.

A post-baseline change (`changed`) requires **all** of:

1. **An observation of the old value after the previous answer.** The observation time is later than
   T0, the moment the baseline assertion was presented (`assertions.presented_at`).
2. **Followed by an observation of the new value**, later than the first.
3. **Matching source identity** between the two observations.
4. **Comparable locale, plan, billing arrangement and pricing context** between the two observations
   (and with the baseline).

If those conditions cannot be established, the verdict is `differs_timing_unknown` (the other verdicts
keep their own conditions, e.g. `baseline_incorrect`, `contested`, `unable_to_verify`).

### How this differs from the current specification

Architecture §8 ("post-baseline proof"; text as it stood before the 2026-11-12 correction) says `changed` holds if **either** a stated effective date after
T0 exists **or** same-source bracketing holds, where bracketing is an observation of `vB` made as early
as 48 h *before* T0 followed by a later different observation. The decision above:

- removes the 48 h tolerance (U19 is closed: there is no window to tune);
- requires the old-value observation to be **after** T0, not merely near it;
- adds the comparability conditions (identity, locale, plan, billing, pricing context).

### Sub-questions the decision leaves open

The following need an answer before `ChangeDetector` is written. All rows are decided (d on 2026-11-12, then a, b, c and e as approved definitions on 2026-11-12): an observation is an immutable, timestamped snapshot with sufficient content and validated supporting evidence; source identity is `url_norm` (meaningful query parameters kept, only tracking parameters removed); comparable means `comparableKeys === 'equal'` including locale; the baseline's own fetch never counts; an unknown locale cannot independently establish `changed`. The first reading of "sufficient content" as a successful fresh crawl was **relaxed by the owner on 2026-11-12**: a provider-cached copy can be an observation if it was retrieved after the relevant event, its retrieval time is recorded separately, its cache metadata is kept, and its content supports the claim; it needs an established content as-of time to support a positive `changed` (see ADR-36).

| # | Question | Proposed answer |
|---|---|---|
| a | What counts as an "observation"? | A `pass` evidence statement whose snapshot has `fresh_fetch = 1` and `crawl_status = 'ok'`, timed by `observed_at`. Provider-reported dates are hints and do not count |
| b | What is "matching source identity"? | The same `url_norm` (the same page). A different page on the same domain does not match |
| c | What is "comparable … pricing context"? | `comparableKeys(a, b) === 'equal'`: every dimension of the belief key matches (plan, arrangement, condition hash, unit, usage unit, billing period, currency, value kind), plus locale once it exists. `'comparable'` (differs only where one side is `unspecified`) is **not** enough |
| d | Does a stated effective date after T0 (architecture §8, reason `stated_effective_date`) still count as a post-baseline proof? | **Decided 2026-11-12: yes, when it is explicitly associated with the price and reliable.** An effective date that the extraction attaches to the new price, from an A1 or A2 source, later than T0, can establish timing (`changed`, "from <date>"). A publication date or a fetch date alone cannot, and a fresh fetch never sets one. Architecture §8 is corrected accordingly; the `effective-date-stated` scenario keeps its `changed` outcome only if the date is explicitly tied to the price |
| e | Does the baseline's own fresh fetch count as the old-value observation? | No. It was made before the answer was presented, so it is not "after the previous answer" (rule 1) |

### Consequence for the belief resolver and for demo data

A baseline is presented after it was observed, so the first audit that sees a different price will
usually have **no** old-value observation after T0 and will report `differs_timing_unknown`. `changed`
becomes reachable only when the system has re-observed the old value after T0 and later the new one
(for example two successive audits, or scheduled re-checks). The recorded scenarios for the demo must
therefore include a re-observation of the old value after T0 if a `changed` verdict is to be demonstrated
honestly. This is a real consequence of the stricter rule, not a defect.

Architecture Part IV scenarios 2 and 3 were re-derived under this rule on 2026-11-12 (architecture §8 corrected, old text kept as history). The `silent-change-no-date` fixture does not exist yet; its expected verdict must follow the corrected scenarios.

### Missing `locale` dimension

`PriceBeliefKey` (contracts §2) has no locale. The same plan sold at different prices in different
regions, on the same domain, therefore maps to **one** key:

- two regional pages observed in one run read as a conflict (`contested`) or one silently shadows the
  other, depending on timing;
- the comparability condition "comparable locale" cannot be evaluated, because there is nothing to compare;
- limitation L-11 (regional prices) and open item U17 (crawler location) cannot be addressed in the model.

**Implications for the belief resolver** (written when it did not exist yet; nothing in the database foundation depends on this):

| Area | Effect |
|---|---|
| `encodePriceKey` / `decodePriceKey` / `comparableKeys` | Gain a locale component |
| `keyForEvidence` | Needs the source URL, not only its domain, to derive locale |
| `BeliefResolver` | Evidence for different locales resolves independently instead of contesting each other |
| `ChangeDetector` | Condition 4 needs locale equality |
| Tests | T-KEY round-trip with locale; T-BEL "same plan, two locales" is neither `contested` nor `changed`; "locale unspecified" yields `differs_timing_unknown` |
| Documents | Contracts §2 `PriceBeliefKey` and encoding comment; architecture R3 key table and §8 |

### Smallest contract change proposed for review (NOT applied)

1. `PriceBeliefKey` gains `locale: string`: a lower-cased language or language-region tag such as `en-gb`,
   or the literal `unspecified`.
2. The canonical encoding gains `|loc=<locale>` after `cur=…`:
   `price:v1|e=…|p=…|a=…|c=…|u=…|uu=…|b=…|cur=…|loc=en-gb|vk=…`. Because `encodePriceKey` is not implemented
   and no key has ever been persisted, the key can stay at `v1`; if the reviewer prefers, bump to `v2`.
3. Locale is **derived by code**, never by the model: a leading URL path segment or subdomain matching
   `^[a-z]{2}(-[a-z]{2})?$`, or a `locale=`/`country=` query parameter; otherwise `unspecified`. It is not
   inferred from currency.
4. `keyForEvidence(e, sourceDomain)` becomes `keyForEvidence(e, source: { domain; urlNorm })`.
5. **No SQL change.** `belief_key` and `beliefs.key_json` are `TEXT`, and the extractor contract
   (`RawEvidence`) is unchanged.
6. Open point for the reviewer: two observations of the **same URL** with locale `unspecified` are
   comparable (same page), but `unspecified` against a known locale is not.

Status: **applied to the contract** (2026-11-12): locale is a required pricing-comparability dimension ([ADR-37](adr/ADR-37.md)). The owner approved a different encoding from the proposal above: a canonical BCP-47 tag (`Intl.getCanonicalLocales`) with `und` for unknown, instead of a lower-cased tag with `unspecified`; contracts §2 and `src/shared/belief.ts` carry it. The key-encoding functions and the change detector are implemented. Item 6 is superseded: different locales, `und` against a known locale included, are incomparable, and `und` cannot independently establish `changed`.

---

## Q-002: demo isolation covers only some tables — **applied** (migration 002)

**ADR:** [ADR-28](adr/ADR-28.md)  
**History:** Gap documented and a remediation proposed during the database foundation work → applied as migration 002 in the turn lifecycle work. Complete isolation is still not claimed.

Resolved by `src/db/migrations/002_demo_isolation.sql`. A `real` database now rejects, at the database level:
non-live messages, entities and decisions on insert; relabelling of users, conversations, entities and decisions;
and any change to or deletion of `meta.db_mode`. The tests are the `T-DB-07` group in `invariants.test.ts`;
the characterisation tests that documented the gap were removed because the gap no longer exists.

The migration goes slightly beyond the three tables Q-002 named (relabelling and `db_mode` immutability): those
were extra findings of the same review, and without them the three
tables could still be bypassed.

**Still not claimed:** complete isolation. The proposal's residual list stands: `belief_history`, `search_cache`
and a few plain columns (`evidence_statements.user_id`, `beliefs.user_id`, `search_requests.entity_id`) have no
origin and no guarded parent. Raw SQL by a privileged caller can still do anything; the triggers protect the
application's write paths and the startup check.

**Proposed contract edit (not made):** contracts §1 should list migrations 002 to 005. The contracts file is
unchanged; the parity test still compares only migration 001 with it.

---

## Q-003: PRAGMAs outside migrations — applied, approved

**ADR:** [ADR-25](adr/ADR-25.md)  
**History:** Raised during the database foundation work → approved by the owner → applied (WAL error on a file database reproduced on 2026-11-11).

Owner decision: WAL and the other connection-level PRAGMAs are configured outside the migration
transactions, and schema migrations stay transactional.

- `openDatabase()` sets `foreign_keys = ON`, `busy_timeout = 5000`, and `journal_mode = WAL` for file
  databases (and fails if WAL cannot be enabled).
- Each migration runs in its own `BEGIN IMMEDIATE` transaction together with its `schema_version` update,
  so a failed migration leaves the previous version intact (tested).
- `001_init.sql` differs from contracts §1 only by the missing PRAGMA lines; `contract-parity.test.ts`
  proves this.
- Guard (new): a test fails if any shipped migration contains a `PRAGMA` statement, so the rule cannot
  erode.

**Proposed contract edit (for review; contracts untouched):** in §1, replace the two `PRAGMA` lines with a
note that they are connection settings applied by `openDatabase()`.

---

## Q-004: test IDs T-DB-01..10 — applied

**ADR:** —

The documents name T-DB-02, 04, 08 and 09 and describe the rest without numbers. The enumeration used,
with the invariant, test file and test case for each, is in [testing.md](testing.md). It also records
what each test does **not** prove.

---

## Q-005: privacy deletion and the belief rebuilder — applied; rebuild correctness untested

**ADR:** [ADR-35](adr/ADR-35.md)  
**History:** Applied with a recording fake rebuilder → the belief resolver and repository now exist and rebuild after deletion is tested against them, but T-DB-09 (equality with a fresh rebuild) is still `todo`. Not fully tested.

- Deletion takes an **injected** `BeliefRebuilder`. There is no default implementation, so derived
  state cannot silently go stale.
- **What is tested (database mechanics):** the conversation and what hangs off it are removed; evidence an
  assertion elsewhere still cites survives; unreferenced snapshots and entities are removed, scoped to the
  user; the full-text index is cleaned; the rebuilder is called once, with the affected keys, inside the
  transaction; a throwing rebuilder rolls the whole deletion back. The rebuilder used in these tests is a
  **recording fake**.
- **What is not tested:** that rebuilding produces correct beliefs and history after a deletion. That needs
  the belief resolver, which now exists. **T-DB-09 stays `todo`**; the recall half of T-MEM-08 is tested ([testing.md](testing.md)). Until
  then deletion is not fully tested and must not be described as such.
- Step 6 ("no remaining tag mention") is implemented as: the entity's normalised name appears as a whole
  space-delimited run in some message's `tags`. The contract does not define the match.
- All deletion statements also filter on `user_id`; a test fails if the cleanup steps lose that scoping.

---

## Q-006: `TurnRepository.begin` when a different key hits a running turn — **applied**

**ADR:** [ADR-30](adr/ADR-30.md)  
**History:** Raised during the database foundation work → applied in the turn lifecycle work (the first backstop could never match; fixed and tested).

Enforced at the database level by the contract's partial unique index `turns_one_running`, inside a
`BEGIN IMMEDIATE` transaction in `begin()`. The repository throws a typed `TurnInProgressError(existingTurnId)`
(the API will map it to 409); a backstop converts the index violation to the same error. A real defect was found
while testing this: SQLite reports a partial-unique-index violation as `UNIQUE constraint failed: turns.conversation_id`,
not by index name, so the first version of the backstop could never match. It is fixed and pinned by a test against the
real SQLite error.

Verified with real concurrency (worker threads, one connection each): six racers with different keys give exactly
one winner, five `TurnInProgressError`, one running turn, one stored message.

## Q-007: `user_id` consistency beyond messages and turns — **applied** (migrations 003, 006, 007, 008)

**ADR:** [ADR-27](adr/ADR-27.md)  
**History:** Raised during the database foundation work → partly applied with migration 003, completed with migrations 006 to 008 (only snapshots by turn remain, protected at their links).

Applied for evidence (turn, snapshot, entity), findings (entity), assertions (turn, message, finding-to-turn) and
`assertion_evidence` (migration 003), and for `decisions` and `decision_entities` (migration 006, 8 triggers, 24 tests) and for `search_requests` and `search_results` (migration 007, 5 triggers) and for `beliefs` and `belief_history` (migration 008). Not covered directly: `source_snapshots`, which has no turn; they are protected at their links.

### Plan for the remaining tables (2026-11-12, since carried out)

This was the plan written when only evidence, findings, assertions and `assertion_evidence` were protected (migration 003). Migrations 006, 007 and 008 have since added the triggers for the tables below, and a JSON-referenced id can be checked by a trigger with `json_each`.

Rule for timing: a table's ownership trigger and its cross-user tests land in the same change as the first code that writes it, and that change is not accepted without them. They are not deferred to the end of the project.

| Table | What is unchecked now | Planned enforcement | Enforce before first use by |
|---|---|---|---|
| `decisions` (**applied, migration 006**) | `user_id` may differ from its conversation's or message's owner; `message_id` may belong to another conversation; `supersedes_id` may point at another user's decision | Insert trigger: `user_id` equals the conversation's and the message's; the message belongs to the conversation; `supersedes_id` is the same user's. Update trigger: identity columns immutable | Migration 006 |
| `decision_entities` (**applied, migration 006**) | The decision and the entity may belong to different users | Insert trigger: both rows have the same `user_id` | Same change as `decisions` |
| `search_requests` | `user_id` may differ from its turn's; `entity_id` is unchecked | Insert trigger: `user_id` equals the turn's; `entity_id`, if set, is the same user's. Identity columns immutable | Migration 007 |
| `search_results` | A request and a snapshot of different users can be linked | Insert trigger: request and snapshot have the same `user_id` | Migration 007 |
| `source_snapshots` | It has no turn: a snapshot cannot be tied to the turn that fetched it. `user_id` is bound only by the writer | Cannot be checked against a turn. Ownership is enforced at its links (evidence, already covered; `search_results`, above) and by making the identity columns immutable | Migration 007 |
| `beliefs` | `entity_id` may belong to another user; `winning_evidence` (JSON) may name another user's evidence | Insert/update trigger: the entity is the same user's. The evidence ids are validated by the writer, with a trigger only if `json_each` proves workable. Beliefs are derived, so a failed check is repaired by rebuild | Migration 008 |
| `belief_history` | `user_id` is unchecked; `evidence_ids` (JSON) and `turn_id` (no foreign key) may point at another user's rows | Insert trigger: a non-null `turn_id` belongs to the same user; JSON ids as for `beliefs`. Append-only between rebuilds is already enforced | Migration 008 |

Regression tests required per table, modelled on [ownership.test.ts](../tests/integration/db/ownership.test.ts): a cross-user insert is rejected with the trigger's message; a same-user insert is accepted; identity columns cannot be updated; the rule holds on the real write path at the latest schema; and deleting the trigger makes the test fail (a manual mutation check, recorded in [testing.md](testing.md)).

Two behaviours go beyond the contract and are stated here: a finding's `entity_id` (a plain column in the contract)
must now reference an **existing** entity of the turn's user; and evidence rows may reference a turn only at insert
time (the contract deliberately has no foreign key there, so evidence can outlive a deleted turn).

## Q-008: contract functions with no implementation yet — applied

**ADR:** —

`encodePriceKey`, `decodePriceKey`, `keyForEvidence`, `comparableKeys` and `deliveryState` are declared
(`export declare function`) in the contracts. A declaration with no implementation type-checks but fails at
runtime on import, so they are left out of `src/shared` with a comment naming where they will live.

## Q-009: lint-driven, type-identical edits to the contract types — applied

**ADR:** —

`CurrencyCode | 'unknown'` and ``CurrencyCode | `unknown@${string}` `` are the same type as `string`, and the
`no-redundant-type-constituents` lint rule rejects them. They are written as `string` with the meaning in a
comment. No lint rule is disabled anywhere.

## Q-010: smaller implementation choices, for the record — applied

**ADR:** —

- `MessageRepository.insert` also sets `conversations.updated_at`, so conversation lists sort by activity.
- IDs read from storage are checked for their prefix (`parseId`) instead of cast.
- `zod` appears in `src/shared/llm.ts` (`StructuredRequest.schema`), exactly as the contract has it.
- Development tooling beyond the brief's list: `eslint`, `typescript-eslint`, `@eslint/js` and `prettier`, because
  linting and formatting were requested. TypeScript is `~6.0.3` because `typescript-eslint` 8 does not support 7.x yet.

---

## Questions raised by the turn lifecycle work

None of these blocked memory and recall. Each says what the code does meanwhile.

### Q-011: no failure edge from most states — applied (2026-11-12)

**ADR:** [ADR-39](adr/ADR-39.md), [ADR-29](adr/ADR-29.md)
**History:** Raised during the turn lifecycle work, open through the owner review. The owner decided that replay misses and unexpected failures must move the turn to a terminal state. **Applied.**

The state machine in architecture §4 had failure edges only from ANALYZING and SYNTHESIZING (to PERSISTING) and from
PERSISTING (to FAILED), so an unexpected exception while SEARCHING, EXTRACTING, VERIFYING or RESOLVING_BELIEFS (and in
RECEIVED, RESOLVING_CONTEXT, PLANNING) had no legal way to a final state.

**What the code does now:** every non-final state has an edge to PERSISTING (26 edges, in the TypeScript table and in migration 010). An unexpected error
before persistence makes the coordinator move the turn to PERSISTING and call `complete()` with status `failed`, an error code naming the class
(`replay_miss`, `internal_error`, `contract_violation`, `persistence:<code>`, `external_error`, `deadline`, `cancelled`) and no assistant message; the client gets an SSE
`error` event and the original error is logged and rethrown. If the finalising write fails, `fail()` is used when the turn reached PERSISTING, otherwise
`recoverRunning` still interrupts the turn on the next start. Normal typed outcomes (partial, interrupted, clarify, a fixed reply for a provider outage) are unchanged.

**Not done:** findings gathered before the error are not stored by the failure path, partial search and evidence rows are not cleaned up, and a failed turn is not retried automatically.

### Q-012: an acknowledgement that arrives before the answer is stored is rejected — open

**ADR:** [ADR-23](adr/ADR-23.md)  
**History:** Raised during the turn lifecycle work. **Open.**

The answer is stored only when the turn completes, but the browser may send its `pagehide` beacon while the stream is
still running (architecture R4, U18). `ack()` then has no message to attach to and throws `TurnNotFinishedError`; the
browser's early beacon is lost.

**Behaviour meanwhile:** the browser must re-acknowledge after it renders the stored answer (the architecture's "reconnect
re-render ack", T-DLV-06). Until it does, nothing is presented, which fails safe: too little is told, never too much.
**Alternative if wanted:** persist a pending acknowledgement on the turn and apply it at completion.

### Q-013: meaning of `AckRequest.complete` — open

**ADR:** [ADR-31](adr/ADR-31.md)  
**History:** Raised during the turn lifecycle work. **Open.**

The contract defines the field without semantics. Implemented: `complete: true` claims the browser rendered everything the
server streamed, so `renderedThrough` must equal the streamed extent exactly (otherwise `InvalidAckError`).

### Q-014: JSON columns are only partly validated — open

**ADR:** [ADR-32](adr/ADR-32.md), [ADR-05](adr/ADR-05.md)  
**History:** Raised during the turn lifecycle work. **Open.**

`TurnCompletion.analysis`, `.context` and `.events` are checked as JSON-shaped envelopes only; their full schemas arrive
with their producers (turn analysis, memory and the SSE writer). Fully validated now: sentences,
findings, normalised values, metrics, assertions and baseline events. `complete()` now **accepts and validates** `enrichment` (tags, entity mentions and decisions, with limits, in the same transaction; invalid input rejects the whole completion). It still **rejects** non-empty `touchedBeliefKeys`; it never ignores them. Beliefs are recomputed by the belief repository, outside the completion transaction. Still envelope-only: `analysis`, `context`, `events`.

### Q-015: which stored assertions may become baselines — applied

**ADR:** [ADR-38](adr/ADR-38.md)  
**History:** Raised during the turn lifecycle work. Direction given by the owner; on 2026-11-12 the owner adopted the recall / baseline-eligibility distinction and the rules were written from the actual placeholder grammar and schema. **Decided and applied** ([ADR-38](adr/ADR-38.md)).

The database records every assertion and its delivery state; it does not decide eligibility. The rules are in [ADR-38](adr/ADR-38.md): recall needs presentation; baseline eligibility additionally needs the current-value placeholder `F<n>`, a `verified` sentence, set key and value, and at least one evidence link with every linked statement `pass`. The two questions that were open were answered like this:

- `F<n>:baseline`, `F<n>:verdict` and `F<n>:derived:<k>` are **not** baselines; only `F<n>` is;
- an assertion in a sentence with status `unverified`, `unchecked` or `truncated` is recallable but **not** a baseline.

`BaselineLoader` ([ADR-38](adr/ADR-38.md)) implements rules 1 to 6 and a separate `recallUnverified`; 24 tests. The audit lane calls it through `LoaderBaselineSource` in `src/app/store-adapters.ts`.

### Q-016: `recoverRunning` assumes one application process per database file — open

**ADR:** [ADR-34](adr/ADR-34.md), [ADR-33](adr/ADR-33.md)  
**History:** Raised during the turn lifecycle work. **Open.** Owner review: startup must prevent concurrent instances (ADR-34, Proposed).

It interrupts every running turn, unscoped, at startup. A second process started against the same file would interrupt the
first process's live turns. There is no lease or heartbeat. Acceptable for the single-process monolith in the architecture;
noted so it is not forgotten if that ever changes.

### Q-017: behaviour added beyond the contract — applied

**ADR:** [ADR-30](adr/ADR-30.md), [ADR-32](adr/ADR-32.md)  
**History:** Recorded during the turn lifecycle work.

- Reusing an idempotency key with a different conversation or text throws `IdempotencyConflictError` instead of silently
  returning the first turn.
- `complete()` requires every assertion to match a rendered placeholder of its sentence (same token, finding and rendered text),
  and refuses duplicates, out-of-range sentences and inconsistent statuses.
- A verdict event or a finding baseline may only target an assertion that was presented, to the same user, in an earlier turn.
- Assertions are only stored for assistant messages of their own turn; the assistant message inherits its user message's
  `tz` and `origin`.
- `fail()` is an extra repository method (not in the `TurnRepository` contract) for the PERSISTING to FAILED edge.

### Q-018: test IDs introduced with the turn lifecycle work — applied

**ADR:** —  
**History:** Recorded during the turn lifecycle work.

T-DLV-01..08 are mapped in [testing.md](testing.md): the architecture lists the intent (full render acked; partial render
acked then disconnect; never rendered; duplicate and out-of-order acks; reconnect re-render; retry does not alter the
original) without numbers, and only T-DLV-02 is cited by number elsewhere. The eighth (interrupted turns keep the exact
extent) comes from the turn lifecycle requirements. `T-TRN-*` (turn lifecycle) and `T-ASR-*` (assertion persistence) are new
IDs assigned with the turn lifecycle work and do not exist in the contract documents.

### Q-019: provider cache age or capture time is not in the contract — open

**ADR:** [ADR-36](adr/ADR-36.md)
**History:** Raised 2026-11-12 when the observation definition was relaxed to allow provider-cached copies. **Open.**

ADR-36 needs a content as-of time for a cached observation, and asks that cache metadata and age be preserved when the provider reports them. `SearchHit` and `SourceSnapshot` have only `observedAt`, `providerPublishedAt`, `providerLastUpdatedAt`, `freshFetch` and `crawlStatus`, and the schema has no column for a capture time or cache age. Until this is settled the change detector derives the as-of time from the fields that exist: `observedAt` for a live crawl, otherwise `providerLastUpdatedAt`, otherwise unknown (which cannot support `changed`). Proposed resolution, once the search adapter shows what the provider actually returns: a nullable `contentAsOf` on `SearchHit`, `SourceSnapshot` and the evidence time fields, with an additive migration. Not applied: it changes shared contracts and the schema.

**Finding from the search adapter (2026-11-12, from reading docs.exa.ai; nothing was run against the live API):** the documented search API has no per-result capture time or cache age. A live crawl is requested with `contents.maxAgeHours: 0` (content fetched within the last 60 seconds); a cached result is marked only by `statuses[].source = "cached"`, a field documented for the contents endpoint and **not confirmed** for search. Consequently a cached hit can be dated no better than `publishedAt`, which is a hint. The adapter sets `freshFetch` only when a live fetch was requested, the crawl status is ok and the status source is `live` (an assumption: only `cached` is documented), so it errs towards false. A `contentAsOf` field would therefore usually be null, and the change detector will mostly derive an as-of time from `observedAt` of a live crawl. Raw `source` and `status` are kept in recordings. Decision on adding the field is deferred until a real recording exists.

**Observed on 2026-11-12 with the real API (one request pair):** a search response has no `statuses`, no per-result crawl or cache marker, no crawl date and no last-updated field. Consequence: `freshFetch` is false for every real Exa result, so the content as-of time is unknown unless the provider gives a last-updated time (it does not), and a `changed` verdict by re-observation is unreachable on live data. Options: (a) keep the conservative rule, so live audits give `differs_timing_unknown` or use an explicit effective date; (b) treat a request made with `maxAgeHours: 0` as the provider's statement that the content was fetched live, which is documented behaviour but not a per-result report and is not verified for failed fetches. Not decided.

**Implemented with constraints (2026-11-12):** the freshness observation proposal (now [ADR-36](adr/ADR-36.md) and [ADR-44](adr/ADR-44.md)) is implemented as approved. Each snapshot records a `crawl_basis` (`confirmed_live`, `requested_live`, `cached`, `unknown`; migration 009). `confirmed_live` needs a per-result provider marker, so it is never produced for real Exa search responses. A `maxAgeHours: 0` request with sufficient content is `requested_live`, which is recorded and reported in the finding but changes no belief status, `displayedAt` or verdict; short or thin content is `unknown`. Option (b) is therefore not adopted: a live request is not treated as a confirmation. Retrieval time stays separate from source time. A dedicated capture-time field is still not added.
