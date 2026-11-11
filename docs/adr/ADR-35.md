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

- [src/db/privacy-deletion.ts](../../src/db/privacy-deletion.ts); tests in [tests/integration/db/privacy-deletion.test.ts](../../tests/integration/db/privacy-deletion.test.ts) use a recording fake rebuilder.
- **T-DB-09 (rebuild after deletion equals a fresh rebuild) is `todo`**, as is the recall half of T-MEM-08. Deletion plus rebuilding is not fully tested and must not be described as such before milestone 4.

## Revisit when

- The belief resolver exists (milestone 4): implement T-DB-09.
