-- 004_turn_lifecycle: database-level enforcement of the turn state machine (docs/stage-3-architecture.md §4).
-- Triggers only. Resolves Q-006 at the database level: the contract's partial unique index
-- `turns_one_running` (001) already allows at most one running turn per conversation, and the repository
-- begins turns in an IMMEDIATE transaction; this migration adds the lifecycle rules around it.
--
-- The transition list below MUST match src/shared/turn-state-machine.ts. tests/integration/db/turn-lifecycle
-- checks every (from, to) pair against both, so the two cannot drift silently.
--
-- `state` is where the pipeline is; `status` is the outcome. COMPLETED means persistence succeeded (whatever
-- the outcome); FAILED means persistence itself failed. A turn recovered after a crash keeps the state it was in.

-- A new turn starts running, in RECEIVED, with no finish time; a finished one must carry a finish time.
CREATE TRIGGER turns_new_turn_shape BEFORE INSERT ON turns
WHEN (NEW.status = 'running' AND (NEW.state <> 'RECEIVED' OR NEW.finished_at IS NOT NULL))
  OR (NEW.status <> 'running' AND NEW.finished_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid new turn: running turns start in RECEIVED unfinished, finished turns need finished_at'); END;

CREATE TRIGGER turns_state_valid BEFORE INSERT ON turns
WHEN NEW.state NOT IN ('RECEIVED','ANALYZING','RESOLVING_CONTEXT','CLARIFYING','PLANNING','SEARCHING','EXTRACTING',
                       'VERIFYING','RESOLVING_BELIEFS','SYNTHESIZING','POST_VERIFYING','PERSISTING','COMPLETED','FAILED')
BEGIN SELECT RAISE(ABORT, 'invalid turn state'); END;

-- Identity never changes. (assistant_message_id and retry_of_turn_id are left out: foreign-key SET NULL
-- actions rewrite them when the rows they point at are deleted.)
CREATE TRIGGER turns_identity_immutable
BEFORE UPDATE OF conversation_id, user_id, user_message_id, idempotency_key, started_at, deadline_at ON turns
BEGIN SELECT RAISE(ABORT, 'turn identity is immutable'); END;

-- A finished turn is final: its outcome and results cannot change.
CREATE TRIGGER turns_finished_is_final
BEFORE UPDATE OF status, state, lane, analysis_json, context_json, events_json, metrics_json, error_code, finished_at ON turns
WHEN OLD.status <> 'running'
BEGIN SELECT RAISE(ABORT, 'turn is already finished'); END;

-- State changes follow the state machine (architecture §4). A same-state update is not a transition.
CREATE TRIGGER turns_state_transition BEFORE UPDATE OF state ON turns
WHEN NEW.state IS NOT OLD.state AND NOT (
     (OLD.state = 'RECEIVED'          AND NEW.state = 'ANALYZING')
  OR (OLD.state = 'ANALYZING'         AND NEW.state IN ('RESOLVING_CONTEXT', 'PERSISTING'))
  OR (OLD.state = 'RESOLVING_CONTEXT' AND NEW.state IN ('CLARIFYING', 'SYNTHESIZING', 'PLANNING'))
  OR (OLD.state = 'CLARIFYING'        AND NEW.state = 'PERSISTING')
  OR (OLD.state = 'PLANNING'          AND NEW.state = 'SEARCHING')
  OR (OLD.state = 'SEARCHING'         AND NEW.state IN ('EXTRACTING', 'RESOLVING_BELIEFS'))
  OR (OLD.state = 'EXTRACTING'        AND NEW.state = 'VERIFYING')
  OR (OLD.state = 'VERIFYING'         AND NEW.state IN ('SEARCHING', 'RESOLVING_BELIEFS'))
  OR (OLD.state = 'RESOLVING_BELIEFS' AND NEW.state = 'SYNTHESIZING')
  OR (OLD.state = 'SYNTHESIZING'      AND NEW.state IN ('POST_VERIFYING', 'PERSISTING'))
  OR (OLD.state = 'POST_VERIFYING'    AND NEW.state = 'PERSISTING')
  OR (OLD.state = 'PERSISTING'        AND NEW.state IN ('COMPLETED', 'FAILED'))
)
BEGIN SELECT RAISE(ABORT, 'invalid turn state transition'); END;

-- Status and state must agree where they can: a running turn is never in a final state, and a finished
-- turn always has a finish time.
CREATE TRIGGER turns_running_not_final BEFORE UPDATE OF state, status ON turns
WHEN NEW.status = 'running' AND NEW.state IN ('COMPLETED', 'FAILED')
BEGIN SELECT RAISE(ABORT, 'a running turn cannot be in a final state'); END;

CREATE TRIGGER turns_finished_has_time BEFORE UPDATE OF status, finished_at ON turns
WHEN NEW.status <> 'running' AND NEW.finished_at IS NULL
BEGIN SELECT RAISE(ABORT, 'a finished turn needs finished_at'); END;
