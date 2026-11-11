# ADR-39: Failure transitions from intermediate states

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner decision, 2026-11-12: replay misses and unexpected failures must move the turn to an appropriate terminal state
- **Recorded:** 2026-11-11, accepted 2026-11-12
- **Related:** [ADR-29](ADR-29.md), [ADR-33](ADR-33.md), [ADR-17](ADR-17.md)

## Context

The architecture's state machine had failure edges only from ANALYZING and SYNTHESIZING (to PERSISTING) and from PERSISTING (to FAILED). An unexpected error while the turn was in RECEIVED, RESOLVING_CONTEXT, PLANNING, SEARCHING, EXTRACTING, VERIFYING or RESOLVING_BELIEFS (a replay fixture miss, a programmer error, a persistence failure outside the final write) had no legal path to a final state. The turn stayed `running` until the next restart marked it interrupted, and the conversation refused a new turn in the meantime.

## Options considered

- Allow every non-final state to go to PERSISTING (a change to architecture section 4 and a new migration).
- Classify failures: recoverable ones degrade inside the state; terminal ones go to PERSISTING with a failed or partial status that preserves what was already stored.
- Leave it to recovery at restart.

## Decision

The first two together, and no edges beyond them.

**Edges.** Every non-final state that lacked one gets an edge to PERSISTING: RECEIVED, RESOLVING_CONTEXT, PLANNING, SEARCHING, EXTRACTING, VERIFYING and RESOLVING_BELIEFS (7 new edges, 26 in total). ANALYZING, CLARIFYING, SYNTHESIZING and POST_VERIFYING already had one. COMPLETED and FAILED stay reachable only from PERSISTING, and only through `complete()` and `fail()`. The table exists in `src/shared/turn-state-machine.ts` and, identically, in migration 010, which drops and recreates the transition trigger of migration 004 (migrations are additive; 004 is not edited).

**Which failures are terminal.**

- A typed, expected outcome is not a failure and is unchanged: a provider outage in the analyzer or the answer pipeline is a fixed reply with status `failed` and its existing code (`analysis_degraded`, `synthesis_*`); findings that could not be verified are `unable_to_verify` and the turn is `partial`; a deadline or shutdown during the answer is `interrupted`; a clarification is `clarify`.
- Anything else thrown before persistence is an unexpected error and is terminal: a replay fixture miss, a programmer error, a broken contract, a database failure outside the final write, an illegal transition, and a provider error that surfaced from a lane instead of becoming a finding. The coordinator moves the turn to PERSISTING and calls `complete()` with status `failed`, an error code naming the class, and no assistant message.

**Error codes.** `replay_miss` (search or model fixture miss), `internal_error` (programmer error), `contract_violation` (a component broke its contract), `persistence:<sqlite code or error name>` (our own database failed outside the final write), `external_error` (a provider error that reached the coordinator), `deadline` and `cancelled` (an abort that surfaced as an error). The client sees an SSE `error` event with a code of `replay_miss`, `deadline`, `cancelled` or `internal_error`; database detail is never sent to the client.

**How partial work is preserved.** Work stored incrementally during the turn is already in the database and is not rolled back: search results, evidence statements and snapshots written by their own modules stay. The failed completion writes no assistant message, no assertions, no findings and no enrichment, so nothing from the failed turn can later be treated as something the user was told. The turn row keeps the analysis when one was produced, the events sent so far plus the error event, and metrics with the states visited. A client that already received streamed text (for example a clarification written before the final write failed) keeps seeing it, but it is not stored and the error event follows.

**If the finalising write fails.** The original error is still reported and rethrown. The coordinator calls `fail()` (PERSISTING to FAILED) when the turn reached PERSISTING, with a code derived from the write error. If the turn could not be moved to PERSISTING, or `fail()` is refused too, the turn stays `running` and the next restart marks it interrupted (ADR-33), exactly as before. The lane code and the research service still propagate database failures untouched; the coordinator is the single place that finalises the turn.

**What is NOT done.**

- No error is turned into an answer or into status `complete`. No answer text is invented for an unexpected failure.
- The failed turn is not resumed or retried automatically; the client retries with `retryOfTurnId`.
- Findings gathered before the error are not persisted by the failure path. A finding set that the research service returned but the coordinator could not use is dropped; only what the modules wrote themselves remains.
- Search and evidence rows are not cleaned up after a failure.
- Database failures that make even the finalising write impossible are not handled beyond `fail()` and restart recovery.
- The single-instance assumption of recovery is unchanged (ADR-34).

## Consequences and trade-offs

- A turn that cannot continue always reaches a final state when the database can still be written, so the conversation accepts its next turn at once.
- Status `failed` now covers two things: an expected provider outage with a fixed reply, and an unexpected error with no reply. They are told apart by the error code and by the absence of an assistant message.
- The failure edges are reachable from every state, so the table no longer documents the normal path by itself; the normal paths are listed in the turn lifecycle document.
- A replay fixture miss in the offline demo now leaves a failed, finished turn instead of one that is interrupted only after the next restart.

## Evidence and implementation references

- Table: [src/shared/turn-state-machine.ts](../../src/shared/turn-state-machine.ts); trigger: [src/db/migrations/010_turn_failure_edges.sql](../../src/db/migrations/010_turn_failure_edges.sql); policy: `abandon` in [src/orchestration/orchestrator.ts](../../src/orchestration/orchestrator.ts) and `failureCodeFor` in [src/orchestration/errors.ts](../../src/orchestration/errors.ts).
- Every state reaches a terminal failed turn on an injected error, error codes, finalising failures, unchanged typed outcomes: [tests/integration/orchestration/failure-edges.test.ts](../../tests/integration/orchestration/failure-edges.test.ts); the same through the HTTP server for fixture misses and a database failure: [tests/integration/e2e/replay-misses.test.ts](../../tests/integration/e2e/replay-misses.test.ts), [tests/integration/e2e/failures.test.ts](../../tests/integration/e2e/failures.test.ts).
- Database and TypeScript tables agree on all ordered pairs, and a populated version-8 database upgrades: [tests/integration/db/turn-lifecycle.test.ts](../../tests/integration/db/turn-lifecycle.test.ts), [tests/integration/db/migrations.test.ts](../../tests/integration/db/migrations.test.ts), [tests/unit/turn-state-machine.test.ts](../../tests/unit/turn-state-machine.test.ts).

## Revisit when

- Findings or evidence gathered before a failure should be kept on the failed turn for diagnosis.
- A recoverable class of failure (for example a transient database lock beyond the one retry) should degrade in place instead of failing the turn.
