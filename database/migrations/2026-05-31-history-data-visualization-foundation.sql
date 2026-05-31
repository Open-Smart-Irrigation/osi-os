PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_device_data_deveui_recorded_at
  ON device_data(deveui, recorded_at);

CREATE TABLE IF NOT EXISTS zone_seasons (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id             INTEGER NOT NULL,
  season_uuid         TEXT,
  name                TEXT NOT NULL,
  starts_on           TEXT NOT NULL,
  ends_on             TEXT NOT NULL,
  crop_type           TEXT,
  variety             TEXT,
  phenological_stage  TEXT,
  is_active           INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  is_default          INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (starts_on <= ends_on),
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zone_seasons_zone_range
  ON zone_seasons(zone_id, starts_on, ends_on);
CREATE INDEX IF NOT EXISTS idx_zone_seasons_zone_active
  ON zone_seasons(zone_id, is_active, starts_on, ends_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_seasons_zone_active_unique
  ON zone_seasons(zone_id)
  WHERE is_active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_seasons_zone_default
  ON zone_seasons(zone_id)
  WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_seasons_uuid
  ON zone_seasons(season_uuid)
  WHERE season_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS history_channel_rollups (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id                   INTEGER NOT NULL,
  card_type                 TEXT NOT NULL,
  logical_source_key        TEXT NOT NULL,
  channel_id                TEXT NOT NULL,
  bucket_level              TEXT NOT NULL CHECK (bucket_level IN ('15m', 'hourly', 'daily', 'weekly', 'season')),
  bucket_start              TEXT NOT NULL,
  bucket_end                TEXT NOT NULL,
  min_value                 REAL,
  max_value                 REAL,
  mean_value                REAL,
  median_value              REAL,
  latest_value              REAL,
  dominant_status           TEXT,
  coverage_pct              REAL CHECK (coverage_pct IS NULL OR (coverage_pct >= 0 AND coverage_pct <= 100)),
  coverage_confidence       TEXT NOT NULL DEFAULT 'unknown' CHECK (coverage_confidence IN ('configured', 'derived', 'unknown')),
  sample_count              INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  event_count               INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  threshold_crossing_count  INTEGER NOT NULL DEFAULT 0 CHECK (threshold_crossing_count >= 0),
  unit                      TEXT,
  computed_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (bucket_start < bucket_end),
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_history_rollups_unique_bucket
  ON history_channel_rollups(zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start);
CREATE INDEX IF NOT EXISTS idx_history_rollups_zone_card_bucket
  ON history_channel_rollups(zone_id, card_type, bucket_level, bucket_start, bucket_end);
CREATE INDEX IF NOT EXISTS idx_history_rollups_source_channel
  ON history_channel_rollups(logical_source_key, channel_id, bucket_level, bucket_start);

CREATE TABLE IF NOT EXISTS history_card_preferences (
  user_id          INTEGER NOT NULL,
  owner_user_uuid  TEXT,
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('zone', 'gateway')),
  zone_id          INTEGER,
  gateway_eui      TEXT,
  card_id          TEXT NOT NULL,
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  manual_order     INTEGER,
  open_count       INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  last_opened_at   TEXT,
  last_view_mode   TEXT,
  hidden           INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (scope_type = 'zone' AND zone_id IS NOT NULL AND gateway_eui IS NULL) OR
    (scope_type = 'gateway' AND gateway_eui IS NOT NULL AND zone_id IS NULL)
  ),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_history_card_preferences_zone
  ON history_card_preferences(user_id, zone_id, card_id)
  WHERE scope_type = 'zone';
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_card_preferences_gateway
  ON history_card_preferences(user_id, gateway_eui, card_id)
  WHERE scope_type = 'gateway';

CREATE TABLE IF NOT EXISTS history_workspaces (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  owner_user_uuid TEXT,
  zone_id         INTEGER,
  name            TEXT NOT NULL,
  workspace_json  TEXT NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_history_workspaces_user_zone
  ON history_workspaces(user_id, zone_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_workspaces_user_default
  ON history_workspaces(user_id, zone_id)
  WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_workspaces_user_global_default
  ON history_workspaces(user_id)
  WHERE is_default = 1 AND zone_id IS NULL;

ANALYZE;
