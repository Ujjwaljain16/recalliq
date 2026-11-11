# Open questions and deviations

Raised during implementation. An entry here means the specification was silent, contradictory, or
narrower than what the code needed. Nothing here was resolved by silently inventing a design: each
entry says what the code does meanwhile.

Status values: **open** (needs a decision), **applied** (implemented as described, awaiting
confirmation that the specification should be updated to match).

## Q-001: the 48 h bracketing window, and "comparable" same-site context — open

**Conflict.** The Milestone 1 kickoff says:

- a 48-hour pairing window must never *independently* establish that a price changed;
- same-site comparisons must also establish comparable locale, plan, billing arrangement and
  pricing context.

Architecture §8 (post-baseline proof) treats same-source bracketing — a `vB` observation within
48 h of T0 followed by a later different observation — as sufficient for `changed`. The contracts have no
`locale` field in `PriceBeliefKey` or `NormalizedValue`, so "comparable locale" cannot be expressed today.

**Why it matters.** `ChangeDetector` (evidence/belief milestone).

**Code meanwhile.** Not implemented yet. The stricter kickoff reading will be followed.

**Decision needed.**

1. Does bracketing still count as a proof of `changed` when the plan, billing, unit, currency and
   value kind of the two observations are identical (already guaranteed by an identical belief key),
   and what extra condition replaces "48 h alone"?
2. Is locale a new field on the belief key (a contract change), or recorded only as evidence
   provenance?

## Q-002: demo isolation does not cover every table — open

The `*_no_fixture_in_real` triggers cover `users`, `conversations` and `source_snapshots`. A row with
`origin <> 'live'` can still be inserted into `messages`, `entities` and `decisions` of a real
database (a `recorded` message inside a `live` conversation). `evidence_statements` has no origin
column at all.

**Smallest correction.** The same trigger pattern on `messages`, `entities` and `decisions`. This is a
contract change, so it is not applied. A `it.todo` in `tests/integration/db/invariants.test.ts` marks it.

## Q-003: PRAGMAs moved out of `001_init.sql` — applied

`PRAGMA journal_mode = WAL` cannot run inside the transaction each migration uses, and
`foreign_keys` is a per-connection setting. Both are applied in `openDatabase()`. This is the only
difference between `001_init.sql` and the contract's SQL; `contract-parity.test.ts` proves it by
comparing the two after removing comments, whitespace and the PRAGMA lines.

**Action.** Update contracts §1 to say the PRAGMAs are connection settings.

## Q-004: test IDs T-DB-01..10 are not enumerated anywhere — applied

The documents name T-DB-02, 04, 08 and 09 explicitly, and list the remaining intent without numbers. The
mapping used in the tests:

| ID | Covers |
|---|---|
| T-DB-01 | idempotency key unique per user |
| T-DB-02 | owner mismatch on messages and turns |
| T-DB-03 | UPDATE rejected on L1, L2, assertion events, belief history |
| T-DB-04 | message content immutable; no update/delete surface on the repository |
| T-DB-05 | `presented_at` settable once; other assertion columns immutable |
| T-DB-06 | `rendered_through` never decreases |
| T-DB-07 | fixture data rejected in a real database |
| T-DB-08 | evidence cited elsewhere survives deletion |
| T-DB-09 | rebuild after deletion equals fresh rebuild (`todo`, needs the resolver) |
| T-DB-10 | startup refuses an `APP_MODE` / `db_mode` mismatch |

Tests without an ID (one running turn per conversation, FTS5 sync, snapshot observations) are named
descriptively. T-MEM-08 is a `todo`: its database half is covered by T-DB-08, its recall half needs the
memory milestone.

## Q-005: privacy deletion, two interpretations — applied

- **Step 6 ("no remaining `message_search` tag mention").** The contract does not define a match.
  Implemented: the entity's normalised name appears as a whole space-delimited run in some
  message's `tags`. Conservative, and tested.
- **Step 7 (rebuild beliefs).** It needs the belief resolver, which does not exist yet. The
  procedure therefore takes a `BeliefRebuilder` dependency and calls it inside the deletion
  transaction; there is no default implementation, so derived state can never be silently left
  stale. A rebuilder that throws rolls back the whole deletion (tested).
- All statements additionally filter on `user_id`; the contract's SQL is a subset of that. A test
  fails if the cleanup steps lose that scoping.

## Q-006: `TurnRepository.begin` when a different key hits a running turn — open (conversation-lifecycle milestone)

The contract's return type covers "same idempotency key" (`{ existing, status }`) but not "different
key while a turn is running", which `turns_one_running` rejects. Proposed: throw a typed
`TurnInProgressError(existingTurnId)` that the API maps to 409.

## Q-007: user_id consistency is enforced only for messages and turns — open

Only `messages` and `turns` have owner triggers. `evidence_statements`, `findings`, `assertions`,
`search_requests`, `decisions` and `source_snapshots` carry a `user_id` that nothing in the database
compares with the owning turn or conversation; the 3.1 review says repositories derive it
("covered by T-DB-02"). Those repositories do not exist yet, so nothing can be tested.

**Smallest correction if wanted.** Owner triggers on the same pattern, or repositories that take the
user id from the turn and a test per repository. To decide before the evidence-pipeline milestone.

## Q-008: contract functions with no implementation yet — applied

`encodePriceKey`, `decodePriceKey`, `keyForEvidence`, `comparableKeys` and `deliveryState` are declared
(`export declare function`) in the contracts. A declaration with no implementation type-checks but fails at
runtime on import, so they are left out of `src/shared` with a comment naming where they will live
(`src/belief/belief-key.ts`, and the acknowledgement handler).

## Q-009: lint-driven, type-identical edits to the contract types — applied

`CurrencyCode | 'unknown'` and `CurrencyCode | \`unknown@${string}\`` are the same type as `string`, and the
`no-redundant-type-constituents` lint rule rejects them. They are written as `string` with the meaning in
a comment. No lint rule is disabled anywhere.

## Q-010: smaller implementation choices, for the record — applied

- `MessageRepository.insert` also sets `conversations.updated_at`, so conversation lists sort by activity.
- IDs read from storage are checked for their prefix (`parseId`) instead of cast.
- `zod` appears in `src/shared/llm.ts` (`StructuredRequest.schema`), exactly as the contract has it.
- Development tooling beyond the brief's list: `eslint`, `typescript-eslint`, `@eslint/js` and `prettier`,
  because linting and formatting were requested. TypeScript is `~6.0.3` because `typescript-eslint` 8 does not
  support 7.x yet.
