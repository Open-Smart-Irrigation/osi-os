ALTER TABLE jobs ADD COLUMN artifact_quarantine_intent_path TEXT;

CREATE TABLE legacy_blocked_publish_evidence (
  job_id TEXT PRIMARY KEY,
  artifact_staging_path TEXT,
  artifact_quarantine_path TEXT,
  artifact_final_directory TEXT,
  artifact_final_path TEXT,
  artifact_sha256 TEXT,
  artifact_size INTEGER,
  artifact_mtime TEXT,
  checksum_path TEXT,
  checksum_sha256 TEXT,
  manifest_path TEXT,
  manifest_sha256 TEXT,
  verification_path TEXT,
  verification_sha256 TEXT,
  publish_state TEXT NOT NULL CHECK (publish_state = 'blocked'),
  publish_started_at TEXT,
  published_at TEXT,
  publish_blocker_code TEXT,
  publish_blocker_json TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

INSERT INTO legacy_blocked_publish_evidence (
  job_id, artifact_staging_path, artifact_quarantine_path, artifact_final_directory,
  artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path,
  checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256,
  publish_state, publish_started_at, published_at, publish_blocker_code, publish_blocker_json
)
SELECT
  job_id, artifact_staging_path, artifact_quarantine_path, artifact_final_directory,
  artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path,
  checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256,
  publish_state, publish_started_at, published_at, publish_blocker_code, publish_blocker_json
FROM jobs
WHERE publish_state = 'blocked'
  AND NOT (
    artifact_staging_path IS NULL
    AND artifact_quarantine_path IS NULL
    AND artifact_quarantine_intent_path IS NULL
    AND artifact_final_directory IS NULL
    AND artifact_final_path IS NULL
    AND artifact_sha256 IS NOT NULL
    AND artifact_size IS NOT NULL
    AND artifact_mtime IS NOT NULL
    AND checksum_path IS NOT NULL
    AND checksum_sha256 IS NOT NULL
    AND manifest_path IS NOT NULL
    AND manifest_sha256 IS NOT NULL
    AND verification_path IS NOT NULL
    AND verification_sha256 IS NOT NULL
    AND publish_started_at IS NULL
    AND published_at IS NULL
    AND publish_blocker_code IS NOT NULL
    AND publish_blocker_json IS NOT NULL
  );

UPDATE jobs
SET artifact_staging_path = NULL,
    artifact_quarantine_path = NULL,
    artifact_quarantine_intent_path = NULL,
    artifact_final_directory = NULL,
    artifact_final_path = NULL,
    artifact_sha256 = NULL,
    artifact_size = NULL,
    artifact_mtime = NULL,
    checksum_path = NULL,
    checksum_sha256 = NULL,
    manifest_path = NULL,
    manifest_sha256 = NULL,
    verification_path = NULL,
    verification_sha256 = NULL,
    publish_state = 'not_started',
    publish_started_at = NULL,
    published_at = NULL,
    publish_blocker_code = NULL,
    publish_blocker_json = NULL
WHERE job_id IN (SELECT job_id FROM legacy_blocked_publish_evidence);

CREATE TRIGGER legacy_blocked_publish_evidence_update_guard
BEFORE UPDATE ON legacy_blocked_publish_evidence
BEGIN
  SELECT RAISE(ABORT, 'legacy blocked publish evidence is immutable');
END;

CREATE TRIGGER legacy_blocked_publish_evidence_delete_guard
BEFORE DELETE ON legacy_blocked_publish_evidence
BEGIN
  SELECT RAISE(ABORT, 'legacy blocked publish evidence is immutable');
END;

DROP TRIGGER jobs_publish_null_guard;
DROP TRIGGER jobs_publish_null_guard_update;
DROP TRIGGER jobs_publish_guard;
DROP TRIGGER jobs_publish_guard_insert;

CREATE TRIGGER jobs_publish_null_guard
BEFORE INSERT ON jobs
WHEN NEW.publish_state IS NULL AND (NEW.artifact_staging_path IS NOT NULL OR NEW.artifact_quarantine_path IS NOT NULL OR NEW.artifact_quarantine_intent_path IS NOT NULL OR NEW.artifact_final_directory IS NOT NULL OR NEW.artifact_final_path IS NOT NULL OR NEW.artifact_sha256 IS NOT NULL OR NEW.artifact_size IS NOT NULL OR NEW.artifact_mtime IS NOT NULL OR NEW.checksum_path IS NOT NULL OR NEW.checksum_sha256 IS NOT NULL OR NEW.manifest_path IS NOT NULL OR NEW.manifest_sha256 IS NOT NULL OR NEW.verification_path IS NOT NULL OR NEW.verification_sha256 IS NOT NULL OR NEW.publish_started_at IS NOT NULL OR NEW.published_at IS NOT NULL OR NEW.publish_blocker_code IS NOT NULL OR NEW.publish_blocker_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'publish fields require a state'); END;

CREATE TRIGGER jobs_publish_null_guard_update
BEFORE UPDATE OF artifact_staging_path, artifact_quarantine_path, artifact_quarantine_intent_path, artifact_final_directory, artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256, publish_state, publish_started_at, published_at, publish_blocker_code, publish_blocker_json ON jobs
WHEN NEW.publish_state IS NULL AND (NEW.artifact_staging_path IS NOT NULL OR NEW.artifact_quarantine_path IS NOT NULL OR NEW.artifact_quarantine_intent_path IS NOT NULL OR NEW.artifact_final_directory IS NOT NULL OR NEW.artifact_final_path IS NOT NULL OR NEW.artifact_sha256 IS NOT NULL OR NEW.artifact_size IS NOT NULL OR NEW.artifact_mtime IS NOT NULL OR NEW.checksum_path IS NOT NULL OR NEW.checksum_sha256 IS NOT NULL OR NEW.manifest_path IS NOT NULL OR NEW.manifest_sha256 IS NOT NULL OR NEW.verification_path IS NOT NULL OR NEW.verification_sha256 IS NOT NULL OR NEW.publish_started_at IS NOT NULL OR NEW.published_at IS NOT NULL OR NEW.publish_blocker_code IS NOT NULL OR NEW.publish_blocker_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'publish fields require a state'); END;

CREATE TRIGGER jobs_publish_guard
BEFORE UPDATE OF artifact_staging_path, artifact_quarantine_path, artifact_quarantine_intent_path, artifact_final_directory, artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256, publish_state, publish_started_at, published_at, publish_blocker_code, publish_blocker_json ON jobs
WHEN NEW.publish_state IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    (NEW.publish_state = 'not_started' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.checksum_path IS NULL AND NEW.manifest_path IS NULL AND NEW.verification_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'staged' AND NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'publishing' AND NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL AND (NEW.artifact_quarantine_intent_path IS NULL OR NEW.artifact_quarantine_intent_path = '.osi-image-builder/quarantine/' || NEW.job_id) AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'published' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NOT NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'quarantined' AND NEW.artifact_quarantine_path IS NOT NULL AND NEW.artifact_staging_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'blocked' AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_blocker_code IS NOT NULL AND NEW.publish_blocker_json IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NOT (NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_quarantine_path IS NOT NULL))
  ) THEN RAISE(ABORT, 'publish result is incoherent') END;
END;

CREATE TRIGGER jobs_publish_guard_insert
BEFORE INSERT ON jobs
WHEN NEW.publish_state IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    (NEW.publish_state = 'not_started' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.checksum_path IS NULL AND NEW.manifest_path IS NULL AND NEW.verification_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'staged' AND NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'publishing' AND NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL AND (NEW.artifact_quarantine_intent_path IS NULL OR NEW.artifact_quarantine_intent_path = '.osi-image-builder/quarantine/' || NEW.job_id) AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'published' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NOT NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'quarantined' AND NEW.artifact_quarantine_path IS NOT NULL AND NEW.artifact_staging_path IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'blocked' AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_blocker_code IS NOT NULL AND NEW.publish_blocker_json IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_intent_path IS NULL AND NOT (NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_quarantine_path IS NOT NULL))
  ) THEN RAISE(ABORT, 'publish result is incoherent') END;
END;

DROP TRIGGER job_operations_committed_update_guard;
DROP TRIGGER job_operations_manifest_label_guard;
DROP TRIGGER job_operations_manifest_label_guard_update;
DROP TRIGGER job_operations_committed_delete_guard;
DROP INDEX job_operations_identity;
ALTER TABLE job_operations RENAME TO job_operations_legacy;

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
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('passed', 'failed', 'accepted')),
  accepted_disposition TEXT CHECK (accepted_disposition IS NULL OR accepted_disposition = 'expected-rootfs-already-present'),
  evidence_path TEXT,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR (length(evidence_sha256) = 64 AND evidence_sha256 GLOB '[0-9a-f]*' AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE', 'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT', 'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED', 'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH', 'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH', 'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED', 'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED', 'CLEANUP_UNIT_UNEXPECTED_EXIT', 'DOCKER_CONTAINER_ORPHANED', 'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED', 'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED', 'CANCELLED', 'RECOVERY_LOG_GAP')),
  error_json TEXT CHECK (error_json IS NULL OR (json_valid(error_json) = 1 AND json_type(error_json) = 'object')),
  PRIMARY KEY (job_id, operation_id, attempt),
  CONSTRAINT operation_evidence_pair CHECK ((evidence_path IS NULL AND evidence_sha256 IS NULL) OR (evidence_path IS NOT NULL AND evidence_sha256 IS NOT NULL AND outcome IS NOT NULL)),
  CONSTRAINT operation_finished_requires_start CHECK (finished_at IS NULL OR started_at IS NOT NULL),
  CONSTRAINT operation_completed_evidence CHECK (outcome IS NULL OR (finished_at IS NOT NULL AND evidence_path IS NOT NULL AND evidence_sha256 IS NOT NULL)),
  CONSTRAINT operation_exit_signal_exclusive CHECK (NOT (exit_code IS NOT NULL AND signal IS NOT NULL)),
  CONSTRAINT operation_disposition_shape CHECK ((outcome = 'accepted' AND accepted_disposition = 'expected-rootfs-already-present') OR (outcome <> 'accepted' AND accepted_disposition IS NULL) OR (outcome IS NULL AND accepted_disposition IS NULL)),
  CONSTRAINT operation_passed_exit CHECK (outcome <> 'passed' OR (exit_code = 0 AND signal IS NULL)),
  CONSTRAINT operation_passed_timeout CHECK (outcome <> 'passed' OR timed_out = 0),
  CONSTRAINT operation_accepted_result CHECK (outcome <> 'accepted' OR (operation_id = 'activate-target' AND exit_code = 2 AND signal IS NULL AND timed_out = 0 AND error_code IS NULL AND error_json IS NULL)),
  CONSTRAINT operation_success_container CHECK (outcome NOT IN ('passed', 'accepted') OR (
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

INSERT INTO job_operations (
  job_id, operation_id, attempt, argv_hash, argv_json, started_at, finished_at,
  container_id, container_name, container_image_digest, container_label_job_id,
  container_label_manifest_sha, container_mount_json, container_env_json,
  container_security_json, inspection_json, timed_out, lifecycle_phase,
  exit_code, signal, outcome, accepted_disposition, evidence_path,
  evidence_sha256, error_code, error_json
)
SELECT
  job_id, operation_id, attempt, argv_hash, argv_json, started_at, finished_at,
  container_id, container_name, container_image_digest, container_label_job_id,
  container_label_manifest_sha, container_mount_json, container_env_json,
  container_security_json, inspection_json, timed_out, lifecycle_phase,
  exit_code, signal, outcome, NULL, evidence_path, evidence_sha256,
  error_code, error_json
FROM job_operations_legacy;

DROP TABLE job_operations_legacy;
CREATE INDEX job_operations_identity ON job_operations (job_id, operation_id, attempt);

CREATE TRIGGER job_operations_committed_update_guard
BEFORE UPDATE ON job_operations
WHEN OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'committed operation evidence is immutable');
END;

CREATE TRIGGER job_operations_manifest_label_guard
BEFORE INSERT ON job_operations
WHEN NEW.outcome IS NOT NULL AND (NEW.outcome IN ('passed', 'accepted') OR NEW.lifecycle_phase <> 'not_created')
  AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id = NEW.job_id AND NEW.container_label_job_id = NEW.job_id AND NEW.container_label_manifest_sha = jobs.target_manifest_sha256)
BEGIN
  SELECT RAISE(ABORT, 'operation Docker manifest label is invalid');
END;

CREATE TRIGGER job_operations_manifest_label_guard_update
BEFORE UPDATE OF outcome, container_label_job_id, container_label_manifest_sha ON job_operations
WHEN NEW.outcome IS NOT NULL AND (NEW.outcome IN ('passed', 'accepted') OR NEW.lifecycle_phase <> 'not_created')
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
