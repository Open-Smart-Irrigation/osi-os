CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  filename TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 GLOB '[0-9a-f]*' AND sha256 NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_json TEXT CHECK (request_json IS NULL OR (json_valid(request_json) = 1 AND json_type(request_json) = 'object')),
  source_remote TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  expected_sha TEXT NOT NULL CHECK (length(expected_sha) = 40 AND expected_sha GLOB '[0-9a-f]*' AND expected_sha NOT GLOB '*[^0-9a-f]*'),
  pinned_sha TEXT NOT NULL CHECK (length(pinned_sha) = 40 AND pinned_sha GLOB '[0-9a-f]*' AND pinned_sha NOT GLOB '*[^0-9a-f]*'),
  target_id TEXT NOT NULL CHECK (target_id IN ('rpi-5', 'rpi-2')),
  root_id TEXT NOT NULL,
  target_manifest_sha256 TEXT NOT NULL CHECK (length(target_manifest_sha256) = 64 AND target_manifest_sha256 GLOB '[0-9a-f]*' AND target_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_commit_time TEXT NOT NULL,
  source_author TEXT NOT NULL,
  source_subject TEXT NOT NULL,
  preflight_sha TEXT CHECK (preflight_sha IS NULL OR (length(preflight_sha) = 40 AND preflight_sha GLOB '[0-9a-f]*' AND preflight_sha NOT GLOB '*[^0-9a-f]*')),
  preflight_checked_at TEXT,
  preflight_expires_at TEXT,
  accepted_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  current_stage TEXT CHECK (current_stage IS NULL OR current_stage IN ('preflight', 'source', 'release-gates', 'frontend', 'target-setup', 'feeds', 'config', 'build', 'verify', 'publish')),
  queue_state TEXT NOT NULL CHECK (queue_state IN ('queued', 'dispatched', 'released', 'cancelled', 'complete')),
  queue_position INTEGER CHECK (queue_position IS NULL OR queue_position >= 0),
  cancel_requested_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_branch = branch),
  CHECK (source_ref = 'refs/remotes/origin/' || branch),
  CHECK (expected_sha = pinned_sha),
  CHECK ((preflight_sha IS NULL AND preflight_checked_at IS NULL AND preflight_expires_at IS NULL)
    OR (preflight_sha = pinned_sha AND preflight_checked_at IS NOT NULL AND preflight_expires_at IS NOT NULL))
);

CREATE TABLE queue_entries (
  job_id TEXT PRIMARY KEY,
  fifo_seq INTEGER NOT NULL UNIQUE CHECK (fifo_seq >= 0),
  enqueued_at TEXT NOT NULL,
  claimed_at TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE job_stages (
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('preflight', 'source', 'release-gates', 'frontend', 'target-setup', 'feeds', 'config', 'build', 'verify', 'publish')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('running', 'passed', 'failed', 'cancelled', 'interrupted')),
  started_at TEXT,
  finished_at TEXT,
  evidence_path TEXT,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR (length(evidence_sha256) = 64 AND evidence_sha256 GLOB '[0-9a-f]*' AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE', 'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT', 'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED', 'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH', 'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH', 'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED', 'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED', 'CLEANUP_UNIT_UNEXPECTED_EXIT', 'CLEANUP_UNIT_STOP_FAILED', 'DOCKER_CONTAINER_ORPHANED', 'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED', 'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED', 'CANCELLED', 'RECOVERY_LOG_GAP')),
  error_json TEXT CHECK (error_json IS NULL OR (json_valid(error_json) = 1 AND json_type(error_json) = 'object')),
  PRIMARY KEY (job_id, stage),
  CHECK ((evidence_path IS NULL AND evidence_sha256 IS NULL) OR (evidence_path IS NOT NULL AND evidence_sha256 IS NOT NULL)),
  CHECK (finished_at IS NULL OR started_at IS NOT NULL),
  CHECK ((outcome IS NULL AND started_at IS NULL AND finished_at IS NULL AND evidence_path IS NULL AND evidence_sha256 IS NULL AND error_code IS NULL AND error_json IS NULL)
    OR (outcome IS NOT NULL AND ((outcome = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND evidence_path IS NULL AND evidence_sha256 IS NULL AND error_code IS NULL AND error_json IS NULL)
      OR (outcome = 'passed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND evidence_path IS NOT NULL AND evidence_sha256 IS NOT NULL AND error_code IS NULL AND error_json IS NULL)
      OR (outcome IN ('failed', 'cancelled', 'interrupted') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND evidence_path IS NOT NULL AND evidence_sha256 IS NOT NULL AND error_code IS NOT NULL AND error_json IS NOT NULL)))),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE job_operations (
  job_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (operation_id IN ('activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config', 'build-image', 'verify-image', 'verify-profile-parity', 'verify-chameleon', 'verify-db-schema', 'verify-sync-flow', 'verify-strega', 'verify-communication', 'check-mqtt-topics', 'frontend-install', 'frontend-test', 'frontend-typecheck', 'frontend-build', 'mirror-gui')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  argv_hash TEXT NOT NULL CHECK (length(argv_hash) = 64 AND argv_hash GLOB '[0-9a-f]*' AND argv_hash NOT GLOB '*[^0-9a-f]*'),
  argv_json TEXT NOT NULL CHECK (json_valid(argv_json) = 1 AND json_type(argv_json) = 'array'),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  container_id TEXT,
  container_name TEXT,
  container_image_digest TEXT CHECK (container_image_digest IS NULL OR (length(container_image_digest) = 64 AND container_image_digest GLOB '[0-9a-f]*' AND container_image_digest NOT GLOB '*[^0-9a-f]*')),
  container_label_job_id TEXT,
  container_label_manifest_sha TEXT CHECK (container_label_manifest_sha IS NULL OR (length(container_label_manifest_sha) = 64 AND container_label_manifest_sha GLOB '[0-9a-f]*' AND container_label_manifest_sha NOT GLOB '*[^0-9a-f]*')),
  container_mount_json TEXT CHECK (container_mount_json IS NULL OR (json_valid(container_mount_json) = 1 AND json_type(container_mount_json) = 'object')),
  container_env_json TEXT CHECK (container_env_json IS NULL OR (json_valid(container_env_json) = 1 AND json_type(container_env_json) = 'object')),
  container_security_json TEXT CHECK (container_security_json IS NULL OR (json_valid(container_security_json) = 1 AND json_type(container_security_json) = 'object')),
  inspection_json TEXT CHECK (inspection_json IS NULL OR (json_valid(inspection_json) = 1 AND json_type(inspection_json) = 'object')),
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0, 1)),
  lifecycle_phase TEXT NOT NULL DEFAULT 'not_created' CHECK (lifecycle_phase IN ('not_created', 'created', 'started', 'stopped', 'removed')),
  exit_code INTEGER CHECK (exit_code IS NULL OR exit_code >= 0),
  signal TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('passed', 'failed')),
  evidence_path TEXT,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR (length(evidence_sha256) = 64 AND evidence_sha256 GLOB '[0-9a-f]*' AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE', 'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT', 'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED', 'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH', 'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH', 'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED', 'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED', 'CLEANUP_UNIT_UNEXPECTED_EXIT', 'CLEANUP_UNIT_STOP_FAILED', 'DOCKER_CONTAINER_ORPHANED', 'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED', 'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED', 'CANCELLED', 'RECOVERY_LOG_GAP')),
  error_json TEXT CHECK (error_json IS NULL OR (json_valid(error_json) = 1 AND json_type(error_json) = 'object')),
  PRIMARY KEY (job_id, operation_id, attempt),
  CONSTRAINT operation_evidence_pair CHECK ((evidence_path IS NULL AND evidence_sha256 IS NULL) OR (evidence_path IS NOT NULL AND evidence_sha256 IS NOT NULL AND outcome IS NOT NULL)),
  CONSTRAINT operation_finished_requires_start CHECK (finished_at IS NULL OR started_at IS NOT NULL),
  CONSTRAINT operation_completed_evidence CHECK (outcome IS NULL OR (finished_at IS NOT NULL AND evidence_path IS NOT NULL AND evidence_sha256 IS NOT NULL)),
  CONSTRAINT operation_exit_signal_exclusive CHECK (NOT (exit_code IS NOT NULL AND signal IS NOT NULL)),
  CONSTRAINT operation_passed_exit CHECK (outcome <> 'passed' OR (exit_code = 0 AND signal IS NULL)),
  CONSTRAINT operation_passed_timeout CHECK (outcome <> 'passed' OR timed_out = 0),
  CONSTRAINT operation_passed_container CHECK (outcome <> 'passed' OR (
    lifecycle_phase IN ('started', 'stopped', 'removed')
    AND container_id IS NOT NULL AND container_name IS NOT NULL AND container_image_digest IS NOT NULL
    AND container_label_job_id = job_id AND container_label_manifest_sha IS NOT NULL
    AND container_mount_json IS NOT NULL AND container_env_json IS NOT NULL AND container_security_json IS NOT NULL AND inspection_json IS NOT NULL
    AND error_code IS NULL AND error_json IS NULL
  )),
  CONSTRAINT operation_failed_error_evidence CHECK (outcome <> 'failed' OR (error_code IS NOT NULL AND error_json IS NOT NULL)),
  CONSTRAINT operation_failed_container_shape CHECK (outcome <> 'failed' OR (
    (lifecycle_phase = 'not_created' AND container_id IS NULL AND container_name IS NULL AND container_image_digest IS NULL
      AND container_label_job_id IS NULL AND container_label_manifest_sha IS NULL AND container_mount_json IS NULL AND container_env_json IS NULL
      AND container_security_json IS NULL AND inspection_json IS NULL)
    OR (lifecycle_phase <> 'not_created' AND container_id IS NOT NULL AND container_name IS NOT NULL AND container_image_digest IS NOT NULL
      AND container_label_job_id = job_id AND container_label_manifest_sha IS NOT NULL
      AND container_mount_json IS NOT NULL AND container_env_json IS NOT NULL AND container_security_json IS NOT NULL AND inspection_json IS NOT NULL)
  )),
  CONSTRAINT operation_failed_result CHECK (outcome <> 'failed' OR (timed_out = 1 OR exit_code IS NULL OR exit_code <> 0 OR signal IS NOT NULL)),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX queue_entries_fifo ON queue_entries (fifo_seq, job_id);
CREATE INDEX job_stages_job ON job_stages (job_id, stage);
CREATE INDEX job_operations_identity ON job_operations (job_id, operation_id, attempt);

CREATE TRIGGER job_operations_committed_update_guard
BEFORE UPDATE ON job_operations
WHEN OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'committed operation evidence is immutable');
END;

CREATE TRIGGER job_operations_manifest_label_guard
BEFORE INSERT ON job_operations
WHEN NEW.outcome IS NOT NULL AND (NEW.outcome = 'passed' OR NEW.lifecycle_phase <> 'not_created')
  AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id = NEW.job_id AND NEW.container_label_job_id = NEW.job_id AND NEW.container_label_manifest_sha = jobs.target_manifest_sha256)
BEGIN
  SELECT RAISE(ABORT, 'operation Docker manifest label is invalid');
END;

CREATE TRIGGER job_operations_manifest_label_guard_update
BEFORE UPDATE OF outcome, container_label_job_id, container_label_manifest_sha ON job_operations
WHEN NEW.outcome IS NOT NULL AND (NEW.outcome = 'passed' OR NEW.lifecycle_phase <> 'not_created')
  AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id = NEW.job_id AND NEW.container_label_job_id = NEW.job_id AND NEW.container_label_manifest_sha = jobs.target_manifest_sha256)
BEGIN
  SELECT RAISE(ABORT, 'operation Docker manifest label is invalid');
END;

CREATE TRIGGER job_operations_committed_delete_guard
BEFORE DELETE ON job_operations
WHEN OLD.outcome IS NOT NULL OR OLD.evidence_sha256 IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'committed operation evidence is immutable');
END;

CREATE TRIGGER jobs_request_immutable_guard
BEFORE UPDATE OF request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha,
  target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject,
  preflight_sha, preflight_checked_at, preflight_expires_at, accepted_at ON jobs
BEGIN
  SELECT RAISE(ABORT, 'accepted job identity is immutable');
END;
