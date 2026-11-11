# Security

RecallIQ is a chat agent that one person runs on their own machine, with their own Gemini and Exa keys. This
page says what it protects, against whom, and what it does not.

## Threat model

**Assets.** The provider keys and the money they can spend; the user's conversations and remembered facts; the
integrity of the audit verdicts (an answer that says a price `changed` must be one the code proved).

**Adversaries.**

- **A web page the user visits** while the server runs. It can make the browser send requests to
  `localhost:3001` (CSRF), or point a name it controls at `127.0.0.1` (DNS rebinding) so that its scripts are
  same-origin with the server.
- **A page the agent reads.** Every search result is attacker-controllable text: it can carry instructions for the
  model (prompt injection) or a plausible but false price (baseline poisoning).
- **Another client of the same server** (another browser profile, or another machine if the owner exposes it):
  it must not read or change someone else's data, nor exhaust the keys.

**Out of scope.** Someone with access to the user's account or files (they can read `.env` and the database), a
compromised provider, and denial of service from the network when the server is exposed beyond loopback.

## What is protected, and how

| Concern | Control | Where |
|---|---|---|
| XSS | The client builds the page with `textContent` only, never HTML from data; a strict Content-Security-Policy (`default-src 'self'`, no inline script, `frame-ancestors 'none'`) and `X-Content-Type-Options: nosniff` on every response | `web/js`, `src/server/http.ts` |
| CSRF | State-changing requests carrying an `Origin` must come from the page's own origin or `ALLOWED_ORIGIN` (`403 forbidden_origin`); bodies must be `application/json`, which a plain form cannot send; the cookie is `SameSite=Lax` and `HttpOnly` | `src/server/app.ts`, `src/server/http.ts` |
| Cross-origin reads | No CORS headers unless `ALLOWED_ORIGIN` is set; then only that one origin, with credentials | `src/server/app.ts` |
| DNS rebinding | Every request, static files included, must name a known host: `localhost`, `127.0.0.1`, `[::1]`, the configured `HOST`, or the host of `ALLOWED_ORIGIN`. Anything else is `421 misdirected_request`, before routing | `src/server/app.ts` |
| Ownership | The signed session cookie names one user row; every query is scoped by user, and database triggers reject rows that cross users. Another user's conversation or turn is a `404`, the same as one that does not exist | `src/server/cookie.ts`, `src/db` |
| SQL injection | Every statement is prepared with bound parameters; the few dynamic parts (`IN (?, ?)` lists) are built from placeholders only | `src/db` |
| Secrets | Keys are read from the environment, used only server-side, and never sent to the browser; configuration errors name variables, never values; the logger is never passed request bodies, message text or keys | `src/config/env.ts`, `src/app/env.ts`, `src/app/logger.ts` |
| Network exposure | `HOST` defaults to `127.0.0.1`. A non-loopback `HOST` is refused unless `NODE_ENV=production` and `SESSION_SECRET` are set, and then a warning is logged | `src/app/env.ts` |
| Cookie transport | `Secure` when `NODE_ENV=production` or `ALLOWED_ORIGIN` is https. `Max-Age` is one year: the anonymous session is the only key to the user's history, and it grants nothing beyond that user's own data | `src/server/cookie.ts` |
| Quotas (cost and DoS) | Per user: at most `MAX_RUNNING_TURNS_PER_USER` running turns across all conversations (default 2, `429 too_many_turns`), and a token bucket of `TURN_RATE_BURST` turns refilled at `TURN_RATE_PER_MINUTE` (default 5 and 10, `429 turn_rate_limited`). Per client address: `NEW_SESSIONS_PER_HOUR` new anonymous users (default 20, `429 too_many_sessions`). Every 429 has `Retry-After`. Process-wide: at most `EXA_MAX_CONCURRENT` searches in flight (default 4) and the Gemini limiter; per-turn budgets and deadlines; `SERVER_MAX_CONNECTIONS`, `SERVER_HEADERS_TIMEOUT_MS`, `SERVER_REQUEST_TIMEOUT_MS`; request bodies at most 32 KiB | `src/server/limits.ts`, `src/search/limited.ts`, `src/llm/limiter.ts` |
| Data at rest | `PRAGMA secure_delete = ON`, so privacy deletion overwrites rows; on POSIX the database file is `0600` and a new data directory `0700` | `src/db/connection.ts` |
| Baseline poisoning | See below | `src/belief/detector.ts` |
| Prompt injection | See below | `src/llm/prompts`, `src/evidence`, `src/answer` |

### Baseline poisoning

Without an owner registry of official domains (`OFFICIAL_DOMAINS_FILE`), no site is official: a source is tier B
when it is on the short curated list of reputable secondary sources in `src/evidence/authority.ts` (review and
news sites such as g2.com or reuters.com), and tier C otherwise. Anyone can publish a tier C page that names the
entity and states a price verbatim. Such a page could become a presented, verified answer and so a baseline, and a
later honest value would then look like a code-computed `changed`.

The change detector therefore applies a **low-authority gate** (architecture section 8): `changed`,
`unchanged_confirmed` and `baseline_incorrect` (`other_value_in_effect_at_T0`) need the baseline's evidence and
the current value's evidence to be tier A1, A2 or B, and the proofs read only A1, A2 and B statements. Otherwise
the verdict is `differs_timing_unknown` or `no_evidence_of_change` with reason `low_authority_source`. The cost is
deliberate: without a registry, re-observation on ordinary vendor pages no longer proves a change.

### Prompt injection

Page text and user text are data, never instructions, and the model never decides what is true:

- **Fenced untrusted text.** Page text reaches the extractor only inside `<source>` blocks, which the prompt
  declares untrusted; delimiter look-alikes inside user and page text are neutralised before they are wrapped.
  The extractor has no tools, and synthesis never sees raw pages.
- **Placeholders.** The answer model writes `[[F1]]`-style placeholders, not values; the server substitutes the
  stored values. Placeholder look-alikes in untrusted text are defused, so a page cannot inject a claim.
- **Server-minted ids.** Every id (finding, evidence, source, turn) is created by the server. The model sees only
  short references (`S1`, `E1`, `F1`); the server maps them back, and a statement naming a reference it did not
  issue is dropped.
- **Verified against sourced statements.** A statement counts only if the quote is found verbatim in the stored
  page and binds to the entity by the verifier's rules; each sentence carries a status (`verified`, `unverified`,
  ...), and only verified, acknowledged claims become baselines (ADR-38). Verdicts are computed by code from those
  statements, not by the model.

## Known limits

- Quotas are in memory and per process: a restart resets them, and several processes do not share them.
- The session quota is keyed by the socket address. Behind a reverse proxy every client shares one address;
  `X-Forwarded-For` is deliberately not trusted.
- A running turn that waits for a slot still counts against the user's running-turn cap; the `Retry-After` of
  `too_many_turns` is a hint (5 seconds), not a promise.
- With `HOST=0.0.0.0` only the loopback names and the `ALLOWED_ORIGIN` host are answered; reach the server through
  that origin.
- Prompt injection is mitigated, not eliminated: a page can still mislead the extractor about its own content; the
  verifier and the authority tiers limit what that can change.
- The session cookie is a bearer token with a one-year lifetime; anyone who copies it is that user.
- On Windows the database file keeps the ACLs of the user profile; no mode is set.
