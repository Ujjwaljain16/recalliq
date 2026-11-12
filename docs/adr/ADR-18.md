# ADR-18: Test strategy: ports, recorded replay, fixed clock, offline by default

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-19](ADR-19.md)

## Context

Reviewers will check that the system is testable without live APIs.

## Options considered

- Live-only tests.
- Mocks.
- Recorded replay that fails loudly on a miss, plus fake and fixed-clock adapters.

## Decision

The third.

## Consequences and trade-offs

- Fixtures need maintenance.

## Evidence and implementation references

- `FixedClock` ([src/temporal/clock.ts](../../src/temporal/clock.ts)); scripted, recording and replay adapters for the model ([src/llm/fake.ts](../../src/llm/fake.ts), [src/llm/replay.ts](../../src/llm/replay.ts)) and for search ([src/search/recording.ts](../../src/search/recording.ts), [src/search/replay.ts](../../src/search/replay.ts)); fixture-backed providers for the replay component set with `ReplayMissError` handling ([src/app/live/replay-providers.ts](../../src/app/live/replay-providers.ts)). A miss ends the turn as failed with code `replay_miss` (ADR-39).
- Every default test is offline, in-memory or temporary-file, and deterministic; live smoke tests are skipped unless provider variables are set ([tests/integration/e2e/live-smoke.test.ts](../../tests/integration/e2e/live-smoke.test.ts)). Replay tests: [tests/unit/search/replay.test.ts](../../tests/unit/search/replay.test.ts), [tests/integration/e2e/replay-misses.test.ts](../../tests/integration/e2e/replay-misses.test.ts); worker-thread concurrency tests: [tests/integration/db/concurrency.test.ts](../../tests/integration/db/concurrency.test.ts). Test inventory: [docs/testing.md](../testing.md).

## Revisit when

- Fixture upkeep dominates the effort.
