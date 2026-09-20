-- risk: additive
-- Durable one-time valve dispatch intent and attempt marker.
CREATE TABLE IF NOT EXISTS valve_once_dispatch_intents (
  schedule_uuid TEXT PRIMARY KEY REFERENCES valve_schedules(schedule_uuid) ON DELETE CASCADE,
  device_eui TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','ATTEMPTED','UNKNOWN','SKIPPED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  attempted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_valve_once_dispatch_intents_device_state
  ON valve_once_dispatch_intents(device_eui, state);
