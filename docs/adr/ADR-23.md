# ADR-23: Sentence-level delivery acknowledgement

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
- **Related:** [ADR-31](ADR-31.md), [ADR-32](ADR-32.md), [ADR-17](ADR-17.md), [ADR-38](ADR-38.md)

## Context

A server that finished generating is not a user who read the answer. A message-level flag cannot say a partly displayed answer was partly seen.

## Options considered

- Per message.
- Per assertion.
- Per sentence.

## Decision

Per sentence: the smallest unit the client can render atomically, and the unit that already carries the assertions. Acknowledgements are monotonic and idempotent.

## Consequences and trade-offs

- Client complexity.
- An acknowledgement proves rendering, not reading.
- An acknowledgement that arrives before the answer is stored is rejected (Q-012).

## Evidence and implementation references

- [src/db/repositories/turns.ts](../../src/db/repositories/turns.ts) (`ack`), [src/shared/delivery.ts](../../src/shared/delivery.ts), [src/db/migrations/005_delivery_acknowledgement.sql](../../src/db/migrations/005_delivery_acknowledgement.sql).
- Tests T-DLV-01 to 08 in [tests/integration/db/delivery.test.ts](../../tests/integration/db/delivery.test.ts) and eight racing-acknowledgement cases in [tests/integration/db/concurrency.test.ts](../../tests/integration/db/concurrency.test.ts); mutation spot checks are described in [docs/testing.md](../testing.md).

## Revisit when

- The beacon on page close proves unreliable across browsers (open item U18).
