# Test documentation

How the tests map to the invariants they protect. Statuses below come from an actual run of the suite on
2026-11-11 (`npx vitest run --reporter=json`); they are re-derived, not assumed. Re-run before relying on
them.

Run everything: `npm run check` (typecheck, lint, format check, tests). Tests only: `npm test`. All tests are
offline and deterministic (in-memory SQLite, a fixed clock, no network).

## T-DB-01 … T-DB-10

The documents name T-DB-02, 04, 08 and 09 and describe the rest without numbers; this enumeration is the one
the tests use (Q-004). Test files are under `tests/integration/db/`. The test case is the test's full name
with the group title first.

| ID | Invariant | Test file | Test cases | Status (last run) | Not proved by these tests |
|---|---|---|---|---|---|
| **T-DB-01** | An idempotency key is unique per user, not globally | `invariants.test.ts` | "the same key for two users is fine; the same key twice for one user is rejected" | passed | Behaviour of `TurnRepository.begin` on a duplicate (not implemented yet) |
| **T-DB-02** | A message or turn cannot belong to a different user than its conversation | `invariants.test.ts` | "rejects a message whose user_id differs from its conversation owner"; "rejects a turn whose user_id differs from its conversation owner". Repository half: `repositories.test.ts` "refuses to write into a conversation the user does not own…" | passed | Ownership of evidence, findings, assertions, decisions: not enforced by the database (Q-007) |
| **T-DB-03** | L1 snapshots, L2 evidence, assertion events and belief history reject UPDATE; DELETE stays possible | `invariants.test.ts` | "source_snapshots (L1)", "evidence_statements (L2)", "assertion_events", "belief_history", "DELETE stays possible, because privacy deletion and rebuilds need it" | passed | That nothing deletes these rows outside the deletion procedure (no repository for them exists yet) |
| **T-DB-04** | Message content is immutable, and a message cannot be deleted and re-inserted through the repository | `invariants.test.ts` | "rejects UPDATE of every protected message column"; "cannot be re-parented to another user or conversation"; "the message repository exposes no way to update, delete or replace a message" | passed | Raw SQL `DELETE` + `INSERT` under the same id is possible for a caller with the connection |
| **T-DB-05** | An assertion's `presented_at` is set once and nothing else about it changes; at most one `presented` and one `not_presented` event | `invariants.test.ts` | "allows presented_at to be set from NULL"; "rejects changing presented_at a second time"; "rejects clearing presented_at"; "rejects editing any other column, even together with presented_at"; "records at most one presented and one not_presented event per assertion" | passed | The acknowledgement logic that sets it (conversation-lifecycle milestone) |
| **T-DB-06** | `rendered_through` never decreases | `invariants.test.ts` | "starts at -1 and can move forward or stay put"; "rejects a decrease"; "still allows last_ack_at to be written alongside an acknowledgement" | passed | Acknowledgement idempotency and delivery states (not implemented) |
| **T-DB-07** | A real database rejects fixture users, non-live conversations and non-live snapshots | `invariants.test.ts` | "rejects fixture users, non-live conversations and non-live snapshots in real mode"; "accepts the same data in a demo database" | passed (**partial**); plus 1 `todo` for the open part | **Messages, entities, decisions, UPDATE paths and `db_mode` itself are not guarded.** Documented by `demo-isolation-gap.test.ts` (below). Isolation is **not** complete (Q-002) |
| **T-DB-08** | Evidence an assertion in another conversation still cites survives conversation deletion | `privacy-deletion.test.ts` | "T-DB-08: keeps evidence an assertion in another conversation still cites, and what it needs" | passed | Belief rebuilding (see T-DB-09). The rebuilder in these tests is a recording fake |
| **T-DB-09** | After deletion, beliefs and belief history equal a fresh rebuild from the remaining evidence | `invariants.test.ts` | "beliefs and belief_history after deleteConversation equal a rebuild from the remaining evidence" | **todo: not implemented, not tested** | Everything. Blocked on the belief resolver (Milestone 4). Deletion and rebuilding are **not** fully tested |
| **T-DB-10** | The application refuses to open a database created in a different `APP_MODE` | `migrations.test.ts` | "T-DB-10: reopening a database in a different APP_MODE is refused" | passed | The same guard for the seed script (not written yet) |

### Other deletion tests (no contract ID)

`privacy-deletion.test.ts`: removes the conversation and what hangs off it; garbage-collects unreferenced snapshots and entities;
removes only the deleted conversation from the full-text index; hands the affected belief keys to the rebuilder once, inside the transaction;
does not touch another user's data (including unreferenced rows of theirs); refuses another user's conversation; is all-or-nothing when the
rebuilder throws; does not call the rebuilder when no keys were affected. All passed. These test deletion **mechanics** only.

**T-MEM-08** ("a deleted conversation cannot be recalled") is `todo`: its database half is covered above, its recall half needs
the memory milestone.

## Migrations and connection settings

| Test (`migrations.test.ts`) | Protects |
|---|---|
| creates the schema, stamps `db_mode`; installs every contract trigger; creates the FTS5 index; is idempotent | the fresh-database path |
| refuses a foreign non-empty database; refuses a newer schema; applies only pending migrations; rolls a failing migration back completely; rejects gaps and bad file names | the upgrade path |
| `Q-003: openDatabase configures the connection before any migration runs` | `foreign_keys`, `busy_timeout`, WAL are set on the connection |
| `Q-003: no shipped migration contains a PRAGMA statement` | PRAGMAs stay outside migration transactions |
| `Q-003: each migration runs in its own transaction, together with its version stamp` | migrations stay transactional |
| `contract-parity.test.ts` | `001_init.sql` equals contracts §1 apart from comments, whitespace and the PRAGMA lines |

## Known-gap and proposal tests (Q-002)

| File | Default run | Meaning |
|---|---|---|
| `demo-isolation-gap.test.ts` | 6 passed | **Characterisation of today's behaviour.** Each asserts that the real database *accepts* something it should not. They are not guarantees; they start failing when the remediation lands and are then replaced |
| `demo-isolation-proposal.test.ts` | 7 skipped | Validates the proposed remediation on a scratch database. Runs only with `RUN_PROPOSALS=1`. It does not test the shipped schema |

## Other suites

- `tests/unit/config.test.ts`: environment validation (defaults, modes, blank values, ranges, secrets not echoed).
- `tests/integration/db/repositories.test.ts`: user scoping, sequence numbers, sentence JSON validation, clock use.
- `tests/integration/db/invariants.test.ts` (no ID): one running turn per conversation; unique message order; every observation of a page is kept; FTS5 index follows insert, update and delete.

## Coverage the tests were checked against

The invariant, deletion and migration tests were also run against deliberately broken schema or code (mutation checks done by hand:
disabled triggers, global idempotency key, missing user scoping on cleanup, swallowed rebuilder error, a PRAGMA in a migration,
migrations run without a transaction). Each broken version made at least one test fail, and one initially missed mutation
(unscoped entity cleanup) led to a stronger test. This is a manual spot check, not an automated mutation-testing run.
