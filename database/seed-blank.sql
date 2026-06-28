-- =============================================================================
--  OSI OS  —  Blank seed database schema
--  Canonical source of truth for first-boot DB creation.
--
--  Derived from: Silvan production DB (2026-05-18) + WS1/WS2/WS3 migrations
--  Tables: all Silvan tables + chameleon_readings + applied_commands +
--          command_ack_outbox + valve_actuation_expectations +
--          zone_irrigation_calibration
--  Data:   none  (no demo users / devices / zones)
--
--  Usage:
--    sqlite3 /path/to/farming.db < database/seed-blank.sql
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  username                        TEXT UNIQUE NOT NULL,
  password_hash                   TEXT NOT NULL,
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT DEFAULT CURRENT_TIMESTAMP,
  auth_mode                       TEXT NOT NULL DEFAULT 'local',
  server_username                 TEXT,
  server_password_hash            TEXT,
  server_linked_at                TEXT,
  user_uuid                       TEXT,
  cloud_user_id                   INTEGER,
  server_url                      TEXT,
  server_sync_token               TEXT,
  server_sync_token_expires_at    INTEGER,
  server_offline_verifier         TEXT,
  edge_originated                 INTEGER DEFAULT 0,
  server_offline_verifier_version INTEGER DEFAULT 0,
  last_auth_sync_at               TEXT,
  last_auth_sync_status           TEXT,
  last_auth_sync_error            TEXT
);

CREATE UNIQUE INDEX idx_users_user_uuid ON users(user_uuid);

-- ---------------------------------------------------------------------------
-- farms
-- ---------------------------------------------------------------------------
CREATE TABLE farms (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id          TEXT UNIQUE NOT NULL,
  claim_code_hash  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name             TEXT NULL
);

-- ---------------------------------------------------------------------------
-- irrigation_zones
-- ---------------------------------------------------------------------------
CREATE TABLE irrigation_zones (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  name                        TEXT NOT NULL,
  user_id                     INTEGER NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at                  TEXT NULL,
  timezone                    TEXT NOT NULL DEFAULT 'UTC',
  zone_uuid                   TEXT,
  gateway_device_eui          TEXT,
  sync_version                INTEGER DEFAULT 0,
  area_m2                     REAL,
  irrigation_efficiency_pct   REAL,
  scheduling_mode             TEXT DEFAULT 'local',
  latitude                    REAL,
  longitude                   REAL,
  phenological_stage          TEXT DEFAULT 'default',
  calibration_key             TEXT DEFAULT 'default',
  crop_type                   TEXT,
  variety                     TEXT,
  soil_type                   TEXT,
  irrigation_method           TEXT,
  notes                       TEXT,
  prediction_card_enabled     INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX        idx_irrigation_zones_user_id      ON irrigation_zones(user_id);
CREATE INDEX        idx_irrigation_zones_user_deleted  ON irrigation_zones(user_id, deleted_at);
CREATE UNIQUE INDEX idx_irrigation_zones_zone_uuid    ON irrigation_zones(zone_uuid);

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id                                    INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui                                TEXT UNIQUE NOT NULL,
  name                                  TEXT NOT NULL,
  type_id                               TEXT NOT NULL CHECK(type_id IN (
                                          'KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50',
                                          'TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN')),
  user_id                               INTEGER NULL,
  farm_id                               TEXT NULL,
  current_state                         TEXT CHECK(current_state IN ('OPEN','CLOSED')),
  target_state                          TEXT CHECK(target_state IN ('OPEN','CLOSED')),
  created_at                            TEXT NOT NULL,
  updated_at                            TEXT NOT NULL,
  claimed_at                            TEXT NULL,
  chirpstack_app_id                     TEXT,
  irrigation_zone_id                    INTEGER REFERENCES irrigation_zones(id) ON DELETE SET NULL,
  dendro_enabled                        INTEGER NOT NULL DEFAULT 0,
  temp_enabled                          INTEGER NOT NULL DEFAULT 0,
  is_reference_tree                     INTEGER NOT NULL DEFAULT 0,
  sync_version                          INTEGER DEFAULT 0,
  deleted_at                            DATETIME,
  gateway_device_eui                    TEXT,
  strega_model                          TEXT,
  rain_gauge_enabled                    INTEGER DEFAULT 0,
  flow_meter_enabled                    INTEGER DEFAULT 0,
  soil_moisture_probe_depths_json       TEXT,
  soil_moisture_probe_depths_configured INTEGER DEFAULT 0,
  dendro_ratio_at_retracted             REAL,
  dendro_ratio_at_extended              REAL,
  dendro_force_legacy                   INTEGER DEFAULT 0,
  dendro_stroke_mm                      REAL,
  dendro_ratio_zero                     REAL,
  dendro_ratio_span                     REAL,
  dendro_baseline_position_mm           REAL,
  dendro_baseline_mode_used             TEXT,
  dendro_baseline_calibration_signature TEXT,
  dendro_baseline_pending               INTEGER DEFAULT 0,
  dendro_invert_direction               INTEGER DEFAULT 0,
  device_mode                           INTEGER DEFAULT 1,
  chameleon_enabled                     INTEGER DEFAULT 0,
  chameleon_swt1_depth_cm               REAL,
  chameleon_swt2_depth_cm               REAL,
  chameleon_swt3_depth_cm               REAL,
  FOREIGN KEY (user_id)  REFERENCES users(id)             ON DELETE SET NULL,
  FOREIGN KEY (farm_id)  REFERENCES farms(farm_id)        ON DELETE SET NULL
);

CREATE INDEX idx_devices_user_id          ON devices(user_id);
CREATE INDEX idx_devices_deveui           ON devices(deveui);
CREATE INDEX idx_devices_farm_id          ON devices(farm_id);
CREATE INDEX idx_devices_irrigation_zone_id ON devices(irrigation_zone_id);

-- ---------------------------------------------------------------------------
-- irrigation_schedules
-- ---------------------------------------------------------------------------
CREATE TABLE irrigation_schedules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  irrigation_zone_id  INTEGER NOT NULL,
  trigger_metric      TEXT NOT NULL CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG')),
  threshold_kpa       REAL NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_triggered_at   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  duration_minutes    INTEGER,
  response_mode       TEXT,
  sync_version        INTEGER DEFAULT 0,
  deleted_at          DATETIME,
  last_applied_at     DATETIME,
  FOREIGN KEY (irrigation_zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  UNIQUE (irrigation_zone_id)
);

-- ---------------------------------------------------------------------------
-- device_data
-- ---------------------------------------------------------------------------
CREATE TABLE device_data (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui                    TEXT NOT NULL,
  swt_wm1                   REAL,
  swt_wm2                   REAL,
  light_lux                 REAL,
  recorded_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ambient_temperature       REAL,
  relative_humidity         REAL,
  ext_temperature_c         REAL,
  bat_v                     REAL,
  adc_ch0v                  REAL,
  dendro_position_mm        REAL,
  dendro_valid              INTEGER,
  dendro_delta_mm           REAL,
  lsn50_mode_code           INTEGER,
  lsn50_mode_label          TEXT,
  lsn50_mode_observed_at    TEXT,
  rain_mm_per_hour          REAL,
  rain_delta_status         TEXT,
  flow_liters_per_min       REAL,
  rain_mm_per_10min         REAL,
  rain_mm_today             REAL,
  flow_liters_per_10min     REAL,
  flow_liters_today         REAL,
  flow_delta_status         TEXT,
  counter_interval_seconds  INTEGER,
  barometric_pressure_hpa   REAL,
  wind_speed_mps            REAL,
  wind_direction_deg        REAL,
  wind_gust_mps             REAL,
  uv_index                  REAL,
  rain_gauge_cumulative_mm  REAL,
  bat_pct                   REAL,
  rain_count_cumulative     INTEGER,
  rain_tips_delta           INTEGER,
  rain_mm_delta             REAL,
  flow_count_cumulative     INTEGER,
  flow_pulses_delta         INTEGER,
  flow_liters_delta         REAL,
  swt_1                     REAL,
  swt_2                     REAL,
  swt_3                     REAL,
  adc_ch1v                  REAL,
  dendro_ratio              REAL,
  dendro_mode_used          TEXT,
  dendro_stem_change_um     REAL,
  dendro_position_raw_mm    REAL,
  dendro_saturated          INTEGER DEFAULT 0,
  dendro_saturation_side    TEXT,
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
);

CREATE INDEX idx_device_data_deveui      ON device_data(deveui);
CREATE INDEX idx_device_data_recorded_at ON device_data(recorded_at);
CREATE INDEX idx_device_data_deveui_recorded_at ON device_data(deveui, recorded_at);

-- ---------------------------------------------------------------------------
-- irrigation_events
-- ---------------------------------------------------------------------------
CREATE TABLE irrigation_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL,
  irrigation_zone_id INTEGER NOT NULL,
  action             TEXT NOT NULL,
  reason             TEXT,
  aggregate_kpa      REAL,
  threshold_kpa      REAL,
  duration_minutes   INTEGER,
  valve_deveui       TEXT,
  payload_json       TEXT,
  event_uuid         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)            REFERENCES users(id),
  FOREIGN KEY (irrigation_zone_id) REFERENCES irrigation_zones(id)
);

CREATE INDEX idx_irrig_events_user_created_at ON irrigation_events(user_id, created_at);
CREATE INDEX idx_irrig_events_zone_created_at ON irrigation_events(irrigation_zone_id, created_at);
CREATE INDEX idx_irrig_events_created_at      ON irrigation_events(created_at);
CREATE INDEX idx_irrigation_events_zone_id    ON irrigation_events(irrigation_zone_id, id DESC);
CREATE UNIQUE INDEX idx_irrigation_events_event_uuid ON irrigation_events(event_uuid);

CREATE TRIGGER trg_sync_irrigation_events_uuid_ai
AFTER INSERT ON irrigation_events
FOR EACH ROW
WHEN NEW.event_uuid IS NULL OR NEW.event_uuid = ''
BEGIN
  UPDATE irrigation_events
  SET event_uuid = 'irrig-' || COALESCE(
    (SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
    '0016C001F11715E2'
  ) || '-' || printf('%012d', NEW.id)
  WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- actuator_log
-- ---------------------------------------------------------------------------
CREATE TABLE actuator_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui             TEXT NOT NULL,
  action             TEXT NOT NULL,
  duration_minutes   INTEGER,
  reason             TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  irrigation_zone_id INTEGER
);

CREATE INDEX idx_actuator_log_deveui_created_at ON actuator_log(deveui, created_at);
CREATE INDEX idx_actuator_log_zone_time          ON actuator_log(irrigation_zone_id, created_at);

-- ---------------------------------------------------------------------------
-- dendrometer_readings
-- ---------------------------------------------------------------------------
CREATE TABLE dendrometer_readings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui                TEXT NOT NULL,
  position_um           REAL NOT NULL,
  adc_v                 REAL,
  bat_v                 REAL,
  is_valid              INTEGER NOT NULL DEFAULT 1,
  invalid_reason        TEXT,
  is_outlier            INTEGER NOT NULL DEFAULT 0,
  recorded_at           TEXT NOT NULL,
  adc_ch0v              REAL,
  adc_ch1v              REAL,
  dendro_ratio          REAL,
  dendro_mode_used      TEXT,
  position_raw_um       REAL,
  dendro_saturated      INTEGER DEFAULT 0,
  dendro_saturation_side TEXT,
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
);

CREATE INDEX idx_dendro_readings_deveui_time ON dendrometer_readings(deveui, recorded_at);

-- ---------------------------------------------------------------------------
-- dendrometer_daily
-- ---------------------------------------------------------------------------
CREATE TABLE dendrometer_daily (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui                      TEXT NOT NULL,
  date                        TEXT NOT NULL,
  d_max_um                    REAL,
  d_min_um                    REAL,
  mds_um                      REAL,
  tgr_um                      REAL,
  tgr_smoothed_um             REAL,
  twd_um                      REAL,
  dr_um                       REAL,
  recovery_delta_um           REAL,
  signal_intensity            REAL,
  stress_level                TEXT,
  data_quality                TEXT,
  valid_readings_count        INTEGER,
  computed_at                 TEXT NOT NULL,
  twd_night_um                REAL,
  twd_day_um                  REAL,
  twd_norm_night              REAL,
  twd_norm_day                REAL,
  mds_norm                    REAL,
  recovery_ratio              REAL,
  recovery_ratio_smoothed     REAL,
  r_delta_5day                REAL,
  delta_twd_smoothed          REAL,
  d_max_running_um            REAL,
  d_max_time                  TEXT,
  d_min_time                  TEXT,
  twd_episode_active          INTEGER DEFAULT 0,
  twd_episode_start           TEXT,
  twd_episode_max_um          REAL,
  envelope_ref_um             REAL,
  twd_method                  TEXT,
  confidence_score            REAL,
  qa_flags_json               TEXT,
  low_confidence_day          INTEGER DEFAULT 0,
  tree_state_v5               TEXT DEFAULT 'none',
  UNIQUE(deveui, date)
);

CREATE INDEX idx_dendro_daily_deveui      ON dendrometer_daily(deveui, date);
CREATE INDEX idx_dendro_daily_deveui_date ON dendrometer_daily(deveui, date);

-- ---------------------------------------------------------------------------
-- dendro_baselines
-- ---------------------------------------------------------------------------
CREATE TABLE dendro_baselines (
  deveui                  TEXT PRIMARY KEY,
  mds_max_reference_um    REAL,
  mds_mean_um             REAL,
  baseline_days           INTEGER DEFAULT 0,
  baseline_complete       INTEGER DEFAULT 0,
  sd_vpd_r2_baseline      REAL,
  sd_vpd_n_days           INTEGER DEFAULT 0,
  computed_at             TEXT,
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- weather_station_zones
-- ---------------------------------------------------------------------------
CREATE TABLE weather_station_zones (
  deveui     TEXT NOT NULL,
  zone_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (deveui, zone_id),
  FOREIGN KEY (deveui)  REFERENCES devices(deveui)          ON DELETE CASCADE,
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id)     ON DELETE CASCADE
);

CREATE INDEX idx_wsz_zone_id ON weather_station_zones(zone_id);

-- ---------------------------------------------------------------------------
-- zone_daily_recommendations
-- ---------------------------------------------------------------------------
CREATE TABLE zone_daily_recommendations (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id                     INTEGER NOT NULL,
  date                        TEXT NOT NULL,
  zone_stress_summary         TEXT,
  rainfall_mm                 REAL DEFAULT 0,
  water_delivered_liters      REAL DEFAULT 0,
  irrigation_action           TEXT,
  action_reasoning            TEXT,
  recommendation_json         TEXT,
  computed_at                 TEXT NOT NULL,
  irrigation_window_json      TEXT,
  rain_suppression_active     INTEGER DEFAULT 0,
  recovery_verification_active INTEGER DEFAULT 0,
  vpd_max_kpa                 REAL,
  vpd_source                  TEXT,
  usable_tree_count           INTEGER DEFAULT 0,
  low_confidence_tree_count   INTEGER DEFAULT 0,
  outlier_filtered_tree_count INTEGER DEFAULT 0,
  zone_confidence_score       REAL,
  UNIQUE(zone_id, date)
);

CREATE INDEX idx_zone_rec_zone_date  ON zone_daily_recommendations(zone_id, date);
CREATE INDEX idx_zone_recs_zone_date ON zone_daily_recommendations(zone_id, date);

-- ---------------------------------------------------------------------------
-- zone_daily_environment
-- ---------------------------------------------------------------------------
CREATE TABLE zone_daily_environment (
  zone_id      INTEGER NOT NULL,
  date         TEXT NOT NULL,
  rainfall_mm  REAL DEFAULT 0,
  flow_liters  REAL DEFAULT 0,
  rain_source  TEXT DEFAULT 'none',
  computed_at  TEXT,
  UNIQUE(zone_id, date),
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- zone_irrigation_state
-- ---------------------------------------------------------------------------
CREATE TABLE zone_irrigation_state (
  zone_id                      INTEGER PRIMARY KEY,
  rain_suppression_active      INTEGER DEFAULT 0,
  rain_suppression_start       TEXT,
  rain_suppression_timeout_h   INTEGER DEFAULT 48,
  pre_rain_twd_norm_avg        REAL,
  recovery_verification_active INTEGER DEFAULT 0,
  recovery_verification_start  TEXT,
  recovery_verification_deadline TEXT,
  consecutive_increases        INTEGER DEFAULT 0,
  last_volume_change_at        TEXT,
  current_volume_liters        REAL DEFAULT 0,
  updated_at                   TEXT
);

-- ---------------------------------------------------------------------------
-- zone_weather_cache
-- ---------------------------------------------------------------------------
CREATE TABLE zone_weather_cache (
  zone_id      INTEGER NOT NULL,
  cache_key    TEXT NOT NULL,
  source       TEXT,
  payload_json TEXT NOT NULL,
  observed_at  TEXT,
  fetched_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (zone_id, cache_key),
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- zone_shared_environment
-- ---------------------------------------------------------------------------
CREATE TABLE zone_shared_environment (
  zone_uuid            TEXT PRIMARY KEY,
  zone_id              INTEGER,
  gateway_device_eui   TEXT,
  summary_json         TEXT NOT NULL,
  shared_generated_at  TEXT,
  shared_observed_at   TEXT,
  last_received_at     TEXT NOT NULL,
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
);

CREATE INDEX idx_zone_shared_environment_zone_id      ON zone_shared_environment(zone_id);
CREATE INDEX idx_zone_shared_environment_received_at  ON zone_shared_environment(last_received_at);

-- ---------------------------------------------------------------------------
-- sync_outbox  (includes WS2 v2 columns: rejected_at, rejection_reason,
--               last_retryable_failure_at)
-- ---------------------------------------------------------------------------
CREATE TABLE sync_outbox (
  event_uuid                TEXT PRIMARY KEY,
  aggregate_type            TEXT NOT NULL,
  aggregate_key             TEXT NOT NULL,
  op                        TEXT NOT NULL,
  payload_json              TEXT NOT NULL,
  sync_version              INTEGER NOT NULL DEFAULT 0,
  occurred_at               TEXT NOT NULL,
  delivered_at              TEXT,
  retry_count               INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui        TEXT,
  rejected_at               TEXT,
  rejection_reason          TEXT,
  last_retryable_failure_at TEXT
);

CREATE INDEX idx_sync_outbox_pending ON sync_outbox(delivered_at, occurred_at);

-- ---------------------------------------------------------------------------
-- sync_inbox
-- ---------------------------------------------------------------------------
CREATE TABLE sync_inbox (
  event_uuid    TEXT PRIMARY KEY,
  processed_at  TEXT NOT NULL,
  source_node   TEXT
);

-- ---------------------------------------------------------------------------
-- sync_cursor
-- ---------------------------------------------------------------------------
CREATE TABLE sync_cursor (
  peer_node            TEXT PRIMARY KEY,
  last_event_at        TEXT,
  last_event_uuid      TEXT,
  last_full_backfill_at TEXT
);

CREATE TABLE sync_link_state (
  peer_node TEXT PRIMARY KEY,
  linked INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  cloud_user_id TEXT,
  gateway_device_eui TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_history_cursors (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'backfill',
  snapshot_high_id INTEGER,
  last_acked_id INTEGER,
  last_acked_key TEXT,
  backfill_started_at TEXT,
  backfill_completed_at TEXT,
  last_batch_id TEXT,
  last_batch_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name)
);

CREATE TABLE sync_history_dirty_keys (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  change_kind TEXT NOT NULL DEFAULT 'correction',
  source_row_id INTEGER,
  changed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name, row_key)
);

CREATE TABLE sync_history_segments (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  hash_version INTEGER NOT NULL,
  canonical_row_count INTEGER NOT NULL,
  syncable_row_count INTEGER NOT NULL,
  syncable_payload_hash TEXT NOT NULL,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  covered_max_id INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (peer_node, table_name, segment_key, hash_version)
);

CREATE TABLE sync_history_quarantine (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  history_key TEXT NOT NULL,
  payload_hash TEXT,
  reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (peer_node, table_name, history_key)
);

-- ---------------------------------------------------------------------------
-- chameleon_readings
-- ---------------------------------------------------------------------------
CREATE TABLE chameleon_readings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui          TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  payload_version INTEGER,
  status_flags    INTEGER,
  i2c_missing     INTEGER DEFAULT 0,
  timeout         INTEGER DEFAULT 0,
  temp_fault      INTEGER DEFAULT 0,
  id_fault        INTEGER DEFAULT 0,
  ch1_open        INTEGER DEFAULT 0,
  ch2_open        INTEGER DEFAULT 0,
  ch3_open        INTEGER DEFAULT 0,
  temp_c          REAL,
  r1_ohm_comp     INTEGER,
  r2_ohm_comp     INTEGER,
  r3_ohm_comp     INTEGER,
  r1_ohm_raw      INTEGER,
  r2_ohm_raw      INTEGER,
  r3_ohm_raw      INTEGER,
  array_id        TEXT,
  adc_ch0v        REAL,
  adc_ch1v        REAL,
  adc_ch4v        REAL,
  bat_v           REAL,
  payload_b64     TEXT,
  f_port          INTEGER,
  f_cnt           INTEGER,
  calibration_status TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
);

CREATE INDEX idx_chameleon_readings_deveui_time ON chameleon_readings(deveui, recorded_at);
CREATE INDEX idx_chameleon_readings_array_id    ON chameleon_readings(array_id);

-- ---------------------------------------------------------------------------
-- chameleon_calibrations  (global calibration table keyed by array_id)
-- ---------------------------------------------------------------------------
CREATE TABLE chameleon_calibrations (
  array_id                TEXT PRIMARY KEY,
  sensor_id               TEXT NOT NULL,
  sensor1_a               REAL NOT NULL,
  sensor1_b               REAL NOT NULL,
  sensor1_c               REAL NOT NULL,
  sensor1_r2              REAL,
  sensor2_a               REAL NOT NULL,
  sensor2_b               REAL NOT NULL,
  sensor2_c               REAL NOT NULL,
  sensor2_r2              REAL,
  sensor3_a               REAL NOT NULL,
  sensor3_b               REAL NOT NULL,
  sensor3_c               REAL NOT NULL,
  sensor3_r2              REAL,
  test_rig_run_start_date TEXT,
  source                  TEXT NOT NULL,
  fetched_at              TEXT NOT NULL
);
CREATE INDEX idx_chameleon_calibrations_sensor_id
  ON chameleon_calibrations(sensor_id);

-- ---------------------------------------------------------------------------
-- chameleon_calibration_misses  (negative cache, 24h TTL)
-- ---------------------------------------------------------------------------
CREATE TABLE chameleon_calibration_misses (
  array_id   TEXT PRIMARY KEY,
  last_tried TEXT NOT NULL,
  reason     TEXT
);

-- ---------------------------------------------------------------------------
-- zone_seasons  (history data visualization foundation)
-- ---------------------------------------------------------------------------
CREATE TABLE zone_seasons (
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

CREATE INDEX idx_zone_seasons_zone_range
  ON zone_seasons(zone_id, starts_on, ends_on);
CREATE INDEX idx_zone_seasons_zone_active
  ON zone_seasons(zone_id, is_active, starts_on, ends_on);
CREATE UNIQUE INDEX idx_zone_seasons_zone_active_unique
  ON zone_seasons(zone_id)
  WHERE is_active = 1;
CREATE UNIQUE INDEX idx_zone_seasons_zone_default
  ON zone_seasons(zone_id)
  WHERE is_default = 1;
CREATE UNIQUE INDEX idx_zone_seasons_uuid
  ON zone_seasons(season_uuid)
  WHERE season_uuid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- history_channel_rollups  (edge 30D/Season rollups)
-- ---------------------------------------------------------------------------
CREATE TABLE history_channel_rollups (
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

CREATE UNIQUE INDEX idx_history_rollups_unique_bucket
  ON history_channel_rollups(zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start);
CREATE INDEX idx_history_rollups_zone_card_bucket
  ON history_channel_rollups(zone_id, card_type, bucket_level, bucket_start, bucket_end);
CREATE INDEX idx_history_rollups_source_channel
  ON history_channel_rollups(logical_source_key, channel_id, bucket_level, bucket_start);

-- ---------------------------------------------------------------------------
-- history_card_preferences  (local-only edge MVP)
-- ---------------------------------------------------------------------------
CREATE TABLE history_card_preferences (
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

CREATE UNIQUE INDEX idx_history_card_preferences_zone
  ON history_card_preferences(user_id, zone_id, card_id)
  WHERE scope_type = 'zone';
CREATE UNIQUE INDEX idx_history_card_preferences_gateway
  ON history_card_preferences(user_id, gateway_eui, card_id)
  WHERE scope_type = 'gateway';

-- ---------------------------------------------------------------------------
-- history_workspaces  (local-only edge MVP)
-- ---------------------------------------------------------------------------
CREATE TABLE history_workspaces (
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

CREATE INDEX idx_history_workspaces_user_zone
  ON history_workspaces(user_id, zone_id);
CREATE UNIQUE INDEX idx_history_workspaces_user_default
  ON history_workspaces(user_id, zone_id)
  WHERE is_default = 1;
CREATE UNIQUE INDEX idx_history_workspaces_user_global_default
  ON history_workspaces(user_id)
  WHERE is_default = 1 AND zone_id IS NULL;

-- ---------------------------------------------------------------------------
-- applied_commands  (WS3 — includes retry columns from the start)
-- ---------------------------------------------------------------------------
CREATE TABLE applied_commands (
  command_id          TEXT PRIMARY KEY,
  device_eui          TEXT NOT NULL,
  command_type        TEXT NOT NULL,
  effect_key          TEXT,
  applied_at          TEXT NOT NULL,
  result              TEXT NOT NULL,
  result_detail       TEXT,
  originator          TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  last_ack_attempt_at TEXT,
  expires_at          TEXT
);

CREATE INDEX idx_applied_commands_device_eui ON applied_commands(device_eui);
CREATE INDEX idx_applied_commands_effect_key ON applied_commands(effect_key);
CREATE INDEX idx_applied_commands_applied_at ON applied_commands(applied_at);

-- ---------------------------------------------------------------------------
-- command_ack_outbox  (WS3)
-- ---------------------------------------------------------------------------
CREATE TABLE command_ack_outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);

CREATE INDEX idx_command_ack_outbox_pending    ON command_ack_outbox(delivered_at, created_at);
CREATE INDEX idx_command_ack_outbox_command_id ON command_ack_outbox(command_id);

-- ---------------------------------------------------------------------------
-- valve_actuation_expectations  (WS1)
-- ---------------------------------------------------------------------------
CREATE TABLE valve_actuation_expectations (
  expectation_id             TEXT PRIMARY KEY,
  device_eui                 TEXT NOT NULL,
  zone_id                    INTEGER,
  command_id                 TEXT,
  effect_key                 TEXT,
  commanded_at               TEXT NOT NULL,
  commanded_duration_seconds INTEGER NOT NULL,
  expected_close_at          TEXT NOT NULL,
  flow_rate_lpm              REAL,
  flow_rate_source           TEXT,
  estimated_gross_liters     REAL,
  volume_source              TEXT NOT NULL,
  observed_open_at           TEXT,
  observed_close_at          TEXT,
  reconciliation_state       TEXT NOT NULL DEFAULT 'PENDING_OBSERVATION',
  cancel_reason              TEXT,
  created_at                 TEXT NOT NULL
);

CREATE INDEX idx_valve_act_exp_device_eui ON valve_actuation_expectations(device_eui);
CREATE INDEX idx_valve_act_exp_active
  ON valve_actuation_expectations(reconciliation_state)
  WHERE reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING');
CREATE INDEX idx_valve_act_exp_effect_key ON valve_actuation_expectations(effect_key);

-- ---------------------------------------------------------------------------
-- zone_irrigation_calibration  (WS1)
-- ---------------------------------------------------------------------------
CREATE TABLE zone_irrigation_calibration (
  zone_id                INTEGER PRIMARY KEY,
  valve_device_eui       TEXT,
  measured_flow_rate_lpm REAL NOT NULL,
  measurement_method     TEXT NOT NULL,
  measured_at            TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- gateway_locations
-- ---------------------------------------------------------------------------
CREATE TABLE gateway_locations (
  gateway_device_eui         TEXT PRIMARY KEY,
  latitude                   REAL,
  longitude                  REAL,
  altitude_m                 REAL,
  accuracy_m                 REAL,
  hdop                       REAL,
  satellites                 INTEGER,
  fix_mode                   INTEGER,
  status                     TEXT NOT NULL DEFAULT 'no_fix',
  source                     TEXT NOT NULL DEFAULT 'gpsd',
  native_concentratord_status TEXT,
  chirpstack_mirror_status   TEXT,
  last_fix_at                TEXT,
  last_good_fix_at           TEXT,
  sync_version               INTEGER NOT NULL DEFAULT 0,
  updated_at                 TEXT NOT NULL
);

CREATE INDEX idx_gateway_locations_updated_at ON gateway_locations(updated_at);

-- ---------------------------------------------------------------------------
-- field_tester_uplinks
-- ---------------------------------------------------------------------------
CREATE TABLE field_tester_uplinks (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  deduplication_id     TEXT NOT NULL UNIQUE,
  ts                   TEXT NOT NULL,
  tenant_id            TEXT,
  application_id       TEXT,
  application_name     TEXT,
  device_profile_id    TEXT,
  device_profile_name  TEXT,
  device_name          TEXT,
  dev_eui              TEXT NOT NULL,
  dev_addr             TEXT,
  adr                  INTEGER,
  dr                   INTEGER,
  f_cnt                INTEGER,
  f_port               INTEGER,
  confirmed            INTEGER,
  region               TEXT,
  frequency_hz         INTEGER,
  bandwidth_hz         INTEGER,
  spreading_factor     INTEGER,
  code_rate            TEXT,
  payload_b64          TEXT NOT NULL,
  payload_hex          TEXT,
  latitude             REAL,
  longitude            REAL,
  altitude_m           REAL,
  hdop                 REAL,
  sats                 INTEGER,
  accuracy_m           REAL,
  decode_ok            INTEGER,
  decode_error         TEXT
);

CREATE INDEX ix_ft_uplinks_dev ON field_tester_uplinks(dev_eui, ts);
CREATE INDEX ix_ft_uplinks_ts  ON field_tester_uplinks(ts);
CREATE INDEX idx_ft_uplinks_dev_ts ON field_tester_uplinks(dev_eui, ts);

-- ---------------------------------------------------------------------------
-- field_tester_rxinfo
-- ---------------------------------------------------------------------------
CREATE TABLE field_tester_rxinfo (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  deduplication_id  TEXT NOT NULL,
  gateway_id        TEXT NOT NULL,
  uplink_id_num     INTEGER,
  ns_time           TEXT,
  rssi_dbm          INTEGER,
  snr_db            REAL,
  channel           INTEGER,
  crc_status        TEXT,
  context_b64       TEXT,
  FOREIGN KEY (deduplication_id) REFERENCES field_tester_uplinks(deduplication_id)
);

CREATE INDEX        idx_ft_rx_dedup   ON field_tester_rxinfo(deduplication_id);
CREATE INDEX        idx_ft_rx_gateway ON field_tester_rxinfo(gateway_id);
CREATE UNIQUE INDEX uq_ft_rx_unique
  ON field_tester_rxinfo(deduplication_id, gateway_id, uplink_id_num);

-- ===========================================================================
--  TRIGGERS  (verbatim from Silvan production, 2026-05-18)
-- ===========================================================================

-- Backfill dendro readings from device_data inserts
CREATE TRIGGER sync_dendro_to_readings
AFTER INSERT ON device_data
WHEN NEW.dendro_position_mm IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO dendrometer_readings(
    deveui, position_um, adc_v, adc_ch0v, adc_ch1v,
    dendro_ratio, dendro_mode_used, bat_v, is_valid, recorded_at
  ) VALUES (
    NEW.deveui,
    ROUND(NEW.dendro_position_mm * 1000),
    NEW.adc_ch0v, NEW.adc_ch0v, NEW.adc_ch1v,
    NEW.dendro_ratio, NEW.dendro_mode_used,
    NEW.bat_v, COALESCE(NEW.dendro_valid, 1), NEW.recorded_at
  );
END;

-- Assign uuid on user insert
CREATE TRIGGER trg_sync_users_uuid_ai
AFTER INSERT ON users
FOR EACH ROW
WHEN NEW.user_uuid IS NULL OR NEW.user_uuid = ''
BEGIN
  UPDATE users SET user_uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

-- Zone defaults on insert
CREATE TRIGGER trg_sync_zones_defaults_ai
AFTER INSERT ON irrigation_zones
FOR EACH ROW
BEGIN
  UPDATE irrigation_zones
  SET
    zone_uuid              = COALESCE(zone_uuid, lower(hex(randomblob(16)))),
    gateway_device_eui     = COALESCE(gateway_device_eui, '0016C001F11715E2'),
    sync_version           = CASE WHEN COALESCE(sync_version,0)=0 THEN 1 ELSE sync_version END,
    prediction_card_enabled = COALESCE(prediction_card_enabled, 0)
  WHERE id = NEW.id;
END;

-- Zone outbox on update
CREATE TRIGGER trg_sync_zones_outbox_au
AFTER UPDATE ON irrigation_zones
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND (
    COALESCE(NEW.name,'') <> COALESCE(OLD.name,'') OR
    COALESCE(NEW.zone_uuid,'') <> COALESCE(OLD.zone_uuid,'') OR
    COALESCE(NEW.gateway_device_eui,'') <> COALESCE(OLD.gateway_device_eui,'') OR
    COALESCE(NEW.timezone,'') <> COALESCE(OLD.timezone,'') OR
    COALESCE(NEW.latitude,'') <> COALESCE(OLD.latitude,'') OR
    COALESCE(NEW.longitude,'') <> COALESCE(OLD.longitude,'') OR
    COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'') OR
    COALESCE(NEW.calibration_key,'') <> COALESCE(OLD.calibration_key,'') OR
    COALESCE(NEW.crop_type,'') <> COALESCE(OLD.crop_type,'') OR
    COALESCE(NEW.variety,'') <> COALESCE(OLD.variety,'') OR
    COALESCE(NEW.soil_type,'') <> COALESCE(OLD.soil_type,'') OR
    COALESCE(NEW.irrigation_method,'') <> COALESCE(OLD.irrigation_method,'') OR
    COALESCE(NEW.area_m2,'') <> COALESCE(OLD.area_m2,'') OR
    COALESCE(NEW.irrigation_efficiency_pct,'') <> COALESCE(OLD.irrigation_efficiency_pct,'') OR
    COALESCE(NEW.scheduling_mode,'local') <> COALESCE(OLD.scheduling_mode,'local') OR
    COALESCE(NEW.prediction_card_enabled,0) <> COALESCE(OLD.prediction_card_enabled,0) OR
    COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE',
    COALESCE(NEW.zone_uuid, lower(hex(randomblob(16)))),
    CASE WHEN NEW.deleted_at IS NOT NULL THEN 'ZONE_DELETED' ELSE 'ZONE_UPSERTED' END,
    json_object(
      'zone_uuid',                NEW.zone_uuid,
      'name',                     NEW.name,
      'gateway_device_eui',       COALESCE(NEW.gateway_device_eui,'0016C001F11715E2'),
      'timezone',                 NEW.timezone,
      'latitude',                 NEW.latitude,
      'longitude',                NEW.longitude,
      'phenological_stage',       NEW.phenological_stage,
      'calibration_key',          NEW.calibration_key,
      'crop_type',                NEW.crop_type,
      'variety',                  NEW.variety,
      'soil_type',                NEW.soil_type,
      'irrigation_method',        NEW.irrigation_method,
      'area_m2',                  NEW.area_m2,
      'irrigation_efficiency_pct', NEW.irrigation_efficiency_pct,
      'scheduling_mode',          COALESCE(NEW.scheduling_mode,'local'),
      'prediction_card_enabled',  COALESCE(NEW.prediction_card_enabled,0),
      'notes',                    NEW.notes,
      'sync_version',             NEW.sync_version,
      'deleted_at',               NEW.deleted_at,
      'user', json_object(
        'user_uuid',  (SELECT user_uuid FROM users WHERE id = NEW.user_id),
        'username',   (SELECT username   FROM users WHERE id = NEW.user_id),
        'cloudUserId',(SELECT cloud_user_id FROM users WHERE id = NEW.user_id)
      )
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(NEW.gateway_device_eui,'0016C001F11715E2')
  );
END;

-- Device defaults on insert
CREATE TRIGGER trg_sync_devices_defaults_ai
AFTER INSERT ON devices
FOR EACH ROW
BEGIN
  UPDATE devices
  SET
    gateway_device_eui = COALESCE(gateway_device_eui, '0016C001F11715E2'),
    sync_version       = CASE WHEN COALESCE(sync_version,0)=0 THEN 1 ELSE sync_version END
  WHERE deveui = NEW.deveui;
END;

-- Device outbox on update
CREATE TRIGGER trg_sync_devices_outbox_au
AFTER UPDATE ON devices
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND (
    COALESCE(NEW.user_id,'') <> COALESCE(OLD.user_id,'') OR
    COALESCE(NEW.irrigation_zone_id,'') <> COALESCE(OLD.irrigation_zone_id,'') OR
    COALESCE(NEW.dendro_enabled,0) <> COALESCE(OLD.dendro_enabled,0) OR
    COALESCE(NEW.temp_enabled,0) <> COALESCE(OLD.temp_enabled,0) OR
    COALESCE(NEW.rain_gauge_enabled,0) <> COALESCE(OLD.rain_gauge_enabled,0) OR
    COALESCE(NEW.flow_meter_enabled,0) <> COALESCE(OLD.flow_meter_enabled,0) OR
    COALESCE(NEW.is_reference_tree,0) <> COALESCE(OLD.is_reference_tree,0) OR
    COALESCE(NEW.name,'') <> COALESCE(OLD.name,'') OR
    COALESCE(NEW.strega_model,'') <> COALESCE(OLD.strega_model,'') OR
    COALESCE(NEW.soil_moisture_probe_depths_json,'') <> COALESCE(OLD.soil_moisture_probe_depths_json,'') OR
    COALESCE(NEW.soil_moisture_probe_depths_configured,0) <> COALESCE(OLD.soil_moisture_probe_depths_configured,0) OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'DEVICE',
    NEW.deveui,
    CASE
      WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN 'DEVICE_UNCLAIMED'
      WHEN COALESCE(OLD.irrigation_zone_id,'') <> COALESCE(NEW.irrigation_zone_id,'') AND NEW.irrigation_zone_id IS NULL THEN 'DEVICE_UNASSIGNED'
      WHEN COALESCE(OLD.irrigation_zone_id,'') <> COALESCE(NEW.irrigation_zone_id,'') AND NEW.irrigation_zone_id IS NOT NULL THEN 'DEVICE_ASSIGNED'
      ELSE 'DEVICE_FLAGS_UPDATED'
    END,
    json_object(
      'device_eui',                        NEW.deveui,
      'name',                              NEW.name,
      'type',                              NEW.type_id,
      'claimed_user_uuid',                 (SELECT user_uuid FROM users WHERE id = NEW.user_id),
      'claimed_by_username',               (SELECT COALESCE(server_username,username) FROM users WHERE id = NEW.user_id),
      'zone_uuid',                         (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
      'dendro_enabled',                    NEW.dendro_enabled,
      'temp_enabled',                      NEW.temp_enabled,
      'rain_gauge_enabled',                NEW.rain_gauge_enabled,
      'flow_meter_enabled',                NEW.flow_meter_enabled,
      'is_reference_tree',                 NEW.is_reference_tree,
      'current_state',                     NEW.current_state,
      'target_state',                      NEW.target_state,
      'strega_model',                      NEW.strega_model,
      'soil_moisture_probe_depths_json',   json(COALESCE(NEW.soil_moisture_probe_depths_json,'{}')),
      'soil_moisture_probe_depths_configured', COALESCE(NEW.soil_moisture_probe_depths_configured,0),
      'gateway_device_eui',                COALESCE(NEW.gateway_device_eui,'0016C001F11715E2'),
      'sync_version',                      NEW.sync_version,
      'deleted_at',                        NEW.deleted_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(NEW.gateway_device_eui,'0016C001F11715E2')
  );
END;

-- Schedule defaults on insert
CREATE TRIGGER trg_sync_schedules_defaults_ai
AFTER INSERT ON irrigation_schedules
FOR EACH ROW
BEGIN
  UPDATE irrigation_schedules
  SET
    sync_version  = CASE WHEN COALESCE(sync_version,0)=0 THEN 1 ELSE sync_version END,
    response_mode = COALESCE(response_mode,'proportional')
  WHERE id = NEW.id;
END;

-- Schedule outbox on update
CREATE TRIGGER trg_sync_schedules_outbox_au
AFTER UPDATE ON irrigation_schedules
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND (
    COALESCE(NEW.trigger_metric,'') <> COALESCE(OLD.trigger_metric,'') OR
    COALESCE(NEW.threshold_kpa,0) <> COALESCE(OLD.threshold_kpa,0) OR
    COALESCE(NEW.enabled,0) <> COALESCE(OLD.enabled,0) OR
    COALESCE(NEW.duration_minutes,0) <> COALESCE(OLD.duration_minutes,0) OR
    COALESCE(NEW.response_mode,'') <> COALESCE(OLD.response_mode,'') OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'SCHEDULE',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),''),
    'SCHEDULE_UPSERTED',
    json_object(
      'zone_uuid',       (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
      'trigger_metric',  NEW.trigger_metric,
      'threshold_kpa',   NEW.threshold_kpa,
      'enabled',         NEW.enabled,
      'duration_minutes', NEW.duration_minutes,
      'response_mode',   NEW.response_mode,
      'sync_version',    NEW.sync_version,
      'deleted_at',      NEW.deleted_at,
      'last_applied_at', NEW.last_applied_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)
  );
END;

-- Raw-history correction dirty keys
CREATE TRIGGER trg_sync_device_data_dirty_au
AFTER UPDATE ON device_data
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'device_data',
    'DEVICE_DATA|' || COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') || '|' || NEW.id,
    'correction',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_chameleon_readings_dirty_au
AFTER UPDATE ON chameleon_readings
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'chameleon_readings',
    'CHAMELEON_READING|' || COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') || '|' || NEW.id,
    'correction',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_dendro_readings_dirty_au
AFTER UPDATE ON dendrometer_readings
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'dendrometer_readings',
    'DENDRO_READING|' || COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') || '|' || NEW.id,
    'correction',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

-- Derived-history dirty keys
CREATE TRIGGER trg_sync_zone_env_dirty_ai
AFTER INSERT ON zone_daily_environment
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, changed_at)
  VALUES(
    'cloud',
    'zone_daily_environment',
    'ZONE_ENVIRONMENT|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), '') || '|' || NEW.date,
    'upsert',
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_zone_env_dirty_au
AFTER UPDATE ON zone_daily_environment
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, changed_at)
  VALUES(
    'cloud',
    'zone_daily_environment',
    'ZONE_ENVIRONMENT|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), '') || '|' || NEW.date,
    'upsert',
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_zone_recs_dirty_ai
AFTER INSERT ON zone_daily_recommendations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'zone_daily_recommendations',
    'ZONE_RECOMMENDATION|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), '') || '|' || NEW.date,
    'upsert',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_zone_recs_dirty_au
AFTER UPDATE ON zone_daily_recommendations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'zone_daily_recommendations',
    'ZONE_RECOMMENDATION|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), '') || '|' || NEW.date,
    'upsert',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_dendro_daily_dirty_ai
AFTER INSERT ON dendrometer_daily
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'dendrometer_daily',
    'DENDRO_DAILY|' || NEW.deveui || '|' || NEW.date,
    'upsert',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_dendro_daily_dirty_au
AFTER UPDATE ON dendrometer_daily
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'dendrometer_daily',
    'DENDRO_DAILY|' || NEW.deveui || '|' || NEW.date,
    'upsert',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;



-- dendrometer_daily → sync_outbox (insert)
CREATE TRIGGER trg_dp_dendro_daily_outbox_ai
AFTER INSERT ON dendrometer_daily
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'DENDRO_DAILY',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.date,''),
    'DENDRO_DAILY_UPSERTED',
    json_object(
      'device_eui',            NEW.deveui,
      'zone_id',               (SELECT irrigation_zone_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_uuid',             (SELECT iz.zone_uuid FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id AND iz.deleted_at IS NULL WHERE d.deveui=NEW.deveui AND d.deleted_at IS NULL),
      'gateway_device_eui',    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2'),
      'date',                  NEW.date,
      'd_max_um',              NEW.d_max_um,
      'd_min_um',              NEW.d_min_um,
      'mds_um',                NEW.mds_um,
      'tgr_um',                NEW.tgr_um,
      'tgr_smoothed_um',       NEW.tgr_smoothed_um,
      'twd_um',                NEW.twd_um,
      'dr_um',                 NEW.dr_um,
      'recovery_delta_um',     NEW.recovery_delta_um,
      'signal_intensity',      NEW.signal_intensity,
      'stress_level',          NEW.stress_level,
      'data_quality',          NEW.data_quality,
      'valid_readings_count',  NEW.valid_readings_count,
      'd_max_time',            NEW.d_max_time,
      'd_min_time',            NEW.d_min_time,
      'twd_night_um',          NEW.twd_night_um,
      'twd_day_um',            NEW.twd_day_um,
      'twd_norm_night',        NEW.twd_norm_night,
      'twd_norm_day',          NEW.twd_norm_day,
      'mds_norm',              NEW.mds_norm,
      'recovery_ratio',        NEW.recovery_ratio,
      'recovery_ratio_smoothed', NEW.recovery_ratio_smoothed,
      'r_delta_5day',          NEW.r_delta_5day,
      'delta_twd_smoothed',    NEW.delta_twd_smoothed,
      'd_max_running_um',      NEW.d_max_running_um,
      'twd_episode_active',    NEW.twd_episode_active,
      'twd_episode_start',     NEW.twd_episode_start,
      'twd_episode_max_um',    NEW.twd_episode_max_um,
      'envelope_ref_um',       NEW.envelope_ref_um,
      'twd_method',            NEW.twd_method,
      'confidence_score',      NEW.confidence_score,
      'qa_flags_json',         NEW.qa_flags_json,
      'low_confidence_day',    NEW.low_confidence_day,
      'tree_state_v5',         NEW.tree_state_v5,
      'computed_at',           NEW.computed_at
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- dendrometer_daily → sync_outbox (update)
CREATE TRIGGER trg_dp_dendro_daily_outbox_au
AFTER UPDATE ON dendrometer_daily
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'DENDRO_DAILY',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.date,''),
    'DENDRO_DAILY_UPSERTED',
    json_object(
      'device_eui',            NEW.deveui,
      'zone_id',               (SELECT irrigation_zone_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_uuid',             (SELECT iz.zone_uuid FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id AND iz.deleted_at IS NULL WHERE d.deveui=NEW.deveui AND d.deleted_at IS NULL),
      'gateway_device_eui',    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2'),
      'date',                  NEW.date,
      'd_max_um',              NEW.d_max_um,
      'd_min_um',              NEW.d_min_um,
      'mds_um',                NEW.mds_um,
      'tgr_um',                NEW.tgr_um,
      'tgr_smoothed_um',       NEW.tgr_smoothed_um,
      'twd_um',                NEW.twd_um,
      'dr_um',                 NEW.dr_um,
      'recovery_delta_um',     NEW.recovery_delta_um,
      'signal_intensity',      NEW.signal_intensity,
      'stress_level',          NEW.stress_level,
      'data_quality',          NEW.data_quality,
      'valid_readings_count',  NEW.valid_readings_count,
      'd_max_time',            NEW.d_max_time,
      'd_min_time',            NEW.d_min_time,
      'twd_night_um',          NEW.twd_night_um,
      'twd_day_um',            NEW.twd_day_um,
      'twd_norm_night',        NEW.twd_norm_night,
      'twd_norm_day',          NEW.twd_norm_day,
      'mds_norm',              NEW.mds_norm,
      'recovery_ratio',        NEW.recovery_ratio,
      'recovery_ratio_smoothed', NEW.recovery_ratio_smoothed,
      'r_delta_5day',          NEW.r_delta_5day,
      'delta_twd_smoothed',    NEW.delta_twd_smoothed,
      'd_max_running_um',      NEW.d_max_running_um,
      'twd_episode_active',    NEW.twd_episode_active,
      'twd_episode_start',     NEW.twd_episode_start,
      'twd_episode_max_um',    NEW.twd_episode_max_um,
      'envelope_ref_um',       NEW.envelope_ref_um,
      'twd_method',            NEW.twd_method,
      'confidence_score',      NEW.confidence_score,
      'qa_flags_json',         NEW.qa_flags_json,
      'low_confidence_day',    NEW.low_confidence_day,
      'tree_state_v5',         NEW.tree_state_v5,
      'computed_at',           NEW.computed_at
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- irrigation_events → sync_outbox
CREATE TRIGGER trg_dp_irrigation_events_outbox_ai
AFTER INSERT ON irrigation_events
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_EVENT',
    CAST(NEW.id AS TEXT),
    'IRRIGATION_EVENT_APPENDED',
    json_object(
      'event_id',            NEW.id,
      'user_id',             NEW.user_id,
      'irrigation_zone_id',  NEW.irrigation_zone_id,
      'zone_uuid',           (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),
      'gateway_device_eui',  COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'action',              NEW.action,
      'reason',              NEW.reason,
      'aggregate_kpa',       NEW.aggregate_kpa,
      'threshold_kpa',       NEW.threshold_kpa,
      'duration_minutes',    NEW.duration_minutes,
      'valve_deveui',        NEW.valve_deveui,
      'payload_json',        NEW.payload_json
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- zone_daily_environment → sync_outbox (insert)
CREATE TRIGGER trg_dp_zone_env_outbox_ai
AFTER INSERT ON zone_daily_environment
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_ENVIRONMENT',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_ENVIRONMENT_APPENDED',
    json_object(
      'zone_id',            NEW.zone_id,
      'zone_uuid',          (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',               NEW.date,
      'rainfall_mm',        NEW.rainfall_mm,
      'flow_liters',        NEW.flow_liters,
      'rain_source',        NEW.rain_source,
      'computed_at',        NEW.computed_at,
      'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- zone_daily_environment → sync_outbox (update)
CREATE TRIGGER trg_dp_zone_env_outbox_au
AFTER UPDATE ON zone_daily_environment
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_ENVIRONMENT',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_ENVIRONMENT_APPENDED',
    json_object(
      'zone_id',            NEW.zone_id,
      'zone_uuid',          (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',               NEW.date,
      'rainfall_mm',        NEW.rainfall_mm,
      'flow_liters',        NEW.flow_liters,
      'rain_source',        NEW.rain_source,
      'computed_at',        NEW.computed_at,
      'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- zone_daily_recommendations → sync_outbox (insert)
CREATE TRIGGER trg_dp_zone_recs_outbox_ai
AFTER INSERT ON zone_daily_recommendations
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_RECOMMENDATION',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_RECOMMENDATION_UPSERTED',
    json_object(
      'zone_id',                       NEW.zone_id,
      'zone_uuid',                     (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',                          NEW.date,
      'gateway_device_eui',            COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'zone_stress_summary',           NEW.zone_stress_summary,
      'rainfall_mm',                   NEW.rainfall_mm,
      'water_delivered_liters',        NEW.water_delivered_liters,
      'irrigation_action',             NEW.irrigation_action,
      'action_reasoning',              NEW.action_reasoning,
      'recommendation_json',           NEW.recommendation_json,
      'rain_suppression_active',       NEW.rain_suppression_active,
      'recovery_verification_active',  NEW.recovery_verification_active,
      'vpd_max_kpa',                   NEW.vpd_max_kpa,
      'vpd_source',                    NEW.vpd_source,
      'irrigation_window_json',        NEW.irrigation_window_json,
      'usable_tree_count',             NEW.usable_tree_count,
      'low_confidence_tree_count',     NEW.low_confidence_tree_count,
      'outlier_filtered_tree_count',   NEW.outlier_filtered_tree_count,
      'zone_confidence_score',         NEW.zone_confidence_score,
      'computed_at',                   NEW.computed_at
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- zone_daily_recommendations → sync_outbox (update)
CREATE TRIGGER trg_dp_zone_recs_outbox_au
AFTER UPDATE ON zone_daily_recommendations
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_RECOMMENDATION',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_RECOMMENDATION_UPSERTED',
    json_object(
      'zone_id',                       NEW.zone_id,
      'zone_uuid',                     (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',                          NEW.date,
      'gateway_device_eui',            COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'zone_stress_summary',           NEW.zone_stress_summary,
      'rainfall_mm',                   NEW.rainfall_mm,
      'water_delivered_liters',        NEW.water_delivered_liters,
      'irrigation_action',             NEW.irrigation_action,
      'action_reasoning',              NEW.action_reasoning,
      'recommendation_json',           NEW.recommendation_json,
      'rain_suppression_active',       NEW.rain_suppression_active,
      'recovery_verification_active',  NEW.recovery_verification_active,
      'vpd_max_kpa',                   NEW.vpd_max_kpa,
      'vpd_source',                    NEW.vpd_source,
      'irrigation_window_json',        NEW.irrigation_window_json,
      'usable_tree_count',             NEW.usable_tree_count,
      'low_confidence_tree_count',     NEW.low_confidence_tree_count,
      'outlier_filtered_tree_count',   NEW.outlier_filtered_tree_count,
      'zone_confidence_score',         NEW.zone_confidence_score,
      'computed_at',                   NEW.computed_at
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- gateway_locations → sync_outbox (insert)
CREATE TRIGGER trg_gateway_locations_outbox_ai
AFTER INSERT ON gateway_locations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'GATEWAY_LOCATION',
    NEW.gateway_device_eui,
    'GATEWAY_LOCATION_UPSERTED',
    json_object(
      'gateway_device_eui',           NEW.gateway_device_eui,
      'latitude',                     NEW.latitude,
      'longitude',                    NEW.longitude,
      'altitude_m',                   NEW.altitude_m,
      'accuracy_m',                   NEW.accuracy_m,
      'hdop',                         NEW.hdop,
      'satellites',                   NEW.satellites,
      'fix_mode',                     NEW.fix_mode,
      'status',                       NEW.status,
      'source',                       NEW.source,
      'native_concentratord_status',  NEW.native_concentratord_status,
      'chirpstack_mirror_status',     NEW.chirpstack_mirror_status,
      'last_fix_at',                  NEW.last_fix_at,
      'last_good_fix_at',             NEW.last_good_fix_at,
      'sync_version',                 NEW.sync_version,
      'updated_at',                   NEW.updated_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NEW.gateway_device_eui
  );
END;

-- gateway_locations → sync_outbox (update, guarded)
CREATE TRIGGER trg_gateway_locations_outbox_au
AFTER UPDATE ON gateway_locations
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND (
    COALESCE(NEW.latitude,'')                    <> COALESCE(OLD.latitude,'') OR
    COALESCE(NEW.longitude,'')                   <> COALESCE(OLD.longitude,'') OR
    COALESCE(NEW.altitude_m,'')                  <> COALESCE(OLD.altitude_m,'') OR
    COALESCE(NEW.accuracy_m,'')                  <> COALESCE(OLD.accuracy_m,'') OR
    COALESCE(NEW.hdop,'')                        <> COALESCE(OLD.hdop,'') OR
    COALESCE(NEW.satellites,'')                  <> COALESCE(OLD.satellites,'') OR
    COALESCE(NEW.fix_mode,'')                    <> COALESCE(OLD.fix_mode,'') OR
    COALESCE(NEW.status,'')                      <> COALESCE(OLD.status,'') OR
    COALESCE(NEW.source,'')                      <> COALESCE(OLD.source,'') OR
    COALESCE(NEW.native_concentratord_status,'') <> COALESCE(OLD.native_concentratord_status,'') OR
    COALESCE(NEW.chirpstack_mirror_status,'')    <> COALESCE(OLD.chirpstack_mirror_status,'') OR
    COALESCE(NEW.last_good_fix_at,'')            <> COALESCE(OLD.last_good_fix_at,'') OR
    COALESCE(NEW.sync_version,0)                 <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'GATEWAY_LOCATION',
    NEW.gateway_device_eui,
    'GATEWAY_LOCATION_UPSERTED',
    json_object(
      'gateway_device_eui',           NEW.gateway_device_eui,
      'latitude',                     NEW.latitude,
      'longitude',                    NEW.longitude,
      'altitude_m',                   NEW.altitude_m,
      'accuracy_m',                   NEW.accuracy_m,
      'hdop',                         NEW.hdop,
      'satellites',                   NEW.satellites,
      'fix_mode',                     NEW.fix_mode,
      'status',                       NEW.status,
      'source',                       NEW.source,
      'native_concentratord_status',  NEW.native_concentratord_status,
      'chirpstack_mirror_status',     NEW.chirpstack_mirror_status,
      'last_fix_at',                  NEW.last_fix_at,
      'last_good_fix_at',             NEW.last_good_fix_at,
      'sync_version',                 NEW.sync_version,
      'updated_at',                   NEW.updated_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NEW.gateway_device_eui
  );
END;
