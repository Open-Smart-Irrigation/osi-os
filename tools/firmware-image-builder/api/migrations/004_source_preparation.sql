ALTER TABLE jobs ADD COLUMN source_preparation_json TEXT
  CHECK (source_preparation_json IS NULL OR (json_valid(source_preparation_json) = 1 AND json_type(source_preparation_json) = 'object'));

CREATE TRIGGER jobs_source_preparation_insert_guard
BEFORE INSERT ON jobs
WHEN NEW.source_preparation_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'source preparation is required');
END;

CREATE TRIGGER jobs_source_preparation_immutable_guard
BEFORE UPDATE OF source_preparation_json ON jobs
BEGIN
  SELECT RAISE(ABORT, 'accepted job source preparation is immutable');
END;
