CREATE TABLE publish_blocker_rechecks (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  resolution TEXT NOT NULL CHECK (resolution IN ('cleared_absent', 'marked_published', 'retained_blocker')),
  observed_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  prior_publish_state TEXT NOT NULL CHECK (prior_publish_state = 'blocked'),
  prior_blocker_code TEXT NOT NULL CHECK (prior_blocker_code = 'UNVERIFIED_FINAL_PATH_BLOCKER'),
  prior_blocker_json TEXT NOT NULL CHECK (json_valid(prior_blocker_json) = 1 AND json_type(prior_blocker_json) = 'object'),
  artifact_staging_path TEXT,
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
  CHECK ((final_directory IS NULL AND final_path IS NULL) OR (final_directory IS NOT NULL AND final_path IS NOT NULL)),
  CHECK (
    (resolution = 'cleared_absent' AND artifact_staging_path IS NULL AND final_directory IS NULL AND final_path IS NULL AND published_at IS NULL)
    OR (resolution = 'marked_published' AND artifact_staging_path IS NULL AND final_directory IS NOT NULL AND final_path IS NOT NULL AND published_at IS NOT NULL)
    OR (resolution = 'retained_blocker' AND final_directory IS NULL AND final_path IS NULL AND published_at IS NULL)
  ),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TRIGGER publish_blocker_rechecks_update_guard
BEFORE UPDATE ON publish_blocker_rechecks
BEGIN
  SELECT RAISE(ABORT, 'publish blocker recheck evidence is immutable');
END;

CREATE TRIGGER publish_blocker_rechecks_delete_guard
BEFORE DELETE ON publish_blocker_rechecks
BEGIN
  SELECT RAISE(ABORT, 'publish blocker recheck evidence is immutable');
END;
