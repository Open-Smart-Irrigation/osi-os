ALTER TABLE jobs ADD COLUMN builder_package_version TEXT;
ALTER TABLE jobs ADD COLUMN builder_image_reference TEXT;
ALTER TABLE jobs ADD COLUMN builder_image_id TEXT;
ALTER TABLE jobs ADD COLUMN builder_image_digest TEXT;

CREATE TRIGGER jobs_builder_identity_guard
BEFORE INSERT ON jobs
WHEN NOT (
  (NEW.builder_package_version IS NULL AND NEW.builder_image_reference IS NULL
    AND NEW.builder_image_id IS NULL AND NEW.builder_image_digest IS NULL)
  OR (
    NEW.builder_package_version IS NOT NULL
    AND length(NEW.builder_package_version) BETWEEN 1 AND 64
    AND NEW.builder_package_version NOT GLOB '*[^0-9A-Za-z.+-]*'
    AND NEW.builder_image_digest IS NOT NULL
    AND length(NEW.builder_image_digest) = 64
    AND NEW.builder_image_digest GLOB '[0-9a-f]*'
    AND NEW.builder_image_digest NOT GLOB '*[^0-9a-f]*'
    AND NEW.builder_image_id IS NOT NULL
    AND length(NEW.builder_image_id) = 71
    AND substr(NEW.builder_image_id, 1, 7) = 'sha256:'
    AND substr(NEW.builder_image_id, 8) GLOB '[0-9a-f]*'
    AND substr(NEW.builder_image_id, 8) NOT GLOB '*[^0-9a-f]*'
    AND NEW.builder_image_reference IS NOT NULL
    AND length(NEW.builder_image_reference) BETWEEN 73 AND 512
    AND substr(NEW.builder_image_reference, -72) = '@sha256:' || NEW.builder_image_digest
  )
)
BEGIN
  SELECT RAISE(ABORT, 'job builder identity is incomplete or invalid');
END;

CREATE TRIGGER jobs_builder_identity_guard_update
BEFORE UPDATE OF builder_package_version, builder_image_reference, builder_image_id, builder_image_digest ON jobs
WHEN NOT (
  (NEW.builder_package_version IS NULL AND NEW.builder_image_reference IS NULL
    AND NEW.builder_image_id IS NULL AND NEW.builder_image_digest IS NULL)
  OR (
    NEW.builder_package_version IS NOT NULL
    AND length(NEW.builder_package_version) BETWEEN 1 AND 64
    AND NEW.builder_package_version NOT GLOB '*[^0-9A-Za-z.+-]*'
    AND NEW.builder_image_digest IS NOT NULL
    AND length(NEW.builder_image_digest) = 64
    AND NEW.builder_image_digest GLOB '[0-9a-f]*'
    AND NEW.builder_image_digest NOT GLOB '*[^0-9a-f]*'
    AND NEW.builder_image_id IS NOT NULL
    AND length(NEW.builder_image_id) = 71
    AND substr(NEW.builder_image_id, 1, 7) = 'sha256:'
    AND substr(NEW.builder_image_id, 8) GLOB '[0-9a-f]*'
    AND substr(NEW.builder_image_id, 8) NOT GLOB '*[^0-9a-f]*'
    AND NEW.builder_image_reference IS NOT NULL
    AND length(NEW.builder_image_reference) BETWEEN 73 AND 512
    AND substr(NEW.builder_image_reference, -72) = '@sha256:' || NEW.builder_image_digest
  )
)
BEGIN
  SELECT RAISE(ABORT, 'job builder identity is incomplete or invalid');
END;

CREATE TRIGGER jobs_builder_identity_immutable_guard
BEFORE UPDATE OF builder_package_version, builder_image_reference, builder_image_id, builder_image_digest ON jobs
WHEN OLD.builder_package_version IS NOT NULL AND (
  NEW.builder_package_version IS NOT OLD.builder_package_version
  OR NEW.builder_image_reference IS NOT OLD.builder_image_reference
  OR NEW.builder_image_id IS NOT OLD.builder_image_id
  OR NEW.builder_image_digest IS NOT OLD.builder_image_digest
)
BEGIN
  SELECT RAISE(ABORT, 'job builder identity is immutable');
END;
