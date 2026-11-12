-- 006_decision_ownership: ownership consistency for `decisions` and `decision_entities` (docs/questions.md, "user_id consistency"), in the same
-- change as the first code that writes them (write-time enrichment). Triggers only; 001 to 005 are untouched.
--
-- A decision belongs to one user, one conversation and one message of that conversation; a decision it
-- supersedes, and an entity it is linked to, must belong to the same user.

-- decisions: the user must own the conversation and the message, and the message must be in that conversation.
CREATE TRIGGER decisions_conversation_owner BEFORE INSERT ON decisions
WHEN NEW.user_id IS NOT (SELECT user_id FROM conversations WHERE id = NEW.conversation_id)
BEGIN SELECT RAISE(ABORT, 'decision conversation owner mismatch'); END;

CREATE TRIGGER decisions_message_owner BEFORE INSERT ON decisions
WHEN NEW.user_id IS NOT (SELECT user_id FROM messages WHERE id = NEW.message_id)
BEGIN SELECT RAISE(ABORT, 'decision message owner mismatch'); END;

CREATE TRIGGER decisions_message_conversation BEFORE INSERT ON decisions
WHEN NEW.conversation_id IS NOT (SELECT conversation_id FROM messages WHERE id = NEW.message_id)
BEGIN SELECT RAISE(ABORT, 'decision message belongs to another conversation'); END;

-- A superseded decision must be the same user's. Checked on update as well, but only for a non-null value:
-- the foreign key's ON DELETE SET NULL rewrites supersedes_id to NULL and must keep working.
CREATE TRIGGER decisions_supersedes_owner BEFORE INSERT ON decisions
WHEN NEW.supersedes_id IS NOT NULL
 AND (SELECT user_id FROM decisions WHERE id = NEW.supersedes_id) IS NOT NEW.user_id
BEGIN SELECT RAISE(ABORT, 'decision supersedes another user''s decision'); END;

CREATE TRIGGER decisions_supersedes_owner_upd BEFORE UPDATE OF supersedes_id ON decisions
WHEN NEW.supersedes_id IS NOT NULL
 AND (SELECT user_id FROM decisions WHERE id = NEW.supersedes_id) IS NOT NEW.user_id
BEGIN SELECT RAISE(ABORT, 'decision supersedes another user''s decision'); END;

-- Identity and provenance never change. (supersedes_id is left out: SET NULL rewrites it.)
CREATE TRIGGER decisions_identity_immutable
BEFORE UPDATE OF id, user_id, conversation_id, message_id, user_quote, created_at ON decisions
BEGIN SELECT RAISE(ABORT, 'decision identity is immutable'); END;

-- decision_entities: a decision can only be linked to its own user's entity; links are append-only.
CREATE TRIGGER decision_entities_owner BEFORE INSERT ON decision_entities
WHEN (SELECT user_id FROM decisions WHERE id = NEW.decision_id) IS NOT (SELECT user_id FROM entities WHERE id = NEW.entity_id)
BEGIN SELECT RAISE(ABORT, 'decision entity owner mismatch'); END;

CREATE TRIGGER decision_entities_immutable BEFORE UPDATE ON decision_entities
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
