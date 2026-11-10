-- risk: additive
-- 0076: Retain complete SDI-12 application transmissions before normalization.
CREATE TABLE IF NOT EXISTS sdi12_transmissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT NOT NULL,
  recorded_at TEXT,
  received_at TEXT NOT NULL,
  payload_version INTEGER,
  raw_ascii TEXT NOT NULL,
  frames_json TEXT NOT NULL CHECK (json_valid(frames_json)),
  context_json TEXT NOT NULL CHECK (json_valid(context_json))
);
CREATE INDEX IF NOT EXISTS idx_sdi12_transmissions_device_time
  ON sdi12_transmissions(deveui, received_at, id);
