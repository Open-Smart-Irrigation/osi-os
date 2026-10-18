-- risk: additive
-- 0074: Retain addressed Tensiomark evidence linked to canonical readings.
CREATE TABLE IF NOT EXISTS tensiomark_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_data_id INTEGER REFERENCES device_data(id) ON DELETE SET NULL,
  deveui TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  payload_base64 TEXT,
  configuration_hash TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN (
    'accepted', 'rejected_framing', 'rejected_addresses', 'rejected_values'
  )),
  normalized_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tensiomark_observations_device_time
  ON tensiomark_observations(deveui, recorded_at);
CREATE INDEX IF NOT EXISTS idx_tensiomark_observations_device_data
  ON tensiomark_observations(device_data_id);
