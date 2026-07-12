-- risk: additive
-- 0009: Dead-letter table for narrow-waist ingest (3.1).
-- Captures unmapped, unknown, or server-only channels that the manifest-driven
-- writer cannot persist to device_data. Forensic log — no FK on deveui so
-- unregistered devices can be quarantined too.
-- Row-capped at ~1000 by the writer (oldest-eviction before insert).

CREATE TABLE IF NOT EXISTS ingest_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT NOT NULL,
  channel TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_value TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ingest_quarantine_received
  ON ingest_quarantine(received_at);
