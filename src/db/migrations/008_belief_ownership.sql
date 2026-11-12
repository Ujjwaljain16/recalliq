-- 008_belief_ownership: ownership consistency for `beliefs` and `belief_history`, added together with the
-- first code that writes them (src/belief). Additive: triggers only; earlier migrations are untouched.
--
-- Beliefs are derived (L4) and rebuildable, so these triggers guard writes, not history: a belief belongs to
-- one user, its entity and every evidence id it cites must be that user's, and its identity never changes.
-- The JSON id lists are checked with json_each, which SQLite evaluates inside a trigger (tested per trigger).
-- An id that does not exist counts as a mismatch, so a belief can never cite evidence that is not there.

-- beliefs: the user must exist, and the entity must be the same user's.
CREATE TRIGGER beliefs_user_exists BEFORE INSERT ON beliefs
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'belief user does not exist'); END;

CREATE TRIGGER beliefs_entity_owner BEFORE INSERT ON beliefs
WHEN NEW.user_id IS NOT (SELECT user_id FROM entities WHERE id = NEW.entity_id)
BEGIN SELECT RAISE(ABORT, 'belief entity owner mismatch'); END;

-- beliefs: every cited winning evidence row must exist and belong to the same user.
CREATE TRIGGER beliefs_evidence_owner BEFORE INSERT ON beliefs
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.winning_evidence) j
  WHERE (SELECT user_id FROM evidence_statements WHERE id = j.value) IS NOT NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'belief evidence owner mismatch'); END;

CREATE TRIGGER beliefs_evidence_owner_upd BEFORE UPDATE OF winning_evidence ON beliefs
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.winning_evidence) j
  WHERE (SELECT user_id FROM evidence_statements WHERE id = j.value) IS NOT NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'belief evidence owner mismatch'); END;

-- beliefs: identity never changes (value, status and signals are what a recomputation updates).
CREATE TRIGGER beliefs_identity_immutable
BEFORE UPDATE OF user_id, belief_key, key_json, entity_id ON beliefs
BEGIN SELECT RAISE(ABORT, 'belief identity is immutable'); END;

-- belief_history: the user must exist; a non-null turn must be the same user's; cited evidence likewise.
CREATE TRIGGER belief_history_user_exists BEFORE INSERT ON belief_history
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'belief history user does not exist'); END;

CREATE TRIGGER belief_history_turn_owner BEFORE INSERT ON belief_history
WHEN NEW.turn_id IS NOT NULL AND NEW.user_id IS NOT (SELECT user_id FROM turns WHERE id = NEW.turn_id)
BEGIN SELECT RAISE(ABORT, 'belief history turn owner mismatch'); END;

CREATE TRIGGER belief_history_evidence_owner BEFORE INSERT ON belief_history
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.evidence_ids) j
  WHERE (SELECT user_id FROM evidence_statements WHERE id = j.value) IS NOT NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'belief history evidence owner mismatch'); END;
