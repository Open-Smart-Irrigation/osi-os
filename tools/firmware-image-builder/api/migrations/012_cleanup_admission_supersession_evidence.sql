ALTER TABLE cleanup_leases ADD COLUMN expired_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN superseded_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN superseded_by_admission_id TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_status TEXT CHECK (predecessor_status IS NULL OR predecessor_status IN ('admitted', 'claimed', 'failed', 'blocking'));
ALTER TABLE cleanup_leases ADD COLUMN predecessor_claim_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_renew_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_blocker_code TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_blocker_json TEXT;
ALTER TABLE cleanup_leases ADD COLUMN stop_authorization_attempt_id TEXT;
ALTER TABLE cleanup_leases ADD COLUMN stop_authorization_owner TEXT;
ALTER TABLE cleanup_leases ADD COLUMN stop_authorization_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN stop_authorization_expires_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN stop_authorization_state TEXT CHECK (stop_authorization_state IS NULL OR stop_authorization_state IN ('consumed', 'failed', 'orphaned'));
ALTER TABLE cleanup_leases ADD COLUMN unexpected_exit_json TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_stop_authorization_attempt_id TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_stop_authorization_owner TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_stop_authorization_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_stop_authorization_expires_at TEXT;
ALTER TABLE cleanup_leases ADD COLUMN predecessor_stop_authorization_state TEXT CHECK (predecessor_stop_authorization_state IS NULL OR predecessor_stop_authorization_state IN ('consumed', 'failed', 'orphaned'));
ALTER TABLE cleanup_leases ADD COLUMN predecessor_unexpected_exit_json TEXT;

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

CREATE TABLE cleanup_stop_authorizations (
  attempt_id TEXT PRIMARY KEY CHECK (
    length(attempt_id) = 36
    AND substr(attempt_id, 1, 4) = 'sta_'
    AND substr(attempt_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  job_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  request_owner TEXT NOT NULL,
  authorization_owner TEXT NOT NULL,
  authorization_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authorization_at) = authorization_at),
  authorization_expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authorization_expires_at) = authorization_expires_at AND authorization_expires_at > authorization_at),
  unit_name TEXT NOT NULL,
  fence_generation INTEGER NOT NULL CHECK (fence_generation > 0),
  fence_token_hash TEXT NOT NULL CHECK (length(fence_token_hash) = 64 AND fence_token_hash NOT GLOB '*[^0-9a-f]*'),
  predecessor_status TEXT NOT NULL CHECK (predecessor_status IN ('admitted', 'claimed', 'failed', 'blocking')),
  predecessor_owner TEXT NOT NULL,
  predecessor_expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', predecessor_expires_at) = predecessor_expires_at AND predecessor_expires_at <= authorization_at),
  predecessor_claim_at TEXT,
  predecessor_renew_at TEXT,
  predecessor_blocker_code TEXT,
  predecessor_blocker_json TEXT,
  CHECK ((predecessor_blocker_code IS NULL) = (predecessor_blocker_json IS NULL)),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (admission_id) REFERENCES cleanup_leases(admission_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE (admission_id, attempt_no)
);

CREATE TABLE cleanup_stop_authorization_heads (
  admission_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('authorized', 'consumed', 'failed', 'orphaned')),
  authorization_owner TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  outcome_json TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (admission_id) REFERENCES cleanup_leases(admission_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES cleanup_stop_authorizations(attempt_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX cleanup_stop_authorizations_admission ON cleanup_stop_authorizations (admission_id, attempt_no);
CREATE INDEX cleanup_stop_authorizations_expiry ON cleanup_stop_authorizations (authorization_expires_at);

CREATE TRIGGER cleanup_stop_authorizations_immutable_update_guard
BEFORE UPDATE ON cleanup_stop_authorizations
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization attempts are immutable');
END;

CREATE TRIGGER cleanup_stop_authorization_heads_transition_guard
BEFORE UPDATE ON cleanup_stop_authorization_heads
WHEN NEW.admission_id IS NOT OLD.admission_id
  OR NEW.job_id IS NOT OLD.job_id
  OR NOT (OLD.state IN ('failed', 'orphaned') AND NEW.state = 'authorized')
     AND (NEW.attempt_id IS NOT OLD.attempt_id OR NEW.authorization_owner IS NOT OLD.authorization_owner)
  OR OLD.state = 'authorized' AND NEW.state = 'authorized' AND NEW.outcome_json IS NOT OLD.outcome_json
  OR OLD.state IN ('failed', 'orphaned') AND NEW.state IN ('failed', 'orphaned') AND NEW.outcome_json IS NOT OLD.outcome_json
  OR OLD.state IN ('failed', 'orphaned') AND NEW.state = 'authorized' AND NEW.outcome_json IS NOT NULL
  OR NEW.state IN ('consumed', 'failed', 'orphaned') AND NOT EXISTS (
    SELECT 1
    FROM cleanup_leases AS lease
    WHERE lease.admission_id = NEW.admission_id
      AND lease.job_id = NEW.job_id
      AND lease.stop_authorization_attempt_id = NEW.attempt_id
      AND lease.stop_authorization_owner = NEW.authorization_owner
      AND lease.stop_authorization_state = NEW.state
  )
  OR (OLD.state = 'authorized' AND NEW.state NOT IN ('authorized', 'consumed', 'failed', 'orphaned'))
  OR OLD.state IN ('consumed', 'orphaned', 'failed') AND NEW.state NOT IN ('consumed', 'orphaned', 'failed', 'authorized')
  OR OLD.state = 'consumed' AND NEW.state <> 'consumed'
  OR OLD.state IN ('authorized', 'consumed') AND NEW.attempt_id IS NOT OLD.attempt_id AND NOT (OLD.state IN ('failed', 'orphaned') AND NEW.state = 'authorized')
  OR OLD.state = 'consumed' AND NEW.outcome_json IS NOT OLD.outcome_json
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization head transition is incoherent');
END;

CREATE TRIGGER cleanup_stop_authorizations_identity_guard
BEFORE INSERT ON cleanup_stop_authorizations
WHEN NOT EXISTS (
  SELECT 1
  FROM cleanup_leases AS lease
  JOIN jobs AS job ON job.job_id = lease.job_id
  WHERE lease.admission_id = NEW.admission_id
    AND lease.job_id = NEW.job_id
    AND lease.unit_name = NEW.unit_name
    AND lease.fence_generation = NEW.fence_generation
    AND lease.fence_token_hash = NEW.fence_token_hash
    AND lease.status = NEW.predecessor_status
    AND lease.owner = NEW.predecessor_owner
    AND lease.expires_at = NEW.predecessor_expires_at
    AND lease.claim_at IS NEW.predecessor_claim_at
    AND lease.renew_at IS NEW.predecessor_renew_at
    AND lease.blocker_code IS NEW.predecessor_blocker_code
    AND lease.blocker_json IS NEW.predecessor_blocker_json
    AND job.cleanup_admission_id = NEW.admission_id
    AND job.cleanup_fence_generation = NEW.fence_generation
    AND job.cleanup_fence_token_hash = NEW.fence_token_hash
)
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization identity is incoherent');
END;

CREATE TRIGGER cleanup_stop_authorization_head_identity_guard
BEFORE INSERT ON cleanup_stop_authorization_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM cleanup_stop_authorizations AS attempt
  WHERE attempt.attempt_id = NEW.attempt_id
    AND attempt.admission_id = NEW.admission_id
    AND attempt.job_id = NEW.job_id
    AND attempt.authorization_owner = NEW.authorization_owner
)
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization head identity is incoherent');
END;

CREATE TRIGGER cleanup_stop_authorization_head_identity_update_guard
BEFORE UPDATE ON cleanup_stop_authorization_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM cleanup_stop_authorizations AS attempt
  WHERE attempt.attempt_id = NEW.attempt_id
    AND attempt.admission_id = NEW.admission_id
    AND attempt.job_id = NEW.job_id
    AND attempt.authorization_owner = NEW.authorization_owner
)
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization head identity is incoherent');
END;

CREATE TRIGGER cleanup_leases_stop_authorization_columns_guard
BEFORE INSERT ON cleanup_leases
WHEN (NEW.stop_authorization_attempt_id IS NULL AND (
    NEW.stop_authorization_owner IS NOT NULL
    OR NEW.stop_authorization_at IS NOT NULL
    OR NEW.stop_authorization_expires_at IS NOT NULL
    OR NEW.stop_authorization_state IS NOT NULL
  ))
  OR (NEW.stop_authorization_attempt_id IS NOT NULL AND (
    NEW.stop_authorization_owner IS NULL
    OR NEW.stop_authorization_at IS NULL
    OR NEW.stop_authorization_expires_at IS NULL
    OR NEW.stop_authorization_state IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization columns must be complete');
END;

CREATE TRIGGER cleanup_leases_stop_authorization_columns_update_guard
BEFORE UPDATE ON cleanup_leases
WHEN (NEW.stop_authorization_attempt_id IS NULL AND (
    NEW.stop_authorization_owner IS NOT NULL
    OR NEW.stop_authorization_at IS NOT NULL
    OR NEW.stop_authorization_expires_at IS NOT NULL
    OR NEW.stop_authorization_state IS NOT NULL
  ))
  OR (NEW.stop_authorization_attempt_id IS NOT NULL AND (
    NEW.stop_authorization_owner IS NULL
    OR NEW.stop_authorization_at IS NULL
    OR NEW.stop_authorization_expires_at IS NULL
    OR NEW.stop_authorization_state IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization columns must be complete');
END;

CREATE TRIGGER cleanup_leases_stop_authorization_identity_guard
BEFORE UPDATE ON cleanup_leases
WHEN NEW.stop_authorization_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM cleanup_stop_authorizations AS attempt
    WHERE attempt.attempt_id = NEW.stop_authorization_attempt_id
      AND attempt.job_id = NEW.job_id
      AND attempt.admission_id = NEW.admission_id
      AND attempt.unit_name = NEW.unit_name
      AND attempt.fence_generation = NEW.fence_generation
      AND attempt.fence_token_hash = NEW.fence_token_hash
      AND attempt.authorization_owner = NEW.stop_authorization_owner
      AND attempt.authorization_at = NEW.stop_authorization_at
      AND attempt.authorization_expires_at = NEW.stop_authorization_expires_at
      AND attempt.predecessor_status = OLD.status
      AND attempt.predecessor_owner = OLD.owner
      AND attempt.predecessor_expires_at = OLD.expires_at
      AND attempt.predecessor_claim_at IS OLD.claim_at
      AND attempt.predecessor_renew_at IS OLD.renew_at
      AND attempt.predecessor_blocker_code IS OLD.blocker_code
      AND attempt.predecessor_blocker_json IS OLD.blocker_json
      AND EXISTS (
        SELECT 1
        FROM cleanup_stop_authorization_heads AS head
        WHERE head.attempt_id = attempt.attempt_id
          AND head.admission_id = NEW.admission_id
          AND head.job_id = NEW.job_id
          AND (
            (NEW.stop_authorization_state = 'consumed' AND head.state IN ('authorized', 'consumed'))
            OR (NEW.stop_authorization_state = 'failed' AND head.state IN ('authorized', 'failed'))
            OR (NEW.stop_authorization_state = 'orphaned' AND head.state IN ('authorized', 'orphaned'))
          )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization evidence is incoherent');
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
  OR NEW.predecessor_stop_authorization_attempt_id IS NOT NULL
  OR NEW.predecessor_stop_authorization_owner IS NOT NULL
  OR NEW.predecessor_stop_authorization_at IS NOT NULL
  OR NEW.predecessor_stop_authorization_expires_at IS NOT NULL
  OR NEW.predecessor_stop_authorization_state IS NOT NULL
  OR NEW.predecessor_unexpected_exit_json IS NOT NULL
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
    AND NEW.predecessor_stop_authorization_attempt_id IS OLD.stop_authorization_attempt_id
    AND NEW.predecessor_stop_authorization_owner IS OLD.stop_authorization_owner
    AND NEW.predecessor_stop_authorization_at IS OLD.stop_authorization_at
    AND NEW.predecessor_stop_authorization_expires_at IS OLD.stop_authorization_expires_at
    AND NEW.predecessor_stop_authorization_state IS OLD.stop_authorization_state
    AND NEW.predecessor_unexpected_exit_json IS OLD.unexpected_exit_json
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
    AND NEW.claim_at IS OLD.claim_at
    AND NEW.renew_at IS OLD.renew_at
    AND NEW.complete_at IS OLD.complete_at
    AND NEW.handback_at IS OLD.handback_at
    AND NEW.stop_authorization_attempt_id IS OLD.stop_authorization_attempt_id
    AND NEW.stop_authorization_owner IS OLD.stop_authorization_owner
    AND NEW.stop_authorization_at IS OLD.stop_authorization_at
    AND NEW.stop_authorization_expires_at IS OLD.stop_authorization_expires_at
    AND NEW.stop_authorization_state IS OLD.stop_authorization_state
    AND NEW.unexpected_exit_json IS OLD.unexpected_exit_json
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
    OR NEW.stop_authorization_attempt_id IS NOT OLD.stop_authorization_attempt_id
    OR NEW.stop_authorization_owner IS NOT OLD.stop_authorization_owner
    OR NEW.stop_authorization_at IS NOT OLD.stop_authorization_at
    OR NEW.stop_authorization_expires_at IS NOT OLD.stop_authorization_expires_at
    OR NEW.stop_authorization_state IS NOT OLD.stop_authorization_state
    OR NEW.unexpected_exit_json IS NOT OLD.unexpected_exit_json
    OR NEW.predecessor_stop_authorization_attempt_id IS NOT OLD.predecessor_stop_authorization_attempt_id
    OR NEW.predecessor_stop_authorization_owner IS NOT OLD.predecessor_stop_authorization_owner
    OR NEW.predecessor_stop_authorization_at IS NOT OLD.predecessor_stop_authorization_at
    OR NEW.predecessor_stop_authorization_expires_at IS NOT OLD.predecessor_stop_authorization_expires_at
    OR NEW.predecessor_stop_authorization_state IS NOT OLD.predecessor_stop_authorization_state
    OR NEW.predecessor_unexpected_exit_json IS NOT OLD.predecessor_unexpected_exit_json
  )
BEGIN
  SELECT RAISE(ABORT, 'expired cleanup supersession evidence is immutable');
END;
