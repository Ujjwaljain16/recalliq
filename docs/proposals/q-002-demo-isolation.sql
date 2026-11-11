-- PROPOSAL for review (Q-002). NOT APPLIED: this file is not in src/db/migrations and is not loaded by
-- the migration runner. If accepted it becomes migration 002 (and contracts §1 gains these triggers).
-- Validated only by tests/integration/db/demo-isolation-proposal.test.ts (RUN_PROPOSALS=1).
--
-- Same pattern and error style as the contract's existing *_no_fixture_in_real triggers.

-- 1. The three tables the request names: messages, entities, decisions (INSERT).
CREATE TRIGGER messages_no_fixture_in_real BEFORE INSERT ON messages
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live message in real db'); END;

CREATE TRIGGER entities_no_fixture_in_real BEFORE INSERT ON entities
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live entity in real db'); END;

CREATE TRIGGER decisions_no_fixture_in_real BEFORE INSERT ON decisions
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live decision in real db'); END;

-- 2. Additional findings, not part of the three-table request: the existing triggers fire on INSERT only,
--    so a live row can be relabelled afterwards. (messages and source_snapshots are already immutable.)
CREATE TRIGGER users_no_fixture_in_real_upd BEFORE UPDATE OF kind ON users
WHEN NEW.kind <> 'real' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'fixture user in real db'); END;

CREATE TRIGGER conversations_no_fixture_in_real_upd BEFORE UPDATE OF origin ON conversations
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live conversation in real db'); END;

CREATE TRIGGER entities_no_fixture_in_real_upd BEFORE UPDATE OF origin ON entities
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live entity in real db'); END;

CREATE TRIGGER decisions_no_fixture_in_real_upd BEFORE UPDATE OF origin ON decisions
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live decision in real db'); END;

-- 3. Every trigger above reads meta.db_mode, so the row itself must not be changeable. Today it can be
--    updated to 'demo', or deleted (then the comparison is NULL and every trigger passes everything).
CREATE TRIGGER meta_db_mode_immutable BEFORE UPDATE ON meta
WHEN OLD.key = 'db_mode'
BEGIN SELECT RAISE(ABORT, 'db_mode is immutable'); END;

CREATE TRIGGER meta_db_mode_undeletable BEFORE DELETE ON meta
WHEN OLD.key = 'db_mode'
BEGIN SELECT RAISE(ABORT, 'db_mode is immutable'); END;
