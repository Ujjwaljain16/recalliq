# ADR-35: Privacy deletion with an injected belief rebuilder

- **Status:** Accepted
- **Implementation:** partly implemented
- **Decided:** Owner approved (Q-005), 2026-11-11
- **Recorded:** 2026-11-11
- **Related:** [ADR-06](ADR-06.md), [ADR-13](ADR-13.md), [Q-005](../questions.md)

## Context

Evidence can outlive the conversation that produced it (another conversation's assertion may still cite it), while nothing derived from the user's own messages may survive.

## Options considered

- Rely on cascades.
- An explicit procedure with scoped cleanup and a required rebuilder.

## Decision

Explicit procedure (contracts §1.1), user-scoped throughout. The belief rebuilder is mandatory so derived state cannot silently go stale; a rebuilder that throws rolls the whole deletion back.

## Consequences and trade-offs

- Entity cleanup interprets "no remaining tag mention" as the normalised name appearing as a whole space-delimited run in message tags (the contract does not define it).

## Evidence and implementation references

- [src/db/privacy-deletion.ts](../../src/db/privacy-deletion.ts), reached through the turn repository and the server's delete route ([src/server/app.ts](../../src/server/app.ts)). The rebuilder is the real `BeliefRepository` ([src/belief/repository.ts](../../src/belief/repository.ts)); the deletion tests in [tests/integration/db/privacy-deletion.test.ts](../../tests/integration/db/privacy-deletion.test.ts) use a recording fake rebuilder.
- Rebuilding after a deletion is tested against the real repository ([tests/integration/belief/repository.test.ts](../../tests/integration/belief/repository.test.ts), T-DB-REBUILD-03 and 04), and T-MEM-08 (a deleted conversation cannot be recalled) runs on the real recall path ([tests/integration/db/memory-recall.test.ts](../../tests/integration/db/memory-recall.test.ts)).
- **T-DB-09 (beliefs after deletion equal a fresh rebuild) is still `todo`** in [tests/integration/db/invariants.test.ts](../../tests/integration/db/invariants.test.ts), so the full equivalence is not asserted and must not be described as tested.

## Revisit when

- T-DB-09 is written as an equality test between the beliefs left after deletion and a fresh rebuild.
