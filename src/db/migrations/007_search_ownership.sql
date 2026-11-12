-- 007_search_ownership: ownership consistency for `search_requests`, `search_results` and the snapshot links
-- (docs/questions.md, "user_id consistency"), in the same change as the first code that writes them (the search executor).
-- Triggers only; 001 to 006 are untouched.
--
-- source_snapshots has no turn, so it cannot be checked against one. Its ownership is enforced at its links:
-- evidence (migration 003) and search_results (below). Its columns are already all immutable (snapshots_immutable,
-- migration 001: BEFORE UPDATE with no column list), which is what "identity columns immutable" asks for.

-- search_requests: the user must own the turn; entity_id, if set, must be an existing entity of the same user.
CREATE TRIGGER search_requests_turn_owner BEFORE INSERT ON search_requests
WHEN NEW.user_id IS NOT (SELECT user_id FROM turns WHERE id = NEW.turn_id)
BEGIN SELECT RAISE(ABORT, 'search request turn owner mismatch'); END;

CREATE TRIGGER search_requests_entity_owner BEFORE INSERT ON search_requests
WHEN NEW.entity_id IS NOT NULL
 AND NEW.user_id IS NOT (SELECT user_id FROM entities WHERE id = NEW.entity_id)
BEGIN SELECT RAISE(ABORT, 'search request entity owner mismatch'); END;

-- Identity and provenance never change. (status, error_code, latency_ms and cost_usd are outcome columns.)
CREATE TRIGGER search_requests_identity_immutable
BEFORE UPDATE OF id, turn_id, user_id, entity_id, intent, round, provider, request_json, started_at ON search_requests
BEGIN SELECT RAISE(ABORT, 'search request identity is immutable'); END;

-- search_results: the request and the snapshot must exist and belong to the same user.
CREATE TRIGGER search_results_owner BEFORE INSERT ON search_results
WHEN (SELECT user_id FROM search_requests WHERE id = NEW.search_request_id) IS NULL
  OR (SELECT user_id FROM source_snapshots WHERE id = NEW.snapshot_id) IS NULL
  OR (SELECT user_id FROM search_requests WHERE id = NEW.search_request_id)
     IS NOT (SELECT user_id FROM source_snapshots WHERE id = NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT, 'search result owner mismatch'); END;

-- Links are append-only (cascading deletes from privacy deletion are not UPDATEs and keep working).
CREATE TRIGGER search_results_immutable BEFORE UPDATE ON search_results
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
