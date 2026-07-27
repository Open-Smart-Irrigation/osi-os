ALTER TABLE cleanup_leases ADD COLUMN expired_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN superseded_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN superseded_by_admission_id TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_status TEXT CHECK (predecessor_status IS NULL OR predecessor_status IN ('admitted', 'claimed', 'failed', 'blocking'));
ALTER TABLE cleanup_leases ADD COLUMN predecessor_claim_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_renew_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_blocker_code TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_blocker_json TEXT;

CREATE TRIGGER cleanup_leases_supersession_evidence_guard
BEFORE UPDATE OF expired_at, superseded_at, superseded_by_admission_id, predecessor_status,
  predecessor_claim_at, predecessor_renew_at, predecessor_blocker_code, predecessor_blocker_json
ON cleanup_leases
WHEN OLD.expired_at IS NOT NULL AND (
  NEW.expired_at IS NOT OLD.expired_at
  OR NEW.superseded_at IS NOT OLD.superseded_at
  OR NEW.superseded_by_admission_id IS NOT OLD.superseded_by_admission_id
  OR NEW.predecessor_status IS NOT OLD.predecessor_status
  OR NEW.predecessor_claim_at IS NOT OLD.predecessor_claim_at
  OR NEW.predecessor_renew_at IS NOT OLD.predecessor_renew_at
  OR NEW.predecessor_blocker_code IS NOT OLD.predecessor_blocker_code
  OR NEW.predecessor_blocker_json IS NOT OLD.predecessor_blocker_json
)
BEGIN
  SELECT RAISE(ABORT, 'cleanup supersession evidence is immutable');
END;
