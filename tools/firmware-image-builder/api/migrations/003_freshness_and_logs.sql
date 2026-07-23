ALTER TABLE jobs ADD COLUMN artifact_staging_path TEXT;
ALTER TABLE jobs ADD COLUMN artifact_quarantine_path TEXT;
ALTER TABLE jobs ADD COLUMN artifact_final_directory TEXT;
ALTER TABLE jobs ADD COLUMN artifact_final_path TEXT;
ALTER TABLE jobs ADD COLUMN artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR (length(artifact_sha256) = 64 AND artifact_sha256 GLOB '[0-9a-f]*' AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE jobs ADD COLUMN artifact_size INTEGER CHECK (artifact_size IS NULL OR artifact_size >= 0);
ALTER TABLE jobs ADD COLUMN artifact_mtime TEXT;
ALTER TABLE jobs ADD COLUMN checksum_path TEXT;
ALTER TABLE jobs ADD COLUMN checksum_sha256 TEXT CHECK (checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 GLOB '[0-9a-f]*' AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE jobs ADD COLUMN manifest_path TEXT;
ALTER TABLE jobs ADD COLUMN manifest_sha256 TEXT CHECK (manifest_sha256 IS NULL OR (length(manifest_sha256) = 64 AND manifest_sha256 GLOB '[0-9a-f]*' AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE jobs ADD COLUMN verification_path TEXT;
ALTER TABLE jobs ADD COLUMN verification_sha256 TEXT CHECK (verification_sha256 IS NULL OR (length(verification_sha256) = 64 AND verification_sha256 GLOB '[0-9a-f]*' AND verification_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE jobs ADD COLUMN publish_state TEXT CHECK (publish_state IS NULL OR publish_state IN ('not_started', 'staged', 'publishing', 'published', 'quarantined', 'blocked'));
ALTER TABLE jobs ADD COLUMN publish_started_at TEXT;
ALTER TABLE jobs ADD COLUMN published_at TEXT;
ALTER TABLE jobs ADD COLUMN publish_blocker_code TEXT CHECK (publish_blocker_code IS NULL OR publish_blocker_code IN ('BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE', 'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE', 'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT', 'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED', 'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH', 'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH', 'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED', 'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED', 'CLEANUP_UNIT_UNEXPECTED_EXIT', 'CLEANUP_UNIT_STOP_FAILED', 'DOCKER_CONTAINER_ORPHANED', 'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED', 'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED', 'CANCELLED', 'RECOVERY_LOG_GAP'));
ALTER TABLE jobs ADD COLUMN publish_blocker_json TEXT CHECK (publish_blocker_json IS NULL OR (json_valid(publish_blocker_json) = 1 AND json_type(publish_blocker_json) = 'object'));
ALTER TABLE jobs ADD COLUMN freshness_status TEXT CHECK (freshness_status IS NULL OR freshness_status IN ('fresh', 'advanced', 'unknown'));
ALTER TABLE jobs ADD COLUMN freshness_observed_sha TEXT CHECK (freshness_observed_sha IS NULL OR (length(freshness_observed_sha) = 40 AND freshness_observed_sha GLOB '[0-9a-f]*' AND freshness_observed_sha NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE jobs ADD COLUMN newer_source_available INTEGER CHECK (newer_source_available IS NULL OR newer_source_available IN (0, 1));
ALTER TABLE jobs ADD COLUMN freshness_requested_at TEXT;
ALTER TABLE jobs ADD COLUMN freshness_checked_at TEXT;
ALTER TABLE jobs ADD COLUMN freshness_error_code TEXT CHECK (freshness_error_code IS NULL OR freshness_error_code = 'FRESHNESS_UNKNOWN');
ALTER TABLE jobs ADD COLUMN freshness_error_json TEXT CHECK (freshness_error_json IS NULL OR (json_valid(freshness_error_json) = 1 AND json_type(freshness_error_json) = 'object'));
ALTER TABLE jobs ADD COLUMN freshness_error_evidence_path TEXT;
ALTER TABLE jobs ADD COLUMN freshness_error_evidence_sha256 TEXT CHECK (freshness_error_evidence_sha256 IS NULL OR (length(freshness_error_evidence_sha256) = 64 AND freshness_error_evidence_sha256 GLOB '[0-9a-f]*' AND freshness_error_evidence_sha256 NOT GLOB '*[^0-9a-f]*'));

CREATE TABLE job_log_generations (
  job_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('runner', 'docker')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  path TEXT NOT NULL CHECK (path LIKE 'logs/%' AND path NOT LIKE '%..%'),
  started_at TEXT NOT NULL,
  sealed_at TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 GLOB '[0-9a-f]*' AND sha256 NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (job_id, stream, generation),
  CHECK ((sealed_at IS NULL AND sha256 IS NULL) OR (sealed_at IS NOT NULL AND sha256 IS NOT NULL)),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE job_events (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('enqueue', 'cancellation_requested', 'dispatch', 'state', 'stage', 'operation', 'container', 'artifact', 'publish', 'terminal', 'cleanup_admission', 'cleanup_claim', 'cleanup_renew', 'cleanup_complete', 'cleanup', 'recovery', 'freshness', 'log', 'log_orphan_tail', 'log-gap', 'log-truncated')),
  state TEXT CHECK (state IS NULL OR state IN ('queued', 'starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  stage TEXT CHECK (stage IS NULL OR stage IN ('preflight', 'source', 'release-gates', 'frontend', 'target-setup', 'feeds', 'config', 'build', 'verify', 'publish')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1 AND json_type(payload_json) = 'object'),
  at TEXT NOT NULL,
  stream TEXT CHECK (stream IS NULL OR stream IN ('runner', 'docker')),
  file_generation INTEGER CHECK (file_generation IS NULL OR file_generation >= 0),
  byte_offset INTEGER CHECK (byte_offset IS NULL OR byte_offset >= 0),
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  partial INTEGER CHECK (partial IS NULL OR partial IN (0, 1)),
  PRIMARY KEY (job_id, seq),
  CHECK ((stream IS NULL AND file_generation IS NULL AND byte_offset IS NULL AND byte_length IS NULL AND partial IS NULL)
    OR (stream IS NOT NULL AND file_generation IS NOT NULL AND byte_offset IS NOT NULL AND byte_length IS NOT NULL AND partial IS NOT NULL
      AND byte_length > 0 AND byte_offset <= 9223372036854775807 - byte_length
      AND event_type IN ('log', 'log_orphan_tail', 'log-gap', 'log-truncated'))),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (job_id, stream, file_generation) REFERENCES job_log_generations(job_id, stream, generation) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX job_events_sequence ON job_events (job_id, seq);
CREATE INDEX job_events_log_range ON job_events (job_id, stream, file_generation, byte_offset);
CREATE INDEX job_log_generations_active ON job_log_generations (job_id, stream, generation, sealed_at);

CREATE TRIGGER job_log_generations_append_guard
BEFORE INSERT ON job_log_generations
WHEN NEW.generation <> COALESCE((SELECT MAX(generation) + 1 FROM job_log_generations WHERE job_id = NEW.job_id AND stream = NEW.stream), 0)
BEGIN
  SELECT RAISE(ABORT, 'log generations must be contiguous');
END;

CREATE TRIGGER job_log_generations_immutable_guard
BEFORE UPDATE ON job_log_generations
WHEN NEW.job_id <> OLD.job_id OR NEW.stream <> OLD.stream OR NEW.generation <> OLD.generation OR NEW.path <> OLD.path OR NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'log generation identity is immutable');
END;

CREATE TRIGGER job_log_generations_size_guard
BEFORE UPDATE OF size_bytes ON job_log_generations
WHEN NEW.size_bytes < OLD.size_bytes OR OLD.sealed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'log generation size is not append-only');
END;

CREATE TRIGGER job_log_generations_seal_guard
BEFORE UPDATE OF sealed_at, sha256 ON job_log_generations
WHEN (OLD.sealed_at IS NOT NULL)
  OR (NEW.sealed_at IS NOT NULL AND (OLD.sealed_at IS NOT NULL OR NEW.sha256 IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'log generation seal is immutable');
END;

CREATE TRIGGER job_events_append_guard
BEFORE INSERT ON job_events
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) + 1 FROM job_events WHERE job_id = NEW.job_id), 0)
  OR (NEW.stream IS NOT NULL AND (
    NEW.byte_offset <> COALESCE((SELECT MAX(byte_offset + byte_length) FROM job_events WHERE job_id = NEW.job_id AND stream = NEW.stream AND file_generation = NEW.file_generation), 0)
    OR NEW.byte_offset + NEW.byte_length > (SELECT size_bytes FROM job_log_generations WHERE job_id = NEW.job_id AND stream = NEW.stream AND generation = NEW.file_generation)
    OR EXISTS (SELECT 1 FROM job_log_generations WHERE job_id = NEW.job_id AND stream = NEW.stream AND generation = NEW.file_generation AND sealed_at IS NOT NULL)))
BEGIN
  SELECT RAISE(ABORT, 'job events must append within an open log generation');
END;

CREATE TRIGGER job_events_immutable_update_guard
BEFORE UPDATE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job events are immutable');
END;

CREATE TRIGGER jobs_freshness_guard
BEFORE INSERT ON jobs
WHEN NEW.freshness_status IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    NEW.freshness_requested_at IS NOT NULL AND NEW.freshness_checked_at IS NOT NULL
    AND ((NEW.freshness_status = 'fresh' AND NEW.freshness_observed_sha = NEW.pinned_sha AND NEW.newer_source_available = 0 AND NEW.freshness_error_code IS NULL AND NEW.freshness_error_json IS NULL AND NEW.freshness_error_evidence_path IS NULL AND NEW.freshness_error_evidence_sha256 IS NULL)
      OR (NEW.freshness_status = 'advanced' AND NEW.freshness_observed_sha IS NOT NULL AND NEW.freshness_observed_sha <> NEW.pinned_sha AND NEW.newer_source_available = 1 AND NEW.freshness_error_code IS NULL AND NEW.freshness_error_json IS NULL AND NEW.freshness_error_evidence_path IS NULL AND NEW.freshness_error_evidence_sha256 IS NULL)
      OR (NEW.freshness_status = 'unknown' AND NEW.freshness_observed_sha IS NULL AND NEW.newer_source_available = 0 AND NEW.freshness_error_code = 'FRESHNESS_UNKNOWN' AND NEW.freshness_error_json IS NOT NULL AND NEW.freshness_error_evidence_path IS NOT NULL AND NEW.freshness_error_evidence_sha256 IS NOT NULL))
  ) THEN RAISE(ABORT, 'freshness result is incoherent') END;
END;

CREATE TRIGGER jobs_freshness_guard_update
BEFORE UPDATE OF freshness_status, freshness_observed_sha, newer_source_available, freshness_checked_at, freshness_error_code, freshness_error_json, freshness_error_evidence_path, freshness_error_evidence_sha256 ON jobs
WHEN NEW.freshness_status IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    NEW.freshness_requested_at IS NOT NULL AND NEW.freshness_checked_at IS NOT NULL
    AND ((NEW.freshness_status = 'fresh' AND NEW.freshness_observed_sha = NEW.pinned_sha AND NEW.newer_source_available = 0 AND NEW.freshness_error_code IS NULL AND NEW.freshness_error_json IS NULL AND NEW.freshness_error_evidence_path IS NULL AND NEW.freshness_error_evidence_sha256 IS NULL)
      OR (NEW.freshness_status = 'advanced' AND NEW.freshness_observed_sha IS NOT NULL AND NEW.freshness_observed_sha <> NEW.pinned_sha AND NEW.newer_source_available = 1 AND NEW.freshness_error_code IS NULL AND NEW.freshness_error_json IS NULL AND NEW.freshness_error_evidence_path IS NULL AND NEW.freshness_error_evidence_sha256 IS NULL)
      OR (NEW.freshness_status = 'unknown' AND NEW.freshness_observed_sha IS NULL AND NEW.newer_source_available = 0 AND NEW.freshness_error_code = 'FRESHNESS_UNKNOWN' AND NEW.freshness_error_json IS NOT NULL AND NEW.freshness_error_evidence_path IS NOT NULL AND NEW.freshness_error_evidence_sha256 IS NOT NULL))
  ) THEN RAISE(ABORT, 'freshness result is incoherent') END;
END;

CREATE TRIGGER jobs_freshness_null_guard
BEFORE INSERT ON jobs
WHEN NEW.freshness_status IS NULL AND (NEW.freshness_observed_sha IS NOT NULL OR NEW.newer_source_available IS NOT NULL OR NEW.freshness_checked_at IS NOT NULL OR NEW.freshness_error_code IS NOT NULL OR NEW.freshness_error_json IS NOT NULL OR NEW.freshness_error_evidence_path IS NOT NULL OR NEW.freshness_error_evidence_sha256 IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'freshness result requires a status');
END;

CREATE TRIGGER jobs_freshness_null_guard_update
BEFORE UPDATE OF freshness_status, freshness_observed_sha, newer_source_available, freshness_requested_at, freshness_checked_at, freshness_error_code, freshness_error_json, freshness_error_evidence_path, freshness_error_evidence_sha256 ON jobs
WHEN NEW.freshness_status IS NULL AND (NEW.freshness_observed_sha IS NOT NULL OR NEW.newer_source_available IS NOT NULL OR NEW.freshness_checked_at IS NOT NULL OR NEW.freshness_error_code IS NOT NULL OR NEW.freshness_error_json IS NOT NULL OR NEW.freshness_error_evidence_path IS NOT NULL OR NEW.freshness_error_evidence_sha256 IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'freshness result requires a status');
END;

CREATE TRIGGER jobs_freshness_timestamp_guard
BEFORE UPDATE OF freshness_requested_at, freshness_checked_at ON jobs
WHEN (OLD.freshness_requested_at IS NOT NULL AND NEW.freshness_requested_at <> OLD.freshness_requested_at)
  OR (OLD.freshness_checked_at IS NOT NULL AND NEW.freshness_checked_at <> OLD.freshness_checked_at)
BEGIN
  SELECT RAISE(ABORT, 'freshness timestamps are immutable');
END;

CREATE TRIGGER jobs_freshness_timestamp_guard_update
BEFORE UPDATE OF freshness_requested_at, freshness_checked_at ON jobs
WHEN OLD.freshness_status IS NOT NULL AND (NEW.freshness_requested_at IS NULL OR NEW.freshness_checked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'freshness timestamps cannot be cleared');
END;

CREATE TRIGGER jobs_publish_null_guard
BEFORE INSERT ON jobs
WHEN NEW.publish_state IS NULL AND (NEW.artifact_staging_path IS NOT NULL OR NEW.artifact_quarantine_path IS NOT NULL OR NEW.artifact_final_directory IS NOT NULL OR NEW.artifact_final_path IS NOT NULL OR NEW.artifact_sha256 IS NOT NULL OR NEW.artifact_size IS NOT NULL OR NEW.artifact_mtime IS NOT NULL OR NEW.checksum_path IS NOT NULL OR NEW.checksum_sha256 IS NOT NULL OR NEW.manifest_path IS NOT NULL OR NEW.manifest_sha256 IS NOT NULL OR NEW.verification_path IS NOT NULL OR NEW.verification_sha256 IS NOT NULL OR NEW.publish_started_at IS NOT NULL OR NEW.published_at IS NOT NULL OR NEW.publish_blocker_code IS NOT NULL OR NEW.publish_blocker_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'publish fields require a state'); END;

CREATE TRIGGER jobs_publish_null_guard_update
BEFORE UPDATE OF artifact_staging_path, artifact_quarantine_path, artifact_final_directory, artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256, publish_state, publish_started_at, published_at, publish_blocker_code, publish_blocker_json ON jobs
WHEN NEW.publish_state IS NULL AND (NEW.artifact_staging_path IS NOT NULL OR NEW.artifact_quarantine_path IS NOT NULL OR NEW.artifact_final_directory IS NOT NULL OR NEW.artifact_final_path IS NOT NULL OR NEW.artifact_sha256 IS NOT NULL OR NEW.artifact_size IS NOT NULL OR NEW.artifact_mtime IS NOT NULL OR NEW.checksum_path IS NOT NULL OR NEW.checksum_sha256 IS NOT NULL OR NEW.manifest_path IS NOT NULL OR NEW.manifest_sha256 IS NOT NULL OR NEW.verification_path IS NOT NULL OR NEW.verification_sha256 IS NOT NULL OR NEW.publish_started_at IS NOT NULL OR NEW.published_at IS NOT NULL OR NEW.publish_blocker_code IS NOT NULL OR NEW.publish_blocker_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'publish fields require a state'); END;

CREATE TRIGGER jobs_publish_pairs_guard
BEFORE INSERT ON jobs
WHEN NOT ((NEW.artifact_sha256 IS NULL AND NEW.artifact_size IS NULL AND NEW.artifact_mtime IS NULL) OR (NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL))
  OR NOT ((NEW.checksum_path IS NULL AND NEW.checksum_sha256 IS NULL) OR (NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL))
  OR NOT ((NEW.manifest_path IS NULL AND NEW.manifest_sha256 IS NULL) OR (NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL))
  OR NOT ((NEW.verification_path IS NULL AND NEW.verification_sha256 IS NULL) OR (NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL))
  OR ((NEW.artifact_final_directory IS NULL) <> (NEW.artifact_final_path IS NULL))
BEGIN SELECT RAISE(ABORT, 'artifact evidence groups are incomplete'); END;

CREATE TRIGGER jobs_publish_pairs_guard_update
BEFORE UPDATE OF artifact_staging_path, artifact_final_directory, artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256 ON jobs
WHEN NOT ((NEW.artifact_sha256 IS NULL AND NEW.artifact_size IS NULL AND NEW.artifact_mtime IS NULL) OR (NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL))
  OR NOT ((NEW.checksum_path IS NULL AND NEW.checksum_sha256 IS NULL) OR (NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL))
  OR NOT ((NEW.manifest_path IS NULL AND NEW.manifest_sha256 IS NULL) OR (NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL))
  OR NOT ((NEW.verification_path IS NULL AND NEW.verification_sha256 IS NULL) OR (NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL))
  OR ((NEW.artifact_final_directory IS NULL) <> (NEW.artifact_final_path IS NULL))
BEGIN SELECT RAISE(ABORT, 'artifact evidence groups are incomplete'); END;

CREATE TRIGGER jobs_freshness_evidence_pair_guard
BEFORE INSERT ON jobs
WHEN (NEW.freshness_error_evidence_path IS NULL) <> (NEW.freshness_error_evidence_sha256 IS NULL)
BEGIN SELECT RAISE(ABORT, 'freshness error evidence is incomplete'); END;

CREATE TRIGGER jobs_freshness_evidence_pair_guard_update
BEFORE UPDATE OF freshness_error_evidence_path, freshness_error_evidence_sha256 ON jobs
WHEN (NEW.freshness_error_evidence_path IS NULL) <> (NEW.freshness_error_evidence_sha256 IS NULL)
BEGIN SELECT RAISE(ABORT, 'freshness error evidence is incomplete'); END;

CREATE TRIGGER jobs_publish_guard
BEFORE UPDATE OF artifact_staging_path, artifact_quarantine_path, artifact_final_directory, artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256, publish_state, publish_started_at, published_at, publish_blocker_code, publish_blocker_json ON jobs
WHEN NEW.publish_state IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    (NEW.publish_state = 'not_started' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.checksum_path IS NULL AND NEW.manifest_path IS NULL AND NEW.verification_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state IN ('staged', 'publishing') AND NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND ((NEW.publish_state = 'staged' AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL) OR (NEW.publish_state = 'publishing' AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.publish_started_at IS NOT NULL)) AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'published' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NOT NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'quarantined' AND NEW.artifact_quarantine_path IS NOT NULL AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'blocked' AND NEW.publish_blocker_code IS NOT NULL AND NEW.publish_blocker_json IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL)
  ) THEN RAISE(ABORT, 'publish result is incoherent') END;
END;

CREATE TRIGGER jobs_publish_guard_insert
BEFORE INSERT ON jobs
WHEN NEW.publish_state IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    (NEW.publish_state = 'not_started' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.checksum_path IS NULL AND NEW.manifest_path IS NULL AND NEW.verification_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state IN ('staged', 'publishing') AND NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND ((NEW.publish_state = 'staged' AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL) OR (NEW.publish_state = 'publishing' AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.publish_started_at IS NOT NULL)) AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'quarantined' AND NEW.artifact_quarantine_path IS NOT NULL AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'blocked' AND NEW.publish_blocker_code IS NOT NULL AND NEW.publish_blocker_json IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL)
    OR (NEW.publish_state = 'published' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NOT NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
  ) THEN RAISE(ABORT, 'publish result is incoherent') END;
END;
