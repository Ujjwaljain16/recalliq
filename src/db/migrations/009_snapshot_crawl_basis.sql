-- 009_snapshot_crawl_basis: record what a snapshot's freshness rests on. Additive: one column and one trigger;
-- earlier migrations are untouched and snapshots stay immutable (snapshots_immutable still blocks every UPDATE).
--
-- crawl_basis is one of four distinct states (contracts §1.2): confirmed_live (the provider reported, for this
-- result, a successful live crawl), requested_live (a live crawl was requested and the content was sufficient, but
-- nothing per result confirms it), cached, unknown. Only confirmed_live is a confirmation, and it is exactly the
-- state in which fresh_fetch = 1.
--
-- Existing rows: ADD COLUMN gives them the default 'unknown', and they cannot be updated (immutable). A legacy row
-- with fresh_fetch = 1 was marked by a per-result provider marker, so the store reads it back as confirmed_live:
-- the read-time rule is "fresh_fetch = 1 means confirmed_live", and the trigger below stops any NEW row from
-- contradicting it. Legacy fresh_fetch = 0 rows stay 'unknown', which is true of them.
ALTER TABLE source_snapshots ADD COLUMN crawl_basis TEXT NOT NULL DEFAULT 'unknown'
  CHECK (crawl_basis IN ('confirmed_live','requested_live','cached','unknown'));

-- fresh_fetch and crawl_basis may not disagree: a confirmed_live row must be a fresh fetch, and a fresh fetch may
-- not claim to be requested_live or cached. (fresh_fetch = 1 with the default 'unknown' is the legacy shape.)
CREATE TRIGGER snapshots_crawl_basis_consistent BEFORE INSERT ON source_snapshots
WHEN (NEW.crawl_basis = 'confirmed_live' AND NEW.fresh_fetch <> 1)
  OR (NEW.fresh_fetch = 1 AND NEW.crawl_basis IN ('requested_live','cached'))
BEGIN SELECT RAISE(ABORT, 'snapshot crawl_basis contradicts fresh_fetch'); END;
