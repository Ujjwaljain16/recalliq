# Running RecallIQ: scripted, replay and live

The component set is chosen once, by `APP_COMPONENTS`, and is fixed for the life of the process and of every
turn. There is no automatic switching and no fallback: a set that cannot start says why and exits. The active
set is reported by `GET /api/health` (`components`, `mode`, `banner`) and by the banner in the browser client.

| Set | Analyzer, research, answer | Search and model | Banner | Database mode |
|---|---|---|---|---|
| `scripted` | canned, no research | none | "Scripted demo responses, no real search or model" | `real` or `demo` |
| `replay` | the real ones | recorded fixtures (`REPLAY_FIXTURE`) | "Offline replay: recorded fixtures ..." | `demo` only |
| `live` | the real ones | Exa and Gemini | none | `real` only |

## scripted

```
APP_COMPONENTS=scripted npm run dev
```

Proves the application surface only: routing, streaming, acknowledgement, scoping, the browser client. Nothing it
says is research.

## replay

```
npm run dev:replay
```

or, equivalently, `APP_COMPONENTS=replay APP_MODE=demo REPLAY_FIXTURE=<file> npm run dev`. `npm run dev:replay`
uses `tests/fixtures/e2e/demo.json` and starts from an empty `data/replay-demo.db` each time, because the fixture's
recorded searches are consumed in order.

Replay runs the same application as live: the turn orchestrator, memory, the research service, evidence
verification, belief resolution, the answer pipeline with validate-before-release streaming, SSE delivery,
acknowledgement and persistence. Only the two provider adapters differ: the search port and the model port read
the fixture. Rows written from a fixture carry origin `synthetic` or `recorded`, which a real database rejects by
design, so replay refuses to start unless `APP_MODE=demo` (and `REPLAY_FIXTURE` is set). `npm run dev:replay` also sets `OFFICIAL_DOMAINS_FILE` to the synthetic example.

A request the fixture does not cover is a loud failure: the turn stops with an `internal_error` event and no
answer, nothing is stored as an answer, and no network request is made (the replay providers hold no `fetch`).

The demo fixture knows three questions: "What does Acme CRM cost?", "What does Beta Suite cost?" and "Is the Acme
CRM price you gave me still correct?". Acme's recorded searches return US$90 first and US$100 second; asked
again in the same process the third call has no recording and fails loudly, so restart to start over. The vendors
and prices are invented ([SYNTHETIC], `.example` domains).

Fixture format: `src/app/live/fixture.ts`. A search entry is a query and the answers to its successive calls
(hits, or a provider error code). Model entries match on the user's message: analysis replies, extraction
statements (matched by entity and by text in a source), and synthesis templates. A hash-keyed recording file
(`searchRecordings`) is also accepted.

## live

```
APP_COMPONENTS=live APP_MODE=real GEMINI_API_KEY=... EXA_API_KEY=... npm start
```

Needs both keys (GEMINI_MODEL is optional and defaults to gemini-3.5-flash-lite). A missing key stops the process before the database is opened, with a message naming
it. No other provider is used. The model calls go through a client-side limiter
(up to 3 requests in flight, at most 15 starts in any rolling minute: GEMINI_MAX_CONCURRENT,
GEMINI_MAX_PER_MINUTE) sized for a free tier, so one turn's calls start without waiting. If the main model is rate
limited or overloaded, the turn asks GEMINI_FALLBACK_MODEL once (logged as "model fallback").

## Official domains

A page counts as an official source (the top two authority tiers) only when its domain is explicitly known to
belong to the entity. Three sources, and no others (the third, exact-name domains, is described after the list):

1. **A registry file you supply**, named by the optional `OFFICIAL_DOMAINS_FILE`: a JSON object mapping a
   normalised entity name to the registrable domains it owns, for example
   `{ "acme crm": ["acme.example"] }`. It is validated at startup (an unreadable or malformed file stops the
   process with a message naming the variable). **None ships with the project and none is downloaded**; without
   the variable only the exact-name domains below are official. The replay demo uses
   a synthetic example, `tests/fixtures/e2e/official-domains.example.json` (`.example` domains only).
2. **A domain the entity's own stored row already carries** from an explicit earlier source. Nothing in the
   application writes one today.

A domain that is exactly the company's one-word name on a common ending (supabase.com for Supabase, and its
subdomains) is official when the registry has no entry for that name ([ADR-44](adr/ADR-44.md)); a registry entry
replaces that guess. The model's guess never counts: the analysis's `officialDomainGuess` only steers a search query. A domain not listed is not official even when it looks
right (a look-alike such as the same name on another top-level domain). All domains listed for a name are
official; a domain listed for two entities is official for neither.

Consequence for audits: a same-value verdict of "unchanged" needs an official page, and the effective-date route
to "changed" needs an official source, so both need a registry entry. The re-observation route to "changed"
does not depend on the tier. Without a registry, audits still report `differs_timing_unknown` and, with the
re-observation proof, `changed`, and otherwise the weaker "no sign of a change".

## What each one does and does not prove

- **Scripted:** the surface works. Not research.
- **Replay (offline):** with the recorded provider answers, the real pipeline produces cited findings, per-entity
  statuses, strict audit verdicts, validated streaming, acknowledgement-gated baselines, restart persistence,
  isolation and privacy deletion. It does **not** show that Gemini returns output the schemas accept, that Exa
  returns pages the extractor can read, how either behaves under rate limits or latency, or that prompts produce
  good answers. The fixtures are hand-written; a model that behaves differently from the fixture is not tested.
- **Live:** not verified by the automated tests. The gated smoke tests in `tests/integration/e2e/live-smoke.test.ts`
  run only when the provider variables are in the process environment (no `.env` file is read) and make at most two
  calls each.

## Security

What the server protects and its limits (DNS rebinding, quotas, cookies, baseline poisoning, prompt injection) are
in [security.md](security.md). The defaults suit one person on one machine: `HOST=127.0.0.1`, no CORS, and per-user
quotas on turns.

## Tests

```
npx vitest run tests/integration/e2e        # the offline replay end-to-end tests
GEMINI_API_KEY=... GEMINI_MODEL=... EXA_API_KEY=... npx vitest run tests/integration/e2e/live-smoke.test.ts
```
