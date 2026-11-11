# Open questions and deviations

Raised during implementation. An entry means the specification was silent, contradictory, or narrower
than what the code needed. Nothing here was resolved by silently inventing a design: each entry says what
the code does meanwhile.

Status values: **open** (needs a decision), **decided** (owner decision recorded, implementation pending),
**applied** (implemented as described).

The normative contracts (`stage-3-contracts.md`) are **not** modified during Milestone 1. Proposed contract
edits are written here for review instead.

| ID | Topic | Status | Blocks |
|---|---|---|---|
| Q-001 | Temporal proof for `changed`; missing `locale` dimension | **decided** (rule) / **open** (locale contract change) | Milestone 4 change detector |
| Q-002 | Demo isolation covers only some tables | **open**, remediation proposed | Real-database isolation claim |
| Q-003 | PRAGMAs outside migrations | **applied**, approved | — |
| Q-004 | Test IDs T-DB-01..10 | **applied** → [testing.md](testing.md) | — |
| Q-005 | Deletion and the belief rebuilder | **applied**, rebuild correctness untested until M4 | T-DB-09 |
| Q-006 | `begin` while a different key is running | open | Conversation-lifecycle milestone |
| Q-007 | `user_id` consistency beyond messages and turns | open | Evidence-pipeline milestone |
| Q-008 | Declared-only contract functions | applied | — |
| Q-009 | Type-identical lint edits | applied | — |
| Q-010 | Small implementation choices | applied | — |

---

## Q-001: temporal proof for `changed`, and the missing `locale` dimension

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

Architecture §8 ("post-baseline proof") says `changed` holds if **either** a stated effective date after
T0 exists **or** same-source bracketing holds, where bracketing is an observation of `vB` made as early
as 48 h *before* T0 followed by a later different observation. The decision above:

- removes the 48 h tolerance (U19 is closed: there is no window to tune);
- requires the old-value observation to be **after** T0, not merely near it;
- adds the comparability conditions (identity, locale, plan, billing, pricing context).

### Sub-questions the decision leaves open

The following need an answer before `ChangeDetector` is written. The proposed answer is the one the code
will follow unless the owner says otherwise.

| # | Question | Proposed answer |
|---|---|---|
| a | What counts as an "observation"? | A `pass` evidence statement whose snapshot has `fresh_fetch = 1` and `crawl_status = 'ok'`, timed by `observed_at`. Provider-reported dates are hints and do not count |
| b | What is "matching source identity"? | The same `url_norm` (the same page). A different page on the same domain does not match |
| c | What is "comparable … pricing context"? | `comparableKeys(a, b) === 'equal'`: every dimension of the belief key matches (plan, arrangement, condition hash, unit, usage unit, billing period, currency, value kind), plus locale once it exists. `'comparable'` (differs only where one side is `unspecified`) is **not** enough |
| d | Does a stated effective date after T0 (architecture §8, reason `stated_effective_date`) still count as a post-baseline proof? | **Unclear in the decision.** Read literally, only bracketing yields `changed`, and "effective 1 Dec" from an official page alone would give `differs_timing_unknown`. That changes architecture §8 rows 6b, the `stated_effective_date` reason, and the expected outcome of the `effective-date-stated` synthetic scenario (T-BEL-2x). Needs an explicit answer |
| e | Does the baseline's own fresh fetch count as the old-value observation? | No. It was made before the answer was presented, so it is not "after the previous answer" (rule 1) |

### Consequence for M4 and for demo data

A baseline is presented after it was observed, so the first audit that sees a different price will
usually have **no** old-value observation after T0 and will report `differs_timing_unknown`. `changed`
becomes reachable only when the system has re-observed the old value after T0 and later the new one
(for example two successive audits, or scheduled re-checks). The recorded scenarios for the demo must
therefore include a re-observation of the old value after T0 if a `changed` verdict is to be demonstrated
honestly. This is a real consequence of the stricter rule, not a defect.

Architecture Part IV scenarios 2 and 3 and the `silent-change-no-date` fixture need their expected verdicts
re-derived under this rule when the architecture document is next updated (not done in M1).

### Missing `locale` dimension

`PriceBeliefKey` (contracts §2) has no locale. The same plan sold at different prices in different
regions, on the same domain, therefore maps to **one** key:

- two regional pages observed in one run read as a conflict (`contested`) or one silently shadows the
  other, depending on timing;
- the comparability condition "comparable locale" cannot be evaluated, because there is nothing to compare;
- limitation L-11 (regional prices) and open item U17 (crawler location) cannot be addressed in the model.

**Implications for M4** (not implemented; nothing in M1 depends on this):

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

Status: **open**. The change detector will not be written until this is reviewed.

---

## Q-002: demo isolation covers only some tables

**Documented gap.** `*_no_fixture_in_real` triggers exist for exactly three tables. Coverage today:

| Table | Has `origin` / `kind` | Rejected in a `real` database? |
|---|---|---|
| `users` | `kind` | **yes** (`fixture`) |
| `conversations` | `origin` | **yes** (`recorded`, `synthetic`) |
| `source_snapshots` | `origin` | **yes** |
| `messages` | `origin` | **no** |
| `entities` | `origin` | **no** |
| `decisions` | `origin` | **no** |
| every other table | none | not applicable; reachable only through the tables above, with the exceptions listed in the proposal |

So a `recorded` message inside a `live` conversation, or a `synthetic` entity or decision, is accepted by a
real database today. **The database does not guarantee isolation of demo data.** The tests
`KNOWN GAP Q-002` in `tests/integration/db/demo-isolation-gap.test.ts` assert this behaviour so the gap is
visible and verifiable; they are expected to fail, and be replaced, when the remediation lands.

**Remediation proposed** (not applied; no schema change was made):
[proposals/q-002-demo-isolation.md](proposals/q-002-demo-isolation.md), with the SQL
(`proposals/q-002-demo-isolation.sql`) and regression tests
(`tests/integration/db/demo-isolation-proposal.test.ts`, skipped unless `RUN_PROPOSALS=1`).

Status: **open**; needs a decision to ship it as migration `002`.

---

## Q-003: PRAGMAs outside migrations — applied, approved

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

The documents name T-DB-02, 04, 08 and 09 and describe the rest without numbers. The enumeration used,
with the invariant, test file and test case for each, is in [testing.md](testing.md). It also records
what each test does **not** prove.

---

## Q-005: privacy deletion and the belief rebuilder — applied; rebuild correctness untested

- Deletion takes an **injected** `BeliefRebuilder`. There is no default implementation, so derived
  state cannot silently go stale.
- **What is tested (database mechanics):** the conversation and what hangs off it are removed; evidence an
  assertion elsewhere still cites survives; unreferenced snapshots and entities are removed, scoped to the
  user; the full-text index is cleaned; the rebuilder is called once, with the affected keys, inside the
  transaction; a throwing rebuilder rolls the whole deletion back. The rebuilder used in these tests is a
  **recording fake**.
- **What is not tested:** that rebuilding produces correct beliefs and history after a deletion. That needs
  the belief resolver (Milestone 4). **T-DB-09 stays `todo`**, as does the recall half of T-MEM-08. Until
  then deletion is not fully tested and must not be described as such.
- Step 6 ("no remaining tag mention") is implemented as: the entity's normalised name appears as a whole
  space-delimited run in some message's `tags`. The contract does not define the match.
- All deletion statements also filter on `user_id`; a test fails if the cleanup steps lose that scoping.

---

## Q-006: `TurnRepository.begin` when a different key hits a running turn — open

The contract's return type covers "same idempotency key" (`{ existing, status }`) but not "different key while a
turn is running", which `turns_one_running` rejects. Proposed: throw a typed `TurnInProgressError(existingTurnId)`
that the API maps to 409. Conversation-lifecycle milestone.

## Q-007: `user_id` consistency is enforced only for messages and turns — open

Only `messages` and `turns` have owner triggers. `evidence_statements`, `findings`, `assertions`,
`search_requests`, `decisions` and `source_snapshots` carry a `user_id` that nothing in the database compares with
the owning turn or conversation; the 3.1 review says repositories derive it. Those repositories do not exist yet.
Smallest correction if wanted: owner triggers on the same pattern. Decide before the evidence-pipeline milestone.

## Q-008: contract functions with no implementation yet — applied

`encodePriceKey`, `decodePriceKey`, `keyForEvidence`, `comparableKeys` and `deliveryState` are declared
(`export declare function`) in the contracts. A declaration with no implementation type-checks but fails at
runtime on import, so they are left out of `src/shared` with a comment naming where they will live.

## Q-009: lint-driven, type-identical edits to the contract types — applied

`CurrencyCode | 'unknown'` and ``CurrencyCode | `unknown@${string}` `` are the same type as `string`, and the
`no-redundant-type-constituents` lint rule rejects them. They are written as `string` with the meaning in a
comment. No lint rule is disabled anywhere.

## Q-010: smaller implementation choices, for the record — applied

- `MessageRepository.insert` also sets `conversations.updated_at`, so conversation lists sort by activity.
- IDs read from storage are checked for their prefix (`parseId`) instead of cast.
- `zod` appears in `src/shared/llm.ts` (`StructuredRequest.schema`), exactly as the contract has it.
- Development tooling beyond the brief's list: `eslint`, `typescript-eslint`, `@eslint/js` and `prettier`, because
  linting and formatting were requested. TypeScript is `~6.0.3` because `typescript-eslint` 8 does not support 7.x yet.
