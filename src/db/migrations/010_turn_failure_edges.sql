-- 010_turn_failure_edges: every non-final turn state may move to PERSISTING (ADR-39).
-- Replaces the transition trigger of migration 004 with the extended table; every other lifecycle trigger of 004
-- is left as it is. Migration 004 itself is never edited.
--
-- New edges (7): RECEIVED, RESOLVING_CONTEXT, PLANNING, SEARCHING, EXTRACTING, VERIFYING and RESOLVING_BELIEFS
-- to PERSISTING. A turn that cannot continue (a replay fixture miss, a defect, a failure outside the final
-- write) is finalised through PERSISTING with status 'failed'. COMPLETED and FAILED stay reachable only from
-- PERSISTING.
--
-- The transition list below MUST match src/shared/turn-state-machine.ts. tests/integration/db/turn-lifecycle
-- checks every (from, to) pair against both.

DROP TRIGGER turns_state_transition;

CREATE TRIGGER turns_state_transition BEFORE UPDATE OF state ON turns
WHEN NEW.state IS NOT OLD.state AND NOT (
     (OLD.state = 'RECEIVED'          AND NEW.state IN ('ANALYZING', 'PERSISTING'))
  OR (OLD.state = 'ANALYZING'         AND NEW.state IN ('RESOLVING_CONTEXT', 'PERSISTING'))
  OR (OLD.state = 'RESOLVING_CONTEXT' AND NEW.state IN ('CLARIFYING', 'SYNTHESIZING', 'PLANNING', 'PERSISTING'))
  OR (OLD.state = 'CLARIFYING'        AND NEW.state = 'PERSISTING')
  OR (OLD.state = 'PLANNING'          AND NEW.state IN ('SEARCHING', 'PERSISTING'))
  OR (OLD.state = 'SEARCHING'         AND NEW.state IN ('EXTRACTING', 'RESOLVING_BELIEFS', 'PERSISTING'))
  OR (OLD.state = 'EXTRACTING'        AND NEW.state IN ('VERIFYING', 'PERSISTING'))
  OR (OLD.state = 'VERIFYING'         AND NEW.state IN ('SEARCHING', 'RESOLVING_BELIEFS', 'PERSISTING'))
  OR (OLD.state = 'RESOLVING_BELIEFS' AND NEW.state IN ('SYNTHESIZING', 'PERSISTING'))
  OR (OLD.state = 'SYNTHESIZING'      AND NEW.state IN ('POST_VERIFYING', 'PERSISTING'))
  OR (OLD.state = 'POST_VERIFYING'    AND NEW.state = 'PERSISTING')
  OR (OLD.state = 'PERSISTING'        AND NEW.state IN ('COMPLETED', 'FAILED'))
)
BEGIN SELECT RAISE(ABORT, 'invalid turn state transition'); END;
