-- risk: additive
-- 0023: Gateway-level key/value settings store (FW-T5, valve-control fix wave).
-- First consumer: gateway_timezone, the default timezone for newly created
-- zones and a fallback link in the valve-time chain. Absent key means the
-- caller falls back to 'UTC' in code; no seed rows are inserted here.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
