CREATE TABLE publish_blocker_rechecks (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
  resolution TEXT NOT NULL CHECK (resolution IN ('cleared_absent', 'marked_published', 'retained_blocker')),
  observed_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  prior_publish_state TEXT NOT NULL CHECK (prior_publish_state = 'blocked'),
  prior_blocker_code TEXT NOT NULL CHECK (prior_blocker_code = 'UNVERIFIED_FINAL_PATH_BLOCKER'),
  prior_blocker_json TEXT NOT NULL CHECK (json_valid(prior_blocker_json) = 1 AND json_type(prior_blocker_json) = 'object'),
  artifact_staging_path TEXT,
  artifact_quarantine_path TEXT,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64 AND artifact_sha256 GLOB '[0-9a-f]*' AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  artifact_size INTEGER NOT NULL CHECK (artifact_size >= 0),
  artifact_mtime TEXT NOT NULL,
  checksum_path TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64 AND checksum_sha256 GLOB '[0-9a-f]*' AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_path TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 GLOB '[0-9a-f]*' AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  verification_path TEXT NOT NULL,
  verification_sha256 TEXT NOT NULL CHECK (length(verification_sha256) = 64 AND verification_sha256 GLOB '[0-9a-f]*' AND verification_sha256 NOT GLOB '*[^0-9a-f]*'),
  final_directory TEXT,
  final_path TEXT,
  published_at TEXT,
  proof_json TEXT NOT NULL CHECK (json_valid(proof_json) = 1 AND json_type(proof_json) = 'object'),
  PRIMARY KEY (job_id, attempt),
  UNIQUE (job_id, event_seq),
  CHECK ((final_directory IS NULL AND final_path IS NULL) OR (final_directory IS NOT NULL AND final_path IS NOT NULL)),
  CHECK (
    (resolution = 'cleared_absent' AND artifact_staging_path IS NULL AND final_directory IS NULL AND final_path IS NULL AND published_at IS NULL)
    OR (resolution = 'marked_published' AND artifact_staging_path IS NULL AND final_directory IS NOT NULL AND final_path IS NOT NULL AND published_at IS NOT NULL)
    OR (resolution = 'retained_blocker' AND final_directory IS NULL AND final_path IS NULL AND published_at IS NULL)
  ),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (job_id, event_seq) REFERENCES job_events(job_id, seq) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TRIGGER publish_blocker_rechecks_insert_guard
BEFORE INSERT ON publish_blocker_rechecks
WHEN NOT EXISTS (
  SELECT 1
  FROM jobs AS job
  JOIN job_events AS event
    ON event.job_id = NEW.job_id
   AND event.seq = NEW.event_seq
  WHERE job.job_id = NEW.job_id
    AND job.state = 'failed'
    AND job.publish_state = 'blocked'
    AND job.publish_blocker_code = 'UNVERIFIED_FINAL_PATH_BLOCKER'
    AND json(job.publish_blocker_json) = json(NEW.prior_blocker_json)
    AND job.artifact_staging_path IS NEW.artifact_staging_path
    AND job.artifact_quarantine_path IS NEW.artifact_quarantine_path
    AND job.artifact_sha256 = NEW.artifact_sha256
    AND job.artifact_size = NEW.artifact_size
    AND job.artifact_mtime = NEW.artifact_mtime
    AND job.checksum_path = NEW.checksum_path
    AND job.checksum_sha256 = NEW.checksum_sha256
    AND job.manifest_path = NEW.manifest_path
    AND job.manifest_sha256 = NEW.manifest_sha256
    AND job.verification_path = NEW.verification_path
    AND job.verification_sha256 = NEW.verification_sha256
    AND event.event_type = 'recovery'
    AND event.state = 'failed'
    AND event.at = NEW.committed_at
    AND json_extract(event.payload_json, '$.kind') = 'publish-blocker-recheck'
    AND json_extract(event.payload_json, '$.resolution') = NEW.resolution
    AND json_extract(event.payload_json, '$.attempt') = NEW.attempt
    AND json(json_extract(event.payload_json, '$.proof')) = json(NEW.proof_json)
    AND json_extract(NEW.proof_json, '$.observedAt') = NEW.observed_at
    AND json_type(NEW.proof_json, '$.publisher.mutationCount') = 'integer'
    AND json_extract(NEW.proof_json, '$.publisher.mutationCount') = 0
    AND (
      (NEW.resolution = 'cleared_absent'
        AND json_extract(NEW.proof_json, '$.kind') = 'destination-absent'
        AND json_extract(NEW.proof_json, '$.publisher.destination') = 'absent'
        AND json_extract(NEW.proof_json, '$.publisher.staging') = 'absent'
        AND json_extract(NEW.proof_json, '$.finalDirectory')
          = json_extract(NEW.prior_blocker_json, '$.binding.finalDirectory')
        AND json_extract(NEW.proof_json, '$.finalPath')
          = json_extract(NEW.prior_blocker_json, '$.binding.finalPath'))
      OR (NEW.resolution = 'marked_published'
        AND json_extract(NEW.proof_json, '$.kind') = 'destination-matches'
        AND json_extract(NEW.proof_json, '$.publisher.destination') = 'candidate'
        AND json_extract(NEW.proof_json, '$.publisher.staging') = 'absent'
        AND json_extract(NEW.proof_json, '$.staging.path') = 'staging/' || NEW.job_id
        AND json_extract(NEW.proof_json, '$.staging.state') = 'absent'
        AND json_extract(NEW.proof_json, '$.finalDirectory') = NEW.final_directory
        AND json_extract(NEW.proof_json, '$.finalPath') = NEW.final_path
        AND NEW.final_directory
          = json_extract(NEW.prior_blocker_json, '$.binding.finalDirectory')
        AND NEW.final_path
          = json_extract(NEW.prior_blocker_json, '$.binding.finalPath')
        AND json_extract(NEW.proof_json, '$.artifact.sha256') = NEW.artifact_sha256
        AND json_extract(NEW.proof_json, '$.artifact.size') = NEW.artifact_size
        AND json_extract(NEW.proof_json, '$.artifact.mtime') = NEW.artifact_mtime
        AND json_extract(NEW.proof_json, '$.checksum.path') = NEW.final_directory || '/sha256sums'
        AND json_extract(NEW.proof_json, '$.checksum.sha256') = NEW.checksum_sha256
        AND json_extract(NEW.proof_json, '$.manifest.path') = NEW.final_directory || '/build-manifest.json'
        AND json_extract(NEW.proof_json, '$.manifest.sha256') = NEW.manifest_sha256
        AND json_extract(NEW.proof_json, '$.verification.path') = NEW.final_directory || '/verification.json'
        AND json_extract(NEW.proof_json, '$.verification.sha256') = NEW.verification_sha256
        AND NEW.published_at = NEW.committed_at)
      OR (NEW.resolution = 'retained_blocker'
        AND json_extract(NEW.proof_json, '$.kind') = 'retained-blocker'
        AND (
          (json_extract(NEW.proof_json, '$.reason') = 'destination-mismatched'
            AND json_extract(NEW.proof_json, '$.publisher.destination') = 'mismatched')
          OR (json_extract(NEW.proof_json, '$.reason') = 'staging-present'
            AND json_extract(NEW.proof_json, '$.publisher.staging') = 'present')
          OR (json_extract(NEW.proof_json, '$.reason') = 'incomplete-evidence'
            AND json_extract(NEW.proof_json, '$.publisher.destination') = 'candidate'
            AND json_extract(NEW.proof_json, '$.publisher.staging') = 'absent')
          OR (json_extract(NEW.proof_json, '$.reason') IN ('unsafe-path', 'publisher-unavailable')
            AND json_extract(NEW.proof_json, '$.publisher.destination') = 'unknown'
            AND json_extract(NEW.proof_json, '$.publisher.staging') = 'unknown')
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'publish blocker recheck evidence is not bound to the blocked job and event');
END;

CREATE TRIGGER publish_blocker_rechecks_update_guard
BEFORE UPDATE ON publish_blocker_rechecks
BEGIN
  SELECT RAISE(ABORT, 'publish blocker recheck evidence is immutable');
END;

CREATE TRIGGER publish_blocker_rechecks_delete_guard
BEFORE DELETE ON publish_blocker_rechecks
WHEN NOT EXISTS (SELECT 1 FROM retention_purge_authorizations WHERE job_id = OLD.job_id)
BEGIN
  SELECT RAISE(ABORT, 'publish blocker recheck evidence is immutable');
END;
