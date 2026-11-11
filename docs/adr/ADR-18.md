# ADR-18: Test strategy: ports, recorded replay, fixed clock, offline by default

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture §20 register and the Stage 3 / 3.1 design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- Implemented: `FixedClock` ([src/temporal/clock.ts](../../src/temporal/clock.ts)); every test is offline, in-memory or temporary-file, deterministic; worker-thread concurrency tests ([tests/integration/db/concurrency.test.ts](../../tests/integration/db/concurrency.test.ts)).
- Not implemented: replay and recording adapters, `ReplayMissError` handling. Test inventory: [docs/testing.md](../testing.md).

## Revisit when

- Fixture upkeep dominates the effort.
