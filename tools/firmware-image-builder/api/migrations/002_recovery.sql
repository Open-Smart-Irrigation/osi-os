ALTER TABLE jobs ADD COLUMN dispatched_at TEXT;
ALTER TABLE jobs ADD COLUMN runner_unit TEXT CHECK (runner_unit IS NULL OR runner_unit = 'osi-image-builder-runner@' || job_id || '.service');
ALTER TABLE jobs ADD COLUMN runner_lease_owner TEXT;
ALTER TABLE jobs ADD COLUMN runner_lease_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN runner_started_at TEXT;
ALTER TABLE jobs ADD COLUMN runner_finished_at TEXT;
ALTER TABLE jobs ADD COLUMN container_id TEXT;
ALTER TABLE jobs ADD COLUMN container_name TEXT;
ALTER TABLE jobs ADD COLUMN container_image_digest TEXT CHECK (container_image_digest IS NULL OR (length(container_image_digest) = 64 AND container_image_digest GLOB '[0-9a-f]*' AND container_image_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE jobs ADD COLUMN container_label_job_id TEXT;
ALTER TABLE jobs ADD COLUMN container_label_manifest_sha TEXT CHECK (length(container_label_manifest_sha) = 64 AND container_label_manifest_sha GLOB '[0-9a-f]*' AND container_label_manifest_sha NOT GLOB '*[^0-9a-f]*');
ALTER TABLE jobs ADD COLUMN container_labels_json TEXT CHECK (container_labels_json IS NULL OR (json_valid(container_labels_json) = 1 AND json_type(container_labels_json) = 'object'));
ALTER TABLE jobs ADD COLUMN container_mount_json TEXT CHECK (container_mount_json IS NULL OR (json_valid(container_mount_json) = 1 AND json_type(container_mount_json) = 'object'));
ALTER TABLE jobs ADD COLUMN container_env_json TEXT CHECK (container_env_json IS NULL OR (json_valid(container_env_json) = 1 AND json_type(container_env_json) = 'object'));
ALTER TABLE jobs ADD COLUMN container_security_json TEXT CHECK (container_security_json IS NULL OR (json_valid(container_security_json) = 1 AND json_type(container_security_json) = 'object'));
ALTER TABLE jobs ADD COLUMN container_inspection_json TEXT CHECK (container_inspection_json IS NULL OR (json_valid(container_inspection_json) = 1 AND json_type(container_inspection_json) = 'object'));
ALTER TABLE jobs ADD COLUMN container_created_at TEXT;
ALTER TABLE jobs ADD COLUMN container_started_at TEXT;
ALTER TABLE jobs ADD COLUMN container_stopped_at TEXT;
ALTER TABLE jobs ADD COLUMN container_removed_at TEXT;
ALTER TABLE jobs ADD COLUMN container_cleanup_outcome TEXT CHECK (container_cleanup_outcome IS NULL OR container_cleanup_outcome IN ('passed', 'failed', 'blocking'));
ALTER TABLE jobs ADD COLUMN cleanup_generation INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_generation >= 0);
ALTER TABLE jobs ADD COLUMN cleanup_fence_generation INTEGER CHECK (cleanup_fence_generation IS NULL OR cleanup_fence_generation > 0);
ALTER TABLE jobs ADD COLUMN cleanup_fence_token_hash TEXT CHECK (cleanup_fence_token_hash IS NULL OR (length(cleanup_fence_token_hash) = 64 AND cleanup_fence_token_hash GLOB '[0-9a-f]*' AND cleanup_fence_token_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE jobs ADD COLUMN cleanup_admission_id TEXT;
ALTER TABLE jobs ADD COLUMN cleanup_blocker_code TEXT CHECK (cleanup_blocker_code IS NULL OR cleanup_blocker_code IN ('BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE', 'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT', 'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED', 'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH', 'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH', 'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED', 'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED', 'CLEANUP_UNIT_UNEXPECTED_EXIT', 'CLEANUP_UNIT_STOP_FAILED', 'DOCKER_CONTAINER_ORPHANED', 'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED', 'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED', 'CANCELLED', 'RECOVERY_LOG_GAP'));
ALTER TABLE jobs ADD COLUMN cleanup_blocker_json TEXT CHECK (cleanup_blocker_json IS NULL OR (json_valid(cleanup_blocker_json) = 1 AND json_type(cleanup_blocker_json) = 'object'));
ALTER TABLE jobs ADD COLUMN terminal_error_code TEXT CHECK (terminal_error_code IS NULL OR terminal_error_code IN ('BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE', 'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT', 'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED', 'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH', 'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH', 'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED', 'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED', 'CLEANUP_UNIT_UNEXPECTED_EXIT', 'CLEANUP_UNIT_STOP_FAILED', 'DOCKER_CONTAINER_ORPHANED', 'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED', 'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED', 'CANCELLED', 'RECOVERY_LOG_GAP'));
ALTER TABLE jobs ADD COLUMN terminal_error_json TEXT CHECK (terminal_error_json IS NULL OR (json_valid(terminal_error_json) = 1 AND json_type(terminal_error_json) = 'object'));
ALTER TABLE jobs ADD COLUMN terminal_at TEXT;

CREATE UNIQUE INDEX jobs_cleanup_admission ON jobs (cleanup_admission_id) WHERE cleanup_admission_id IS NOT NULL;
CREATE INDEX jobs_recovery ON jobs (state, runner_lease_expires_at, cleanup_fence_generation);

CREATE TABLE cleanup_leases (
  admission_id TEXT PRIMARY KEY CHECK (length(admission_id) = 30 AND substr(admission_id, 1, 4) = 'cln_' AND substr(admission_id, 5) NOT GLOB '' AND substr(admission_id, 5) NOT GLOB '*[^0-9a-hj-km-np-tv-z]*'),
  job_id TEXT NOT NULL,
  unit_name TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'claimed', 'completed', 'failed', 'blocking', 'expired', 'handed_back')),
  credential_relative_path TEXT NOT NULL CHECK (credential_relative_path = 'recovery/cleanup-credentials/' || admission_id || '.token'),
  credential_sha256 TEXT NOT NULL CHECK (length(credential_sha256) = 64 AND credential_sha256 GLOB '[0-9a-f]*' AND credential_sha256 NOT GLOB '*[^0-9a-f]*'),
  fence_generation INTEGER NOT NULL CHECK (fence_generation > 0),
  fence_token_hash TEXT NOT NULL CHECK (length(fence_token_hash) = 64 AND fence_token_hash GLOB '[0-9a-f]*' AND fence_token_hash NOT GLOB '*[^0-9a-f]*'),
  stale_runner_unit TEXT,
  stale_runner_owner TEXT,
  stale_runner_lease_expires_at TEXT,
  stale_state TEXT CHECK (stale_state IS NULL OR stale_state IN ('starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'cancel_requested', 'interrupted')),
  stale_container_id TEXT,
  stale_container_name TEXT,
  stale_container_labels_json TEXT CHECK (stale_container_labels_json IS NULL OR (json_valid(stale_container_labels_json) = 1 AND json_type(stale_container_labels_json) = 'object')),
  proof_json TEXT NOT NULL CHECK (json_valid(proof_json) = 1 AND json_type(proof_json) = 'object'),
  blocker_code TEXT CHECK (blocker_code IS NULL OR blocker_code IN ('BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE', 'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT', 'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED', 'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH', 'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH', 'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED', 'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED', 'CLEANUP_UNIT_UNEXPECTED_EXIT', 'CLEANUP_UNIT_STOP_FAILED', 'DOCKER_CONTAINER_ORPHANED', 'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED', 'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED', 'CANCELLED', 'RECOVERY_LOG_GAP')),
  blocker_json TEXT CHECK (blocker_json IS NULL OR (json_valid(blocker_json) = 1 AND json_type(blocker_json) = 'object')),
  completion_evidence_path TEXT,
  completion_evidence_sha256 TEXT CHECK (completion_evidence_sha256 IS NULL OR (length(completion_evidence_sha256) = 64 AND completion_evidence_sha256 GLOB '[0-9a-f]*' AND completion_evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  admitted_at TEXT NOT NULL,
  claim_at TEXT,
  renew_at TEXT,
  complete_at TEXT,
  handback_at TEXT,
  CHECK (unit_name = 'osi-image-builder-cleanup@' || admission_id || '.service'),
  CHECK ((completion_evidence_path IS NULL AND completion_evidence_sha256 IS NULL) OR (completion_evidence_path IS NOT NULL AND completion_evidence_sha256 IS NOT NULL)),
  CHECK ((blocker_code IS NULL AND blocker_json IS NULL) OR (blocker_code IS NOT NULL AND blocker_json IS NOT NULL)),
  CHECK ((status = 'admitted' AND claim_at IS NULL AND renew_at IS NULL AND complete_at IS NULL AND handback_at IS NULL AND completion_evidence_path IS NULL AND blocker_code IS NULL AND blocker_json IS NULL)
    OR (status = 'claimed' AND claim_at IS NOT NULL AND complete_at IS NULL AND handback_at IS NULL AND completion_evidence_path IS NULL AND blocker_code IS NULL AND blocker_json IS NULL)
    OR (status = 'completed' AND claim_at IS NOT NULL AND complete_at IS NOT NULL AND handback_at IS NULL AND completion_evidence_path IS NOT NULL AND completion_evidence_sha256 IS NOT NULL AND blocker_code IS NULL AND blocker_json IS NULL)
    OR (status = 'handed_back' AND claim_at IS NOT NULL AND complete_at IS NOT NULL AND handback_at IS NOT NULL AND completion_evidence_path IS NOT NULL AND completion_evidence_sha256 IS NOT NULL AND blocker_code IS NULL AND blocker_json IS NULL)
    OR (status IN ('failed', 'blocking') AND complete_at IS NULL AND handback_at IS NULL AND completion_evidence_path IS NULL AND blocker_code IS NOT NULL AND blocker_json IS NOT NULL)
    OR (status = 'expired' AND complete_at IS NULL AND handback_at IS NULL AND completion_evidence_path IS NULL AND blocker_code IS NULL AND blocker_json IS NULL)),
  CHECK (renew_at IS NULL OR claim_at IS NOT NULL),
  CHECK (complete_at IS NULL OR claim_at IS NOT NULL),
  CHECK (handback_at IS NULL OR complete_at IS NOT NULL),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX cleanup_leases_job ON cleanup_leases (job_id, status, fence_generation);
CREATE INDEX cleanup_leases_expiry ON cleanup_leases (status, expires_at);
CREATE UNIQUE INDEX cleanup_leases_fence_identity ON cleanup_leases (job_id, fence_generation);
CREATE UNIQUE INDEX cleanup_leases_fence_token_identity ON cleanup_leases (job_id, fence_token_hash);

CREATE TRIGGER jobs_fence_guard
BEFORE INSERT ON jobs
WHEN NEW.cleanup_fence_generation IS NOT NULL OR NEW.cleanup_fence_token_hash IS NOT NULL OR NEW.cleanup_admission_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    NEW.cleanup_fence_generation IS NOT NULL AND NEW.cleanup_fence_token_hash IS NOT NULL AND NEW.cleanup_admission_id IS NOT NULL
    AND NEW.cleanup_fence_generation = NEW.cleanup_generation AND NEW.cleanup_fence_generation > 0
    AND EXISTS (SELECT 1 FROM cleanup_leases AS lease
      WHERE lease.job_id = NEW.job_id AND lease.admission_id = NEW.cleanup_admission_id
        AND lease.fence_generation = NEW.cleanup_fence_generation AND lease.fence_token_hash = NEW.cleanup_fence_token_hash
        AND lease.status <> 'handed_back')
  ) THEN RAISE(ABORT, 'invalid cleanup fence') END;
END;

CREATE TRIGGER jobs_fence_guard_update
BEFORE UPDATE OF cleanup_generation, cleanup_fence_generation, cleanup_fence_token_hash, cleanup_admission_id ON jobs
WHEN NEW.cleanup_fence_generation IS NOT NULL OR NEW.cleanup_fence_token_hash IS NOT NULL OR NEW.cleanup_admission_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    NEW.cleanup_fence_generation IS NOT NULL AND NEW.cleanup_fence_token_hash IS NOT NULL AND NEW.cleanup_admission_id IS NOT NULL
    AND NEW.cleanup_fence_generation = NEW.cleanup_generation AND NEW.cleanup_fence_generation > 0
    AND EXISTS (SELECT 1 FROM cleanup_leases AS lease
      WHERE lease.job_id = NEW.job_id AND lease.admission_id = NEW.cleanup_admission_id
        AND lease.fence_generation = NEW.cleanup_fence_generation AND lease.fence_token_hash = NEW.cleanup_fence_token_hash
        AND lease.status <> 'handed_back')
  ) THEN RAISE(ABORT, 'invalid cleanup fence') END;
END;

CREATE TRIGGER cleanup_leases_fence_update_guard
BEFORE UPDATE ON cleanup_leases
WHEN EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id = OLD.job_id AND jobs.cleanup_admission_id = OLD.admission_id AND jobs.cleanup_fence_generation = OLD.fence_generation AND jobs.cleanup_fence_token_hash = OLD.fence_token_hash)
  AND (NEW.job_id <> OLD.job_id OR NEW.admission_id <> OLD.admission_id OR NEW.fence_generation <> OLD.fence_generation OR NEW.fence_token_hash <> OLD.fence_token_hash)
BEGIN
  SELECT RAISE(ABORT, 'cleanup lease is linked by an active job fence');
END;

CREATE TRIGGER cleanup_leases_fence_delete_guard
BEFORE DELETE ON cleanup_leases
WHEN EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id = OLD.job_id AND jobs.cleanup_admission_id = OLD.admission_id AND jobs.cleanup_fence_generation = OLD.fence_generation AND jobs.cleanup_fence_token_hash = OLD.fence_token_hash)
BEGIN
  SELECT RAISE(ABORT, 'cleanup lease is linked by an active job fence');
END;

CREATE TRIGGER cleanup_leases_identity_guard
BEFORE UPDATE OF admission_id, job_id, fence_generation, fence_token_hash ON cleanup_leases
WHEN NEW.admission_id <> OLD.admission_id OR NEW.job_id <> OLD.job_id OR NEW.fence_generation <> OLD.fence_generation OR NEW.fence_token_hash <> OLD.fence_token_hash
BEGIN
  SELECT RAISE(ABORT, 'cleanup lease fence identity is immutable');
END;

CREATE TRIGGER cleanup_leases_status_guard
BEFORE INSERT ON cleanup_leases
WHEN NEW.status <> 'admitted' AND NEW.status <> 'expired'
BEGIN
  SELECT CASE WHEN NEW.claim_at IS NULL AND NEW.status NOT IN ('failed', 'blocking') THEN RAISE(ABORT, 'cleanup status requires claim') END;
END;

CREATE TRIGGER cleanup_leases_status_guard_update
BEFORE UPDATE ON cleanup_leases
WHEN NEW.status <> 'admitted' AND NEW.status <> 'expired'
BEGIN
  SELECT CASE WHEN NEW.status IN ('completed', 'handed_back') AND (NEW.claim_at IS NULL OR NEW.complete_at IS NULL) THEN RAISE(ABORT, 'cleanup status timestamps are incomplete') END;
  SELECT CASE WHEN NEW.status = 'handed_back' AND EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id = NEW.job_id AND jobs.cleanup_admission_id = NEW.admission_id AND jobs.cleanup_fence_generation = NEW.fence_generation AND jobs.cleanup_fence_token_hash = NEW.fence_token_hash) THEN RAISE(ABORT, 'handback requires clearing the active fence') END;
END;

CREATE TRIGGER jobs_cleanup_generation_guard
BEFORE UPDATE OF cleanup_generation ON jobs
WHEN NEW.cleanup_generation < OLD.cleanup_generation
BEGIN
  SELECT RAISE(ABORT, 'cleanup generation is monotonic');
END;

CREATE TRIGGER jobs_cleanup_blocker_guard
BEFORE INSERT ON jobs
WHEN (NEW.cleanup_blocker_code IS NULL) <> (NEW.cleanup_blocker_json IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'cleanup blocker evidence is incomplete');
END;

CREATE TRIGGER jobs_cleanup_blocker_guard_update
BEFORE UPDATE OF cleanup_blocker_code, cleanup_blocker_json ON jobs
WHEN (NEW.cleanup_blocker_code IS NULL) <> (NEW.cleanup_blocker_json IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'cleanup blocker evidence is incomplete');
END;

CREATE TRIGGER jobs_runner_lease_guard
BEFORE INSERT ON jobs
WHEN NOT ((NEW.runner_unit IS NULL AND NEW.runner_lease_owner IS NULL AND NEW.runner_lease_expires_at IS NULL)
  OR (NEW.runner_unit = 'osi-image-builder-runner@' || NEW.job_id || '.service' AND NEW.runner_lease_owner IS NULL AND NEW.runner_lease_expires_at IS NULL)
  OR (NEW.runner_unit = 'osi-image-builder-runner@' || NEW.job_id || '.service' AND NEW.runner_lease_owner IS NOT NULL AND NEW.runner_lease_owner <> '' AND NEW.runner_lease_expires_at IS NOT NULL AND NEW.runner_lease_expires_at <> ''))
  OR (NEW.runner_started_at IS NOT NULL AND NEW.runner_unit IS NULL)
  OR (NEW.runner_finished_at IS NOT NULL AND NEW.runner_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runner lease evidence is incomplete');
END;

CREATE TRIGGER jobs_runner_lease_guard_update
BEFORE UPDATE OF runner_unit, runner_lease_owner, runner_lease_expires_at, runner_started_at, runner_finished_at ON jobs
WHEN NOT ((NEW.runner_unit IS NULL AND NEW.runner_lease_owner IS NULL AND NEW.runner_lease_expires_at IS NULL)
  OR (NEW.runner_unit = 'osi-image-builder-runner@' || NEW.job_id || '.service' AND NEW.runner_lease_owner IS NULL AND NEW.runner_lease_expires_at IS NULL)
  OR (NEW.runner_unit = 'osi-image-builder-runner@' || NEW.job_id || '.service' AND NEW.runner_lease_owner IS NOT NULL AND NEW.runner_lease_owner <> '' AND NEW.runner_lease_expires_at IS NOT NULL AND NEW.runner_lease_expires_at <> ''))
  OR (NEW.runner_started_at IS NOT NULL AND NEW.runner_unit IS NULL)
  OR (NEW.runner_finished_at IS NOT NULL AND NEW.runner_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runner lease evidence is incomplete');
END;

CREATE TRIGGER jobs_terminal_guard
BEFORE INSERT ON jobs
WHEN (NEW.state IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND (
    NEW.terminal_at IS NULL
    OR (NEW.state = 'succeeded' AND (NEW.terminal_error_code IS NOT NULL OR NEW.terminal_error_json IS NOT NULL))
    OR (NEW.state IN ('failed', 'cancelled', 'interrupted') AND (NEW.terminal_error_code IS NULL OR NEW.terminal_error_json IS NULL))
  )) OR (NEW.state NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND (NEW.terminal_at IS NOT NULL OR NEW.terminal_error_code IS NOT NULL OR NEW.terminal_error_json IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'terminal state evidence is incoherent');
END;

CREATE TRIGGER jobs_terminal_guard_update
BEFORE UPDATE OF state, terminal_at, terminal_error_code, terminal_error_json ON jobs
WHEN (NEW.state IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND (
    NEW.terminal_at IS NULL
    OR (NEW.state = 'succeeded' AND (NEW.terminal_error_code IS NOT NULL OR NEW.terminal_error_json IS NOT NULL))
    OR (NEW.state IN ('failed', 'cancelled', 'interrupted') AND (NEW.terminal_error_code IS NULL OR NEW.terminal_error_json IS NULL))
  )) OR (NEW.state NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND (NEW.terminal_at IS NOT NULL OR NEW.terminal_error_code IS NOT NULL OR NEW.terminal_error_json IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'terminal state evidence is incoherent');
END;

CREATE TRIGGER jobs_container_guard
BEFORE INSERT ON jobs
WHEN NOT (
  (NEW.container_id IS NULL AND NEW.container_name IS NULL AND NEW.container_image_digest IS NULL AND NEW.container_label_job_id IS NULL
    AND NEW.container_label_manifest_sha IS NULL AND NEW.container_labels_json IS NULL AND NEW.container_mount_json IS NULL
    AND NEW.container_env_json IS NULL AND NEW.container_security_json IS NULL AND NEW.container_inspection_json IS NULL
    AND NEW.container_created_at IS NULL AND NEW.container_started_at IS NULL AND NEW.container_stopped_at IS NULL
    AND NEW.container_removed_at IS NULL AND NEW.container_cleanup_outcome IS NULL)
  OR
  (NEW.container_id IS NOT NULL AND NEW.container_name IS NOT NULL AND NEW.container_image_digest IS NOT NULL
    AND NEW.container_label_job_id = NEW.job_id AND NEW.container_label_manifest_sha = NEW.target_manifest_sha256
    AND NEW.container_labels_json IS NOT NULL AND json_valid(NEW.container_labels_json) = 1 AND json_type(NEW.container_labels_json) = 'object'
    AND json_type(NEW.container_labels_json, '$.org.osi.image-builder.job-id') = 'text'
    AND json_extract(NEW.container_labels_json, '$.org.osi.image-builder.job-id') = NEW.job_id
    AND json_type(NEW.container_labels_json, '$.org.osi.image-builder.manifest-sha') = 'text'
    AND json_extract(NEW.container_labels_json, '$.org.osi.image-builder.manifest-sha') = NEW.target_manifest_sha256
    AND (SELECT COUNT(*) FROM json_each(NEW.container_labels_json)) = 2
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.container_labels_json) WHERE key NOT IN ('org.osi.image-builder.job-id', 'org.osi.image-builder.manifest-sha'))
    AND NEW.container_mount_json IS NOT NULL AND NEW.container_env_json IS NOT NULL AND NEW.container_security_json IS NOT NULL
    AND NEW.container_inspection_json IS NOT NULL AND NEW.container_created_at IS NOT NULL
    AND (NEW.container_started_at IS NULL OR NEW.container_started_at >= NEW.container_created_at)
    AND (NEW.container_stopped_at IS NULL OR (NEW.container_started_at IS NOT NULL AND NEW.container_stopped_at >= NEW.container_started_at))
    AND (NEW.container_removed_at IS NULL OR (NEW.container_removed_at >= NEW.container_created_at AND (NEW.container_started_at IS NULL OR (NEW.container_stopped_at IS NOT NULL AND NEW.container_removed_at >= NEW.container_stopped_at))))
    AND (NEW.container_cleanup_outcome IS NULL OR (NEW.container_cleanup_outcome = 'passed' AND NEW.container_removed_at IS NOT NULL)
      OR (NEW.container_cleanup_outcome IN ('failed', 'blocking') AND NEW.container_removed_at IS NULL))
    AND (NEW.container_removed_at IS NULL OR COALESCE(NEW.container_cleanup_outcome = 'passed', 0)))
)
BEGIN
  SELECT RAISE(ABORT, 'container identity and lifecycle evidence is incomplete');
END;

CREATE TRIGGER jobs_container_guard_update
BEFORE UPDATE OF container_id, container_name, container_image_digest, container_label_job_id, container_label_manifest_sha,
  container_labels_json, container_mount_json, container_env_json, container_security_json, container_inspection_json,
  container_created_at, container_started_at, container_stopped_at, container_removed_at, container_cleanup_outcome ON jobs
WHEN NOT (
  (NEW.container_id IS NULL AND NEW.container_name IS NULL AND NEW.container_image_digest IS NULL AND NEW.container_label_job_id IS NULL
    AND NEW.container_label_manifest_sha IS NULL AND NEW.container_labels_json IS NULL AND NEW.container_mount_json IS NULL
    AND NEW.container_env_json IS NULL AND NEW.container_security_json IS NULL AND NEW.container_inspection_json IS NULL
    AND NEW.container_created_at IS NULL AND NEW.container_started_at IS NULL AND NEW.container_stopped_at IS NULL
    AND NEW.container_removed_at IS NULL AND NEW.container_cleanup_outcome IS NULL)
  OR
  (NEW.container_id IS NOT NULL AND NEW.container_name IS NOT NULL AND NEW.container_image_digest IS NOT NULL
    AND NEW.container_label_job_id = NEW.job_id AND NEW.container_label_manifest_sha = NEW.target_manifest_sha256
    AND NEW.container_labels_json IS NOT NULL AND json_valid(NEW.container_labels_json) = 1 AND json_type(NEW.container_labels_json) = 'object'
    AND json_type(NEW.container_labels_json, '$.org.osi.image-builder.job-id') = 'text'
    AND json_extract(NEW.container_labels_json, '$.org.osi.image-builder.job-id') = NEW.job_id
    AND json_type(NEW.container_labels_json, '$.org.osi.image-builder.manifest-sha') = 'text'
    AND json_extract(NEW.container_labels_json, '$.org.osi.image-builder.manifest-sha') = NEW.target_manifest_sha256
    AND (SELECT COUNT(*) FROM json_each(NEW.container_labels_json)) = 2
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.container_labels_json) WHERE key NOT IN ('org.osi.image-builder.job-id', 'org.osi.image-builder.manifest-sha'))
    AND NEW.container_mount_json IS NOT NULL AND NEW.container_env_json IS NOT NULL AND NEW.container_security_json IS NOT NULL
    AND NEW.container_inspection_json IS NOT NULL AND NEW.container_created_at IS NOT NULL
    AND (NEW.container_started_at IS NULL OR NEW.container_started_at >= NEW.container_created_at)
    AND (NEW.container_stopped_at IS NULL OR (NEW.container_started_at IS NOT NULL AND NEW.container_stopped_at >= NEW.container_started_at))
    AND (NEW.container_removed_at IS NULL OR (NEW.container_removed_at >= NEW.container_created_at AND (NEW.container_started_at IS NULL OR (NEW.container_stopped_at IS NOT NULL AND NEW.container_removed_at >= NEW.container_stopped_at))))
    AND (NEW.container_cleanup_outcome IS NULL OR (NEW.container_cleanup_outcome = 'passed' AND NEW.container_removed_at IS NOT NULL)
      OR (NEW.container_cleanup_outcome IN ('failed', 'blocking') AND NEW.container_removed_at IS NULL))
    AND (NEW.container_removed_at IS NULL OR COALESCE(NEW.container_cleanup_outcome = 'passed', 0)))
)
BEGIN
  SELECT RAISE(ABORT, 'container identity and lifecycle evidence is incomplete');
END;
