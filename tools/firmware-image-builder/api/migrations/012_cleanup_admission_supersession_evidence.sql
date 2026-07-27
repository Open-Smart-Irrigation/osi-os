ALTER TABLE cleanup_leases ADD COLUMN expired_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN superseded_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN superseded_by_admission_id TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_status TEXT CHECK (predecessor_status IS NULL OR predecessor_status IN ('admitted', 'claimed', 'failed', 'blocking'));
ALTER TABLE cleanup_leases ADD COLUMN predecessor_claim_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_renew_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_blocker_code TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_blocker_json TEXT;

CREATE TABLE cleanup_credential_reservations (
  job_id TEXT NOT NULL,
  admission_id TEXT PRIMARY KEY CHECK (
    length(admission_id) = 30
    AND substr(admission_id, 1, 4) = 'cln_'
    AND substr(admission_id, 5, 1) BETWEEN '0' AND '7'
    AND substr(admission_id, 6) NOT GLOB '*[^0-9a-hj-km-np-tv-z]*'
  ),
  owner TEXT NOT NULL,
  credential_relative_path TEXT NOT NULL CHECK (credential_relative_path = 'recovery/cleanup-credentials/' || admission_id || '.token'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at AND expires_at > created_at),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX cleanup_credential_reservations_job_path
  ON cleanup_credential_reservations (job_id, credential_relative_path);
CREATE INDEX cleanup_credential_reservations_expiry
  ON cleanup_credential_reservations (expires_at);

CREATE TRIGGER cleanup_credential_reservations_immutable_update_guard
BEFORE UPDATE ON cleanup_credential_reservations
BEGIN
  SELECT RAISE(ABORT, 'cleanup credential reservation is immutable');
END;

CREATE TRIGGER cleanup_leases_admission_id_guard
BEFORE INSERT ON cleanup_leases
WHEN NOT (
  length(NEW.admission_id) = 30
  AND substr(NEW.admission_id, 1, 4) = 'cln_'
  AND substr(NEW.admission_id, 5, 1) BETWEEN '0' AND '7'
  AND substr(NEW.admission_id, 6) NOT GLOB '*[^0-9a-hj-km-np-tv-z]*'
)
BEGIN
  SELECT RAISE(ABORT, 'cleanup admission id is not a lowercase ULID');
END;

CREATE TRIGGER cleanup_leases_admission_id_guard_update
BEFORE UPDATE OF admission_id ON cleanup_leases
WHEN NOT (
  length(NEW.admission_id) = 30
  AND substr(NEW.admission_id, 1, 4) = 'cln_'
  AND substr(NEW.admission_id, 5, 1) BETWEEN '0' AND '7'
  AND substr(NEW.admission_id, 6) NOT GLOB '*[^0-9a-hj-km-np-tv-z]*'
)
BEGIN
  SELECT RAISE(ABORT, 'cleanup admission id is not a lowercase ULID');
END;

CREATE TRIGGER cleanup_leases_supersession_insert_guard
BEFORE INSERT ON cleanup_leases
WHEN NEW.status = 'expired'
  OR NEW.expired_at IS NOT NULL
  OR NEW.superseded_at IS NOT NULL
  OR NEW.superseded_by_admission_id IS NOT NULL
  OR NEW.predecessor_status IS NOT NULL
  OR NEW.predecessor_claim_at IS NOT NULL
  OR NEW.predecessor_renew_at IS NOT NULL
  OR NEW.predecessor_blocker_code IS NOT NULL
  OR NEW.predecessor_blocker_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cleanup supersession evidence must start null');
END;

CREATE TRIGGER cleanup_leases_supersession_transition_guard
BEFORE UPDATE ON cleanup_leases
WHEN OLD.status <> 'expired'
  AND (
    NEW.status = 'expired'
    OR NEW.expired_at IS NOT NULL
    OR NEW.superseded_at IS NOT NULL
    OR NEW.superseded_by_admission_id IS NOT NULL
    OR NEW.predecessor_status IS NOT NULL
    OR NEW.predecessor_claim_at IS NOT NULL
    OR NEW.predecessor_renew_at IS NOT NULL
    OR NEW.predecessor_blocker_code IS NOT NULL
    OR NEW.predecessor_blocker_json IS NOT NULL
  )
  AND NOT (
    NEW.status = 'expired'
    AND OLD.status IN ('admitted', 'claimed', 'failed', 'blocking')
    AND NEW.expired_at IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expired_at) = NEW.expired_at
    AND NEW.superseded_at = NEW.expired_at
    AND NEW.superseded_by_admission_id IS NOT NULL
    AND length(NEW.superseded_by_admission_id) = 30
    AND substr(NEW.superseded_by_admission_id, 1, 4) = 'cln_'
    AND substr(NEW.superseded_by_admission_id, 5, 1) BETWEEN '0' AND '7'
    AND substr(NEW.superseded_by_admission_id, 6) NOT GLOB '*[^0-9a-hj-km-np-tv-z]*'
    AND NEW.superseded_by_admission_id <> OLD.admission_id
    AND NEW.predecessor_status = OLD.status
    AND NEW.predecessor_claim_at IS OLD.claim_at
    AND NEW.predecessor_renew_at IS OLD.renew_at
    AND NEW.predecessor_blocker_code IS OLD.blocker_code
    AND NEW.predecessor_blocker_json IS OLD.blocker_json
    AND NEW.admission_id IS OLD.admission_id
    AND NEW.job_id IS OLD.job_id
    AND NEW.unit_name IS OLD.unit_name
    AND NEW.owner IS OLD.owner
    AND NEW.expires_at IS OLD.expires_at
    AND NEW.credential_relative_path IS OLD.credential_relative_path
    AND NEW.credential_sha256 IS OLD.credential_sha256
    AND NEW.fence_generation IS OLD.fence_generation
    AND NEW.fence_token_hash IS OLD.fence_token_hash
    AND NEW.stale_runner_unit IS OLD.stale_runner_unit
    AND NEW.stale_runner_owner IS OLD.stale_runner_owner
    AND NEW.stale_runner_lease_expires_at IS OLD.stale_runner_lease_expires_at
    AND NEW.stale_state IS OLD.stale_state
    AND NEW.stale_container_id IS OLD.stale_container_id
    AND NEW.stale_container_name IS OLD.stale_container_name
    AND NEW.stale_container_labels_json IS OLD.stale_container_labels_json
    AND NEW.proof_json IS OLD.proof_json
    AND NEW.completion_evidence_path IS OLD.completion_evidence_path
    AND NEW.completion_evidence_sha256 IS OLD.completion_evidence_sha256
    AND NEW.admitted_at IS OLD.admitted_at
    AND NEW.complete_at IS OLD.complete_at
    AND NEW.handback_at IS OLD.handback_at
    AND EXISTS (
      SELECT 1
      FROM cleanup_leases AS replacement
      JOIN jobs AS current_job ON current_job.job_id = replacement.job_id
      WHERE replacement.admission_id = NEW.superseded_by_admission_id
        AND replacement.job_id = OLD.job_id
        AND replacement.status = 'admitted'
        AND current_job.cleanup_admission_id = replacement.admission_id
        AND current_job.cleanup_fence_generation = replacement.fence_generation
        AND current_job.cleanup_fence_token_hash = replacement.fence_token_hash
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'cleanup supersession transition evidence is incoherent');
END;

CREATE TRIGGER cleanup_leases_expired_immutable_guard
BEFORE UPDATE ON cleanup_leases
WHEN OLD.status = 'expired'
  AND (
    NEW.admission_id IS NOT OLD.admission_id
    OR NEW.job_id IS NOT OLD.job_id
    OR NEW.unit_name IS NOT OLD.unit_name
    OR NEW.owner IS NOT OLD.owner
    OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.status IS NOT OLD.status
    OR NEW.credential_relative_path IS NOT OLD.credential_relative_path
    OR NEW.credential_sha256 IS NOT OLD.credential_sha256
    OR NEW.fence_generation IS NOT OLD.fence_generation
    OR NEW.fence_token_hash IS NOT OLD.fence_token_hash
    OR NEW.stale_runner_unit IS NOT OLD.stale_runner_unit
    OR NEW.stale_runner_owner IS NOT OLD.stale_runner_owner
    OR NEW.stale_runner_lease_expires_at IS NOT OLD.stale_runner_lease_expires_at
    OR NEW.stale_state IS NOT OLD.stale_state
    OR NEW.stale_container_id IS NOT OLD.stale_container_id
    OR NEW.stale_container_name IS NOT OLD.stale_container_name
    OR NEW.stale_container_labels_json IS NOT OLD.stale_container_labels_json
    OR NEW.proof_json IS NOT OLD.proof_json
    OR NEW.blocker_code IS NOT OLD.blocker_code
    OR NEW.blocker_json IS NOT OLD.blocker_json
    OR NEW.completion_evidence_path IS NOT OLD.completion_evidence_path
    OR NEW.completion_evidence_sha256 IS NOT OLD.completion_evidence_sha256
    OR NEW.admitted_at IS NOT OLD.admitted_at
    OR NEW.claim_at IS NOT OLD.claim_at
    OR NEW.renew_at IS NOT OLD.renew_at
    OR NEW.complete_at IS NOT OLD.complete_at
    OR NEW.handback_at IS NOT OLD.handback_at
    OR NEW.expired_at IS NOT OLD.expired_at
    OR NEW.superseded_at IS NOT OLD.superseded_at
    OR NEW.superseded_by_admission_id IS NOT OLD.superseded_by_admission_id
    OR NEW.predecessor_status IS NOT OLD.predecessor_status
    OR NEW.predecessor_claim_at IS NOT OLD.predecessor_claim_at
    OR NEW.predecessor_renew_at IS NOT OLD.predecessor_renew_at
    OR NEW.predecessor_blocker_code IS NOT OLD.predecessor_blocker_code
    OR NEW.predecessor_blocker_json IS NOT OLD.predecessor_blocker_json
  )
BEGIN
  SELECT RAISE(ABORT, 'expired cleanup supersession evidence is immutable');
END;
