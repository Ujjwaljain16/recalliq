-- 002_demo_isolation: implements the demo-isolation proposal (docs/proposals/demo-isolation.md; docs/questions.md, "Demo isolation covers only some tables").
-- Triggers only; no table or column changes. 001 is untouched.
--
-- Requested scope: messages, entities and decisions are no longer accepted with a non-live origin in a
-- `real` database. Two further findings from the same review are included, because fixing the three tables
-- alone would leave a way round: the existing isolation triggers fire on INSERT only (a live row could be
-- relabelled afterwards), and every isolation trigger reads meta.db_mode, which could be updated or deleted.

CREATE TRIGGER messages_no_fixture_in_real BEFORE INSERT ON messages
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live message in real db'); END;

CREATE TRIGGER entities_no_fixture_in_real BEFORE INSERT ON entities
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live entity in real db'); END;

CREATE TRIGGER decisions_no_fixture_in_real BEFORE INSERT ON decisions
WHEN NEW.origin <> 'live' AND (SELECT value FROM meta WHERE key = 'db_mode') = 'real'
BEGIN SELECT RAISE(ABORT, 'non-live decision in real db'); END;

-- Relabelling (messages and source_snapshots are already immutable).
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

-- db_mode itself: if the row is deleted the triggers' comparison becomes NULL and they pass everything.
CREATE TRIGGER meta_db_mode_immutable BEFORE UPDATE ON meta
WHEN OLD.key = 'db_mode'
BEGIN SELECT RAISE(ABORT, 'db_mode is immutable'); END;

CREATE TRIGGER meta_db_mode_undeletable BEFORE DELETE ON meta
WHEN OLD.key = 'db_mode'
BEGIN SELECT RAISE(ABORT, 'db_mode is immutable'); END;
