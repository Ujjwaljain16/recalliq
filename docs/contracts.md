# Stage 3 Contracts: Schema, TypeScript Interfaces, SSE

Reconciled in Stage 3.1 (2026-11-11). This document is **normative**: if [architecture.md](architecture.md) disagrees with it, that disagreement is a bug.

Conventions:

- Instants are stored as `INTEGER` epoch milliseconds, UTC.
- IDs are `TEXT`: a prefix plus `crypto.randomUUID()`.
- JSON columns are `TEXT`, validated with zod on both read and write.
- Every user-owned row carries `user_id`. Every repository method takes `userId` and filters on it. There is no unscoped query method.

---

## 1. SQL schema (`001_init.sql`)

> **Correction (final documentation pass, 2026-11-12).** Two statements in this section are narrower in the implementation, and the schema below is no longer the whole database:
>
> - **The two `PRAGMA` lines are connection settings, not migration statements.** `foreign_keys` is per connection and `journal_mode = WAL` cannot be changed inside a transaction on a file database (verified, [ADR-25](adr/ADR-25.md)), so `openDatabase()` sets them on every connection and `001_init.sql` omits them. A test compares the rest of the SQL block below with `001_init.sql` ([tests/integration/db/contract-parity.test.ts](../tests/integration/db/contract-parity.test.ts)).
> - **Migrations 002–009 add triggers and one column that this block does not show** (009 adds `source_snapshots.crawl_basis`). They are listed in [§1.2](#12-migrations-applied-on-top-of-the-schema) and in [turn-lifecycle.md](turn-lifecycle.md). Where this document or the architecture says a trigger "blocks" something, §1.2 says whether it does so today.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- required rows: schema_version, db_mode ('real'|'demo'), created_at.
-- Startup refuses to run if APP_MODE != db_mode. seed:demo refuses unless db_mode = 'demo'.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('real','fixture')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,
  origin      TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','recorded','synthetic')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_id           TEXT,                      -- provenance; turns reference messages, not vice versa
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content           TEXT NOT NULL,             -- assistant: rendered text
  content_template  TEXT,                      -- assistant: raw synthesis template with placeholders
  sentences_json    TEXT,                      -- assistant: PersistedSentence[]
  status            TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','interrupted')),
  streamed_through  INTEGER,                   -- assistant: highest sentence index fully written to SSE (-1 = none)
  rendered_through  INTEGER NOT NULL DEFAULT -1, -- assistant: highest sentence index acked as rendered
  last_ack_at       INTEGER,
  tz                TEXT NOT NULL,
  origin            TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','recorded','synthetic')),
  created_at        INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_user_time ON messages(user_id, created_at);

CREATE TABLE message_search (
  rowid       INTEGER PRIMARY KEY,
  message_id  TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  body        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX message_search_user_time ON message_search(user_id, created_at);
CREATE VIRTUAL TABLE message_fts USING fts5(body, tags, content='message_search', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER message_search_ai AFTER INSERT ON message_search BEGIN
  INSERT INTO message_fts(rowid, body, tags) VALUES (new.rowid, new.body, new.tags); END;
CREATE TRIGGER message_search_ad AFTER DELETE ON message_search BEGIN
  INSERT INTO message_fts(message_fts, rowid, body, tags) VALUES ('delete', old.rowid, old.body, old.tags); END;
CREATE TRIGGER message_search_au AFTER UPDATE ON message_search BEGIN
  INSERT INTO message_fts(message_fts, rowid, body, tags) VALUES ('delete', old.rowid, old.body, old.tags);
  INSERT INTO message_fts(rowid, body, tags) VALUES (new.rowid, new.body, new.tags); END;

CREATE TABLE turns (
  id                    TEXT PRIMARY KEY,
  conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  user_message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
  idempotency_key       TEXT NOT NULL,
  retry_of_turn_id      TEXT REFERENCES turns(id) ON DELETE SET NULL,
  lane                  TEXT CHECK (lane IN ('chat','recall','research','audit','clarify')),
  state                 TEXT NOT NULL,         -- TurnState
  status                TEXT NOT NULL CHECK (status IN ('running','complete','partial','clarify','interrupted','failed')),
  deadline_at           INTEGER NOT NULL,
  analysis_json         TEXT, context_json TEXT, events_json TEXT, metrics_json TEXT,
  error_code            TEXT,
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER,
  UNIQUE (user_id, idempotency_key)
);
CREATE UNIQUE INDEX turns_one_running ON turns(conversation_id) WHERE status = 'running';
CREATE INDEX turns_user_time ON turns(user_id, started_at);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical TEXT NOT NULL, norm TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'product',
  origin TEXT NOT NULL DEFAULT 'live', created_at INTEGER NOT NULL,
  UNIQUE (user_id, norm)
);
CREATE TABLE entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias_norm TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user','analysis','evidence')),
  PRIMARY KEY (entity_id, alias_norm)
);
CREATE TABLE entity_plans (                    -- known plan names, used by the intervening-tier rule
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  plan_norm TEXT NOT NULL,
  PRIMARY KEY (entity_id, plan_norm)
);
CREATE TABLE entity_domains (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('name_match','analysis_confirmed','user')),
  PRIMARY KEY (entity_id, domain)
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shortlist','constraint','preference','choice')),
  payload_json TEXT NOT NULL,
  user_quote TEXT NOT NULL,                    -- verified verbatim substring of the user message
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  origin TEXT NOT NULL DEFAULT 'live',
  created_at INTEGER NOT NULL
);
CREATE INDEX decisions_user_kind_time ON decisions(user_id, kind, created_at);
CREATE TABLE decision_entities (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, entity_id)
);

CREATE TABLE search_requests (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  entity_id TEXT,
  intent TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round IN (1,2)),
  provider TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','empty','failed','cached')),
  error_code TEXT,                             -- SearchErrorCode | 'deadline'
  latency_ms INTEGER, cost_usd REAL,
  started_at INTEGER NOT NULL
);
CREATE INDEX search_requests_turn ON search_requests(turn_id);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL, url_norm TEXT NOT NULL, domain TEXT NOT NULL, title TEXT,
  content_text TEXT NOT NULL,                  -- ≤ 6000 chars
  content_mode TEXT NOT NULL CHECK (content_mode IN ('text','highlights')),
  content_sha256 TEXT NOT NULL,
  provider TEXT NOT NULL,                      -- provenance of provider_* timestamps
  provider_published_at INTEGER,
  provider_last_updated_at INTEGER,
  observed_at INTEGER NOT NULL,                -- when we retrieved it
  fresh_fetch INTEGER NOT NULL CHECK (fresh_fetch IN (0,1)),
  crawl_status TEXT NOT NULL CHECK (crawl_status IN ('ok','failed','unknown')),
  origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','recorded','synthetic')),
  UNIQUE (user_id, url_norm, content_sha256, observed_at)
);
CREATE INDEX snapshots_user_url ON source_snapshots(user_id, url_norm, observed_at);

CREATE TABLE search_results (
  search_request_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL, provider_score REAL,
  PRIMARY KEY (search_request_id, snapshot_id)
);

CREATE TABLE evidence_statements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,                       -- provenance only, deliberately NOT a FK (see §1.1)
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('price','release','plan_change','other')),
  belief_key TEXT,                             -- canonical encoding; null if no key (historical, negated, other)
  payload_json TEXT NOT NULL,                  -- EvidenceFields
  quote TEXT NOT NULL, context_quote TEXT,
  polarity TEXT NOT NULL CHECK (polarity IN ('affirmed','negated')),
  modality TEXT NOT NULL CHECK (modality IN ('current','planned','historical','conditional','promotional')),
  effective_from INTEGER,                      -- as stated in text; null if not stated
  event_date INTEGER,                          -- releases: as stated in text
  displayed_at INTEGER,                        -- derived; see TimeFields
  displayed_at_basis TEXT NOT NULL CHECK (displayed_at_basis IN ('fresh_fetch','provider_last_updated','provider_published','unknown')),
  authority_tier TEXT NOT NULL CHECK (authority_tier IN ('A1','A2','B','C')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('pass','weak','fail')),
  verification_json TEXT NOT NULL,
  significance TEXT CHECK (significance IN ('major','minor')),
  created_at INTEGER NOT NULL
);
CREATE INDEX evidence_key_time ON evidence_statements(user_id, belief_key, displayed_at);
CREATE INDEX evidence_entity ON evidence_statements(user_id, entity_id, kind);
CREATE INDEX evidence_turn ON evidence_statements(turn_id);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('pricing','releases','general')),
  belief_key TEXT,
  current_status TEXT NOT NULL CHECK (current_status IN ('confirmed','contested','stale','unknown','unable_to_verify')),
  verdict TEXT,                                -- PriceVerdict | ReleaseVerdict | null
  verdict_reason TEXT,
  baseline_assertion_id TEXT,
  data_json TEXT NOT NULL,                     -- Finding
  UNIQUE (turn_id, ord)
);

CREATE TABLE assertions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  sentence_index INTEGER NOT NULL,
  placeholder TEXT NOT NULL,                   -- e.g. "F3", "F3:baseline"
  belief_key TEXT,
  rendered_text TEXT NOT NULL,
  value_json TEXT,                             -- NormalizedValue
  created_at INTEGER NOT NULL,
  presented_at INTEGER                         -- set once, by ack
);
CREATE INDEX assertions_key ON assertions(user_id, belief_key, presented_at);
CREATE INDEX assertions_message ON assertions(message_id, sentence_index);

CREATE TABLE assertion_evidence (
  assertion_id TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_statements(id) ON DELETE CASCADE,
  PRIMARY KEY (assertion_id, evidence_id)
);

CREATE TABLE assertion_events (
  id TEXT PRIMARY KEY,
  assertion_id TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('presented','not_presented','reaffirmed','superseded_world_changed','retracted_was_wrong','contested','unverifiable_now','differs_timing_unknown')),
  reason TEXT, evidence_ids TEXT, turn_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX assertion_events_a ON assertion_events(assertion_id, at);
CREATE UNIQUE INDEX assertion_presented_once ON assertion_events(assertion_id) WHERE status = 'presented';
CREATE UNIQUE INDEX assertion_not_presented_once ON assertion_events(assertion_id) WHERE status = 'not_presented';

CREATE TABLE beliefs (                           -- derived
  user_id TEXT NOT NULL,
  belief_key TEXT NOT NULL,
  key_json TEXT NOT NULL,                      -- decoded PriceBeliefKey | ReleaseKey
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('confirmed','contested','stale','unknown')),
  value_json TEXT, contested_json TEXT, pending_signals_json TEXT,
  displayed_at INTEGER, verified_at INTEGER,
  winning_evidence TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, belief_key)
);
CREATE TABLE belief_history (                    -- derived, append-only between rebuilds
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL, belief_key TEXT NOT NULL,
  prev_json TEXT, next_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('initial','reconfirmed','world_changed','corrected','contested','staled')),
  evidence_ids TEXT NOT NULL, turn_id TEXT, at INTEGER NOT NULL
);
CREATE INDEX belief_history_key ON belief_history(user_id, belief_key, at);

CREATE TABLE search_cache (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX search_cache_exp ON search_cache(expires_at);

-- ───────────── integrity triggers (each protects a named invariant) ─────────────

-- INV-07 owner consistency
CREATE TRIGGER messages_owner BEFORE INSERT ON messages
WHEN NEW.user_id IS NOT (SELECT user_id FROM conversations WHERE id = NEW.conversation_id)
BEGIN SELECT RAISE(ABORT, 'message owner mismatch'); END;
CREATE TRIGGER turns_owner BEFORE INSERT ON turns
WHEN NEW.user_id IS NOT (SELECT user_id FROM conversations WHERE id = NEW.conversation_id)
BEGIN SELECT RAISE(ABORT, 'turn owner mismatch'); END;

-- Demo isolation: no fixture/recorded/synthetic data in a real DB
CREATE TRIGGER users_no_fixture_in_real BEFORE INSERT ON users
WHEN NEW.kind <> 'real' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'fixture user in real db'); END;
CREATE TRIGGER conversations_no_fixture_in_real BEFORE INSERT ON conversations
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live conversation in real db'); END;
CREATE TRIGGER snapshots_no_fixture_in_real BEFORE INSERT ON source_snapshots
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live snapshot in real db'); END;

-- Append-only: L1, L2, events, history (DELETE stays possible for privacy deletion and rebuild)
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON source_snapshots BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER evidence_immutable  BEFORE UPDATE ON evidence_statements BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER assertion_events_immutable BEFORE UPDATE ON assertion_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER belief_history_immutable BEFORE UPDATE ON belief_history BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- L3: assertions may only receive presented_at once
CREATE TRIGGER assertions_presented_once BEFORE UPDATE ON assertions
WHEN NOT (OLD.presented_at IS NULL AND NEW.presented_at IS NOT NULL
          AND NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.message_id IS OLD.message_id
          AND NEW.turn_id IS OLD.turn_id AND NEW.finding_id IS OLD.finding_id
          AND NEW.sentence_index IS OLD.sentence_index AND NEW.placeholder IS OLD.placeholder
          AND NEW.belief_key IS OLD.belief_key AND NEW.rendered_text IS OLD.rendered_text
          AND NEW.value_json IS OLD.value_json AND NEW.created_at IS OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'assertions are immutable except presented_at once'); END;

-- Messages: content immutable; rendered_through monotonic
CREATE TRIGGER messages_content_immutable
BEFORE UPDATE OF content, content_template, sentences_json, role, user_id, conversation_id, seq, status, streamed_through, tz, origin, created_at ON messages
BEGIN SELECT RAISE(ABORT, 'message content is immutable'); END;
CREATE TRIGGER messages_ack_monotonic BEFORE UPDATE OF rendered_through ON messages
WHEN NEW.rendered_through < OLD.rendered_through
BEGIN SELECT RAISE(ABORT, 'rendered_through must not decrease'); END;
```

**Foreign-key actions and triggers.** None of the protected tables depends on an `ON DELETE SET NULL` action, so whether SQLite foreign-key actions fire UPDATE triggers doesn't matter here. `assertions.finding_id` uses `CASCADE` for that reason. `turns.assistant_message_id` and `decisions.supersedes_id` use `SET NULL`, and neither table is append-protected.

**Message immutability has one gap: rewriting a whole row.** Columns that are immutable cannot change through UPDATE. Nothing stops a repository from deleting a message and re-inserting it under the same ID, so repositories have no such method, and T-DB-04 asserts that.

### 1.1 Privacy deletion procedure (`deleteConversation(userId, conversationId)`)

This runs as one transaction:

1. `D := SELECT id FROM turns WHERE conversation_id = ? AND user_id = ?`.
2. `K := SELECT DISTINCT belief_key FROM evidence_statements WHERE turn_id IN D AND belief_key IS NOT NULL`.
3. `DELETE FROM conversations WHERE id = ? AND user_id = ?`. This cascades to messages, message_search (and the FTS triggers), turns, search_requests, search_results, findings, assertions, assertion_evidence, assertion_events and decisions.
4. Delete this conversation's evidence, **except evidence still cited by an assertion in another conversation**:
   ```sql
   DELETE FROM evidence_statements
   WHERE turn_id IN D
     AND id NOT IN (SELECT evidence_id FROM assertion_evidence);
   ```
   Evidence that survives is web-derived and keeps only a dangling `turn_id` for provenance. No text from the user's messages survives.
5. Garbage-collect snapshots that nothing references any more:
   ```sql
   DELETE FROM source_snapshots
   WHERE user_id = ?
     AND id NOT IN (SELECT snapshot_id FROM evidence_statements)
     AND id NOT IN (SELECT snapshot_id FROM search_results);
   ```
6. Garbage-collect entities that have no evidence, no `decision_entities` and no remaining `message_search` tag mention. This cascades to aliases, plans, domains and beliefs.
7. `rebuildBeliefs(userId, K)`: delete `beliefs` and `belief_history` for every key in K, then replay the remaining `pass` evidence.

Test coverage: T-MEM-08, T-DB-08 (referenced evidence survives), T-DB-09 (rebuild-after-delete equals a fresh rebuild).

### 1.2 Migrations applied on top of the schema

Added after this document was reconciled (002 to 005 in milestone 2, 006 in milestone 3). They only add triggers; no table or column changed. Decisions: [ADR-25](adr/ADR-25.md) to [ADR-32](adr/ADR-32.md).

| # | Migration | Enforces in the database | Not covered |
|---|---|---|---|
| 002 | `002_demo_isolation.sql` | A `real` database rejects inserts of non-live messages, entities and decisions, relabelling of users, conversations, entities and decisions, and any change to `meta.db_mode` | Other tables carry no origin column or are not checked; isolation is partial (Q-002) |
| 003 | `003_ownership_consistency.sql` | Evidence, findings and assertions reference only rows of the same user as their turn; `assertion_evidence` and the evidence/finding references are immutable | snapshots by turn (they have no turn column; protected at their links) (Q-007; plan in [questions.md](questions.md)) |
| 004 | `004_turn_lifecycle.sql` | The 19-edge transition table, immutable turn identity, finished turns are final, state/status coupling | Failure edges from intermediate states (Q-011) |
| 005 | `005_delivery_acknowledgement.sql` | Streamed vs rendered extents, "presented only if acknowledged", the `presented`, `not_presented` and verdict event rules | |
| 006 | `006_decision_ownership.sql` | `decisions` and `decision_entities`: owner equals the conversation's and the message's, the message belongs to the conversation, `supersedes_id` is the same user's, identity columns are immutable, links are append-only | Added in milestone 3 |
| 007 | `007_search_ownership.sql` | `search_requests` (owner equals the turn's; entity, if set, is the same user's; identity columns immutable) and `search_results` (request and snapshot belong to the same user; append-only). `source_snapshots` has no turn, so its ownership is enforced at its links | Added in milestone 4 |
| 008 | `008_belief_ownership.sql` | `beliefs` (user exists; entity belongs to the same user; every winning evidence id belongs to the same user, checked with `json_each`; identity columns immutable) and `belief_history` (user exists; a non-null turn and every evidence id belong to the same user; append-only was already enforced) | Added with the belief resolver |
| 009 | `009_snapshot_crawl_basis.sql` | `source_snapshots.crawl_basis TEXT NOT NULL DEFAULT 'unknown'`, checked to be one of `confirmed_live`, `requested_live`, `cached`, `unknown`; a trigger rejects a new row whose `fresh_fetch` and `crawl_basis` contradict each other (`confirmed_live` needs `fresh_fetch = 1`; `fresh_fetch = 1` cannot be `requested_live` or `cached`). Snapshots stay immutable. Existing rows keep the default and are read back with the rule "`fresh_fetch = 1` means `confirmed_live`" | Added for the freshness observation states. Existing rows with `fresh_fetch = 0` read as `unknown`: the migration cannot say more, and snapshots cannot be updated |

The origin triggers mentioned in architecture §12 therefore block **some** fixture rows, not all, and ownership is enforced for some tables, not all.

---

## 2. TypeScript contracts (`src/shared/`)

```ts
// ── primitives ──
export type Ms = number; export type IanaTz = string;
export type Id<P extends string> = `${P}_${string}`;
export type UserId = Id<'usr'>; export type ConversationId = Id<'cnv'>; export type MessageId = Id<'msg'>;
export type TurnId = Id<'trn'>; export type EntityId = Id<'ent'>; export type SnapshotId = Id<'src'>;
export type EvidenceId = Id<'ev'>; export type FindingId = Id<'fnd'>; export type AssertionId = Id<'asr'>;
export type DecisionId = Id<'dec'>;
export type Origin = 'live' | 'recorded' | 'synthetic';

// ── infrastructure ──
export interface Clock { now(): Ms; }
export interface Logger { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void; child(b: object): Logger; }

export type BudgetStage = 'analysis' | 'search' | 'extraction' | 'judge' | 'synthesis';
export type BudgetOp = 'search_retry' | 'extraction_retry' | 'extraction_split' | 'fallback_round' | 'judge';
export interface TurnBudget {
  readonly deadline: Ms;
  readonly signal: AbortSignal;                       // aborts at deadline or shutdown; NOT on client disconnect
  remaining(): Ms;
  /** min(cap, remaining − reserve(stage)); ≤ 0 means the call must not start */
  timeoutFor(stage: BudgetStage, capMs: Ms): Ms;
  /** AbortSignal.any([this.signal, AbortSignal.timeout(timeoutFor(...))]) */
  signalFor(stage: BudgetStage, capMs: Ms): AbortSignal;
  /** remaining − reserve(stage) ≥ minDuration(op) */
  admit(op: BudgetOp): boolean;
}
// Constants (config): TURN_DEADLINE_MS 60000; caps: analysis 8000, search 6000, extraction 25000, judge 4000;
// reserves: search 13000, extraction 10000, judge → must end by deadline−500; minDuration: search_retry 2000,
// extraction_retry/split 8000, fallback_round 15000, judge 2000; SYNTH_COMPACT_BELOW_MS 12000.

// ── LLM port ──
export type LlmRole = 'analysis' | 'extraction' | 'synthesis' | 'judge';
export interface LlmUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; }
export interface StructuredRequest<T> {
  role: LlmRole; system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  schema: import('zod').ZodType<T>; schemaName: string; maxTokens: number; signal: AbortSignal;   // from TurnBudget
}
export interface StructuredResult<T> { value: T; usage: LlmUsage; model: string; latencyMs: number; }
export interface StreamRequest { role: 'synthesis'; system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens: number; signal: AbortSignal; }
export type StreamEvent = { type: 'delta'; text: string } | { type: 'done'; usage: LlmUsage; model: string; ttftMs: number; latencyMs: number };
export type LlmErrorCode = 'rate_limited' | 'unavailable' | 'timeout' | 'cancelled' | 'refused' | 'invalid_output' | 'bad_request';
export class LlmError extends Error { constructor(public code: LlmErrorCode, msg: string, public retryAfterMs?: number) { super(msg); } }
export interface LlmPort { structured<T>(r: StructuredRequest<T>): Promise<StructuredResult<T>>; stream(r: StreamRequest): AsyncIterable<StreamEvent>; }

// ── search port ──
export interface SearchRequest {
  query: string; numResults: number;                  // 1..10
  includeDomains?: string[]; startPublishedDate?: Ms; endPublishedDate?: Ms; category?: 'news';
  freshness: 'cached' | 'live';                       // live → provider fresh crawl
  liveTimeoutMs?: number;                             // ≤ 5000
  contentMode: 'text' | 'highlights';                 // pricing → text (keeps headings/tables)
  contentChars: number;                               // ≤ 6000
}
/** What a result's freshness rests on. Only `confirmed_live` (a per-result provider marker) is a confirmation; a successful response or a `maxAgeHours: 0` request never is. See ADR-36. */
export type CrawlBasis = 'confirmed_live' | 'requested_live' | 'cached' | 'unknown';
export interface SearchHit {
  url: string; title: string | null; text: string;
  publishedAt: Ms | null; lastUpdatedAt: Ms | null;   // provider metadata → snapshot.provider_*
  providerScore: number | null;
  freshFetch: boolean;                                // live requested AND crawl ok; equals crawlBasis === 'confirmed_live'
  crawlBasis?: CrawlBasis;                            // absent on older recordings; the store derives it from freshFetch
  crawlStatus: 'ok' | 'failed' | 'unknown';
}
export interface SearchResponse { provider: string; hits: SearchHit[]; droppedMalformed: number; latencyMs: number; costUsd: number | null; observedAt: Ms; }
export type SearchErrorCode = 'rate_limited' | 'quota_exhausted' | 'unavailable' | 'timeout' | 'cancelled' | 'bad_request';
export class SearchError extends Error { constructor(public code: SearchErrorCode, msg: string, public retryAfterMs?: number) { super(msg); } }
export class ReplayMissError extends Error {}         // never caught by retry policy; fails the test run
export interface SearchPort { readonly provider: string; search(req: SearchRequest, signal: AbortSignal): Promise<SearchResponse>; }

// ── understanding ──
export type Lane = 'chat' | 'recall' | 'research' | 'audit' | 'clarify';
export type Intent = 'pricing' | 'releases' | 'general';
export type TemporalExpression =
  | { kind: 'today' } | { kind: 'yesterday' } | { kind: 'days_ago'; n: number }
  | { kind: 'weekday'; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; modifier: 'none' | 'last' | 'this' }
  | { kind: 'calendar_date'; day: number; month: number; year?: number }
  | { kind: 'last_week' }
  | { kind: 'since'; anchor: Exclude<TemporalExpression, { kind: 'since' }> };
export interface TemporalMention { text: string; expr: TemporalExpression; role: 'reference_conversation' | 'change_since' | 'event_time'; }
export interface EntityMention { text: string; normalized: string; officialDomainGuess?: string; }
export interface DecisionPayload {
  kind: 'shortlist' | 'constraint' | 'preference' | 'choice';
  entities?: string[]; label?: string;
  constraint?: { key: string; value: string | number; unit?: string };
}
export interface UserFact { kind: DecisionPayload['kind'] | 'correction'; quote: string; data: DecisionPayload; correctsDecisionKind?: DecisionPayload['kind']; }
export interface TurnAnalysis {
  laneHint: Lane; intents: Intent[]; temporal: TemporalMention[]; entities: EntityMention[];
  references: Array<{ text: string; kind: 'previous_answer' | 'decision' | 'conversation' | 'entity_set' }>;
  topicTerms: string[]; asksStillCorrect: boolean; queries: string[]; alternateQueries: string[];
  userFacts: UserFact[]; degraded: boolean;
}

// ── temporal ──
export interface DayInterval { startMs: Ms; endMs: Ms; localDate: string; tz: IanaTz; }   // [start, end)
export interface ResolvedTemporal { mention: TemporalMention; candidates: DayInterval[]; status: 'resolved' | 'ambiguous' | 'unresolved'; }
export interface TemporalResolver { resolve(m: TemporalMention[], tz: IanaTz, now: Ms): ResolvedTemporal[]; }

// ── memory ──
export interface MemoryCandidate { conversationId: ConversationId; messageId: MessageId; turnId: TurnId | null; createdAt: Ms; localTime: string; excerpt: string; matchedTerms: string[]; score: number; intervalIndex: number; }
export interface DecisionRecord { id: DecisionId; payload: DecisionPayload; entityIds: EntityId[]; createdAt: Ms; messageId: MessageId; version: number; }
export interface Baseline {                              // from PRESENTED assertions only
  assertionId: AssertionId; beliefKey: string; key: PriceBeliefKey; entityId: EntityId;
  value: NormalizedValue; presentedAt: Ms;               // T0
  evidence: VerifiedEvidence[];                          // as stored
  evidenceStatusAtT0: 'pass_current' | 'pass_stale' | 'weak' | 'missing';
}
export interface ResolvedContext {
  lane: Lane; temporal: ResolvedTemporal[]; memoryHits: MemoryCandidate[]; decisions: DecisionRecord[];
  entities: Array<{ id: EntityId; name: string; aliases: string[]; plans: string[]; officialDomains: string[] }>;
  baselines: Baseline[]; reuseFindingSetFromTurn?: TurnId;
  clarification?: { question: string; options: Array<{ label: string; ref: string }> };
}
export interface MemoryRetriever {
  messagesInIntervals(u: UserId, iv: DayInterval[], terms: string[]): MemoryCandidate[];
  searchAll(u: UserId, terms: string[], limit: number): MemoryCandidate[];
  decisions(u: UserId, kind: DecisionPayload['kind'] | null, iv: DayInterval[] | null): DecisionRecord[];
  entitiesByAlias(u: UserId, normalized: string[]): ResolvedContext['entities'];
}
export interface BaselineLoader { load(u: UserId, turnIds: TurnId[], entityIds: EntityId[]): Baseline[]; }

// ── research ──
export interface QuerySpec { id: string; entityId: EntityId | null; intent: Intent | 'official_domain_discovery'; round: 1 | 2; request: SearchRequest; }
export interface ResearchPlan { specs: QuerySpec[]; fallback: QuerySpec[]; budget: { maxSearches: number; maxPerEntity: number; concurrency: number }; }
export interface SearchOutcome { spec: QuerySpec; status: 'ok' | 'empty' | 'failed' | 'cached'; errorCode?: SearchErrorCode | 'deadline'; snapshotIds: SnapshotId[]; }
export interface SourceSnapshot {
  id: SnapshotId; url: string; urlNorm: string; domain: string; title: string | null;
  text: string; contentMode: 'text' | 'highlights'; sha256: string; provider: string;
  providerPublishedAt: Ms | null; providerLastUpdatedAt: Ms | null;
  observedAt: Ms; freshFetch: boolean; crawlBasis?: CrawlBasis; crawlStatus: 'ok' | 'failed' | 'unknown'; origin: Origin;
}
export interface ResearchPlanner { plan(ctx: ResolvedContext, a: TurnAnalysis, now: Ms): ResearchPlan; }
export interface ResearchExecutor { execute(plan: ResearchPlan, round: 1 | 2, budget: TurnBudget, emit: EventSink): Promise<SearchOutcome[]>; }

// ── evidence ──
export type AuthorityTier = 'A1' | 'A2' | 'B' | 'C';
export type Modality = 'current' | 'planned' | 'historical' | 'conditional' | 'promotional';
export type Unit = 'per_seat' | 'flat' | 'usage' | 'unspecified';
export type BillingPeriod = 'monthly' | 'annual' | 'monthly_billed_annually' | 'one_time' | 'unspecified';
export type CurrencyCode = string;                       // ISO 4217
export interface NormalizedValue {
  amount: number;
  currency: CurrencyCode | 'unknown';
  currencySymbol: string | null;                       // as displayed, e.g. "$"
  unit: Unit;
  usageUnit: string | null;                            // required iff unit = 'usage', e.g. "gb-month"
  billingPeriod: BillingPeriod;
  valueKind: 'exact' | 'lower_bound' | 'upper_bound';
}
export interface EvidenceFields {
  plan: string | null; planNorm: string | null;
  attribute: 'price' | 'release' | 'plan_change' | 'other';
  value: NormalizedValue | null;                       // price only
  releaseTitle?: string; releaseKind?: 'launch' | 'change' | 'removal';
  conditions: string | null;                           // verbatim cue text for conditional/promotional
}
export interface RawEvidence {                         // extractor output, unverified
  snapshotRef: string; entityRef: string; kind: EvidenceFields['attribute']; fields: EvidenceFields;
  quote: string;                                       // ≤ 400, verbatim
  contextQuote: string | null;                         // ≤ 200, verbatim, nearest heading/table header ABOVE quote
  polarity: 'affirmed' | 'negated'; modality: Modality;
  effectiveFromText: string | null; eventDateText: string | null;   // parsed by code
  significance: 'major' | 'minor' | null; significanceReason: string | null;
}
export type VerificationCheck =
  | 'quote_verbatim' | 'context_verbatim' | 'context_association'
  | 'subject_binding' | 'competitor_attribution' | 'plan_binding' | 'intervening_tier'
  | 'value_presence' | 'currency' | 'unit' | 'billing_period' | 'date_presence'
  | 'negation' | 'historical_cue' | 'conditional_cue' | 'planned_cue';
export interface CheckResult { check: VerificationCheck; outcome: 'pass' | 'weak' | 'fail' | 'n/a'; detail?: string; }
export interface VerificationReport { status: 'pass' | 'weak' | 'fail'; checks: CheckResult[]; }

/** All time fields, kept distinct (ADR-22). */
export interface TimeFields {
  observedAt: Ms;                                      // snapshot retrieval
  freshFetch: boolean;
  providerPublishedAt: Ms | null; providerLastUpdatedAt: Ms | null;   // provenance: snapshot.provider
  effectiveFrom: Ms | null;                            // stated in text
  eventDate: Ms | null;                                // stated in text (releases)
  displayedAt: Ms | null;                              // derived: latest instant source provably displayed it
  displayedAtBasis: 'fresh_fetch' | 'provider_last_updated' | 'provider_published' | 'unknown';
}
export interface VerifiedEvidence extends TimeFields {
  id: EvidenceId; snapshotId: SnapshotId; urlNorm: string; entityId: EntityId;
  kind: EvidenceFields['attribute']; beliefKey: string | null; fields: EvidenceFields;
  quote: string; contextQuote: string | null; polarity: 'affirmed' | 'negated'; modality: Modality;
  authorityTier: AuthorityTier; verification: VerificationReport; significance: 'major' | 'minor' | null;
}
export interface ExtractionBatch { id: string; entityIds: EntityId[]; snapshotIds: SnapshotId[]; estTokens: number; trimmed: SnapshotId[]; }
export interface ExtractionBatcher { pack(byEntity: Map<EntityId, SourceSnapshot[]>): ExtractionBatch[]; }
export interface EvidenceExtractor { extract(batch: ExtractionBatch, budget: TurnBudget): Promise<RawEvidence[]>; }
export interface EntityContext { id: EntityId; aliases: string[]; plans: string[]; officialDomains: string[]; otherEntityAliases: string[]; }
export interface EvidenceVerifier { verify(raw: RawEvidence, s: SourceSnapshot, e: EntityContext, tier: AuthorityTier, now: Ms): VerifiedEvidence; }  // pure
export interface AuthorityClassifier { classify(s: SourceSnapshot, officialDomains: string[]): AuthorityTier; }

// ── belief keys (ADR-21) ──
export type Arrangement = 'list' | 'conditional' | 'promotional' | 'planned';
export interface PriceBeliefKey {
  kind: 'price'; version: 1;
  entityId: EntityId;
  plan: string;                                        // planNorm or 'unspecified'
  arrangement: Arrangement;
  conditionHash: string | null;                        // sha1(normalised conditions) for conditional/promotional; else null
  unit: Unit; usageUnit: string | null;
  billingPeriod: BillingPeriod;
  currency: CurrencyCode | `unknown@${string}`;        // unknown scoped to registrable source domain
  locale: string;                                      // canonical BCP-47 (Intl.getCanonicalLocales), 'und' if undetermined; derived by code from the URL, never by the model (ADR-37)
  valueKind: NormalizedValue['valueKind'];
}
export interface ReleaseKey { kind: 'release'; version: 1; entityId: EntityId; titleHash: string; }
export declare function encodePriceKey(k: PriceBeliefKey): string;
// "price:v1|e=<entityId>|p=<plan>|a=<arrangement>|c=<hash|->|u=<unit>|uu=<usageUnit|->|b=<billing>|cur=<currency>|loc=<locale>|vk=<valueKind>"
// (version stays 1: no belief key has ever been stored; beliefs are derived and rebuildable)
export declare function decodePriceKey(s: string): PriceBeliefKey;          // throws on non-canonical input
export declare function keyForEvidence(e: Omit<VerifiedEvidence, 'beliefKey'>, source: { domain: string; urlNorm: string }): string | null;
// modality current→list, conditional→conditional, promotional→promotional, planned→planned; historical/negated/other→null
export declare function comparableKeys(a: PriceBeliefKey, b: PriceBeliefKey): 'equal' | 'comparable' | 'different';
// Different locales are 'different', including 'und' against a known locale. Two keys that agree in every dimension, 'und' included, are 'equal';
// but an 'und' locale can never be what establishes a positive `changed` verdict (architecture §8, ADR-36).

// ── belief & change ──
export type BeliefStatus = 'confirmed' | 'contested' | 'stale' | 'unknown';
export interface PendingSignal { kind: 'lower_tier_newer' | 'planned_due'; value: NormalizedValue; effectiveFrom: Ms | null; evidenceIds: EvidenceId[]; }
export interface Belief {
  key: string; entityId: EntityId; status: BeliefStatus;
  value: NormalizedValue | null;
  contestedValues?: Array<{ value: NormalizedValue; evidenceIds: EvidenceId[] }>;
  displayedAt: Ms | null; verifiedAt: Ms | null;       // verifiedAt = latest fresh_fetch winner
  winningEvidence: EvidenceId[]; pendingSignals: PendingSignal[];
}
export type BeliefTransitionReason = 'initial' | 'reconfirmed' | 'world_changed' | 'corrected' | 'contested' | 'staled';
export interface BeliefPolicy { freshnessMs: Record<'price', Ms>; contestWindowMs: Ms; lowerTierLeadMs: Ms; }   // 30 d, 7 d, 2 d
export interface BeliefResolver {
  resolve(key: string, evidence: VerifiedEvidence[], prev: Belief | null, now: Ms, policy: BeliefPolicy):
    { belief: Belief; transition: { reason: BeliefTransitionReason; prev: Belief | null } | null };
}

export type PriceVerdict =
  | 'changed' | 'baseline_incorrect' | 'differs_timing_unknown'
  | 'unchanged_confirmed' | 'no_evidence_of_change' | 'contested' | 'unable_to_verify';
export type PriceVerdictReason =
  | 'unsupported_at_time' | 'other_value_in_effect_at_T0' | 'timing_conflict'
  | 'same_source_bracketing' | 'stated_effective_date' | 'listed_differently'
  | CoverageFailure;
export type ReleaseVerdict = 'releases_found' | 'none_found' | 'unable_to_verify';
export type CoverageFailure = 'search_timeout' | 'search_unavailable' | 'quota_exhausted' | 'extraction_failed' | 'deadline';
export interface Coverage {
  searchesOk: number; searchesFailed: number; extractionFailed: boolean;
  sourcesChecked: number; newestDatedSource: Ms | null; freshOfficialFetched: boolean;
  failure: CoverageFailure | null;
}
export interface ChangeWindow { after: Ms; notAfter: Ms; }      // change occurred in (after, notAfter]
export interface ChangeDetector {
  price(b: Baseline, current: Belief | null, keyEvidence: VerifiedEvidence[], coverage: Coverage):
    { verdict: PriceVerdict; reason: PriceVerdictReason | null; window?: ChangeWindow; effectiveFrom?: Ms; direction?: 'up' | 'down' | 'other' };
  releases(evidence: VerifiedEvidence[], coverage: Coverage, t0: Ms):
    { verdict: ReleaseVerdict; items: VerifiedEvidence[] };
}

/** currentStatus = state of the current belief (or coverage failure). verdict = comparison against a baseline (audit) or the release interval. */
export type FindingCurrentStatus = BeliefStatus | 'unable_to_verify';
export interface Finding {
  id: FindingId; ord: number;                          // rendered as F{ord}
  entityId: EntityId; entityName: string; intent: Intent; beliefKey: string | null;
  currentStatus: FindingCurrentStatus;
  verdict: PriceVerdict | ReleaseVerdict | null;       // null for research-lane price findings with no baseline
  verdictReason: PriceVerdictReason | null;
  direction?: 'up' | 'down' | 'other';                 // changed / differs_timing_unknown only
  changeWindow?: ChangeWindow; effectiveFrom?: Ms;
  current?: { value: NormalizedValue | null; displayedAt: Ms | null; verifiedAt: Ms | null; citations: SnapshotId[];
              contested?: Belief['contestedValues']; pendingSignals: PendingSignal[] };
  baseline?: { value: NormalizedValue; presentedAt: Ms; citations: SnapshotId[]; assertionId: AssertionId };
  releases?: Array<{ title: string; kind: 'launch' | 'change' | 'removal'; eventDate: Ms | null; providerPublishedAt: Ms | null;
                     significance: 'major' | 'minor' | null; announcedBeforeBaseline: boolean; citations: SnapshotId[] }>;
  derived?: Array<{ label: string; amount: number; currency: NormalizedValue['currency']; currencySymbol: string | null; formula: string }>;
  coverage: Coverage; evidenceIds: EvidenceId[];
}
export interface FindingSet { turnId: TurnId; createdAt: Ms; findings: Finding[];
  sources: Record<SnapshotId, { url: string; title: string | null; domain: string; tier: AuthorityTier; observedAt: Ms }>; }

// ── answer ──
export type PlaceholderRef =
  | { kind: 'finding'; ord: number; variant: 'current' | 'baseline' | 'verdict' }
  | { kind: 'finding_derived'; ord: number; index: number }
  | { kind: 'message'; messageId: MessageId }
  | { kind: 'source'; snapshotId: SnapshotId };
export type SentenceStatus = 'verified' | 'no_claims' | 'unverified' | 'unchecked' | 'truncated';
export type SentenceIssue =
  | 'malformed_placeholder' | 'unknown_ref' | 'inapplicable_variant' | 'render_mismatch'
  | 'free_number' | 'free_currency' | 'free_percent' | 'free_date' | 'unsupported_verdict_word'
  | 'unsupported_global_negative' | 'judge_unsupported' | 'judge_partial' | 'judge_unavailable';
export interface PersistedSentence {
  index: number; text: string; template: string; status: SentenceStatus; issues: SentenceIssue[];
  placeholders: Array<{ token: string; findingId?: FindingId; messageId?: MessageId; snapshotId?: SnapshotId; rendered: string }>;
}
export interface AnswerPipeline {
  run(input: { findings: FindingSet | null; recall: Map<MessageId, { text: string; localTime: string }>; ctx: ResolvedContext;
               userMessage: string; window: Array<{ role: 'user' | 'assistant'; content: string }>; tz: IanaTz },
      budget: TurnBudget, emit: EventSink):
    Promise<{ sentences: PersistedSentence[]; streamedThrough: number; interrupted: boolean; template: string; rendered: string }>;
}

// ── delivery ──
export interface AckRequest { renderedThrough: number; complete: boolean; }   // POST /api/turns/:turnId/ack
export type DeliveryState = 'presented' | 'streamed_unacknowledged' | 'not_streamed';
export declare function deliveryState(sentenceIndex: number, msg: { renderedThrough: number; streamedThrough: number | null }): DeliveryState;

// ── orchestration ──
export type TurnState = 'RECEIVED' | 'ANALYZING' | 'RESOLVING_CONTEXT' | 'CLARIFYING' | 'PLANNING' | 'SEARCHING' | 'EXTRACTING'
  | 'VERIFYING' | 'RESOLVING_BELIEFS' | 'SYNTHESIZING' | 'POST_VERIFYING' | 'PERSISTING' | 'COMPLETED' | 'FAILED';
export type TurnStatus = 'running' | 'complete' | 'partial' | 'clarify' | 'interrupted' | 'failed';
export type TerminalTurnStatus = Exclude<TurnStatus, 'running'>;
export interface TurnRequest { userId: UserId; conversationId: ConversationId; text: string; tz: IanaTz; idempotencyKey: string; retryOfTurnId?: TurnId; }
export interface TurnMetrics {
  ttfpMs: number | null; ttftMs: number | null; ttcMs: number; deadlineHit: boolean;
  llmCalls: Array<{ role: LlmRole; model: string; usage: LlmUsage; latencyMs: number; ok: boolean; errorCode?: LlmErrorCode }>;
  searches: { total: number; ok: number; failed: number; cached: number; notAdmitted: number; costUsd: number };
  extraction: { batches: number; retries: number; splits: number };
  verification: { pass: number; weak: number; fail: number; byCheck: Partial<Record<VerificationCheck, { weak: number; fail: number }>> };
  sentences: Record<SentenceStatus, number>; judgeCalls: number;
  statesVisited: TurnState[];
}
export interface TurnResult { turnId: TurnId; status: TerminalTurnStatus; assistantMessageId: MessageId | null; metrics: TurnMetrics; }
export type EventSink = (e: SseEvent) => void;
export interface TurnOrchestrator { run(req: TurnRequest, emit: EventSink): Promise<TurnResult>; }   // budget created inside

// ── SSE contract ──
export type SseEvent =
  | { event: 'turn.started'; data: { turnId: TurnId; userMessageId: MessageId } }
  | { event: 'progress'; data: { stage: TurnState; text: string } }
  | { event: 'context'; data: { lane: Lane; resolvedDates: Array<{ text: string; localDates: string[] }>; memoryHits: Array<{ messageId: MessageId; localTime: string; excerpt: string }>; decisionIds: DecisionId[] } }
  | { event: 'clarification'; data: { question: string; options: Array<{ label: string; ref: string }> } }
  | { event: 'plan'; data: { entities: string[]; intents: Intent[]; plannedSearches: number } }
  | { event: 'source'; data: { sourceId: SnapshotId; url: string; domain: string; title: string | null; tier: AuthorityTier; freshFetch: boolean; observedAt: Ms; providerPublishedAt: Ms | null } }
  | { event: 'finding'; data: Finding }
  | { event: 'answer.delta'; data: { sentenceIndex: number; text: string } }
  | { event: 'answer.sentence_end'; data: { index: number; status: SentenceStatus | 'pending_judge'; issues: SentenceIssue[] } }
  | { event: 'verification'; data: { index: number; status: SentenceStatus; issues: SentenceIssue[] } }
  | { event: 'answer.completed'; data: { assistantMessageId: MessageId; sentences: Array<Pick<PersistedSentence, 'index' | 'status' | 'issues'>>; citations: SnapshotId[] } }
  | { event: 'warning'; data: { code: 'search_partial' | 'deadline_compacted' | 'analysis_degraded' | 'judge_skipped' | 'entity_cap' | 'sentence_withheld'; text: string } }
  | { event: 'error'; data: { code: string; text: string; recoverable: boolean } }
  | { event: 'turn.completed'; data: { status: TerminalTurnStatus; metrics: Pick<TurnMetrics, 'ttfpMs' | 'ttftMs' | 'ttcMs'> } };

// ── repositories (excerpt; every method takes userId) ──
export interface TurnRepository {
  begin(req: TurnRequest, now: Ms, deadline: Ms): { turnId: TurnId; userMessageId: MessageId } | { existing: TurnId; status: TurnStatus };
  setState(u: UserId, t: TurnId, s: TurnState): void;
  complete(u: UserId, t: TurnId, c: TurnCompletion): void;        // one transaction
  ack(u: UserId, t: TurnId, req: AckRequest, now: Ms): { renderedThrough: number; newlyPresented: number };   // idempotent, monotonic
  recoverRunning(now: Ms): number;
  deleteConversation(u: UserId, c: ConversationId): void;         // §1.1
}
export interface TurnCompletion {
  status: TerminalTurnStatus;
  assistant: { rendered: string; template: string; sentences: PersistedSentence[]; streamedThrough: number; messageStatus: 'complete' | 'interrupted' } | null;
  findings: FindingSet | null;
  assertions: Array<{ findingId: FindingId; sentenceIndex: number; placeholder: string; beliefKey: string | null; renderedText: string; value: NormalizedValue | null; evidenceIds: EvidenceId[] }>;
  baselineEvents: Array<{ assertionId: AssertionId; status: 'reaffirmed' | 'superseded_world_changed' | 'retracted_was_wrong' | 'contested' | 'unverifiable_now' | 'differs_timing_unknown'; reason: string; evidenceIds: EvidenceId[] }>;
  touchedBeliefKeys: string[];
  enrichment: { tags: string[]; entities: EntityMention[]; decisions: UserFact[] };
  analysis: TurnAnalysis | null; context: ResolvedContext | null;
  events: SseEvent[]; metrics: TurnMetrics; errorCode?: string;
}
```

**Allowed combinations of `currentStatus` and `verdict`.** These are enforced by `FindingBuilder` and checked by a unit test, T-FND-01.

| `currentStatus` | Allowed price verdicts (audit) |
|---|---|
| `confirmed` | `changed`, `baseline_incorrect`, `differs_timing_unknown`, `unchanged_confirmed`, `no_evidence_of_change`, `contested` (reason `timing_conflict`) |
| `contested` | `contested` |
| `stale` / `unknown` | `no_evidence_of_change`, `baseline_incorrect` (reason `unsupported_at_time`) |
| `unable_to_verify` | `unable_to_verify` |

For releases, `releases_found` and `none_found` require `currentStatus ≠ unable_to_verify`, and `unable_to_verify` requires `currentStatus = unable_to_verify`.

**Mapping from baseline verdict to assertion event.** These events are written at persist time on the *baseline* assertion.

| Verdict | Assertion event |
|---|---|
| `unchanged_confirmed` | `reaffirmed` |
| `changed` | `superseded_world_changed` |
| `baseline_incorrect` | `retracted_was_wrong` |
| `contested` | `contested` |
| `differs_timing_unknown` | `differs_timing_unknown` |
| `unable_to_verify` | `unverifiable_now` |
| `no_evidence_of_change` | none |

---

## 3. Placeholder grammar and rendering

```
placeholder := "[[" body "]]"
body        := "F" INT                      ; finding current value
             | "F" INT ":baseline"          ; baseline value
             | "F" INT ":verdict"           ; verdict phrase
             | "F" INT ":derived:" INT      ; code-computed derived value
             | "M:" MESSAGE_ID              ; historical message, quoted verbatim
             | "S:" SNAPSHOT_ID             ; source citation only
INT := [1-9][0-9]{0,2}
```

**Parsing and authorisation**
- The parser holds an opening `[[` until it sees `]]`, for at most 64 characters. Past that limit it gives up and flags `malformed_placeholder`, and the fragment is dropped.
- Authorised IDs are: finding ords in the current or reused FindingSet, message IDs in `ResolvedContext.memoryHits`, and snapshot IDs in `FindingSet.sources`.
- A placeholder that parses but isn't authorised gets `unknown_ref` and is dropped.
- A variant that doesn't apply gets `inapplicable_variant` and is dropped: `:baseline` when the finding has no baseline, or `:derived:k` when index `k` is out of range.

**Rendering**

| Placeholder | Rendered as |
|---|---|
| `[[F3]]` | `<amount with symbol> <unit/period phrase> (<plan>[, <arrangement if not list>][, currency not stated]) [n]`. If contested: `listed as A [n] and B [m] — official sources disagree`. If `stale`: `<value> (last seen <date>) [n]` |
| `[[F3:baseline]]` | `<value> as of <local date of presentedAt> [n]` |
| `[[F3:verdict]]` | Fixed template per (verdict, reason), as in the architecture doc §8 table. `changed` with a window renders "changed between `<after>` and `<notAfter>`" |
| `[[F3:derived:0]]` | `<amount> (<formula>)`, e.g. "$2,000/month (20 seats × $100)" |
| `[[M:msg_…]]` | `"<user text>" (<weekday d Mon, HH:mm local>)` |
| `[[S:src_…]]` | `[n]` |

**T3a compatible-verdict sets** (verdict words in the free text of a sentence)

| Phrase family | Requires a `[[F…]]` in the same sentence with |
|---|---|
| raised, increased, went up | `changed` with `direction = up` |
| cut, lowered, reduced, dropped | `changed` with `direction = down` |
| unchanged, same price, no change | `unchanged_confirmed` |
| no sign of a change, no evidence of a change | `unchanged_confirmed` or `no_evidence_of_change` |
| different now, differs | `differs_timing_unknown` or `changed` |
| launched, released, shipped, introduced | `releases_found` with a `launch` or `change` item |
| discontinued, removed, retired | `releases_found` with a `removal` item |
| was wrong, out of date, incorrect | `baseline_incorrect` |

**Global negatives** ("none of them", "no changes", "nothing changed", "all the same") are allowed only when both of these hold:
- every finding's verdict is in {`unchanged_confirmed`, `no_evidence_of_change`, `none_found`};
- if any verdict is `no_evidence_of_change` or `none_found`, the phrase belongs to the "no sign / no evidence" family.

Otherwise the sentence is flagged `unsupported_global_negative`.

**T3a allowlist** (free-text tokens that are never flagged)
- Numerals that appear verbatim in the current user message.
- Line-start list markers.
- Calendar dates equal to a `localDate` in `ResolvedContext.temporal`.
- Weekday names.

**Render-integrity check** (performed for every placeholder)
- Assert that `render(record(ref)) === renderedText`.
- Assert that `ref` is in the authorised set.
- If either fails, flag `render_mismatch` and log an error. This is a renderer bug.
- The test injects a faulty renderer.

---

## 4. Turn Analysis schema notes

These are unchanged from Stage 3:
- Field caps: entities ≤ 8, queries ≤ 3, topicTerms ≤ 8, userFacts ≤ 5.
- `laneHint` is advisory only.
- If the analysis call fails twice, a heuristic fallback produces the analysis and sets `degraded = true`.
