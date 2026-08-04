ALTER TABLE jobs ADD COLUMN builder_identity_status TEXT NOT NULL DEFAULT 'legacy_blocked'
  CHECK (builder_identity_status IN ('admitted', 'legacy_blocked'));
ALTER TABLE jobs ADD COLUMN builder_package_root TEXT;
ALTER TABLE jobs ADD COLUMN builder_lock_sha256 TEXT;
ALTER TABLE jobs ADD COLUMN builder_execution_definition_sha256 TEXT;
ALTER TABLE jobs ADD COLUMN builder_target_manifest_sha256 TEXT;
ALTER TABLE jobs ADD COLUMN builder_runner_sha256 TEXT;
ALTER TABLE jobs ADD COLUMN builder_cleanup_worker_sha256 TEXT;

DROP TRIGGER jobs_builder_identity_guard;
DROP TRIGGER jobs_builder_identity_guard_update;
DROP TRIGGER jobs_builder_identity_immutable_guard;

-- Migration 019 admitted only four fields. They are not sufficient to identify
-- executable bytes, so normalize every historical row to one blocked null shape.
UPDATE jobs
SET builder_package_version = NULL,
    builder_image_reference = NULL,
    builder_image_id = NULL,
    builder_image_digest = NULL
WHERE builder_identity_status = 'legacy_blocked'
  AND (builder_package_version IS NOT NULL
    OR builder_image_reference IS NOT NULL
    OR builder_image_id IS NOT NULL
    OR builder_image_digest IS NOT NULL);

INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at)
SELECT job_id,
       COALESCE((SELECT MAX(existing.seq) + 1 FROM job_events AS existing WHERE existing.job_id = jobs.job_id), 0),
       'recovery',
       'interrupted',
       NULL,
       '{"reason":"legacy job has no complete admitted builder identity","recovery":"reenqueue-required"}',
       updated_at
FROM jobs
WHERE builder_identity_status = 'legacy_blocked' AND queue_state = 'queued';

DELETE FROM queue_entries
WHERE job_id IN (
  SELECT job_id FROM jobs
  WHERE builder_identity_status = 'legacy_blocked' AND queue_state = 'queued'
);

UPDATE jobs
SET state = 'interrupted',
    current_stage = NULL,
    queue_state = 'complete',
    queue_position = NULL,
    terminal_error_code = 'BUILDER_DIGEST_MISMATCH',
    terminal_error_json = '{"reason":"legacy job has no complete admitted builder identity","recovery":"reenqueue-required"}',
    terminal_at = updated_at
WHERE builder_identity_status = 'legacy_blocked' AND queue_state = 'queued';

UPDATE jobs
SET queue_position = (
  SELECT COUNT(*) FROM jobs AS predecessor
  WHERE predecessor.queue_state = 'queued'
    AND (
      predecessor.queue_position < jobs.queue_position
      OR (predecessor.queue_position = jobs.queue_position AND predecessor.job_id < jobs.job_id)
    )
)
WHERE queue_state = 'queued';

CREATE TRIGGER jobs_builder_identity_guard
BEFORE INSERT ON jobs
WHEN NOT (
  NEW.builder_identity_status = 'admitted'
  AND NEW.builder_package_version IS NOT NULL
  AND (
    (
      NEW.builder_package_version NOT GLOB '*[^0-9.]*'
      AND length(NEW.builder_package_version) - length(replace(NEW.builder_package_version, '.', '')) = 2
      AND substr(NEW.builder_package_version, 1, 1) <> '.'
      AND substr(NEW.builder_package_version, -1) <> '.'
      AND NEW.builder_package_version NOT GLOB '*..*'
    )
    OR (
      substr(NEW.builder_package_version, 1, 1) = 'v'
      AND length(NEW.builder_package_version) > 1
      AND substr(NEW.builder_package_version, 2) NOT GLOB '*[^0-9.]*'
      AND length(substr(NEW.builder_package_version, 2)) - length(replace(substr(NEW.builder_package_version, 2), '.', '')) = 2
      AND substr(NEW.builder_package_version, 2, 1) <> '.'
      AND substr(NEW.builder_package_version, -1) <> '.'
      AND substr(NEW.builder_package_version, 2) NOT GLOB '*..*'
    )
    OR (
      NEW.builder_package_version NOT GLOB '*[^0-9.]*'
      AND length(NEW.builder_package_version) - length(replace(NEW.builder_package_version, '.', '')) = 3
      AND instr(NEW.builder_package_version, '.') = 5
      AND instr(substr(NEW.builder_package_version, 6), '.') = 3
      AND instr(substr(NEW.builder_package_version, 9), '.') = 3
      AND length(substr(NEW.builder_package_version, 12)) > 0
    )
  )
  AND NEW.builder_package_root IS NOT NULL
  AND length(NEW.builder_package_root) BETWEEN 2 AND 1024
  AND substr(NEW.builder_package_root, 1, 1) = '/'
  AND NEW.builder_package_root NOT GLOB '*[^A-Za-z0-9._/-]*'
  AND substr(NEW.builder_package_root, -length(NEW.builder_package_version) - 1) = '/' || NEW.builder_package_version
  AND NEW.builder_package_root NOT GLOB '*//*'
  AND NEW.builder_package_root NOT GLOB '*/./*'
  AND NEW.builder_package_root NOT GLOB '*/../*'
  AND substr(NEW.builder_package_root, -2) <> '/.'
  AND substr(NEW.builder_package_root, -3) <> '/..'
  AND NEW.builder_lock_sha256 IS NOT NULL AND length(NEW.builder_lock_sha256) = 64
  AND NEW.builder_lock_sha256 NOT GLOB '*[^0-9a-f]*'
  AND NEW.builder_lock_sha256 <> '0000000000000000000000000000000000000000000000000000000000000000'
  AND NEW.builder_execution_definition_sha256 IS NOT NULL AND length(NEW.builder_execution_definition_sha256) = 64
  AND NEW.builder_execution_definition_sha256 NOT GLOB '*[^0-9a-f]*'
  AND NEW.builder_execution_definition_sha256 <> '0000000000000000000000000000000000000000000000000000000000000000'
  AND NEW.builder_target_manifest_sha256 IS NOT NULL AND length(NEW.builder_target_manifest_sha256) = 64
  AND NEW.builder_target_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  AND NEW.builder_target_manifest_sha256 <> '0000000000000000000000000000000000000000000000000000000000000000'
  AND NEW.builder_target_manifest_sha256 = NEW.target_manifest_sha256
  AND NEW.builder_runner_sha256 IS NOT NULL AND length(NEW.builder_runner_sha256) = 64
  AND NEW.builder_runner_sha256 NOT GLOB '*[^0-9a-f]*'
  AND NEW.builder_runner_sha256 <> '0000000000000000000000000000000000000000000000000000000000000000'
  AND NEW.builder_cleanup_worker_sha256 IS NOT NULL AND length(NEW.builder_cleanup_worker_sha256) = 64
  AND NEW.builder_cleanup_worker_sha256 NOT GLOB '*[^0-9a-f]*'
  AND NEW.builder_cleanup_worker_sha256 <> '0000000000000000000000000000000000000000000000000000000000000000'
  AND NEW.builder_image_digest IS NOT NULL AND length(NEW.builder_image_digest) = 64
  AND NEW.builder_image_digest NOT GLOB '*[^0-9a-f]*'
  AND NEW.builder_image_digest <> '0000000000000000000000000000000000000000000000000000000000000000'
  AND NEW.builder_image_id IS NOT NULL AND length(NEW.builder_image_id) = 71
  AND substr(NEW.builder_image_id, 1, 7) = 'sha256:'
  AND substr(NEW.builder_image_id, 8) NOT GLOB '*[^0-9a-f]*'
  AND substr(NEW.builder_image_id, 8) <> '0000000000000000000000000000000000000000000000000000000000000000'
  AND NEW.builder_image_reference IS NOT NULL
  AND length(NEW.builder_image_reference) >= 73
  AND substr(NEW.builder_image_reference, -72) = '@sha256:' || NEW.builder_image_digest
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT substr(NEW.builder_image_reference, 1, length(NEW.builder_image_reference) - 72) AS repository
    ) AS image
    WHERE length(image.repository) > 0
      AND image.repository NOT GLOB '*[^a-z0-9._/:-]*'
      AND substr(image.repository, 1, 1) GLOB '[a-z0-9]'
      AND substr(image.repository, -1) GLOB '[a-z0-9]'
      AND image.repository NOT GLOB '*[._/-][._/-]*'
      AND (
        length(image.repository) - length(replace(image.repository, ':', '')) = 0
        OR (
          length(image.repository) - length(replace(image.repository, ':', '')) = 1
          AND instr(image.repository, ':') > 1
          AND (instr(image.repository, '/') = 0 OR instr(image.repository, ':') < instr(image.repository, '/'))
          AND substr(image.repository, instr(image.repository, ':') - 1, 1) GLOB '[a-z0-9]'
          AND substr(image.repository, instr(image.repository, ':') + 1, 1) GLOB '[1-9]'
          AND length(substr(
            image.repository,
            instr(image.repository, ':') + 1,
            CASE WHEN instr(image.repository, '/') = 0
              THEN length(image.repository) - instr(image.repository, ':')
              ELSE instr(image.repository, '/') - instr(image.repository, ':') - 1
            END
          )) BETWEEN 1 AND 5
          AND substr(
            image.repository,
            instr(image.repository, ':') + 1,
            CASE WHEN instr(image.repository, '/') = 0
              THEN length(image.repository) - instr(image.repository, ':')
              ELSE instr(image.repository, '/') - instr(image.repository, ':') - 1
            END
          ) NOT GLOB '*[^0-9]*'
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'job builder identity is incomplete or invalid');
END;

CREATE TRIGGER jobs_builder_identity_guard_update
BEFORE UPDATE OF builder_identity_status, builder_package_version, builder_package_root, builder_lock_sha256,
  builder_execution_definition_sha256, builder_target_manifest_sha256, builder_image_reference,
  builder_runner_sha256, builder_cleanup_worker_sha256, builder_image_id, builder_image_digest ON jobs
WHEN NEW.builder_identity_status IS NOT OLD.builder_identity_status
  OR NEW.builder_package_version IS NOT OLD.builder_package_version
  OR NEW.builder_package_root IS NOT OLD.builder_package_root
  OR NEW.builder_lock_sha256 IS NOT OLD.builder_lock_sha256
  OR NEW.builder_execution_definition_sha256 IS NOT OLD.builder_execution_definition_sha256
  OR NEW.builder_target_manifest_sha256 IS NOT OLD.builder_target_manifest_sha256
  OR NEW.builder_runner_sha256 IS NOT OLD.builder_runner_sha256
  OR NEW.builder_cleanup_worker_sha256 IS NOT OLD.builder_cleanup_worker_sha256
  OR NEW.builder_image_reference IS NOT OLD.builder_image_reference
  OR NEW.builder_image_id IS NOT OLD.builder_image_id
  OR NEW.builder_image_digest IS NOT OLD.builder_image_digest
BEGIN
  SELECT RAISE(ABORT, 'job builder identity is immutable');
END;
