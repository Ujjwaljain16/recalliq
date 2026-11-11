# Proposal Q-002: complete database-level demo isolation

**Status: proposal for review. Nothing here is applied.** The shipped schema (migration 001) is unchanged, and the
claim "a real database refuses demo data" is **not** currently true. See [questions.md](../questions.md#q-002-demo-isolation-covers-only-some-tables).

## What the schema guarantees today

`db_mode` (`real` | `demo`) is stamped when the database is created and checked at startup. Three
`BEFORE INSERT` triggers reject non-live data when `db_mode = 'real'`: `users` (`kind <> 'real'`),
`conversations` (`origin <> 'live'`) and `source_snapshots` (`origin <> 'live'`).

## Gaps

| # | Gap | Evidence (a test that passes today) |
|---|---|---|
| 1 | `messages` with `origin <> 'live'` are accepted | `KNOWN GAP Q-002: a recorded message inside a live conversation` |
| 2 | `entities` with `origin <> 'live'` are accepted | `… a synthetic entity` |
| 3 | `decisions` with `origin <> 'live'` are accepted | `… a recorded decision` |
| 4 | The existing triggers fire on INSERT only: a real user can be relabelled `fixture` | `… relabelling an existing user as a fixture` |
| 5 | Likewise a conversation can be relabelled `recorded` | `… relabelling an existing conversation as recorded` |
| 6 | `meta.db_mode` can be updated to `demo` or deleted, which switches every trigger off. With the row gone the triggers' `= 'real'` comparison is NULL, so they pass everything | `… changing or deleting meta.db_mode` |

Gaps 1–3 are the three tables named in the request. Gaps 4–6 are additional findings from reviewing the
existing triggers: without them, fixing 1–3 would still leave a way round.

(`messages` and `source_snapshots` cannot be relabelled after insert: both already have immutability triggers.)

## Proposed migration `002`

[`q-002-demo-isolation.sql`](q-002-demo-isolation.sql): nine triggers, no table or column changes.

| Trigger(s) | Closes |
|---|---|
| `messages_no_fixture_in_real`, `entities_no_fixture_in_real`, `decisions_no_fixture_in_real` | 1, 2, 3 |
| `users_…_upd`, `conversations_…_upd`, `entities_…_upd`, `decisions_…_upd` (`BEFORE UPDATE OF kind/origin`) | 4, 5 and the relabel path for 2, 3 |
| `meta_db_mode_immutable`, `meta_db_mode_undeletable` | 6 |

`schema_version` and `created_at` stay updatable; only the `db_mode` row is protected.

## Regression tests

[`demo-isolation-proposal.test.ts`](../../tests/integration/db/demo-isolation-proposal.test.ts). It applies the proposal SQL on top of
migration 001 inside the test, and is **skipped** unless `RUN_PROPOSALS=1`, so the default suite never presents it as
coverage of the shipped schema.

| Test | Asserts |
|---|---|
| non-live message | rejected through `MessageRepository.insert` and through raw SQL; no row left behind |
| non-live entity | rejected on insert and on relabel |
| non-live decision | rejected on insert and on relabel |
| relabelling users and conversations | rejected |
| `db_mode` immutability | update and delete rejected; fixture users still rejected afterwards |
| live data and `schema_version` | still accepted |
| demo database | non-live messages, entities and decisions still accepted (the triggers are keyed on `db_mode`) |

When the migration is adopted: move these tests out of the proposal file into the main suite, add them to the
`T-DB-07` group in [testing.md](../testing.md), and replace the six `KNOWN GAP Q-002` tests (which will start
failing) with them.

## Validation actually performed (2026-11-11)

| Check | Result |
|---|---|
| Default run: gap tests | 6 passed (they document the current behaviour) |
| Default run: proposal tests | 7 skipped |
| `RUN_PROPOSALS=1`: proposal tests | 7 passed |
| The six gap tests re-run with the proposal SQL applied (throwaway copy, since deleted) | 6 failed, as intended |

This shows the proposal closes the six gaps in a scratch database. It does **not** show that the proposal is
complete; see the next section.

## What would still not be covered

Even with the proposal, these remain unguarded by the database, because they have no `origin` column and no foreign key to a guarded
parent:

- `belief_history` (plain `user_id` and `belief_key` text, no foreign keys);
- `search_cache` (no user, no origin);
- `evidence_statements.user_id`, `beliefs.user_id`, `findings.entity_id`, `search_requests.entity_id` (plain columns).

Every other table is reachable only through a guarded parent (conversation, snapshot, entity or turn). Raw SQL by a
privileged caller can still do anything; the triggers protect the application's own write paths and the startup
check. Do not describe the result as "complete isolation".

## Decision needed

1. Ship as migration `002` (and add the triggers to contracts §1)?
2. Optional, not included: a trigger requiring `messages.origin = conversations.origin`, which would also stop a
   synthetic message in a live conversation inside a demo database.
3. Whether the residual gaps above need closing now or are accepted.
