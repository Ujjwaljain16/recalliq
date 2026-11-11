# HTTP and SSE API

The server is plain `node:http` (no framework). It serves the browser client from `web/` and a JSON and
Server-Sent Events API under `/api`. The event types are the `SseEvent` union in
[src/shared/sse.ts](../src/shared/sse.ts); the contract is in [contracts.md](contracts.md) and
[architecture.md](architecture.md) section 13.

> **Scripted components.** Until the real analyzer, research service and answer pipeline are wired in
> (`src/app/live.ts`), the server runs a scripted demo set (`APP_COMPONENTS=scripted`). It gives canned answers
> and does no search and no model call. `GET /api/health` reports which set is active, and the client shows
> a banner while it is scripted.

## Configuration

Read at startup and validated together; an error names the variable and the rule, never its value.

| Variable | Meaning |
|---|---|
| `APP_MODE` | `real` or `demo`; selects the database file exactly as `src/config/env.ts` does |
| `PORT`, `HOST` | Listening port (default 3001) and address (default `127.0.0.1`) |
| `ALLOWED_ORIGIN` | The one cross-origin origin allowed to call the API (CORS with credentials) |
| `SESSION_SECRET` | At least 32 characters; signs the session cookie. Unset in development: a random secret is generated for the process and a warning is logged (sessions end at restart). Required when `NODE_ENV=production` |
| `APP_COMPONENTS` | `scripted` or `live`. Default `scripted` unless a provider key is set. `live` fails fast, naming the missing components; it never falls back to scripted |
| `SHUTDOWN_GRACE_MS` | How long a shutdown waits for running turns to persist (default 15000) |
| `SCRIPTED_PACE_MS` | Pause between scripted sentences so the stream is visible (default 120) |

`npm run dev` (watch mode) and `npm start` read `.env` if it exists. On SIGINT or SIGTERM the server stops
accepting connections, aborts the shutdown signal, lets running turns finish and persist within the grace
period, and closes the database. At startup turns left `running` by a crash become `interrupted` (ADR-33).

## Identity

An anonymous signed cookie names a user row (ADR-20): `recalliq_session=<userId>.<HMAC-SHA256>`, `HttpOnly`,
`SameSite=Lax`, `Path=/`, one year, `Secure` when `ALLOWED_ORIGIN` is https. It is set by the first
`POST /api/conversations`. A forged, tampered or unknown-user cookie gets `401 invalid_session` and the cookie
is cleared. Every route is scoped to the cookie's user: another user's conversation or turn is a `404`,
indistinguishable from one that does not exist.

State-changing requests with an `Origin` header must come from the page's own origin or `ALLOWED_ORIGIN`
(otherwise `403 forbidden_origin`). Request bodies are JSON (`Content-Type: application/json`, else `415`) and
limited to 32 KiB (`413`).

## Errors

```json
{ "error": { "code": "invalid_request", "message": "...", "issues": [{ "path": "text", "message": "..." }] } }
```

| Status | Codes |
|---|---|
| 400 | `invalid_json`, `invalid_request`, `invalid_ack` (`reason`: `beyond_streamed_extent` or `complete_flag_mismatch`) |
| 401 | `no_session`, `invalid_session` |
| 403 | `forbidden_origin` |
| 404 | `not_found` |
| 405, 413, 415 | `method_not_allowed`, `payload_too_large`, `unsupported_media_type` |
| 409 | `turn_in_progress` (`turnId`), `idempotency_conflict`, `turn_not_finished` |
| 500, 503 | `internal_error`, `database_busy`, `shutting_down` |

## Routes

### `GET /api/health`

`{ "status": "ok", "mode": "real|demo", "components": "scripted|live", "banner": string | null }`. No session.

### `POST /api/conversations`

Creates a conversation, and the user and cookie on first use. `201 { conversation }`.

### `GET /api/conversations`

The caller's conversations, newest first: `{ conversations: [{ id, title, preview, createdAt, updatedAt }] }`.
Without a cookie: an empty list, and no user is created.

### `GET /api/conversations/:id/messages`

`{ conversationId, messages: [...] }` in conversation order. A message has `id, role, content, status,
createdAt, turnId, streamedThrough, renderedThrough, sentences, sources, clarification, turn`.

- Each assistant sentence is `{ index, text, status, issues, delivery }`. `delivery` is derived from the stored
  extents by `deliveryState`: `presented` (acknowledged), `streamed_unacknowledged`, `not_streamed`.
- `sources` come from the turn's stored `source` events, numbered from 1 in event order. An `[n]` marker in
  the text refers to source `n`.
- `clarification` is the stored question and options of a clarify turn.
- `turn` is `{ status, lane, errorCode }`, so a user message whose turn stored no answer can be shown as
  interrupted or failed.

### `POST /api/conversations/:id/turns`

Body `{ text, idempotencyKey, tz?, retryOfTurnId? }` (`text` 1 to 4000 characters, `tz` an IANA zone). The
response is `text/event-stream`:

```
id: 3
event: answer.delta
data: {"sentenceIndex":0,"text":"Acme lists US$25 per user per month [1]."}

: heartbeat
```

- Events are named after the `SseEvent` union, with an increasing `id`; `: heartbeat` comments keep an idle
  connection open. Data is one JSON line; a line break inside a value is escaped by JSON.
- A validated sentence arrives whole: one `answer.delta` carrying the complete rendered text, immediately
  followed by its `answer.sentence_end` with the final status. `answer.completed` follows the last sentence and
  `turn.completed` is always last. The stream then ends.
- A refusal before the turn starts is a normal JSON error: `409 turn_in_progress` (the same key still running,
  or another turn running in the conversation), `409 idempotency_conflict` (the key was used for a different
  message), `404`.
- The same key for a finished turn replays the stored events (plus `answer.completed`) without running it again.
- **A client disconnect does not abort the turn** (ADR-17). The stream stops writing; the turn runs to completion
  and persists. Only acknowledged sentences count as presented.
- A failure after streaming began is sent as an `error` event, then the stream ends.

### `POST /api/turns/:turnId/ack`

Body `{ renderedThrough, complete }`; `200 { renderedThrough, newlyPresented }`. This is the repository's
acknowledgement (ADR-23): monotonic and idempotent, never past the streamed extent (`400 invalid_ack`),
`complete: true` only when `renderedThrough` equals the streamed extent (`400 invalid_ack`), and refused with
`409 turn_not_finished` until the answer is stored. The client sends it only after a sentence is in the DOM.

### `DELETE /api/conversations/:id`

Runs the privacy deletion procedure (contracts 1.1). `204`; `409` while a turn is running in it.

## Browser client

`web/` is plain HTML, CSS and ES modules, no build step. It renders each sentence when its delta arrives,
links `[n]` markers to the sources, shows clarification options as buttons that send the label as the next
message, marks `unverified`, `unchecked` and `truncated` sentences with a visible label, and shows partial,
failed and interrupted outcomes. Acknowledgements are batched after a short delay, only for sentences that
are rendered, contiguous from the first, and not beyond what was streamed (`web/js/ack-tracker.js`, tested
without a DOM). On reload it re-renders stored messages and acknowledges again; on page hide it hands any due
acknowledgement to `navigator.sendBeacon`.
