DROP TRIGGER jobs_publish_guard;
DROP TRIGGER jobs_publish_guard_insert;

UPDATE jobs
SET artifact_staging_path = NULL,
    artifact_quarantine_path = NULL,
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
WHERE publish_state = 'blocked'
  AND (
    artifact_sha256 IS NULL
    OR artifact_size IS NULL
    OR artifact_mtime IS NULL
    OR checksum_path IS NULL
    OR checksum_sha256 IS NULL
    OR manifest_path IS NULL
    OR manifest_sha256 IS NULL
    OR verification_path IS NULL
    OR verification_sha256 IS NULL
    OR (artifact_staging_path IS NOT NULL AND artifact_quarantine_path IS NOT NULL)
  );

CREATE TRIGGER jobs_publish_guard
BEFORE UPDATE OF artifact_staging_path, artifact_quarantine_path, artifact_final_directory, artifact_final_path, artifact_sha256, artifact_size, artifact_mtime, checksum_path, checksum_sha256, manifest_path, manifest_sha256, verification_path, verification_sha256, publish_state, publish_started_at, published_at, publish_blocker_code, publish_blocker_json ON jobs
WHEN NEW.publish_state IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT (
    (NEW.publish_state = 'not_started' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.artifact_sha256 IS NULL AND NEW.checksum_path IS NULL AND NEW.manifest_path IS NULL AND NEW.verification_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state IN ('staged', 'publishing') AND NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND ((NEW.publish_state = 'staged' AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL) OR (NEW.publish_state = 'publishing' AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.publish_started_at IS NOT NULL)) AND NEW.published_at IS NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'published' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NOT NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'quarantined' AND NEW.artifact_quarantine_path IS NOT NULL AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
    OR (NEW.publish_state = 'blocked' AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_blocker_code IS NOT NULL AND NEW.publish_blocker_json IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NOT (NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_quarantine_path IS NOT NULL))
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
    OR (NEW.publish_state = 'blocked' AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_blocker_code IS NOT NULL AND NEW.publish_blocker_json IS NOT NULL AND NEW.artifact_final_directory IS NULL AND NEW.artifact_final_path IS NULL AND NEW.publish_started_at IS NULL AND NEW.published_at IS NULL AND NOT (NEW.artifact_staging_path IS NOT NULL AND NEW.artifact_quarantine_path IS NOT NULL))
    OR (NEW.publish_state = 'published' AND NEW.artifact_staging_path IS NULL AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL AND NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_size IS NOT NULL AND NEW.artifact_mtime IS NOT NULL AND NEW.checksum_path IS NOT NULL AND NEW.checksum_sha256 IS NOT NULL AND NEW.manifest_path IS NOT NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.verification_path IS NOT NULL AND NEW.verification_sha256 IS NOT NULL AND NEW.publish_started_at IS NOT NULL AND NEW.published_at IS NOT NULL AND NEW.artifact_quarantine_path IS NULL AND NEW.publish_blocker_code IS NULL AND NEW.publish_blocker_json IS NULL)
  ) THEN RAISE(ABORT, 'publish result is incoherent') END;
END;
