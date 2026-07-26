ALTER TABLE jobs ADD COLUMN offline_feed_preparation_json TEXT
  CHECK (
    offline_feed_preparation_json IS NULL
    OR (
      json_valid(offline_feed_preparation_json) = 1
      AND json_type(offline_feed_preparation_json) = 'object'
    )
  );

CREATE TRIGGER jobs_offline_feed_preparation_insert_guard
BEFORE INSERT ON jobs
WHEN NEW.offline_feed_preparation_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'offline feed preparation is required');
END;

CREATE TRIGGER jobs_offline_feed_preparation_immutable_guard
BEFORE UPDATE OF offline_feed_preparation_json ON jobs
WHEN OLD.offline_feed_preparation_json IS NOT NEW.offline_feed_preparation_json
BEGIN
  SELECT RAISE(ABORT, 'offline feed preparation is immutable');
END;
