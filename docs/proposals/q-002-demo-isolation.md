# Q-002: database-level demo isolation

**Status: applied as `src/db/migrations/002_demo_isolation.sql` (Milestone 2).** This page is kept as the rationale. The
original proposal's SQL file and gated proposal tests were retired when the migration shipped; the migration is the SQL,
and the tests live in the `T-DB-07` group of `tests/integration/db/invariants.test.ts`.

Isolation is still **not complete**; see "What is still not covered".

## The problem

`db_mode` (`real` | `demo`) is stamped when a database is created and checked at startup. In migration 001, three `BEFORE INSERT`
triggers reject non-live data when `db_mode = 'real'`: `users`, `conversations` and `source_snapshots`.

## Gaps that were found (all now closed by migration 002)

| # | Gap |
|---|---|
| 1 | `messages` with `origin <> 'live'` were accepted |
| 2 | `entities` with `origin <> 'live'` were accepted |
| 3 | `decisions` with `origin <> 'live'` were accepted |
| 4 | The 001 triggers fire on INSERT only: a real user could be relabelled `fixture` |
| 5 | Likewise a conversation could be relabelled `recorded` |
| 6 | `meta.db_mode` could be updated to `demo` or deleted, which switches every isolation trigger off. With the row gone, the triggers' `= 'real'` comparison is NULL and they pass everything |

Gaps 1 to 3 are the tables the request named. 4 to 6 came from reviewing the existing triggers: without them, closing 1 to 3 would still
have left a way round. Each was demonstrated by a passing test against the migration-001 schema before the migration was written, and each
of those tests failed once the proposal SQL was applied.

## What migration 002 adds (nine triggers, no table or column changes)

| Trigger(s) | Closes |
|---|---|
| `messages_no_fixture_in_real`, `entities_no_fixture_in_real`, `decisions_no_fixture_in_real` | 1, 2, 3 |
| `users_no_fixture_in_real_upd`, `conversations_no_fixture_in_real_upd`, `entities_no_fixture_in_real_upd`, `decisions_no_fixture_in_real_upd` | 4, 5, and relabelling for 2 and 3 |
| `meta_db_mode_immutable`, `meta_db_mode_undeletable` | 6 |

`schema_version` and `created_at` stay updatable; only the `db_mode` row is protected.

## What is still not covered

These have no `origin` column and no foreign key to a guarded parent:

- `belief_history` (plain `user_id` and `belief_key` text);
- `search_cache` (no user, no origin);
- `evidence_statements.user_id`, `beliefs.user_id`, `search_requests.entity_id` (plain columns).

Every other table is reachable only through a guarded parent (conversation, snapshot, entity or turn). Raw SQL by a privileged caller can
still do anything; the triggers protect the application's own write paths and the startup check. Do not describe the result as "complete
isolation".

## Not adopted

An optional trigger requiring `messages.origin = conversations.origin` (which would also stop a synthetic message in a live conversation
inside a demo database). It was not requested, so it was not added.
