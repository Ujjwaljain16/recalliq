# ADR-27: Ownership consistency enforced by database triggers (partial)

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11; coverage still open (Q-007)
- **Recorded:** 2026-11-11
- **Related:** [ADR-20](ADR-20.md), [ADR-26](ADR-26.md), [ADR-28](ADR-28.md), [Q-007](../questions.md)

## Context

Every user-owned row carries `user_id`, but nothing in the schema stops a row from pointing at another user's data.

## Options considered

- Repositories derive `user_id` and are trusted.
- Triggers that compare owners at insert time.

## Decision

Triggers, applied incrementally. Migration 001 covers messages and turns; migration 003 adds evidence (turn, snapshot, entity), findings (entity), assertions (turn, message, finding-to-turn) and the assertion-evidence link; migration 006 adds `decisions` and `decision_entities`; migration 007 adds `search_requests` and `search_results` (snapshots have no turn, so they are protected at their links).

## Consequences and trade-offs

- A finding's `entity_id` (a plain column) must now name an existing entity of the turn's user, which is stricter than the contract.
- Evidence references its turn at insert time only, because the contract deliberately has no foreign key there.

## Evidence and implementation references

- [src/db/migrations/003_ownership_consistency.sql](../../src/db/migrations/003_ownership_consistency.sql); [tests/integration/db/ownership.test.ts](../../tests/integration/db/ownership.test.ts) (16 tests on a database stopped at migration 3) and T-ASR-04 in [tests/integration/db/turn-completion.test.ts](../../tests/integration/db/turn-completion.test.ts).
- Migration 007: [src/db/migrations/007_search_ownership.sql](../../src/db/migrations/007_search_ownership.sql), 5 triggers, tested by [tests/integration/search/ownership-007.test.ts](../../tests/integration/search/ownership-007.test.ts).
- Migration 006: [src/db/migrations/006_decision_ownership.sql](../../src/db/migrations/006_decision_ownership.sql), 8 triggers, tested by [tests/integration/db/decision-ownership.test.ts](../../tests/integration/db/decision-ownership.test.ts).
- **Not covered, so ownership integrity must not be described as fully enforced:** source snapshots by turn (they have none), `beliefs` and `belief_history`.

## Revisit when

- Before those tables are used heavily: add the constraints and cross-user regression tests (owner requirement, 2026-11-11).
