-- risk: additive
-- 0022: Valve control module (spec docs/superpowers/specs/2026-08-19-valve-control-design.md).
-- Weekly schedules compiled into the STREGA on-valve scheduler, per-valve settings,
-- downlink push tracking, and a trigger column on actuation expectations.

CREATE TABLE IF NOT EXISTS valve_schedules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_uuid    TEXT NOT NULL UNIQUE,
  device_eui       TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('WEEKLY','ONCE')),
  label            TEXT,
  weekdays_mask    INTEGER,
  start_time       TEXT,
  fire_at          TEXT,
  duration_minutes INTEGER NOT NULL,
  timezone         TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  once_state       TEXT CHECK (once_state IN ('PENDING','FIRED','SKIPPED','CANCELLED')),
  once_fired_at    TEXT,
  sync_version     INTEGER DEFAULT 0,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'WEEKLY' AND weekdays_mask BETWEEN 1 AND 127 AND start_time IS NOT NULL
      AND duration_minutes BETWEEN 1 AND 1439)
    OR
    (kind = 'ONCE' AND fire_at IS NOT NULL AND duration_minutes BETWEEN 1 AND 255)
  )
);
CREATE INDEX IF NOT EXISTS idx_valve_schedules_device ON valve_schedules(device_eui, deleted_at);
CREATE INDEX IF NOT EXISTS idx_valve_schedules_once_due
  ON valve_schedules(fire_at) WHERE kind = 'ONCE' AND once_state = 'PENDING' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS valve_settings (
  device_eui                TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  strega_generation         TEXT NOT NULL DEFAULT 'GEN1' CHECK (strega_generation IN ('GEN1','GEN2')),
  flow_rate_lpm             REAL,
  flow_rate_source          TEXT CHECK (flow_rate_source IS NULL OR flow_rate_source IN ('measured','estimated')),
  flow_rate_updated_at      TEXT,
  default_open_minutes      INTEGER CHECK (default_open_minutes IS NULL OR default_open_minutes BETWEEN 1 AND 255),
  scheduler_status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (scheduler_status IN ('ACTIVE','SKIP_TODAY','DEACTIVATED')),
  skip_today_date           TEXT,
  last_clock_sync_queued_at TEXT,
  last_clock_sync_acked_at  TEXT,
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS valve_schedule_pushes (
  push_id      TEXT PRIMARY KEY,
  device_eui   TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS','CLOCK_SYNC')),
  weekday      INTEGER,
  fport        INTEGER NOT NULL,
  payload_hex  TEXT NOT NULL,
  plan_hash    TEXT,
  state        TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','ACKED','FAILED','SUPERSEDED')),
  ack_status   INTEGER,
  queued_at    TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at     TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_valve_schedule_pushes_device_state ON valve_schedule_pushes(device_eui, state);

ALTER TABLE valve_actuation_expectations ADD COLUMN trigger TEXT;
