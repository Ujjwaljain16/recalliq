-- 001_init: schema from docs/stage-3-contracts.md §1, unchanged except for one deviation:
-- the contract's two PRAGMA lines (journal_mode = WAL, foreign_keys = ON) are NOT here.
-- They are connection settings, and SQLite refuses to change journal_mode inside the
-- transaction each migration runs in. They are applied by openDatabase() (src/db/connection.ts).
--
-- Required meta rows (schema_version, db_mode, created_at) are written by the migration runner in
-- the same transaction, before any other table is used, because the triggers below read db_mode.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

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
