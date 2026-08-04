ALTER TABLE jobs ADD COLUMN release_seal_status TEXT
  CHECK (release_seal_status IS NULL OR release_seal_status IN ('in_progress', 'sealed', 'legacy_mutable'));

UPDATE jobs
SET release_seal_status = CASE
  WHEN publish_state = 'publishing' THEN 'in_progress'
  WHEN publish_state = 'published' THEN 'legacy_mutable'
  ELSE NULL
END;

CREATE TRIGGER jobs_release_seal_status_guard
BEFORE INSERT ON jobs
WHEN COALESCE((
  (NEW.release_seal_status IS NULL AND (
    NEW.publish_state IS NULL OR NEW.publish_state NOT IN ('publishing', 'published')
  ))
  OR (NEW.release_seal_status = 'in_progress'
    AND NEW.publish_state = 'publishing'
    AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL)
  OR (NEW.release_seal_status IN ('sealed', 'legacy_mutable')
    AND NEW.publish_state = 'published'
    AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL)
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'release seal status is incoherent');
END;

CREATE TRIGGER jobs_release_seal_status_guard_update
BEFORE UPDATE OF state, publish_state, artifact_final_directory, artifact_final_path, release_seal_status ON jobs
WHEN COALESCE((
  (NEW.release_seal_status IS NULL AND (
    NEW.publish_state IS NULL OR NEW.publish_state NOT IN ('publishing', 'published')
  ))
  OR (NEW.release_seal_status = 'in_progress'
    AND NEW.publish_state = 'publishing'
    AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL)
  OR (NEW.release_seal_status IN ('sealed', 'legacy_mutable')
    AND NEW.publish_state = 'published'
    AND NEW.artifact_final_directory IS NOT NULL AND NEW.artifact_final_path IS NOT NULL)
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'release seal status is incoherent');
END;

CREATE TRIGGER jobs_release_seal_status_legacy_sealed_guard
BEFORE UPDATE OF release_seal_status ON jobs
WHEN OLD.publish_state = 'published'
  AND OLD.release_seal_status = 'legacy_mutable'
  AND NEW.release_seal_status = 'sealed'
BEGIN
  SELECT RAISE(ABORT, 'legacy mutable release requires audited sealing');
END;
