-- risk: additive
-- 0076: conditional irrigation policy, occurrence and transport storage.
-- Policy and occurrence references are application-validated. They deliberately
-- have no physical foreign keys so old zone/device lifecycle writes preserve the
-- immutable decision history.

CREATE TABLE IF NOT EXISTS irrigation_policies (
  policy_uuid                 TEXT PRIMARY KEY,
  zone_uuid                   TEXT NOT NULL,
  condition_json              TEXT NOT NULL CHECK (json_valid(condition_json) AND json_type(condition_json) = 'object'),
  timezone                    TEXT NOT NULL,
  enabled                     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  observation_window_minutes  INTEGER NOT NULL DEFAULT 60 CHECK (observation_window_minutes BETWEEN 1 AND 1440),
  min_interval_minutes        INTEGER NOT NULL DEFAULT 60 CHECK (min_interval_minutes BETWEEN 0 AND 1440),
  max_daily_minutes           INTEGER NOT NULL DEFAULT 240 CHECK (max_daily_minutes BETWEEN 1 AND 1440),
  delivery_settings_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(delivery_settings_json) AND json_type(delivery_settings_json) = 'object'),
  effective_from              TEXT,
  sync_version                INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at                  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_irrigation_policies_live_zone
  ON irrigation_policies(zone_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_irrigation_policies_zone_history
  ON irrigation_policies(zone_uuid, deleted_at, updated_at);

ALTER TABLE valve_schedules ADD COLUMN condition_policy_uuid TEXT;
ALTER TABLE valve_schedules ADD COLUMN effective_from TEXT;
ALTER TABLE valve_settings ADD COLUMN conditional_control_json TEXT;
ALTER TABLE valve_schedule_pushes ADD COLUMN transport_json TEXT;
ALTER TABLE valve_actuation_expectations ADD COLUMN transport_json TEXT;
ALTER TABLE sync_link_state ADD COLUMN peer_capabilities_json TEXT;
ALTER TABLE sync_link_state ADD COLUMN peer_capabilities_context_json TEXT;
ALTER TABLE sync_link_state ADD COLUMN peer_capabilities_request_id TEXT;
ALTER TABLE sync_link_state ADD COLUMN link_attempt_json TEXT;

CREATE TABLE IF NOT EXISTS irrigation_occurrences (
  schedule_uuid               TEXT NOT NULL,
  local_date                  TEXT NOT NULL,
  local_time                  TEXT NOT NULL,
  policy_uuid                 TEXT,
  zone_uuid                   TEXT,
  device_eui                  TEXT NOT NULL,
  due_at                      TEXT NOT NULL,
  expires_at                  TEXT,
  policy_revision             INTEGER,
  schedule_revision           INTEGER,
  policy_sync_version         INTEGER,
  schedule_sync_version       INTEGER,
  decision                    TEXT,
  decision_reason             TEXT,
  decision_evidence_json      TEXT,
  decision_at                 TEXT,
  requested_duration_minutes  INTEGER,
  effective_duration_minutes  INTEGER,
  command_id                  TEXT UNIQUE,
  queue_id                    TEXT,
  state                       TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','CLAIMED','SKIPPED','RESERVED','ATTEMPTED','SENT','EXPIRED','UNKNOWN')),
  reservation_start_at        TEXT,
  reservation_end_at          TEXT,
  reserved_minutes            INTEGER,
  claimed_at                  TEXT,
  attempted_at                TEXT,
  sent_at                     TEXT,
  observed_open_at            TEXT,
  observed_close_at           TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (schedule_uuid, local_date, local_time)
);
CREATE INDEX IF NOT EXISTS idx_irrigation_occurrences_device_due
  ON irrigation_occurrences(device_eui, due_at);
CREATE INDEX IF NOT EXISTS idx_irrigation_occurrences_policy_state
  ON irrigation_occurrences(policy_uuid, state, due_at);
CREATE INDEX IF NOT EXISTS idx_irrigation_occurrences_command
  ON irrigation_occurrences(command_id) WHERE command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS irrigation_runtime_state (
  singleton_id             INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  last_trusted_tick_at     TEXT,
  last_decided_due_at      TEXT,
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
