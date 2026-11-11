-- 003_ownership_consistency: ownership consistency for evidence, findings and assertions (docs/questions.md, "user_id consistency").
-- Triggers only. A row may only reference rows owned by the same user as its owning turn.
--
-- Not covered here: search_requests, decisions, source_snapshots-by-turn, beliefs (later migrations cover some of these).
-- Findings have no user_id column; their owner is their turn's owner, so the check is on what they reference.

-- evidence_statements: the turn, the snapshot and the entity must all belong to the evidence's user.
-- (turn_id is deliberately not a foreign key, so existence is enforced here, at insert time only:
-- evidence may later outlive its turn through privacy deletion.)
CREATE TRIGGER evidence_turn_owner BEFORE INSERT ON evidence_statements
WHEN NEW.user_id IS NOT (SELECT user_id FROM turns WHERE id = NEW.turn_id)
BEGIN SELECT RAISE(ABORT, 'evidence turn owner mismatch'); END;

CREATE TRIGGER evidence_snapshot_owner BEFORE INSERT ON evidence_statements
WHEN NEW.user_id IS NOT (SELECT user_id FROM source_snapshots WHERE id = NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT, 'evidence snapshot owner mismatch'); END;

CREATE TRIGGER evidence_entity_owner BEFORE INSERT ON evidence_statements
WHEN NEW.user_id IS NOT (SELECT user_id FROM entities WHERE id = NEW.entity_id)
BEGIN SELECT RAISE(ABORT, 'evidence entity owner mismatch'); END;

-- findings: the entity (a plain column, not a foreign key) must exist and belong to the turn's user.
CREATE TRIGGER findings_entity_owner BEFORE INSERT ON findings
WHEN (SELECT user_id FROM entities WHERE id = NEW.entity_id) IS NOT (SELECT user_id FROM turns WHERE id = NEW.turn_id)
BEGIN SELECT RAISE(ABORT, 'finding entity owner mismatch'); END;

CREATE TRIGGER findings_references_immutable BEFORE UPDATE OF turn_id, entity_id ON findings
BEGIN SELECT RAISE(ABORT, 'finding references are immutable'); END;

-- assertions: the user must own the turn and the message, and the finding must belong to that same turn.
CREATE TRIGGER assertions_turn_owner BEFORE INSERT ON assertions
WHEN NEW.user_id IS NOT (SELECT user_id FROM turns WHERE id = NEW.turn_id)
BEGIN SELECT RAISE(ABORT, 'assertion turn owner mismatch'); END;

CREATE TRIGGER assertions_message_owner BEFORE INSERT ON assertions
WHEN NEW.user_id IS NOT (SELECT user_id FROM messages WHERE id = NEW.message_id)
BEGIN SELECT RAISE(ABORT, 'assertion message owner mismatch'); END;

CREATE TRIGGER assertions_finding_turn BEFORE INSERT ON assertions
WHEN (SELECT turn_id FROM findings WHERE id = NEW.finding_id) IS NOT NEW.turn_id
BEGIN SELECT RAISE(ABORT, 'assertion finding belongs to another turn'); END;

-- assertion_evidence: an assertion can only cite its own user's evidence.
CREATE TRIGGER assertion_evidence_owner BEFORE INSERT ON assertion_evidence
WHEN (SELECT user_id FROM evidence_statements WHERE id = NEW.evidence_id) IS NOT (SELECT user_id FROM assertions WHERE id = NEW.assertion_id)
BEGIN SELECT RAISE(ABORT, 'assertion evidence owner mismatch'); END;

CREATE TRIGGER assertion_evidence_immutable BEFORE UPDATE ON assertion_evidence
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
