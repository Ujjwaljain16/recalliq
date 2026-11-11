# ADR-20: Identity: signed anonymous cookie

- **Status:** Accepted
- **Implementation:** not implemented
- **Decided:** Owner approval, 2026-11-11 (Stage 3)
- **Recorded:** 2026-11-11
- **Related:** [ADR-27](ADR-27.md)

## Context

"What did I ask you" needs a stable per-user scope without authentication.

## Options considered

- Full authentication.
- A signed anonymous cookie.

## Decision

The cookie. Every repository method already takes a user id.

## Consequences and trade-offs

- Clearing cookies loses history.

## Evidence and implementation references

- Per-user scoping is implemented at the repository and database level ([tests/integration/db/repositories.test.ts](../../tests/integration/db/repositories.test.ts)); the cookie and `SESSION_SECRET` handling ([src/config/env.ts](../../src/config/env.ts)) are configuration only.

## Revisit when

- A real multi-user product.
