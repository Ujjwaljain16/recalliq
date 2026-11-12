# ADR-20: Identity: signed anonymous cookie

- **Status:** Accepted
- **Implementation:** implemented
- **Decided:** Owner approval, 2026-11-11 (design review)
- **Recorded:** 2026-11-11
- **Provenance:** Reconstructed on 2026-11-11 from the architecture register (§20) and the design documents. This is **not** recovered original ADR text: no earlier ADR pages existed. **Status** (the decision) and **Implementation** (the code) are recorded separately and audited separately.
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

- Signing, verification and the cookie header: [src/server/cookie.ts](../../src/server/cookie.ts) (HMAC-signed value, `HttpOnly`, `SameSite=Lax`), applied by the server in [src/server/app.ts](../../src/server/app.ts); `SESSION_SECRET` (at least 32 characters; a random one is used for the process when unset) is read in [src/config/env.ts](../../src/config/env.ts) and [src/app/env.ts](../../src/app/env.ts). Per-user scoping at the repository and database level: [tests/integration/db/repositories.test.ts](../../tests/integration/db/repositories.test.ts).
- Tested by [tests/unit/server/cookie.test.ts](../../tests/unit/server/cookie.test.ts) and [tests/integration/server/security.test.ts](../../tests/integration/server/security.test.ts).

## Revisit when

- A real multi-user product.
