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
                                          'TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN',
                                          'MILESIGHT_UC512')),
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
  trigger_metric      TEXT NOT NULL CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO')),
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
  valve_1_state             TEXT,
  valve_2_state             TEXT,
  valve_1_pulse             INTEGER,
  valve_2_pulse             INTEGER,
  pipe_pressure_kpa         REAL,
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
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1
  )
  AND COALESCE(
    NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)), ''),
    NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
  ) IS NULL THEN RAISE(ABORT, 'missing_gateway_device_eui') END;
  UPDATE irrigation_events
  SET event_uuid = 'irrig-' || COALESCE(
    NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)), ''),
    NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
  ) || '-' || printf('%015d', NEW.id)
  WHERE id = NEW.id
    AND COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    ) IS NOT NULL;
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  )
  SELECT
    lower(hex(randomblob(16))),
    'IRRIGATION_EVENT',
    event_uuid,
    'IRRIGATION_EVENT_APPENDED',
    json_object(
      'contract_version', 1,
      'event_uuid',          event_uuid,
      'event_id',            id,
      'user_id',             user_id,
      'irrigation_zone_id',  irrigation_zone_id,
      'zone_uuid',           (SELECT zone_uuid FROM irrigation_zones WHERE id=irrigation_zone_id AND deleted_at IS NULL),
      'gateway_device_eui',  COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id=irrigation_zone_id AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
      'action',              action,
      'reason',              reason,
      'aggregate_kpa',       aggregate_kpa,
      'threshold_kpa',       threshold_kpa,
      'duration_minutes',    duration_minutes,
      'valve_deveui',        valve_deveui,
      'payload_json',        payload_json
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id=irrigation_zone_id AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))
  FROM irrigation_events
  WHERE id = NEW.id
    AND irrigation_events.event_uuid IS NOT NULL
    AND irrigation_events.event_uuid <> ''
    AND EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
    AND NOT EXISTS (SELECT 1 FROM sync_outbox WHERE aggregate_type='IRRIGATION_EVENT' AND aggregate_key=irrigation_events.event_uuid);
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
  sync_version                INTEGER NOT NULL DEFAULT 0,
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
  sync_version                INTEGER NOT NULL DEFAULT 0,
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
  sync_version INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX idx_sync_outbox_eviction ON sync_outbox(aggregate_type, delivered_at, occurred_at);

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

-- ---------------------------------------------------------------------------
-- improvement_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS improvement_requests (
  request_uuid              TEXT PRIMARY KEY,
  user_id                   INTEGER NOT NULL,
  type                      TEXT NOT NULL CHECK (type IN ('bug','improvement','feedback')),
  title                     TEXT NOT NULL,
  description               TEXT NOT NULL,
  expected                  TEXT,
  actual                    TEXT,
  steps                     TEXT,
  area                      TEXT NOT NULL,
  severity                  TEXT NOT NULL CHECK (severity IN ('cant_work','workaround','annoying','idea')),
  consent_diagnostics       INTEGER NOT NULL DEFAULT 1 CHECK (consent_diagnostics IN (0,1)),
  consent_public            INTEGER NOT NULL CHECK (consent_public = 1),
  diagnostics_json          TEXT NOT NULL DEFAULT '{}',
  gateway_device_eui        TEXT,
  local_status              TEXT NOT NULL DEFAULT 'QUEUED',
  cloud_status              TEXT,
  cloud_reason              TEXT,
  cloud_human_message       TEXT,
  released_version          TEXT,
  submitted_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_status_at            TEXT,
  created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_version              INTEGER NOT NULL DEFAULT 1,
  contact_email             TEXT,
  status_secret_hash         TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_improvement_requests_user_created_at
  ON improvement_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_improvement_requests_status
  ON improvement_requests(local_status, cloud_status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_improvement_requests_outbox_ai
AFTER INSERT ON improvement_requests
BEGIN
  INSERT OR IGNORE INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  )
  VALUES (
    'work-request-' || NEW.request_uuid,
    'WORK_REQUEST',
    NEW.request_uuid,
    'WORK_REQUEST_SUBMITTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'request_id', NEW.request_uuid,
      'type', NEW.type,
      'title', NEW.title,
      'contact_email', NEW.contact_email,
      'description', NEW.description,
      'expected', NEW.expected,
      'actual', NEW.actual,
      'steps', NEW.steps,
      'area', NEW.area,
      'severity', NEW.severity,
      'consent_public', CASE WHEN NEW.consent_public = 1 THEN json('true') ELSE json('false') END,
      'consent_diagnostics', CASE WHEN NEW.consent_diagnostics = 1 THEN json('true') ELSE json('false') END,
      'diagnostics', json(NEW.diagnostics_json),
      'gateway_device_eui', NEW.gateway_device_eui,
      'status_secret_hash', NEW.status_secret_hash,
      'gui_user', json_object('local_user_id', NEW.user_id),
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.submitted_at
    ),
    NEW.sync_version,
    NEW.submitted_at,
    NEW.gateway_device_eui
  );
END;

CREATE TABLE sync_link_state (
  peer_node TEXT PRIMARY KEY,
  linked INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  cloud_user_id TEXT,
  gateway_device_eui TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at)
SELECT
  'cloud',
  1,
  server_url,
  CAST(cloud_user_id AS TEXT),
  COALESCE(
    (SELECT gateway_device_eui FROM irrigation_zones WHERE gateway_device_eui IS NOT NULL AND trim(gateway_device_eui) <> '' ORDER BY id LIMIT 1),
    (SELECT gateway_device_eui FROM devices WHERE gateway_device_eui IS NOT NULL AND trim(gateway_device_eui) <> '' ORDER BY id LIMIT 1)
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM users
WHERE server_url IS NOT NULL
  AND trim(server_url) <> ''
  AND server_sync_token IS NOT NULL
  AND trim(server_sync_token) <> ''
ORDER BY server_linked_at DESC, id DESC
LIMIT 1
ON CONFLICT(peer_node) DO UPDATE SET
  linked = 1,
  server_url = excluded.server_url,
  cloud_user_id = excluded.cloud_user_id,
  gateway_device_eui = COALESCE(sync_link_state.gateway_device_eui, excluded.gateway_device_eui),
  updated_at = excluded.updated_at;

CREATE TABLE sync_history_cursors (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'backfill',
  snapshot_high_id INTEGER,
  last_acked_id INTEGER,
  last_acked_key TEXT,
  last_shadow_acked_id INTEGER,
  last_shadow_acked_key TEXT,
  last_shadow_error TEXT,
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
  data_invalid    INTEGER DEFAULT 0,
  comp_pending    INTEGER DEFAULT 0,
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
, valve_channel INTEGER);

CREATE INDEX idx_valve_act_exp_device_eui ON valve_actuation_expectations(device_eui);
CREATE INDEX idx_valve_act_exp_active
  ON valve_actuation_expectations(reconciliation_state)
  WHERE reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING');
CREATE INDEX idx_valve_act_exp_effect_key ON valve_actuation_expectations(effect_key);

-- ---------------------------------------------------------------------------
-- zone_valve_assignments  (3.1 channel-per-zone for multi-channel valves)
-- ---------------------------------------------------------------------------
CREATE TABLE zone_valve_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  deveui TEXT NOT NULL,
  valve_channel INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE,
  UNIQUE (zone_id, valve_channel)
);

CREATE INDEX idx_zone_valve_zone ON zone_valve_assignments(zone_id);
CREATE INDEX idx_zone_valve_deveui ON zone_valve_assignments(deveui);

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
    CASE
      WHEN NEW.deleted_at IS NOT NULL THEN 'ZONE_DELETED'
      WHEN COALESCE(NEW.latitude,'') <> COALESCE(OLD.latitude,'') OR
           COALESCE(NEW.longitude,'') <> COALESCE(OLD.longitude,'') THEN 'ZONE_LOCATION_UPSERTED'
      WHEN COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'') OR
           COALESCE(NEW.calibration_key,'') <> COALESCE(OLD.calibration_key,'') OR
           COALESCE(NEW.crop_type,'') <> COALESCE(OLD.crop_type,'') OR
           COALESCE(NEW.variety,'') <> COALESCE(OLD.variety,'') OR
           COALESCE(NEW.soil_type,'') <> COALESCE(OLD.soil_type,'') OR
           COALESCE(NEW.irrigation_method,'') <> COALESCE(OLD.irrigation_method,'') OR
           COALESCE(NEW.area_m2,'') <> COALESCE(OLD.area_m2,'') OR
           COALESCE(NEW.irrigation_efficiency_pct,'') <> COALESCE(OLD.irrigation_efficiency_pct,'') OR
           COALESCE(NEW.scheduling_mode,'local') <> COALESCE(OLD.scheduling_mode,'local') OR
           COALESCE(NEW.prediction_card_enabled,0) <> COALESCE(OLD.prediction_card_enabled,0) OR
           COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') THEN 'ZONE_CONFIG_UPSERTED'
      ELSE 'ZONE_UPSERTED'
    END,
    json_object(
      'contract_version', 1,
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
    COALESCE(NEW.chameleon_enabled,0) <> COALESCE(OLD.chameleon_enabled,0) OR
    COALESCE(NEW.chameleon_swt1_depth_cm,-1) <> COALESCE(OLD.chameleon_swt1_depth_cm,-1) OR
    COALESCE(NEW.chameleon_swt2_depth_cm,-1) <> COALESCE(OLD.chameleon_swt2_depth_cm,-1) OR
    COALESCE(NEW.chameleon_swt3_depth_cm,-1) <> COALESCE(OLD.chameleon_swt3_depth_cm,-1) OR
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
      'contract_version', 1,
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
      'chameleon_enabled',                 NEW.chameleon_enabled,
      'chameleon_swt1_depth_cm',           NEW.chameleon_swt1_depth_cm,
      'chameleon_swt2_depth_cm',           NEW.chameleon_swt2_depth_cm,
      'chameleon_swt3_depth_cm',           NEW.chameleon_swt3_depth_cm,
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
      'contract_version', 1,
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

-- device_data → sync_outbox (insert)
CREATE TRIGGER trg_dp_device_data_outbox_ai
AFTER INSERT ON device_data
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
AND COALESCE(
  NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
  NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
) IS NOT NULL
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'DEVICE_DATA',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.recorded_at,''),
    'DEVICE_DATA_APPENDED',
    json_object(
      'contract_version', 1,
      'device_eui',            NEW.deveui,
      'device_name',           (SELECT name    FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'device_type',           (SELECT type_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_id',               (SELECT irrigation_zone_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_uuid',             (SELECT iz.zone_uuid FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id AND iz.deleted_at IS NULL WHERE d.deveui=NEW.deveui AND d.deleted_at IS NULL),
      'gateway_device_eui',    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2'),
      'recorded_at',           NEW.recorded_at,
      'swt_wm1',               NEW.swt_wm1,
      'swt_wm2',               NEW.swt_wm2,
      'swt_1',                 NEW.swt_1,
      'swt_2',                 NEW.swt_2,
      'swt_3',                 NEW.swt_3,
      'light_lux',             NEW.light_lux,
      'ambient_temperature',   NEW.ambient_temperature,
      'relative_humidity',     NEW.relative_humidity,
      'ext_temperature_c',     NEW.ext_temperature_c,
      'bat_v',                 NEW.bat_v,
      'adc_ch0v',              NEW.adc_ch0v,
      'dendro_position_mm',    NEW.dendro_position_mm,
      'dendro_valid',          NEW.dendro_valid,
      'dendro_delta_mm',       NEW.dendro_delta_mm,
      'dendro_stem_change_um', NEW.dendro_stem_change_um,
      'adc_ch1v',              NEW.adc_ch1v,
      'dendro_ratio',          NEW.dendro_ratio,
      'dendro_mode_used',      NEW.dendro_mode_used,
      'lsn50_mode_code',       NEW.lsn50_mode_code,
      'lsn50_mode_label',      NEW.lsn50_mode_label,
      'lsn50_mode_observed_at', NEW.lsn50_mode_observed_at,
      'rain_count_cumulative', NEW.rain_count_cumulative,
      'rain_tips_delta',       NEW.rain_tips_delta,
      'rain_mm_delta',         NEW.rain_mm_delta,
      'rain_mm_per_hour',      NEW.rain_mm_per_hour,
      'rain_mm_per_10min',     NEW.rain_mm_per_10min,
      'rain_mm_today',         NEW.rain_mm_today,
      'rain_delta_status',     NEW.rain_delta_status,
      'flow_count_cumulative', NEW.flow_count_cumulative,
      'flow_pulses_delta',     NEW.flow_pulses_delta,
      'flow_liters_delta',     NEW.flow_liters_delta,
      'flow_liters_per_min',   NEW.flow_liters_per_min,
      'flow_liters_per_10min', NEW.flow_liters_per_10min,
      'flow_liters_today',     NEW.flow_liters_today,
      'flow_delta_status',     NEW.flow_delta_status,
      'counter_interval_seconds', NEW.counter_interval_seconds,
      'barometric_pressure_hpa',  NEW.barometric_pressure_hpa,
      'wind_speed_mps',        NEW.wind_speed_mps,
      'wind_direction_deg',    NEW.wind_direction_deg,
      'wind_gust_mps',         NEW.wind_gust_mps,
      'uv_index',              NEW.uv_index,
      'rain_gauge_cumulative_mm', NEW.rain_gauge_cumulative_mm,
      'bat_pct',               NEW.bat_pct
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- chameleon_readings → sync_outbox (insert)
CREATE TRIGGER trg_dp_chameleon_readings_outbox_ai
AFTER INSERT ON chameleon_readings
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
AND COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') <> ''
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'CHAMELEON_READING',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.recorded_at,''),
    'CHAMELEON_READING_APPENDED',
    json_object(
      'contract_version', 1,
      'device_eui',           NEW.deveui,
      'recorded_at',          NEW.recorded_at,
      'payload_version',      NEW.payload_version,
      'status_flags',         NEW.status_flags,
      'i2c_missing',          NEW.i2c_missing,
      'timeout',              NEW.timeout,
      'temp_fault',           NEW.temp_fault,
      'id_fault',             NEW.id_fault,
      'ch1_open',             NEW.ch1_open,
      'ch2_open',             NEW.ch2_open,
      'ch3_open',             NEW.ch3_open,
      'temp_c',               NEW.temp_c,
      'r1_ohm_comp',          NEW.r1_ohm_comp,
      'r2_ohm_comp',          NEW.r2_ohm_comp,
      'r3_ohm_comp',          NEW.r3_ohm_comp,
      'r1_ohm_raw',           NEW.r1_ohm_raw,
      'r2_ohm_raw',           NEW.r2_ohm_raw,
      'r3_ohm_raw',           NEW.r3_ohm_raw,
      'array_id',             NEW.array_id,
      'adc_ch0v',             NEW.adc_ch0v,
      'adc_ch1v',             NEW.adc_ch1v,
      'adc_ch4v',             NEW.adc_ch4v,
      'bat_v',                NEW.bat_v,
      'payload_b64',          NEW.payload_b64,
      'f_port',               NEW.f_port,
      'f_cnt',                NEW.f_cnt,
      'calibration_status',   NEW.calibration_status,
      'data_invalid',         COALESCE(NEW.data_invalid,0),
      'comp_pending',         COALESCE(NEW.comp_pending,0),
      'zone_id',              (SELECT irrigation_zone_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_uuid',            (SELECT iz.zone_uuid FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id AND iz.deleted_at IS NULL WHERE d.deveui=NEW.deveui AND d.deleted_at IS NULL),
      'gateway_device_eui',   COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- dendrometer_readings → sync_outbox (insert)
CREATE TRIGGER trg_dp_dendro_readings_outbox_ai
AFTER INSERT ON dendrometer_readings
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
AND COALESCE(
  NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
  NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
) IS NOT NULL
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'DENDRO_READING',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.recorded_at,''),
    'DENDRO_READING_APPENDED',
    json_object(
      'contract_version', 1,
      'device_eui',     NEW.deveui,
      'position_um',    NEW.position_um,
      'adc_v',          NEW.adc_v,
      'bat_v',          NEW.bat_v,
      'is_valid',       NEW.is_valid,
      'invalid_reason', NEW.invalid_reason,
      'is_outlier',     NEW.is_outlier,
      'recorded_at',    NEW.recorded_at,
      'zone_id',        (SELECT irrigation_zone_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_uuid',      (SELECT iz.zone_uuid FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id AND iz.deleted_at IS NULL WHERE d.deveui=NEW.deveui AND d.deleted_at IS NULL),
      'gateway_device_eui', COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))
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
AND COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') <> ''
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
AND COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') <> ''
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
AND COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') <> ''
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
    'ZONE_ENVIRONMENT|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), 'zone-id:' || NEW.zone_id) || '|' || NEW.date,
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
    'ZONE_ENVIRONMENT|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), 'zone-id:' || NEW.zone_id) || '|' || NEW.date,
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
    'ZONE_RECOMMENDATION|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), 'zone-id:' || NEW.zone_id) || '|' || NEW.date,
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
    'ZONE_RECOMMENDATION|' || COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL), 'zone-id:' || NEW.zone_id) || '|' || NEW.date,
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
    'DENDRO_DAILY',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.date,''),
    'DENDRO_DAILY_UPSERTED',
    json_object(
      'contract_version', 1,
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
      'computed_at',           NEW.computed_at,
      'sync_version',          NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- dendrometer_daily → sync_outbox (update)
CREATE TRIGGER trg_dp_dendro_daily_outbox_au
AFTER UPDATE ON dendrometer_daily
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
 AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
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
      'contract_version', 1,
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
      'computed_at',           NEW.computed_at,
      'sync_version',          NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- irrigation_events → sync_outbox
CREATE TRIGGER trg_dp_irrigation_events_outbox_ai
AFTER INSERT ON irrigation_events
FOR EACH ROW
WHEN NEW.event_uuid IS NOT NULL
 AND NEW.event_uuid <> ''
 AND EXISTS (
   SELECT 1 FROM sync_link_state
    WHERE peer_node = 'cloud' AND linked = 1
 )
 AND COALESCE(
   NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)), ''),
   NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
 ) IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM sync_outbox
    WHERE aggregate_type='IRRIGATION_EVENT' AND aggregate_key=NEW.event_uuid
 )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_EVENT',
    NEW.event_uuid,
    'IRRIGATION_EVENT_APPENDED',
    json_object(
      'contract_version', 1,
      'event_uuid',          NEW.event_uuid,
      'event_id',            NEW.id,
      'user_id',             NEW.user_id,
      'irrigation_zone_id',  NEW.irrigation_zone_id,
      'zone_uuid',           (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),
      'gateway_device_eui',  COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
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
    COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))
  );
END;

CREATE TRIGGER trg_dp_irrigation_events_outbox_au_event_uuid
AFTER UPDATE OF event_uuid ON irrigation_events
FOR EACH ROW
WHEN (OLD.event_uuid IS NULL OR OLD.event_uuid = '')
 AND NEW.event_uuid IS NOT NULL
 AND NEW.event_uuid <> ''
 AND EXISTS (
   SELECT 1 FROM sync_link_state
    WHERE peer_node = 'cloud' AND linked = 1
 )
 AND COALESCE(
   NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)), ''),
   NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
 ) IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM sync_outbox
    WHERE aggregate_type='IRRIGATION_EVENT' AND aggregate_key=NEW.event_uuid
 )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_EVENT',
    NEW.event_uuid,
    'IRRIGATION_EVENT_APPENDED',
    json_object(
      'contract_version', 1,
      'event_uuid',          NEW.event_uuid,
      'event_id',            NEW.id,
      'user_id',             NEW.user_id,
      'irrigation_zone_id',  NEW.irrigation_zone_id,
      'zone_uuid',           (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),
      'gateway_device_eui',  COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
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
    COALESCE(NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL)),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))
  );
END;

-- zone_daily_environment → sync_outbox (insert)
CREATE TRIGGER trg_dp_zone_env_outbox_ai
AFTER INSERT ON zone_daily_environment
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
    'ZONE_ENVIRONMENT',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
    'ZONE_ENVIRONMENT_APPENDED',
    json_object(
      'contract_version', 1,
      'zone_id',            NEW.zone_id,
      'zone_uuid',          (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',               NEW.date,
      'rainfall_mm',        NEW.rainfall_mm,
      'flow_liters',        NEW.flow_liters,
      'rain_source',        NEW.rain_source,
      'computed_at',        NEW.computed_at,
      'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'sync_version',       NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- zone_daily_environment → sync_outbox (update)
CREATE TRIGGER trg_dp_zone_env_outbox_au
AFTER UPDATE ON zone_daily_environment
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
 AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_ENVIRONMENT',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
    'ZONE_ENVIRONMENT_APPENDED',
    json_object(
      'contract_version', 1,
      'zone_id',            NEW.zone_id,
      'zone_uuid',          (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',               NEW.date,
      'rainfall_mm',        NEW.rainfall_mm,
      'flow_liters',        NEW.flow_liters,
      'rain_source',        NEW.rain_source,
      'computed_at',        NEW.computed_at,
      'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'sync_version',       NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- zone_daily_recommendations → sync_outbox (insert)
CREATE TRIGGER trg_dp_zone_recs_outbox_ai
AFTER INSERT ON zone_daily_recommendations
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
    'ZONE_RECOMMENDATION',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
    'ZONE_RECOMMENDATION_UPSERTED',
    json_object(
      'contract_version', 1,
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
      'computed_at',                   NEW.computed_at,
      'sync_version',                  NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;

-- zone_daily_recommendations → sync_outbox (update)
CREATE TRIGGER trg_dp_zone_recs_outbox_au
AFTER UPDATE ON zone_daily_recommendations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
 AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_RECOMMENDATION',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
    'ZONE_RECOMMENDATION_UPSERTED',
    json_object(
      'contract_version', 1,
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
      'computed_at',                   NEW.computed_at,
      'sync_version',                  NEW.sync_version
    ),
    NEW.sync_version,
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
AND COALESCE(
  NULLIF(trim(NEW.gateway_device_eui), ''),
  NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
) IS NOT NULL
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'GATEWAY_LOCATION',
    COALESCE(NULLIF(trim(NEW.gateway_device_eui),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
    'GATEWAY_LOCATION_UPSERTED',
    json_object(
      'contract_version', 1,
      'gateway_device_eui',           COALESCE(NULLIF(trim(NEW.gateway_device_eui),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
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
    COALESCE(NULLIF(trim(NEW.gateway_device_eui),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))
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
  AND COALESCE(
    NULLIF(trim(NEW.gateway_device_eui), ''),
    NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
  ) IS NOT NULL
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
    COALESCE(NULLIF(trim(NEW.gateway_device_eui),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
    'GATEWAY_LOCATION_UPSERTED',
    json_object(
      'contract_version', 1,
      'gateway_device_eui',           COALESCE(NULLIF(trim(NEW.gateway_device_eui),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
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
    COALESCE(NULLIF(trim(NEW.gateway_device_eui),''),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))
  );
END;

-- Gateway health persistence (issue #68). Statements below are generated from
-- database/migrations/ordered/0002__gateway_health.sql and MUST stay textually
-- identical to it: scripts/verify-seed-replay.js compares sqlite_master fingerprints.

CREATE TABLE IF NOT EXISTS gateway_health_samples (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_device_eui TEXT NOT NULL,
  sampled_at         TEXT NOT NULL,
  cpu_temp_c         REAL,
  mem_percent        REAL,
  load_1             REAL,
  load_5             REAL,
  load_15            REAL,
  fan_value          REAL,
  throttled          INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_gateway_health_samples_eui_time
  ON gateway_health_samples(gateway_device_eui, sampled_at);

CREATE INDEX IF NOT EXISTS idx_gateway_health_samples_time
  ON gateway_health_samples(sampled_at);

CREATE TABLE IF NOT EXISTS gateway_health_hourly (
  gateway_device_eui TEXT NOT NULL,
  hour_start         TEXT NOT NULL,
  sample_count       INTEGER NOT NULL DEFAULT 0,
  cpu_temp_c_min     REAL,
  cpu_temp_c_mean    REAL,
  cpu_temp_c_max     REAL,
  mem_percent_min    REAL,
  mem_percent_mean   REAL,
  mem_percent_max    REAL,
  load_1_min         REAL,
  load_1_mean        REAL,
  load_1_max         REAL,
  load_5_min         REAL,
  load_5_mean        REAL,
  load_5_max         REAL,
  load_15_min        REAL,
  load_15_mean       REAL,
  load_15_max        REAL,
  fan_value_min      REAL,
  fan_value_mean     REAL,
  fan_value_max      REAL,
  throttled_max      INTEGER,
  computed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (gateway_device_eui, hour_start)
);

CREATE INDEX IF NOT EXISTS idx_gateway_health_hourly_time
  ON gateway_health_hourly(hour_start);

-- ---------------------------------------------------------------------------
-- analysis_views (folded from deploy.sh ensure_analysis_views_schema; migration 0007)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS analysis_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  owner_user_uuid TEXT,
  name TEXT NOT NULL,
  view_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- ingest_quarantine  (3.1 narrow-waist dead-letter)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- lsn50_shadow_diff  (3.3 DD7 narrow-waist shadow validation)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lsn50_shadow_diff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  diff_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- field_journal  (Slice 1 core schema; migration 0014; spec
-- docs/superpowers/specs/2026-07-12-field-journal-design.md §4)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_uuid TEXT UNIQUE NOT NULL,
  owner_user_uuid TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  author_principal_uuid TEXT NOT NULL,
  author_label TEXT,
  plot_uuid TEXT,
  zone_id INTEGER,
  zone_uuid TEXT,
  device_eui TEXT,
  season_uuid TEXT,
  season_crop TEXT,
  season_variety TEXT,
  campaign_uuid TEXT,
  protocol_code TEXT,
  protocol_version TEXT,
  observation_unit_code TEXT,
  pass_uuid TEXT,
  batch_uuid TEXT,
  activity_code TEXT NOT NULL,
  template_code TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  layout_code TEXT NOT NULL,
  layout_version INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL,
  occurred_start TEXT NOT NULL,
  occurred_end TEXT,
  occurred_timezone TEXT NOT NULL,
  occurred_utc_offset_minutes INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('edge-ui','cloud-ui')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','voided')),
  voided_at TEXT,
  voided_by_principal_uuid TEXT,
  void_reason TEXT,
  note TEXT,
  context_json TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plot_uuid) REFERENCES journal_plots(plot_uuid),
  FOREIGN KEY (activity_code) REFERENCES journal_vocab(code)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_zone_time
  ON journal_entries(zone_id, occurred_start DESC, entry_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_gateway_time
  ON journal_entries(gateway_device_eui, occurred_start DESC, entry_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_duplicate
  ON journal_entries(zone_id, activity_code, occurred_start, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_sticky
  ON journal_entries(author_principal_uuid, zone_id, recorded_at DESC, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_plot_duplicate
  ON journal_entries(plot_uuid, activity_code, occurred_start, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_plot_sticky
  ON journal_entries(author_principal_uuid, plot_uuid, recorded_at DESC, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_plot_time
  ON journal_entries (plot_uuid, occurred_start DESC, entry_uuid)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS journal_entry_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid) ON DELETE CASCADE,
  attribute_code TEXT NOT NULL REFERENCES journal_vocab(code),
  group_index INTEGER NOT NULL DEFAULT 0 CHECK (group_index >= 0),
  value_status TEXT NOT NULL DEFAULT 'observed'
    CHECK (value_status IN ('observed','not_observed','not_applicable','below_detection')),
  value_num REAL,
  value_text TEXT,
  unit_code TEXT,
  entered_value_num REAL,
  entered_unit_code TEXT,
  CHECK ( (value_status = 'observed' AND ((value_num IS NULL) <> (value_text IS NULL)))
       OR (value_status <> 'observed' AND value_num IS NULL AND value_text IS NULL) ),
  UNIQUE (entry_uuid, group_index, attribute_code)
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_values_entry ON journal_entry_values(entry_uuid);

CREATE TABLE IF NOT EXISTS journal_vocab (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('activity','attribute','unit','choice')),
  parent_code TEXT,
  value_type TEXT CHECK (value_type IN ('number','text','choice','date','boolean')),
  quantity_kind TEXT,
  basis TEXT,
  default_unit_code TEXT,
  labels_json TEXT NOT NULL DEFAULT '{}',
  icon_key TEXT,
  constraints_json TEXT,
  agrovoc_uri TEXT, icasa_code TEXT, adapt_code TEXT,   -- non-authoritative caches
  scope TEXT NOT NULL DEFAULT 'core' CHECK (scope IN ('core','custom')),
  owner_user_uuid TEXT,
  gateway_device_eui TEXT,
  custom_field_uuid TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_vocab_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_code TEXT NOT NULL REFERENCES journal_vocab(code),
  scheme_uri TEXT NOT NULL,
  scheme_version TEXT NOT NULL,
  mapping_role TEXT NOT NULL CHECK (mapping_role IN
    ('concept','variable','coded_value','operation_type','data_type_definition','unit_of_measure')),
  external_id TEXT NOT NULL,
  external_parent_id TEXT,
  mapping_relation TEXT NOT NULL DEFAULT 'exact'
    CHECK (mapping_relation IN ('exact','close','broad','narrow','related')),
  source_uri TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (term_code, scheme_uri, mapping_role, external_id)
);

CREATE TABLE IF NOT EXISTS journal_templates (
  code TEXT NOT NULL,
  version INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  definition_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (code, version)
);

CREATE TABLE IF NOT EXISTS journal_layouts (
  code TEXT NOT NULL,
  version INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  definition_json TEXT NOT NULL,          -- includes option_dependencies + supported_templates
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (code, version)
);

CREATE TABLE IF NOT EXISTS journal_plots (
  plot_uuid TEXT PRIMARY KEY,
  plot_code TEXT NOT NULL,
  name TEXT,
  zone_uuid TEXT,
  station_code TEXT,
  crop_hint TEXT,
  area_m2 REAL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sync_version INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  owner_user_uuid TEXT,
  UNIQUE (gateway_device_eui, plot_code)
);
CREATE INDEX IF NOT EXISTS idx_journal_plots_owner_gateway
  ON journal_plots(owner_user_uuid, gateway_device_eui, deleted_at, zone_uuid, active);

CREATE TABLE IF NOT EXISTS journal_plot_groups (
  group_uuid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  gateway_device_eui TEXT,
  created_by_principal_uuid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  resolved_by_principal_uuid TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
, owner_user_uuid TEXT);
CREATE INDEX IF NOT EXISTS idx_journal_plot_groups_owner_gateway
  ON journal_plot_groups(owner_user_uuid, gateway_device_eui, deleted_at, resolved_at);

CREATE TABLE IF NOT EXISTS journal_plot_group_members (
  group_uuid TEXT NOT NULL REFERENCES journal_plot_groups(group_uuid) ON DELETE CASCADE,
  plot_uuid TEXT NOT NULL REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  PRIMARY KEY (group_uuid, plot_uuid)
);

-- NOTE: the trailing `\n, context_json TEXT)` (leading comma, no comma after
-- DEFAULT 0) is deliberate, not a formatting slip: SQLite's `ALTER TABLE ...
-- ADD COLUMN` (migration 0024) inserts the new column definition verbatim
-- before the original closing paren rather than reformatting the statement,
-- so this must byte-match that shape after verify-seed-replay.js's
-- whitespace-collapsing normalization, or replay/seed fingerprints diverge.
CREATE TABLE IF NOT EXISTS journal_plot_settings (
  plot_uuid TEXT PRIMARY KEY REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  layout_code TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_principal_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0
, context_json TEXT);

-- ---------------------------------------------------------------------------
-- journal_crop_cycles / journal_crop_cycle_plots (Slice D crop-cycle
-- lifecycle; migration 0025; spec
-- docs/superpowers/specs/2026-07-20-journal-capture-streamlining-design.md §5.1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS journal_crop_cycles (
  cycle_uuid TEXT PRIMARY KEY,
  crop_code TEXT NOT NULL REFERENCES journal_vocab(code),   -- kind='choice', parent 'attr.crop'
  variety TEXT,
  group_uuid TEXT REFERENCES journal_plot_groups(group_uuid),  -- cohort that opened it, nullable
  opened_by_entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid),
  starts_on TEXT NOT NULL,                                  -- = seeding occurred date (local)
  gateway_device_eui TEXT,
  created_by_principal_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Per-plot membership carries the CLOSE state, so partial harvest (D10) and
-- per-plot re-seed (D9) are first-class. A plot's cycle is "open" when ends_on IS NULL.
CREATE TABLE IF NOT EXISTS journal_crop_cycle_plots (
  cycle_uuid TEXT NOT NULL REFERENCES journal_crop_cycles(cycle_uuid) ON DELETE CASCADE,
  plot_uuid  TEXT NOT NULL REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  ends_on TEXT,                                             -- NULL = open on this plot
  closed_by_entry_uuid TEXT REFERENCES journal_entries(entry_uuid),
  close_reason TEXT CHECK (close_reason IN ('harvest','reseed','manual')),
  PRIMARY KEY (cycle_uuid, plot_uuid)
);
CREATE INDEX IF NOT EXISTS idx_ccp_plot_open ON journal_crop_cycle_plots(plot_uuid) WHERE ends_on IS NULL;

CREATE TABLE IF NOT EXISTS journal_products (
  product_uuid TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'core' CHECK (scope IN ('core','farm')),
  owner_user_uuid TEXT,
  gateway_device_eui TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mineral','organic_amendment','plant_protection','other')),
  composition_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_attachments (
  attachment_uuid TEXT PRIMARY KEY,
  entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo')),
  original_filename TEXT,
  mime TEXT,
  size_bytes INTEGER CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (length(sha256) = 64),
  blob_uuid TEXT,
  local_relpath TEXT,
  remote_object_key TEXT,
  transfer_state TEXT NOT NULL DEFAULT 'local_only'
    CHECK (transfer_state IN ('local_only','uploading','uploaded','failed')),
  captured_at TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_attachments_entry ON journal_attachments(entry_uuid, deleted_at);

CREATE TABLE IF NOT EXISTS journal_catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalog_version INTEGER NOT NULL,
  catalog_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- BEGIN GENERATED JOURNAL CATALOG V1
-- journal_vocab
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'irrigation','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Irrigation"}','droplets',NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='irrigation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'fertilization','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Fertilization"}','fertilizer',NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='fertilization');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'fertigation','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Fertigation"}','fertigation',NULL,'core',1,30,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='fertigation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'plant_protection_application','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Plant protection"}','plant_protection',NULL,'core',1,40,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='plant_protection_application');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'weed_control_nonchemical','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Non-chemical weed control"}','weed_control',NULL,'core',1,50,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='weed_control_nonchemical');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'seeding','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Seeding"}','seeding',NULL,'core',1,60,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='seeding');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'planting_transplanting','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Planting / transplanting"}','planting',NULL,'core',1,70,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='planting_transplanting');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'pruning','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Pruning"}','pruning',NULL,'core',1,80,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='pruning');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'crop_care','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Crop care"}','crop_care',NULL,'core',1,90,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='crop_care');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'tillage_soil_work','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Tillage / soil work"}','tillage',NULL,'core',1,100,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='tillage_soil_work');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'mowing','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Mowing"}','mowing',NULL,'core',1,110,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='mowing');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'harvest','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Harvest"}','harvest',NULL,'core',1,120,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='harvest');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'sampling','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Sampling"}','sampling',NULL,'core',1,130,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='sampling');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'general_observation','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"General observation"}','observation',NULL,'core',1,140,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='general_observation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'pest_disease_observation','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Pest / disease observation"}','pest_disease',NULL,'core',1,150,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='pest_disease_observation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'equipment_maintenance','activity',NULL,NULL,NULL,NULL,NULL,'{"en":"Equipment maintenance"}','maintenance',NULL,'core',1,160,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='equipment_maintenance');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.amount_operation_depth','attribute',NULL,'number','operation_depth','operation_depth','unit.cm_operation_depth','{"en":"Operation depth"}',NULL,'{"min":0,"max":200}','core',1,100,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_operation_depth');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.amount_mass_area_product','attribute',NULL,'number','mass_area','product','unit.kg_per_ha_product','{"en":"Product mass per area"}',NULL,'{"min":0}','core',1,101,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_mass_area_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.amount_volume_area_product','attribute',NULL,'number','volume_area','product','unit.l_per_ha_product','{"en":"Product volume per area"}',NULL,'{"min":0}','core',1,102,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_volume_area_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.amount_nutrient_rate','attribute',NULL,'number','nutrient_rate','nutrient',NULL,'{"en":"Nutrient rate"}',NULL,'{"min":0,"repeatable":true,"requires_explicit_unit":true,"semantic_discriminator":"unit_code","allow_default_unit":false}','core',1,103,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_nutrient_rate');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.amount_count_area','attribute',NULL,'number','count_area','plant','unit.plants_per_ha','{"en":"Plant count per area"}',NULL,'{"min":0}','core',1,104,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_count_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.amount_biological_count_area','attribute',NULL,'number','biological_count_area','biological_agent','unit.biological_count_per_ha','{"en":"Biological-agent count per area"}',NULL,'{"min":0}','core',1,105,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_biological_count_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.amount_duration_area','attribute',NULL,'number','duration_area','labor','unit.h_per_ha_labor','{"en":"Labour duration per area"}',NULL,'{"min":0}','core',1,106,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_duration_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.irrigation_volume_area','attribute',NULL,'number','volume_area','water','unit.m3_per_ha_water','{"en":"Irrigation volume per area"}',NULL,'{"min":0}','core',1,107,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.irrigation_volume_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.irrigation_depth','attribute',NULL,'number','water_depth','water','unit.mm_water','{"en":"Irrigation depth"}',NULL,'{"min":0}','core',1,108,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.irrigation_depth');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.duration_minutes','attribute',NULL,'number','duration','elapsed_time','unit.min_duration','{"en":"Duration"}',NULL,'{"min":0}','core',1,109,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.duration_minutes');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.per_plant_volume','attribute',NULL,'number','volume_per_plant','water','unit.l_per_plant_water','{"en":"Volume per plant"}',NULL,'{"min":0}','core',1,110,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.per_plant_volume');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.treated_area','attribute',NULL,'number','area','land_area','unit.m2_area','{"en":"Treated area"}',NULL,'{"min":0}','core',1,111,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.treated_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.harvest_area','attribute',NULL,'number','area','land_area','unit.m2_area','{"en":"Harvest area"}',NULL,'{"min":0}','core',1,112,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.harvest_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.harvest_yield_area','attribute',NULL,'number','yield_area','fresh_product','unit.kg_per_ha_fresh_product','{"en":"Harvest yield per area"}',NULL,'{"min":0}','core',1,113,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.harvest_yield_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.surface_area','attribute',NULL,'number','area','land_area','unit.m2_area','{"en":"Surface area"}',NULL,'{"min":0}','core',1,114,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.surface_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.plant_area','attribute',NULL,'number','area','land_area','unit.m2_area','{"en":"Plant area"}',NULL,'{"min":0}','core',1,115,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.plant_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.wetted_area','attribute',NULL,'number','area','land_area','unit.m2_area','{"en":"Wetted area"}',NULL,'{"min":0}','core',1,116,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.wetted_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.water_input','attribute',NULL,'number','volume','water','unit.l_water','{"en":"Water input"}',NULL,'{"min":0}','core',1,117,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.water_input');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.rain_input','attribute',NULL,'number','water_depth','water','unit.mm_water','{"en":"Rain input"}',NULL,'{"min":0}','core',1,118,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.rain_input');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.drainage_volume','attribute',NULL,'number','volume','water','unit.l_water','{"en":"Drainage volume"}',NULL,'{"min":0}','core',1,119,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.drainage_volume');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.mass_start','attribute',NULL,'number','mass','lysimeter','unit.kg_mass','{"en":"Start mass"}',NULL,'{"min":0}','core',1,120,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.mass_start');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.mass_end','attribute',NULL,'number','mass','lysimeter','unit.kg_mass','{"en":"End mass"}',NULL,'{"min":0}','core',1,121,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.mass_end');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.tare_mass','attribute',NULL,'number','mass','lysimeter','unit.kg_mass','{"en":"Tare mass"}',NULL,'{"min":0}','core',1,122,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.tare_mass');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.interval_minutes','attribute',NULL,'number','duration','elapsed_time','unit.min_duration','{"en":"Measurement interval"}',NULL,'{"min":0}','core',1,123,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.interval_minutes');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.ec','attribute',NULL,'number','electrical_conductivity','solution','unit.ds_per_m','{"en":"Electrical conductivity"}',NULL,'{"min":0}','core',1,124,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.ec');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.ph','attribute',NULL,'number','acidity','solution','unit.ph','{"en":"pH"}',NULL,'{"min":0,"max":14}','core',1,125,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.ph');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.waiting_period_days','attribute',NULL,'number','calendar_duration','calendar_day','unit.day_duration','{"en":"Waiting period"}',NULL,'{"min":0}','core',1,126,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.waiting_period_days');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.combination_group','attribute',NULL,'number','count','operation_group','unit.count_integer','{"en":"Combination group"}',NULL,'{"min":1,"step":1}','core',1,127,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.combination_group');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.dmc_mass_fraction','attribute',NULL,'number','mass_fraction','product_wet_mass','unit.kg_per_t_dry_matter','{"en":"Dry matter per fresh mass"}',NULL,'{"min":0}','core',1,128,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.dmc_mass_fraction');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.dmc_mass_volume','attribute',NULL,'number','mass_concentration','product_volume','unit.kg_per_m3_dry_matter','{"en":"Dry matter per product volume"}',NULL,'{"min":0}','core',1,129,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.dmc_mass_volume');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.c_content','attribute',NULL,'number','mass_fraction','dry_matter_carbon','unit.g_c_per_kg_dm','{"en":"Carbon content"}',NULL,'{"min":0}','core',1,130,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.c_content');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.n_content','attribute',NULL,'number','mass_fraction','dry_matter_nitrogen','unit.g_n_per_kg_dm','{"en":"Nitrogen content"}',NULL,'{"min":0}','core',1,131,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.n_content');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.crop_product','attribute',NULL,'number','yield_area','dry_matter_yield','unit.t_per_ha_dm','{"en":"Exported crop product"}',NULL,'{"min":0}','core',1,132,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.crop_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.crop_residue','attribute',NULL,'number','yield_area','dry_matter_yield','unit.t_per_ha_dm','{"en":"Crop residue"}',NULL,'{"min":0}','core',1,133,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.crop_residue');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.cc_product','attribute',NULL,'number','mass_fraction','dry_matter_carbon','unit.g_c_per_kg_dm','{"en":"Product carbon concentration"}',NULL,'{"min":0}','core',1,134,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.cc_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.cc_residue','attribute',NULL,'number','mass_fraction','dry_matter_carbon','unit.g_c_per_kg_dm','{"en":"Residue carbon concentration"}',NULL,'{"min":0}','core',1,135,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.cc_residue');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.operation','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Operation"}',NULL,'{}','core',1,136,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.operation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.agroscope.device','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Device / method"}',NULL,'{}','core',1,137,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.device');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.crop','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Crop"}',NULL,'{}','core',1,138,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.crop');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.machine','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Machine"}',NULL,'{"maxlength":500}','core',1,139,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.machine');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.product_uuid','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Registered product"}',NULL,'{"maxlength":128,"reference":{"table":"journal_products","column":"product_uuid"}}','core',1,140,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.product_uuid');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.product','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Unregistered product"}',NULL,'{"maxlength":500,"unregistered_compatibility":true}','core',1,141,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.actuation_expectation_id','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Actuation expectation"}',NULL,'{"maxlength":128,"reference":{"table":"valve_actuation_expectations","column":"expectation_id"}}','core',1,142,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.actuation_expectation_id');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.block_bed_row','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Block / bed / row"}',NULL,'{"maxlength":160}','core',1,143,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.block_bed_row');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.cover_type','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Cover type"}',NULL,'{}','core',1,144,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.cover_type');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.denominator','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Application denominator"}',NULL,'{}','core',1,145,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.denominator');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.structure_compartment','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Structure / compartment"}',NULL,'{"maxlength":160}','core',1,146,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.structure_compartment');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.root_zone_system','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Root-zone system"}',NULL,'{}','core',1,147,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.root_zone_system');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.recirculation','attribute',NULL,'boolean',NULL,NULL,NULL,'{"en":"Recirculation"}',NULL,'{}','core',1,148,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.recirculation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.experimental_unit','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Experimental unit"}',NULL,'{"maxlength":160}','core',1,149,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.experimental_unit');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.replicate','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Replicate"}',NULL,'{"maxlength":80}','core',1,150,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.replicate');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.treatment','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Treatment"}',NULL,'{"maxlength":160}','core',1,151,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.treatment');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.mass_method','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Mass method"}',NULL,'{}','core',1,152,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.mass_method');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.irrigation_amount_kind','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Irrigation amount kind"}',NULL,'{}','core',1,153,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.irrigation_amount_kind');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.measurement_source','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Measurement source"}',NULL,'{}','core',1,154,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.measurement_source');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.operator','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Operator"}',NULL,'{"maxlength":160}','core',1,155,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.operator');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.equipment','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Equipment"}',NULL,'{"maxlength":300}','core',1,156,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.equipment');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.method','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Method"}',NULL,'{"maxlength":300}','core',1,157,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.method');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.target','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Target"}',NULL,'{"maxlength":300}','core',1,158,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.target');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.observation_text','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Observation"}',NULL,'{"maxlength":4000}','core',1,159,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.observation_text');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.variety','attribute',NULL,'text',NULL,NULL,NULL,'{"en":"Variety"}',NULL,'{"maxlength":120,"autocomplete":"variety_by_crop"}','core',1,160,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.variety');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.growth_stage_bbch','attribute',NULL,'number','growth_stage','phenology','unit.bbch_stage','{"en":"Growth stage (BBCH)"}',NULL,'{"min":0,"max":99,"step":1}','core',1,161,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.growth_stage_bbch');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.wind_speed','attribute',NULL,'number','wind_speed','ambient','unit.m_per_s','{"en":"Wind speed"}',NULL,'{"min":0}','core',1,162,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.wind_speed');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.wind_direction','attribute',NULL,'choice',NULL,NULL,NULL,'{"en":"Wind direction"}',NULL,'{}','core',1,163,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.wind_direction');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.air_temperature','attribute',NULL,'number','temperature','ambient','unit.deg_c','{"en":"Air temperature"}',NULL,'{"min":-50,"max":60}','core',1,164,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.air_temperature');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'attr.rel_humidity','attribute',NULL,'number','relative_humidity','ambient','unit.percent','{"en":"Relative humidity"}',NULL,'{"min":0,"max":100}','core',1,165,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.rel_humidity');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.cm_operation_depth','unit',NULL,NULL,'operation_depth','operation_depth',NULL,'{"en":"cm"}',NULL,'{"dimension":"length_operation_depth","to_canonical":{"unit_code":"unit.cm_operation_depth","scale":1,"offset":0}}','core',1,500,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.cm_operation_depth');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.g_per_ha_product','unit',NULL,NULL,'mass_area','product',NULL,'{"en":"g/ha"}',NULL,'{"dimension":"mass_product_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_product","scale":0.001,"offset":0}}','core',1,501,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.g_per_ha_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_per_ha_product','unit',NULL,NULL,'mass_area','product',NULL,'{"en":"kg/ha"}',NULL,'{"dimension":"mass_product_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_product","scale":1,"offset":0}}','core',1,502,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_ha_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.t_per_ha_product','unit',NULL,NULL,'mass_area','product',NULL,'{"en":"t/ha"}',NULL,'{"dimension":"mass_product_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_product","scale":1000,"offset":0}}','core',1,503,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.t_per_ha_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.l_per_ha_product','unit',NULL,NULL,'volume_area','product',NULL,'{"en":"L/ha"}',NULL,'{"dimension":"volume_product_per_area","to_canonical":{"unit_code":"unit.l_per_ha_product","scale":1,"offset":0}}','core',1,504,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.l_per_ha_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.m3_per_ha_product','unit',NULL,NULL,'volume_area','product',NULL,'{"en":"m³/ha"}',NULL,'{"dimension":"volume_product_per_area","to_canonical":{"unit_code":"unit.l_per_ha_product","scale":1000,"offset":0}}','core',1,505,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m3_per_ha_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_per_ha_fresh_product','unit',NULL,NULL,'yield_area','fresh_product',NULL,'{"en":"kg/ha"}',NULL,'{"dimension":"fresh_product_yield_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_fresh_product","scale":1,"offset":0}}','core',1,506,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_ha_fresh_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.t_per_ha_fresh_product','unit',NULL,NULL,'yield_area','fresh_product',NULL,'{"en":"t/ha"}',NULL,'{"dimension":"fresh_product_yield_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_fresh_product","scale":1000,"offset":0}}','core',1,507,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.t_per_ha_fresh_product');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.m3_per_ha_water','unit',NULL,NULL,'volume_area','water',NULL,'{"en":"m³/ha"}',NULL,'{"dimension":"water_volume_per_area","to_canonical":{"unit_code":"unit.m3_per_ha_water","scale":1,"offset":0}}','core',1,508,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m3_per_ha_water');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.plants_per_ha','unit',NULL,NULL,'count_area','plant',NULL,'{"en":"plants/ha"}',NULL,'{"dimension":"plant_count_per_area","to_canonical":{"unit_code":"unit.plants_per_ha","scale":1,"offset":0}}','core',1,509,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.plants_per_ha');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.biological_count_per_ha','unit',NULL,NULL,'biological_count_area','biological_agent',NULL,'{"en":"unit/ha"}',NULL,'{"dimension":"biological_agent_count_per_area","to_canonical":{"unit_code":"unit.biological_count_per_ha","scale":1,"offset":0}}','core',1,510,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.biological_count_per_ha');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.h_per_ha_labor','unit',NULL,NULL,'duration_area','labor',NULL,'{"en":"hours/ha"}',NULL,'{"dimension":"labor_time_per_area","to_canonical":{"unit_code":"unit.h_per_ha_labor","scale":1,"offset":0}}','core',1,511,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.h_per_ha_labor');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_n_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg N/ha"}',NULL,'{"dimension":"mass_n_per_area","to_canonical":{"unit_code":"unit.kg_n_per_ha_nutrient","scale":1,"offset":0},"nutrient":"N"}','core',1,512,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_n_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_p2o5_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg P₂O₅/ha"}',NULL,'{"dimension":"mass_p2o5_per_area","to_canonical":{"unit_code":"unit.kg_p2o5_per_ha_nutrient","scale":1,"offset":0},"nutrient":"P2O5"}','core',1,513,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_p2o5_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_k2o_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg K₂O/ha"}',NULL,'{"dimension":"mass_k2o_per_area","to_canonical":{"unit_code":"unit.kg_k2o_per_ha_nutrient","scale":1,"offset":0},"nutrient":"K2O"}','core',1,514,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_k2o_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_mg_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg Mg/ha"}',NULL,'{"dimension":"mass_mg_per_area","to_canonical":{"unit_code":"unit.kg_mg_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Mg"}','core',1,515,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_mg_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_s_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg S/ha"}',NULL,'{"dimension":"mass_s_per_area","to_canonical":{"unit_code":"unit.kg_s_per_ha_nutrient","scale":1,"offset":0},"nutrient":"S"}','core',1,516,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_s_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_ca_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg Ca/ha"}',NULL,'{"dimension":"mass_ca_per_area","to_canonical":{"unit_code":"unit.kg_ca_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Ca"}','core',1,517,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_ca_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_b_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg B/ha"}',NULL,'{"dimension":"mass_b_per_area","to_canonical":{"unit_code":"unit.kg_b_per_ha_nutrient","scale":1,"offset":0},"nutrient":"B"}','core',1,518,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_b_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_na_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg Na/ha"}',NULL,'{"dimension":"mass_na_per_area","to_canonical":{"unit_code":"unit.kg_na_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Na"}','core',1,519,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_na_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_mn_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg Mn/ha"}',NULL,'{"dimension":"mass_mn_per_area","to_canonical":{"unit_code":"unit.kg_mn_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Mn"}','core',1,520,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_mn_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_cao_per_ha_nutrient','unit',NULL,NULL,'nutrient_rate','nutrient',NULL,'{"en":"kg CaO/ha"}',NULL,'{"dimension":"mass_cao_per_area","to_canonical":{"unit_code":"unit.kg_cao_per_ha_nutrient","scale":1,"offset":0},"nutrient":"CaO"}','core',1,521,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_cao_per_ha_nutrient');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.mm_water','unit',NULL,NULL,'water_depth','water',NULL,'{"en":"mm"}',NULL,'{"dimension":"water_depth","to_canonical":{"unit_code":"unit.mm_water","scale":1,"offset":0}}','core',1,522,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.mm_water');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.min_duration','unit',NULL,NULL,'duration','elapsed_time',NULL,'{"en":"min"}',NULL,'{"dimension":"elapsed_time","to_canonical":{"unit_code":"unit.min_duration","scale":1,"offset":0}}','core',1,523,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.min_duration');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.hour_duration','unit',NULL,NULL,'duration','elapsed_time',NULL,'{"en":"h"}',NULL,'{"dimension":"elapsed_time","to_canonical":{"unit_code":"unit.min_duration","scale":60,"offset":0}}','core',1,524,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.hour_duration');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.day_duration','unit',NULL,NULL,'calendar_duration','calendar_day',NULL,'{"en":"days"}',NULL,'{"dimension":"calendar_day","to_canonical":{"unit_code":"unit.day_duration","scale":1,"offset":0}}','core',1,525,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.day_duration');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.l_per_plant_water','unit',NULL,NULL,'volume_per_plant','water',NULL,'{"en":"L/plant"}',NULL,'{"dimension":"water_volume_per_plant","to_canonical":{"unit_code":"unit.l_per_plant_water","scale":1,"offset":0}}','core',1,526,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.l_per_plant_water');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.m2_area','unit',NULL,NULL,'area','land_area',NULL,'{"en":"m²"}',NULL,'{"dimension":"area","to_canonical":{"unit_code":"unit.m2_area","scale":1,"offset":0}}','core',1,527,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m2_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.ha_area','unit',NULL,NULL,'area','land_area',NULL,'{"en":"ha"}',NULL,'{"dimension":"area","to_canonical":{"unit_code":"unit.m2_area","scale":10000,"offset":0}}','core',1,528,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.ha_area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.l_water','unit',NULL,NULL,'volume','water',NULL,'{"en":"L"}',NULL,'{"dimension":"water_volume","to_canonical":{"unit_code":"unit.l_water","scale":1,"offset":0}}','core',1,529,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.l_water');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_mass','unit',NULL,NULL,'mass','lysimeter',NULL,'{"en":"kg"}',NULL,'{"dimension":"mass","to_canonical":{"unit_code":"unit.kg_mass","scale":1,"offset":0}}','core',1,530,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_mass');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.ds_per_m','unit',NULL,NULL,'electrical_conductivity','solution',NULL,'{"en":"dS/m"}',NULL,'{"dimension":"electrical_conductivity","to_canonical":{"unit_code":"unit.ds_per_m","scale":1,"offset":0}}','core',1,531,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.ds_per_m');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.ph','unit',NULL,NULL,'acidity','solution',NULL,'{"en":"pH"}',NULL,'{"dimension":"acidity","to_canonical":{"unit_code":"unit.ph","scale":1,"offset":0}}','core',1,532,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.ph');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.count_integer','unit',NULL,NULL,'count','operation_group',NULL,'{"en":"count"}',NULL,'{"dimension":"count","to_canonical":{"unit_code":"unit.count_integer","scale":1,"offset":0}}','core',1,533,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.count_integer');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_per_t_dry_matter','unit',NULL,NULL,'mass_fraction','product_wet_mass',NULL,'{"en":"kg/t"}',NULL,'{"dimension":"dry_matter_mass_per_fresh_mass","to_canonical":{"unit_code":"unit.kg_per_t_dry_matter","scale":1,"offset":0}}','core',1,534,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_t_dry_matter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.kg_per_m3_dry_matter','unit',NULL,NULL,'mass_concentration','product_volume',NULL,'{"en":"kg/m³"}',NULL,'{"dimension":"dry_matter_mass_per_product_volume","to_canonical":{"unit_code":"unit.kg_per_m3_dry_matter","scale":1,"offset":0}}','core',1,535,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_m3_dry_matter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.g_c_per_kg_dm','unit',NULL,NULL,'mass_fraction','dry_matter_carbon',NULL,'{"en":"g C/kg DM"}',NULL,'{"dimension":"carbon_mass_per_dry_matter_mass","to_canonical":{"unit_code":"unit.g_c_per_kg_dm","scale":1,"offset":0}}','core',1,536,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.g_c_per_kg_dm');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.g_n_per_kg_dm','unit',NULL,NULL,'mass_fraction','dry_matter_nitrogen',NULL,'{"en":"g N/kg DM"}',NULL,'{"dimension":"nitrogen_mass_per_dry_matter_mass","to_canonical":{"unit_code":"unit.g_n_per_kg_dm","scale":1,"offset":0}}','core',1,537,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.g_n_per_kg_dm');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.t_per_ha_dm','unit',NULL,NULL,'yield_area','dry_matter_yield',NULL,'{"en":"t DM/ha"}',NULL,'{"dimension":"dry_matter_yield_per_area","to_canonical":{"unit_code":"unit.t_per_ha_dm","scale":1,"offset":0}}','core',1,538,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.t_per_ha_dm');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.bbch_stage','unit',NULL,NULL,'growth_stage','phenology',NULL,'{"en":"BBCH"}',NULL,'{"dimension":"growth_stage","to_canonical":{"unit_code":"unit.bbch_stage","scale":1,"offset":0}}','core',1,539,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.bbch_stage');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.m_per_s','unit',NULL,NULL,'wind_speed','ambient',NULL,'{"en":"m/s"}',NULL,'{"dimension":"wind_speed","to_canonical":{"unit_code":"unit.m_per_s","scale":1,"offset":0}}','core',1,540,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m_per_s');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.deg_c','unit',NULL,NULL,'temperature','ambient',NULL,'{"en":"°C"}',NULL,'{"dimension":"temperature","to_canonical":{"unit_code":"unit.deg_c","scale":1,"offset":0}}','core',1,541,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.deg_c');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'unit.percent','unit',NULL,NULL,'relative_humidity','ambient',NULL,'{"en":"%"}',NULL,'{"dimension":"relative_humidity","to_canonical":{"unit_code":"unit.percent","scale":1,"offset":0}}','core',1,542,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.percent');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.cover.bare','choice','attr.cover_type',NULL,NULL,NULL,NULL,'{"en":"Bare soil"}',NULL,NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.cover.bare');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.cover.crop','choice','attr.cover_type',NULL,NULL,NULL,NULL,'{"en":"Crop cover"}',NULL,NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.cover.crop');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.cover.mulch','choice','attr.cover_type',NULL,NULL,NULL,NULL,'{"en":"Mulch"}',NULL,NULL,'core',1,30,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.cover.mulch');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.denominator.area','choice','attr.denominator',NULL,NULL,NULL,NULL,'{"en":"Per area"}',NULL,NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.denominator.area');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.denominator.plant','choice','attr.denominator',NULL,NULL,NULL,NULL,'{"en":"Per plant"}',NULL,NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.denominator.plant');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.denominator.row','choice','attr.denominator',NULL,NULL,NULL,NULL,'{"en":"Per row length"}',NULL,NULL,'core',1,30,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.denominator.row');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.root_zone.soil','choice','attr.root_zone_system',NULL,NULL,NULL,NULL,'{"en":"Soil"}',NULL,NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.soil');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.root_zone.container','choice','attr.root_zone_system',NULL,NULL,NULL,NULL,'{"en":"Container"}',NULL,NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.container');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.root_zone.substrate','choice','attr.root_zone_system',NULL,NULL,NULL,NULL,'{"en":"Substrate"}',NULL,NULL,'core',1,30,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.substrate');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.root_zone.hydroponic','choice','attr.root_zone_system',NULL,NULL,NULL,NULL,'{"en":"Hydroponic"}',NULL,NULL,'core',1,40,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.hydroponic');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.mass_method.direct','choice','attr.mass_method',NULL,NULL,NULL,NULL,'{"en":"Direct weighing"}',NULL,NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.mass_method.direct');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.mass_method.load_cell','choice','attr.mass_method',NULL,NULL,NULL,NULL,'{"en":"Load cell"}',NULL,NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.mass_method.load_cell');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.irrigation_amount.measured','choice','attr.irrigation_amount_kind',NULL,NULL,NULL,NULL,'{"en":"Measured"}',NULL,NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.irrigation_amount.measured');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.irrigation_amount.estimated','choice','attr.irrigation_amount_kind',NULL,NULL,NULL,NULL,'{"en":"Estimated"}',NULL,NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.irrigation_amount.estimated');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.irrigation_amount.commanded','choice','attr.irrigation_amount_kind',NULL,NULL,NULL,NULL,'{"en":"Commanded"}',NULL,NULL,'core',1,30,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.irrigation_amount.commanded');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.measurement.manual','choice','attr.measurement_source',NULL,NULL,NULL,NULL,'{"en":"Manual"}',NULL,NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.measurement.manual');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.measurement.sensor','choice','attr.measurement_source',NULL,NULL,NULL,NULL,'{"en":"Sensor"}',NULL,NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.measurement.sensor');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.measurement.controller','choice','attr.measurement_source',NULL,NULL,NULL,NULL,'{"en":"Controller"}',NULL,NULL,'core',1,30,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.measurement.controller');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.permanent_grassland','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Permanent grassland"}',NULL,NULL,'core',1,4000,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.permanent_grassland');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.field_vegetable','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Field vegetable"}',NULL,NULL,'core',1,4010,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.field_vegetable');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.green_manure_cover','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Green manure / cover crop"}',NULL,NULL,'core',1,4020,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.green_manure_cover');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.fallow','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Fallow"}',NULL,NULL,'core',1,4030,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.fallow');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.other','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Other"}',NULL,NULL,'core',1,4040,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.other');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.n','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"North"}',NULL,NULL,'core',1,10,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.n');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.ne','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"Northeast"}',NULL,NULL,'core',1,20,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.ne');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.e','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"East"}',NULL,NULL,'core',1,30,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.e');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.se','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"Southeast"}',NULL,NULL,'core',1,40,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.se');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.s','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"South"}',NULL,NULL,'core',1,50,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.s');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.sw','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"Southwest"}',NULL,NULL,'core',1,60,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.sw');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.w','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"West"}',NULL,NULL,'core',1,70,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.w');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.wind.nw','choice','attr.wind_direction',NULL,NULL,NULL,NULL,'{"en":"Northwest"}',NULL,NULL,'core',1,80,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.nw');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.carrot','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Carrot"}',NULL,NULL,'core',1,3500,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.carrot');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.onion','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Onion"}',NULL,NULL,'core',1,3504,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.onion');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.leek','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Leek"}',NULL,NULL,'core',1,3508,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.leek');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.cabbage','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Cabbage"}',NULL,NULL,'core',1,3512,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.cabbage');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.cauliflower','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Cauliflower"}',NULL,NULL,'core',1,3516,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.cauliflower');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.broccoli','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Broccoli"}',NULL,NULL,'core',1,3520,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.broccoli');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.lettuce','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Lettuce"}',NULL,NULL,'core',1,3524,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.lettuce');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.spinach','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Spinach"}',NULL,NULL,'core',1,3528,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.spinach');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.celeriac','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Celeriac"}',NULL,NULL,'core',1,3532,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.celeriac');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.fennel','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Fennel"}',NULL,NULL,'core',1,3536,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.fennel');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.table_beet','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Table beet"}',NULL,NULL,'core',1,3540,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.table_beet');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.courgette','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Courgette / zucchini"}',NULL,NULL,'core',1,3544,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.courgette');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.pumpkin_squash','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Pumpkin / squash"}',NULL,NULL,'core',1,3548,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.pumpkin_squash');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.sweetcorn','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Sweetcorn"}',NULL,NULL,'core',1,3552,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.sweetcorn');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.garden_pea','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Garden pea"}',NULL,NULL,'core',1,3556,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.garden_pea');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'choice.crop.green_bean','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"Green bean"}',NULL,NULL,'core',1,3560,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.green_bean');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.primary_tillage','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Primary Tillage"}',NULL,'{"description":"Primary tillage is a loosening, mixing or inverting form of cultivation with a cultivation depth between 15 cm and 35 cm. Primary tillage takes place prior to seedbed preparation and sowing.","source":"KTBL (2020)","source_category":"tillage"}','core',1,1000,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.primary_tillage');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.seedbed_preparation','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Seedbed Preparation"}',NULL,'{"description":"Seedbed preparation or secondary tillage is limited to an operation depth of 5-10 cm. The seed horizon\nis crumbled finely, loosened and reconsolidated to ensure optimal seed germination.","source":"KTBL (2020)","source_category":"tillage"}','core',1,1001,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.seedbed_preparation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.stubble_cultivation','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Stubble Cultivation"}',NULL,'{"description":"Stubble cultivation is only a shallow cultivation method to loosen, mix or invert the soil after harvesting to promote the emergence of volunteer grain and weed seeds, with a cultivation depth of up to 15 cm. It is assumed that the implements are used as intended. Within the non-inversion method, all further operations with an operation depth of more than 10 cm represent primary tillage.","source":"KTBL (2020)","source_category":"tillage"}','core',1,1002,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.stubble_cultivation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.sowing_cover_crop','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Sowing Cover Crop"}',NULL,'{"description":"Sowing is the defined placement of seed at an optimal depth for the type of cover crop.","source":"KTBL (2020)","source_category":"sowing"}','core',1,1003,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.sowing_cover_crop');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.sowing_main_crop','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Sowing Main Crop"}',NULL,'{"description":"Sowing is the defined placement of seed at an optimal depth for the type of main crop.","source":"KTBL (2020)","source_category":"sowing"}','core',1,1004,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.sowing_main_crop');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.organic_fertilization','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Organic Fertilization"}',NULL,'{"description":"Organic fertilizer: a carbon-rich fertilizer derived from organic materials, including treated or untreated livestock manures, compost, vermicompost, sewage sludge and other organic materials or mixed materials used to supply nutrients to soils.","source":"AGROVOC","source_category":"fertilizer_application"}','core',1,1005,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.organic_fertilization');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.mineral_fertilization','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Mineral Fertilization"}',NULL,'{"description":"Inorganic fertilizer: a nutrient-rich fertilizer produced industrially by chemical processes, mineral extraction or by mechanical grinding.","source":"AGROVOC","source_category":"fertilizer_application"}','core',1,1006,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.mineral_fertilization');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.other_fertilization','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Other Fertilization"}',NULL,'{"description":"Other soil amendments that are applied in the intention to provide nutrient to crops or to increase soil fertility","source":"AGROVOC","source_category":"fertilizer_application"}','core',1,1007,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.other_fertilization');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.biocontrol','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Biocontrol"}',NULL,'{"description":"Biological control: The use of biological agents (e.g. insects, micro-organisms and/or microbial metabolites) for the control of mites, pests, plant pathogens and spoilage organisms.","source":"AGROVOC","source_category":"crop_protection"}','core',1,1008,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.biocontrol');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.fungicide','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Fungicide"}',NULL,'{"description":"The application of chemicals aimed at killing fungi","source":"Blanchy et al. (2023)","source_category":"crop_protection"}','core',1,1009,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.fungicide');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.insecticide','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Insecticide"}',NULL,'{"description":"The application of chemicals aimed at killing insects","source":"Blanchy et al. (2023)","source_category":"crop_protection"}','core',1,1010,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.insecticide');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.growth_regulator','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Growth Regulator"}',NULL,'{"description":"The application of chemicals aimed at reducing vegative growth of crops","source":"Custom","source_category":"crop_protection"}','core',1,1011,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.growth_regulator');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.weed_herbicide','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Weed Herbicide"}',NULL,'{"description":"The application of chemicals aimed at killing weeds","source":"Blanchy et al. (2023)","source_category":"crop_protection"}','core',1,1012,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.weed_herbicide');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.total_herbicide','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Total Herbicide"}',NULL,'{"description":"","source":"","source_category":"crop_protection"}','core',1,1013,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.total_herbicide');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.weed_mechanical','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Weed Mechanical"}',NULL,'{"description":"Application of mechanical weeding operations to reduce weed preasure.","source":"Custom","source_category":"crop_protection"}','core',1,1014,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.weed_mechanical');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.weed_other','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Weed Other"}',NULL,'{"description":"Application of weeding operations other then chemical and mechanical to reduce weed preasure.","source":"Custom","source_category":"crop_protection"}','core',1,1015,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.weed_other');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.pest_control','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Pest Control"}',NULL,'{"description":"","source":"","source_category":"crop_protection"}','core',1,1016,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.pest_control');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.harvest_main_crop','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Harvest Main Crop"}',NULL,'{"description":"Harvest operation of the main crop","source":"Custom","source_category":"harvest"}','core',1,1017,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.harvest_main_crop');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.harvest_cover_crop','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Harvest Cover Crop"}',NULL,'{"description":"Harvest operation of the cover crop, leads to killing of the cover crop and removal of the aboveground biomass","source":"Custom","source_category":"harvest"}','core',1,1018,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.harvest_cover_crop');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.hay_removal','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Hay Removal"}',NULL,'{"description":"Removing dried grasses (but may include legumes and herbs) that have been cut, to preserve as fodder","source":"AGROVOC","source_category":"harvest"}','core',1,1019,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.hay_removal');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.straw_removal','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Straw Removal"}',NULL,'{"description":"Removing straw and other crop residues from the field","source":"Custom","source_category":"harvest"}','core',1,1020,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.straw_removal');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.cleaning_cut','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Cleaning Cut"}',NULL,'{"description":"Cutting of grasses and other crops for aesthetic reasons","source":"Custom","source_category":"harvest"}','core',1,1021,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.cleaning_cut');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.watering','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Watering"}',NULL,'{"description":"Irrigation is the process of applying controlled amounts of water to plants at needed intervals","source":"AGROVOC","source_category":"irrigation"}','core',1,1022,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.watering');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.sampling','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Sampling"}',NULL,'{"description":"","source":"","source_category":"other"}','core',1,1023,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.sampling');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.operation.note','choice','attr.agroscope.operation',NULL,NULL,NULL,NULL,'{"en":"Note"}',NULL,'{"description":"","source":"","source_category":"other"}','core',1,1024,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.note');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.plough','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Plough"}',NULL,'{"descriptions":["Loosening and mixing, inversion primary tillage. Intensive soil cultivation, very little covering with plant residues on the surface. Also called moldboard plough."],"sources":["KTBL (2020)"]}','core',1,2000,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.plough');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.plough_with_packer','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Plough With Packer"}',NULL,'{"descriptions":["Loosening and mixing, inversion primary tillage with consolidation and breaking of clods. Intensive soil cultivation, leaving very little covering with plant residues on the surface. Crumbling and consolidation through trailing packer."],"sources":["KTBL (2020)"]}','core',1,2001,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.plough_with_packer');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.spading_machine','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Spading Machine"}',NULL,'{"descriptions":["Loosening and mixing, non-inversion primary tillage. The implement reduces covering of the surface with organic residues by 85 %."],"sources":["KTBL (2020)"]}','core',1,2002,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.spading_machine');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.deep_tiller','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Deep Tiller"}',NULL,'{"descriptions":["Loosening and mixing, non-inversion primary tillage with driven tools. The implement reduces covering of the surface with organic residues by 85 %."],"sources":["KTBL (2020)"]}','core',1,2003,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.deep_tiller');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.heavy_duty_cultivator','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Heavy Duty Cultivator"}',NULL,'{"descriptions":["Loosening and mixing, non-inversion primary tillage. The implement reduces covering of the surface with organic residues by 50-75 %. Also called chisel plough.","Loosening and mixing, non-inversion stubble cultivation (deep). The implement reduces covering of the surface with organic residues by 50-75 %. Also called chisel plough."],"sources":["KTBL (2020)"]}','core',1,2004,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.heavy_duty_cultivator');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.heavy_duty_cultivator_sweeps','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Heavy Duty Cultivator Sweeps"}',NULL,'{"descriptions":["Same as above, but with sweeps mounted at the chisel."],"sources":["Custom","KTBL (2020)"]}','core',1,2005,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.heavy_duty_cultivator_sweeps');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.disk_harrow','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Disk Harrow"}',NULL,'{"descriptions":["Loosening and mixing, non-inversion primary tillage. The implement reduces covering of the surface with organic residues by 40-60 %.","Mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 40-60 %."],"sources":["KTBL (2020)"]}','core',1,2006,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.disk_harrow');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.strip_tiller','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Strip Tiller"}',NULL,'{"descriptions":["Partial strip-wise loosening, non-inversion primary tillage - strip-wise cultivation of the seed rows before sowing. Less than 50 % of the total area is cultivated. The implement reduces covering of the surface with organic residues by 60-70 %.","The seed horizon is partially strip-wise loosened and crumbled with towed, not driven implements and reconsolidated with a roller. The implement speed is equivalent to the driving speed. The implement reduces covering of the cultivated surface with organic residues by 50-60 %."],"sources":["KTBL (2020)"]}','core',1,2007,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.strip_tiller');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.subsoiler','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Subsoiler"}',NULL,'{"descriptions":["The subsoiler is a primary tillage tool, that is similar to a chisel plow. It is typically designed to penetrate 30 to 55 cm deep to alleviate soil compaction."],"sources":["NRCS (2017)"]}','core',1,2008,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.subsoiler');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.paraplough','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Paraplough"}',NULL,'{"descriptions":["The purpose of the Paraplough is to loosen compacted soil layers 30 to 40 cm deep and still maintain high surface residue levels. The Paraplow lifts and fractures the soil."],"sources":["NRCS (2017)"]}','core',1,2009,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.paraplough');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.separator','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Separator"}',NULL,'{"descriptions":["Operation to separate stones, typcially used for potatos"],"sources":["Custom"]}','core',1,2010,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.separator');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.skim_plough','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Skim Plough"}',NULL,'{"descriptions":["Inversion stubble cultivation. Little covering with plant residues on the surface (on < 10 % of ground covering)."],"sources":["KTBL (2020)"]}','core',1,2011,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.skim_plough');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.seedbed_combination','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Seedbed Combination"}',NULL,'{"descriptions":[],"sources":[]}','core',1,2012,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.seedbed_combination');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.rotary_harrow','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Rotary Harrow"}',NULL,'{"descriptions":["The seed horizon is loosened and crumbled with driven implements operating around a vertical axis, and reconsolidated with a roller. The implement reduces covering of the surface with organic residues by 30 %. The implement speed is equivalent to the driving speed in interaction with the circumferential speed of 3-6 m/s. Tines are straight, trailed or \"on grip\". Also called rotary cultivator when tines are \"on grip\"."],"sources":["KTBL (2020)"]}','core',1,2013,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rotary_harrow');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.tine_rotor','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Tine Rotor"}',NULL,'{"descriptions":["The seed horizon is loosened and crumbled with driven implements operating around the transverse axis and reconsolidated with a roller. The implement reduces covering of the surface with organic residues by 50-75 %. The implement speed is equivalent to the driving speed in interaction with the circumferential speed of 4-8 m/s."],"sources":["KTBL (2020)"]}','core',1,2014,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tine_rotor');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.tiller','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Tiller"}',NULL,'{"descriptions":["The seed horizon is loosened and crumbled with driven implements operating around the transverse axis, and reconsolidated with a roller. The implement reduces covering of the surface with organic residues by 50-75 %. The implement speed is equivalent to the driving speed in interaction with the circumferential speed of 4-8 m/s"],"sources":["KTBL (2020)"]}','core',1,2015,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tiller');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.bedder','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Bedder"}',NULL,'{"descriptions":["Operation to form dams or beds, e.g. for potatos or carotts"],"sources":["Custom"]}','core',1,2016,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.bedder');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.mulching','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Mulching"}',NULL,'{"descriptions":["Mulching involves shredding of above-ground organic material like stubbles, grasses or cover crops and covering the soil with the shredded material without any intervention in the soil."],"sources":["Custom"]}','core',1,2017,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.mulching');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.tine_weeder','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Tine Weeder"}',NULL,'{"descriptions":["Mixing, very shallow stubble cultivation. Even spreading of the straw covering and unroots weeds. The implement reduces covering of the surface with organic residues by 5 %."],"sources":["KTBL (2020)"]}','core',1,2018,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tine_weeder');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.rotary_weeder','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Rotary Weeder"}',NULL,'{"descriptions":["Mixing, very shallow stubble cultivation with a rotating device. Even spreading of the straw covering and unrooting weeds."],"sources":["Custom"]}','core',1,2019,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rotary_weeder');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.ring_cutter','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Ring Cutter"}',NULL,'{"descriptions":["Loosening and mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 10 %"],"sources":["KTBL (2020)"]}','core',1,2020,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.ring_cutter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.roller','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Roller"}',NULL,'{"descriptions":["Rollers firm the seed bed or consolidate loose soil. This contributes to better seed soil contact and is important for establishment of small seeded crops like forages.","Roller firm the seed bed or recompact loose soil. This contributes to better seed soil contact and is important for establishment of small seeded crops like forages.","Use of a roller to encourage tillering of cereals."],"sources":["Custom","NRCS (2017)"]}','core',1,2021,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.roller');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.knife_roller','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Knife Roller"}',NULL,'{"descriptions":["Crushing, cutting and mixing effect on organic residues and cover crops. The implement reduces covering of the surface with organic residues by 10 %."],"sources":["KTBL (2020)"]}','core',1,2022,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.knife_roller');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.short_disk_harrow','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Short Disk Harrow"}',NULL,'{"descriptions":["Mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 40-60 %."],"sources":["KTBL (2020)"]}','core',1,2023,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.short_disk_harrow');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.spade_roller_harrow','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Spade Roller Harrow"}',NULL,'{"descriptions":["Mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 40-60 %."],"sources":["KTBL (2020)"]}','core',1,2024,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.spade_roller_harrow');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.fine_cultivator','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Fine Cultivator"}',NULL,'{"descriptions":["Loosening and mixing, non-inversion stubble cultivation (shallow). The implement reduces covering of the surface with organic residues by 20-40 %. Also called chisel."],"sources":["KTBL (2020)"]}','core',1,2025,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.fine_cultivator');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.fine_cultivator_sweeps','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Fine Cultivator Sweeps"}',NULL,'{"descriptions":["Same as above, but with sweeps mounted at the chisel."],"sources":["KTBL (2020)"]}','core',1,2026,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.fine_cultivator_sweeps');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.straw_harrow','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Straw Harrow"}',NULL,'{"descriptions":["Harrow, used to distribute residues evenly and level field surface (e.g., in no-till systems)"],"sources":["Custom"]}','core',1,2027,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.straw_harrow');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.direct_drill','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Direct Drill"}',NULL,'{"descriptions":["Seed placement in rows or bands with no prior tillage. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution. Soil disturbance is not more than needed for seed and fertiliser placement. Sowing is carried out on less than 1/3 of the row width Cultivation depth is the seed placement depth."],"sources":["KTBL (2020)"]}','core',1,2028,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.direct_drill');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.direct_single_grain','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Direct Single Grain"}',NULL,'{"descriptions":["Seed placement is carried out without previous tillage. Seed placement in rows with defined longitudinal grain spacing at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution. Sowing is carried out on less than 1/3 of the row width Cultivation depth is the seed placement depth."],"sources":["KTBL (2020)"]}','core',1,2029,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.direct_single_grain');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.classic_drill','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Classic Drill"}',NULL,'{"descriptions":["Seed placement in rows or bands at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution."],"sources":["KTBL (2020)"]}','core',1,2030,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.classic_drill');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.classic_single_grain','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Classic Single Grain"}',NULL,'{"descriptions":["Seed placement in rows with defined longitudinal grain spacing at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution."],"sources":["KTBL (2020)"]}','core',1,2031,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.classic_single_grain');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.broadcast_seeder','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Broadcast Seeder"}',NULL,'{"descriptions":["Broadcast seeding is a method of seeding that involves scattering seed, by hand or mechanically, over a relatively large area."],"sources":["Custom"]}','core',1,2032,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.broadcast_seeder');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.grassland_reseeder','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Grassland Reseeder"}',NULL,'{"descriptions":["Seed placement is carried out without previous tillage. Seed placement in rows at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution."],"sources":["KTBL (2020)"]}','core',1,2033,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.grassland_reseeder');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.potato_planter','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Potato Planter"}',NULL,'{"descriptions":["Planting potatoes into ridges"],"sources":["Custom"]}','core',1,2034,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.potato_planter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liquid_organic_broadcast','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liquid Organic Broadcast"}',NULL,'{"descriptions":["Broadcast application of liquid organic compounds like slurry with baffle plates or other distribution devices."],"sources":["Custom"]}','core',1,2035,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_broadcast');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liquid_organic_draghose','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liquid Organic Draghose"}',NULL,'{"descriptions":["Application of liquid organic compounds like slurry with drag hose distributors."],"sources":["Custom"]}','core',1,2036,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_draghose');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liquid_organic_trailingshoe','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liquid Organic Trailingshoe"}',NULL,'{"descriptions":["Application of liquid organic compounds like slurry with trailingshoe distributors."],"sources":["Custom"]}','core',1,2037,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_trailingshoe');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liquid_organic_injection','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liquid Organic Injection"}',NULL,'{"descriptions":["Application of liquid organic compounds like slurry with injection distributors."],"sources":["Custom"]}','core',1,2038,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_injection');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.manure_broadcast','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Manure Broadcast"}',NULL,'{"descriptions":["An implement used to distribute manure over a field. It usually consists of a trailer towed behind a tractor with a rotating mechanism driven by the tractor''s power take off."],"sources":["AGROVOC"]}','core',1,2039,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.manure_broadcast');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.compost_broadcast','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Compost Broadcast"}',NULL,'{"descriptions":["An implement used to distribute compost over a field. It usually consists of a trailer towed behind a tractor with a rotating mechanism driven by the tractor''s power take off."],"sources":["Custom"]}','core',1,2040,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.compost_broadcast');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.other_organic_solid_broadcast','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Other Organic Solid Broadcast"}',NULL,'{"descriptions":["An implement used to distribute other solid organic amendments than manure or compost over a field. It usually consists of a trailer towed behind a tractor with a rotating mechanism driven by the tractor''s power take off."],"sources":["Custom"]}','core',1,2041,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.other_organic_solid_broadcast');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.solid_broadcast','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Solid Broadcast"}',NULL,'{"descriptions":["Broadcasting of solid mineral fertilizers"],"sources":["AGROVOC"]}','core',1,2042,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.solid_broadcast');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.solid_band','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Solid Band"}',NULL,'{"descriptions":["Band placement of solid mineral fertilizers"],"sources":["AGROVOC"]}','core',1,2043,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.solid_band');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.solid_undersown_placement','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Solid Undersown Placement"}',NULL,'{"descriptions":["An application method for solid mineral fertilizer in which the fertilizer is placed in the soil below the seeds."],"sources":["Custom"]}','core',1,2044,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.solid_undersown_placement');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liquid_injection','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liquid Injection"}',NULL,'{"descriptions":["An application method for liquid mineral fertilizer in which the fertilizer is injected into the soil."],"sources":["Custom"]}','core',1,2045,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_injection');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liquid_spraying','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liquid Spraying"}',NULL,'{"descriptions":["An application method for liquid mineral fertilizer in which the fertilizer is sprayed on the crops and the soil surface."],"sources":["Custom"]}','core',1,2046,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_spraying');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liquid_fertigation','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liquid Fertigation"}',NULL,'{"descriptions":["Fertigation is the injection of fertilizers and other water-soluble products into an irrigation system."],"sources":["AGROVOC"]}','core',1,2047,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_fertigation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.biofertilizer','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Biofertilizer"}',NULL,'{"descriptions":["Application of effective microorganisms, rhizobia, compost tee or biodynamic preparation like e.g. horn manure (P 500), etc."],"sources":["Custom"]}','core',1,2048,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.biofertilizer');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.liming','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Liming"}',NULL,'{"descriptions":["The application of lime, dolomite or gypsum. Specify the product in product colum"],"sources":["Custom"]}','core',1,2049,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liming');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.disease_biocontrol','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Disease Biocontrol"}',NULL,'{"descriptions":["Apllication of biocontrol agent against diseases"],"sources":["Custom"]}','core',1,2050,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.disease_biocontrol');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.pest_biocontrol','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Pest Biocontrol"}',NULL,'{"descriptions":["Apllication of biocontrol agent against pests"],"sources":["Custom"]}','core',1,2051,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.pest_biocontrol');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.weed_biocontrol','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Weed Biocontrol"}',NULL,'{"descriptions":["Apllication of biocontrol agent against weeds"],"sources":["Custom"]}','core',1,2052,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.weed_biocontrol');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.sprayer','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Sprayer"}',NULL,'{"descriptions":["Broadcast application of synthetic fungicides by spraying","Broadcast application of synthetic insecticides by spraying","broadcast application of synthetic growth regulators by spraying"],"sources":["Custom"]}','core',1,2053,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.seed_coating','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Seed Coating"}',NULL,'{"descriptions":["Seed coating with synthetic fungicides","seed coating with synthetic insecticides"],"sources":["Custom"]}','core',1,2054,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.seed_coating');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.sprayer_broadcast','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Sprayer Broadcast"}',NULL,'{"descriptions":["broadcast application of synthetic herbizides by spraying"],"sources":["Custom"]}','core',1,2055,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer_broadcast');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.sprayer_band','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Sprayer Band"}',NULL,'{"descriptions":["Strip or band application of synthetic herbizides by spraying"],"sources":["Custom"]}','core',1,2056,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer_band');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.sprayer_spot','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Sprayer Spot"}',NULL,'{"descriptions":["Spot application of synthetic herbizides by spraying, incl. manual spraying with shoulder mounted tank."],"sources":["Custom"]}','core',1,2057,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer_spot');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.tine_hoe','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Tine Hoe"}',NULL,'{"descriptions":["Inter-rows soil cultivation with shovels, sweeps or pike implements"],"sources":["Mohler et al. (2021)."]}','core',1,2058,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tine_hoe');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.rotary_hoe','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Rotary Hoe"}',NULL,'{"descriptions":["ground-driven implement that uses a series of wheels with metal spoons radiating out"],"sources":["Mohler et al. (2021)."]}','core',1,2059,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rotary_hoe');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.finger_hoe','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Finger Hoe"}',NULL,'{"descriptions":["designed to mount on a row-crop cultivator to provide in-row and near-row weeding that cannot be achieved by sweeps and shovels alone."],"sources":["Mohler et al. (2021)."]}','core',1,2060,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.finger_hoe');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.star_hoe','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Star Hoe"}',NULL,'{"descriptions":["sually consists of gangs of “spider” ground driven wheels with two gangs working in each inter-row. Depending on the setting of the gangs, soil flow is strictly toward or away from the row."],"sources":["Mohler et al. (2021)."]}','core',1,2061,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.star_hoe');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.other_mechanical_weeder','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Other Mechanical Weeder"}',NULL,'{"descriptions":[],"sources":[]}','core',1,2062,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.other_mechanical_weeder');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.burning','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Burning"}',NULL,'{"descriptions":["use of propane or butane flame to burn weeds"],"sources":["Mohler et al. (2021)."]}','core',1,2063,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.burning');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.electric','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Electric"}',NULL,'{"descriptions":["electric discharge weeder bringing a high voltage electrode into contact with weeds"],"sources":["Mohler et al. (2021)."]}','core',1,2064,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.electric');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.manual','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Manual"}',NULL,'{"descriptions":["Manual removing of weeds"],"sources":["Custom"]}','core',1,2065,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.manual');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.slug_control','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Slug Control"}',NULL,'{"descriptions":["Slug control, e.g. with pellets. Specify in product"],"sources":["Custom"]}','core',1,2066,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.slug_control');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.rodent_control','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Rodent Control"}',NULL,'{"descriptions":["Rodent control, e.g. with traps. Specify in product."],"sources":["Custom"]}','core',1,2067,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rodent_control');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.combine_harvester','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Combine Harvester"}',NULL,'{"descriptions":["The combine harvester is a versatile machine designed to efficiently harvest a variety of grain crops. The name derives from its combining three separate harvesting operations—reaping, threshing, and winnowing—into a single process."],"sources":["AGROVOC"]}','core',1,2068,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.combine_harvester');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.beet_lifter','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Beet Lifter"}',NULL,'{"descriptions":["After defoliation with a topper, a mechanical beet lifter pulls beets from the soil, removing much of the soil from the root. Beet lifter-loader harvesters can also load roots onto trucks, but simple two-wheeled, bladed beet lifters may also be followed by hand labourers."],"sources":["AGROVOC"]}','core',1,2069,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.beet_lifter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.potato_harvester','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Potato Harvester"}',NULL,'{"descriptions":["Potato harvesters are machines that harvest potatoes."],"sources":["AGROVOC"]}','core',1,2070,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.potato_harvester');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.maize_chopper','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Maize Chopper"}',NULL,'{"descriptions":["Maize choppers are machines to harvest maize plants."],"sources":["Custom"]}','core',1,2071,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.maize_chopper');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.mower','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Mower"}',NULL,'{"descriptions":["An agricultural implement that is used to cut grass or any plant that grows on the ground.","An agricultural implement used to cut grass or other ground vegetation."],"sources":["AGROVOC"]}','core',1,2072,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.mower');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.self_loading_wagon','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Self Loading Wagon"}',NULL,'{"descriptions":["A machine used to collect grass or hay from a field."],"sources":["Custom"]}','core',1,2073,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.self_loading_wagon');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.square_baler','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Square Baler"}',NULL,'{"descriptions":["A machine used to compress hay or straw into round square bales for easy transport and storage. A bale is the simplest minimum package for marketing."],"sources":["AGROVOC"]}','core',1,2074,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.square_baler');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.round_baler','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Round Baler"}',NULL,'{"descriptions":["A machine used to compress hay or straw into round bales for easy transport and storage. A bale is the simplest minimum package for marketing."],"sources":["AGROVOC"]}','core',1,2075,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.round_baler');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.sprinkler_irrigation','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Sprinkler Irrigation"}',NULL,'{"descriptions":["Spraying water into the air and allowing it to fall on to plants and soil as simulated rainfall."],"sources":["AGROVOC"]}','core',1,2076,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprinkler_irrigation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.trickle_irrigation','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Trickle Irrigation"}',NULL,'{"descriptions":["Dripping water on to a fraction of the ground surface so as to infiltrate it into the root zone."],"sources":["AGROVOC"]}','core',1,2077,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.trickle_irrigation');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.sampling_soil','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Sampling Soil"}',NULL,'{"descriptions":["Date of soil sampling, specify in comments"],"sources":["Custom"]}','core',1,2078,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sampling_soil');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.sampling_plants','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Sampling Plants"}',NULL,'{"descriptions":["Date of plant sampling, specific in comments"],"sources":["Custom"]}','core',1,2079,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sampling_plants');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.note','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Note"}',NULL,'{"descriptions":["No real opeartion, but an important note (e.g. BBCH stage), use with causion"],"sources":["Custom"]}','core',1,2080,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.note');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.device.frost_kill_cover_crop','choice','attr.agroscope.device',NULL,NULL,NULL,NULL,'{"en":"Frost Kill Cover Crop"}',NULL,'{"descriptions":["No real opeartion, but a note that the cover crop was killed by a frost event"],"sources":["Custom"]}','core',1,2081,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.frost_kill_cover_crop');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.barley_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"barley, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3000,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.barley_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.barley_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"barley, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3001,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.barley_winter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.beet_fodder','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"beet, fodder"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3002,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.beet_fodder');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.beet_sugar','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"beet, sugar"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3003,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.beet_sugar');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.faba_bean_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"faba bean, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3004,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.faba_bean_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.faba_bean_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"faba bean, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3005,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.faba_bean_winter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.ley_temporary','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"ley, temporary"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3006,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.ley_temporary');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.maize_grain','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"maize, grain"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3007,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.maize_grain');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.maize_silage','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"maize, silage"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3008,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.maize_silage');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.oat_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"oat, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3009,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.oat_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.oat_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"oat, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3010,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.oat_winter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.pea_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"pea, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3011,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.pea_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.pea_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"pea, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3012,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.pea_winter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.potato','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"potato"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3013,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.potato');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.rapeseed_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"rapeseed, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3014,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rapeseed_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.rapeseed_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"rapeseed, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3015,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rapeseed_winter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.rye_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"rye, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3016,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rye_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.rye_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"rye, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3017,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rye_winter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.sorghum','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"sorghum"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3018,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.sorghum');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.soybean','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"soybean"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3019,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.soybean');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.sunflower','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"sunflower"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3020,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.sunflower');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.triticale_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"triticale, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3021,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.triticale_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.triticale_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"triticale, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3022,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.triticale_winter');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.wheat_durum','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"wheat, durum"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3023,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.wheat_durum');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.wheat_spring','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"wheat, spring"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3024,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.wheat_spring');
INSERT INTO journal_vocab(code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,constraints_json,scope,active,sort_order,sync_version,created_at)
SELECT 'agroscope.crop.wheat_winter','choice','attr.crop',NULL,NULL,NULL,NULL,'{"en":"wheat, winter"}',NULL,'{"source":"SoilManageR management-data template v2.6"}','core',1,3025,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.wheat_winter');

-- journal_vocab_mappings
INSERT INTO journal_vocab_mappings(term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active)
SELECT 'irrigation','https://github.com/ADAPT/Standard','1.0.0','operation_type','APPLICATION_IRRIGATION',NULL,'exact','https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='irrigation' AND scheme_uri='https://github.com/ADAPT/Standard' AND mapping_role='operation_type' AND external_id='APPLICATION_IRRIGATION');
INSERT INTO journal_vocab_mappings(term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active)
SELECT 'fertilization','https://github.com/ADAPT/Standard','1.0.0','operation_type','APPLICATION_FERTILIZING',NULL,'exact','https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='fertilization' AND scheme_uri='https://github.com/ADAPT/Standard' AND mapping_role='operation_type' AND external_id='APPLICATION_FERTILIZING');
INSERT INTO journal_vocab_mappings(term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active)
SELECT 'plant_protection_application','https://github.com/ADAPT/Standard','1.0.0','operation_type','APPLICATION_CROP_PROTECTION',NULL,'exact','https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='plant_protection_application' AND scheme_uri='https://github.com/ADAPT/Standard' AND mapping_role='operation_type' AND external_id='APPLICATION_CROP_PROTECTION');
INSERT INTO journal_vocab_mappings(term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active)
SELECT 'seeding','https://github.com/ADAPT/Standard','1.0.0','operation_type','APPLICATION_SOWING_AND_PLANTING',NULL,'close','https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='seeding' AND scheme_uri='https://github.com/ADAPT/Standard' AND mapping_role='operation_type' AND external_id='APPLICATION_SOWING_AND_PLANTING');
INSERT INTO journal_vocab_mappings(term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active)
SELECT 'planting_transplanting','https://github.com/ADAPT/Standard','1.0.0','operation_type','APPLICATION_SOWING_AND_PLANTING',NULL,'close','https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='planting_transplanting' AND scheme_uri='https://github.com/ADAPT/Standard' AND mapping_role='operation_type' AND external_id='APPLICATION_SOWING_AND_PLANTING');
INSERT INTO journal_vocab_mappings(term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active)
SELECT 'tillage_soil_work','https://github.com/ADAPT/Standard','1.0.0','operation_type','FIELD_PREPARATION_TILLAGE',NULL,'exact','https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='tillage_soil_work' AND scheme_uri='https://github.com/ADAPT/Standard' AND mapping_role='operation_type' AND external_id='FIELD_PREPARATION_TILLAGE');
INSERT INTO journal_vocab_mappings(term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active)
SELECT 'harvest','https://github.com/ADAPT/Standard','1.0.0','operation_type','HARVEST',NULL,'exact','https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='harvest' AND scheme_uri='https://github.com/ADAPT/Standard' AND mapping_role='operation_type' AND external_id='HARVEST');

-- journal_templates
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'farmer_quick',1,'{"en":"Quick"}','{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"key_values","fields":["attr.irrigation_depth","attr.amount_mass_area_product","attr.amount_volume_area_product","note"]}],"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=1);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'farmer_quick',2,'{"en":"Quick"}','{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"key_values","fields":["attr.irrigation_depth","attr.amount_mass_area_product","attr.amount_volume_area_product","note"]},{"code":"carried_forward_details","fields":["attr.operator","attr.equipment","attr.method"]}],"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 2
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=2);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'farmer_quick',3,'{"en":"Quick"}','{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"carried_forward_details","fields":["attr.operator","attr.equipment","attr.method"]}],"quick_fields":{"irrigation":["attr.irrigation_depth","note"],"fertilization":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"fertigation":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"plant_protection_application":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","note"],"weed_control_nonchemical":["note"],"seeding":["attr.crop","attr.amount_mass_area_product","attr.amount_count_area","note"],"planting_transplanting":["attr.crop","attr.amount_count_area","note"],"pruning":["note"],"crop_care":["note"],"tillage_soil_work":["attr.amount_operation_depth","note"],"mowing":["note"],"harvest":["attr.harvest_yield_area","note"],"sampling":["note"],"general_observation":["attr.observation_text","note"],"pest_disease_observation":["attr.observation_text","note"],"equipment_maintenance":["note"]},"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=3);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'farmer_quick',6,'{"en":"Quick"}','{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"carried_forward_details","fields":["attr.operator","attr.equipment","attr.method"]}],"quick_fields":{"irrigation":["attr.irrigation_depth","note"],"fertilization":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"fertigation":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"plant_protection_application":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","note"],"weed_control_nonchemical":["note"],"seeding":["attr.crop","attr.amount_mass_area_product","attr.amount_count_area","note"],"planting_transplanting":["attr.crop","attr.amount_count_area","note"],"pruning":["note"],"crop_care":["attr.growth_stage_bbch","note"],"tillage_soil_work":["attr.amount_operation_depth","note"],"mowing":["note"],"harvest":["attr.harvest_yield_area","attr.growth_stage_bbch","note"],"sampling":["note"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"equipment_maintenance":["note"]},"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=6);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'farmer_quick',9,'{"en":"Quick"}','{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"carried_forward_details","fields":["attr.operator"]}],"quick_fields":{"irrigation":["attr.irrigation_depth","note"],"fertilization":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"fertigation":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"plant_protection_application":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","note"],"weed_control_nonchemical":["note"],"seeding":["attr.crop","attr.amount_mass_area_product","attr.amount_count_area","note"],"planting_transplanting":["attr.crop","attr.amount_count_area","note"],"pruning":["note"],"crop_care":["attr.growth_stage_bbch","note"],"tillage_soil_work":["attr.amount_operation_depth","note"],"mowing":["note"],"harvest":["attr.harvest_yield_area","attr.growth_stage_bbch","note"],"sampling":["note"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"equipment_maintenance":["note"]},"max_primary_fields":5,"carry_forward":["attr.operator"]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 9
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=9);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'full_record',1,'{"en":"Full record"}','{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days"]},{"code":"notes","fields":["note"]}],"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.actuation_expectation_id"]}],"certified_compliance_profile":null}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=1);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'full_record',5,'{"en":"Full record"}','{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.actuation_expectation_id"]}],"certified_compliance_profile":null}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 5
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=5);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'full_record',6,'{"en":"Full record"}','{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=6);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'full_record',7,'{"en":"Full record"}','{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.measurement_source","attr.denominator","attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=7);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'full_record',8,'{"en":"Full record"}','{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.treated_area"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.measurement_source","attr.denominator","attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 8
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=8);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'full_record',9,'{"en":"Full record"}','{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.agroscope.operation","attr.agroscope.device"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.treated_area","attr.agroscope.operation","attr.agroscope.device"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator"],"pruning":["attr.operator"],"crop_care":["attr.growth_stage_bbch","attr.operator"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"mowing":["attr.treated_area","attr.operator"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"sampling":["attr.measurement_source","attr.operator"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator"],"equipment_maintenance":["attr.operator"]},"activity_requirements":{"fertilization":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.agroscope.device","attr.agroscope.operation"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.agroscope.device","attr.agroscope.operation"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]},"tillage_soil_work":{"required":["attr.agroscope.device","attr.agroscope.operation"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.measurement_source","attr.denominator","attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 9
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=9);
INSERT INTO journal_templates(code,version,labels_json,definition_json,active)
SELECT 'research_observation',1,'{"en":"Research"}','{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","campaign_uuid","protocol_code","protocol_version","observation_unit_code"]},{"code":"standard_values","fields":["attr.observation_text"]},{"code":"custom_values","include_scope":"custom"}],"require_explicit_choices":true,"show_standard_mappings":true}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='research_observation' AND version=1);

-- journal_layouts
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'open_field',1,'{"en":"Open field"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.treated_area","attr.cover_type","attr.denominator"],"denominator_contract":["area","plant","row"],"option_dependencies":[]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=1);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'greenhouse',1,'{"en":"Greenhouse"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.structure_compartment","attr.root_zone_system","attr.plant_area","attr.wetted_area","attr.drainage_volume","attr.recirculation"],"conditional_fields":{"solution_managed":["attr.ec","attr.ph"]},"option_dependencies":[]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='greenhouse' AND version=1);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'lysimeter',1,'{"en":"Lysimeter"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.experimental_unit","attr.replicate","attr.treatment","attr.surface_area","attr.interval_minutes","attr.water_input","attr.rain_input","attr.drainage_volume","attr.mass_start","attr.mass_end","attr.tare_mass","attr.mass_method"],"option_dependencies":[]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='lysimeter' AND version=1);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'open_field',3,'{"en":"Open field"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.treated_area","attr.cover_type","attr.denominator"],"static_context_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"reading_fields":[],"denominator_contract":["area","plant","row"],"option_dependencies":[]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=3);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'open_field',8,'{"en":"Open field"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"static_context_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"reading_fields":[],"denominator_contract":["area","plant","row"],"option_dependencies":[]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 8
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=8);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'open_field',9,'{"en":"Open field"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"static_context_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"reading_fields":[],"denominator_contract":["area","plant","row"],"picker_targets":["attr.agroscope.operation"],"option_dependencies":[{"source_category":"tillage","when":{"attribute_code":"activity_code","equals":"tillage_soil_work"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.primary_tillage","agroscope.operation.seedbed_preparation","agroscope.operation.stubble_cultivation"]}},{"source_category":"sowing","when":{"attribute_code":"activity_code","equals":"seeding"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sowing_cover_crop","agroscope.operation.sowing_main_crop"]}},{"source_category":"fertilizer_application","when":{"attribute_code":"activity_code","equals":"fertilization"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.organic_fertilization","agroscope.operation.mineral_fertilization","agroscope.operation.other_fertilization"]}},{"source_category":"crop_protection","when":{"attribute_code":"activity_code","equals":"plant_protection_application"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.biocontrol","agroscope.operation.fungicide","agroscope.operation.insecticide","agroscope.operation.growth_regulator","agroscope.operation.weed_herbicide","agroscope.operation.total_herbicide","agroscope.operation.weed_mechanical","agroscope.operation.weed_other","agroscope.operation.pest_control"]}},{"source_category":"harvest","when":{"attribute_code":"activity_code","equals":"harvest"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.harvest_main_crop","agroscope.operation.harvest_cover_crop","agroscope.operation.hay_removal","agroscope.operation.straw_removal","agroscope.operation.cleaning_cut"]}},{"source_category":"irrigation","when":{"attribute_code":"activity_code","equals":"irrigation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.watering"]}},{"source_category":"other","when":{"attribute_code":"activity_code","equals":"general_observation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sampling","agroscope.operation.note"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.primary_tillage"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.plough","agroscope.device.plough_with_packer","agroscope.device.spading_machine","agroscope.device.deep_tiller","agroscope.device.heavy_duty_cultivator","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.disk_harrow","agroscope.device.strip_tiller","agroscope.device.subsoiler","agroscope.device.paraplough","agroscope.device.separator","agroscope.device.skim_plough"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.seedbed_preparation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.stubble_cultivation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.potato_planter","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.organic_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.liquid_organic_broadcast","agroscope.device.liquid_organic_draghose","agroscope.device.liquid_organic_trailingshoe","agroscope.device.liquid_organic_injection","agroscope.device.manure_broadcast","agroscope.device.compost_broadcast","agroscope.device.other_organic_solid_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.mineral_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.solid_broadcast","agroscope.device.solid_band","agroscope.device.solid_undersown_placement","agroscope.device.liquid_injection","agroscope.device.liquid_spraying","agroscope.device.liquid_fertigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.other_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.biofertilizer","agroscope.device.liming"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.biocontrol"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.disease_biocontrol","agroscope.device.pest_biocontrol","agroscope.device.weed_biocontrol"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.fungicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.insecticide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.growth_regulator"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast","agroscope.device.sprayer_band","agroscope.device.sprayer_spot"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.total_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_mechanical"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.tine_hoe","agroscope.device.rotary_hoe","agroscope.device.finger_hoe","agroscope.device.star_hoe","agroscope.device.other_mechanical_weeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_other"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.burning","agroscope.device.electric","agroscope.device.manual"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.pest_control"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.slug_control","agroscope.device.rodent_control"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.combine_harvester","agroscope.device.beet_lifter","agroscope.device.potato_harvester","agroscope.device.maize_chopper","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.hay_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.straw_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.cleaning_cut"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.watering"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprinkler_irrigation","agroscope.device.trickle_irrigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sampling"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sampling_soil","agroscope.device.sampling_plants"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.note"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.note","agroscope.device.frost_kill_cover_crop"]}}]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 9
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=9);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'greenhouse',3,'{"en":"Greenhouse"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.structure_compartment","attr.root_zone_system","attr.plant_area"],"static_context_fields":["attr.structure_compartment","attr.root_zone_system","attr.plant_area"],"reading_fields":["attr.wetted_area","attr.drainage_volume","attr.recirculation"],"conditional_fields":{"solution_managed":["attr.ec","attr.ph"]},"option_dependencies":[]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='greenhouse' AND version=3);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'lysimeter',3,'{"en":"Lysimeter"}','{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.experimental_unit","attr.replicate","attr.treatment","attr.surface_area"],"static_context_fields":["attr.experimental_unit","attr.replicate","attr.treatment","attr.surface_area"],"reading_fields":["attr.interval_minutes","attr.water_input","attr.rain_input","attr.drainage_volume","attr.mass_start","attr.mass_end","attr.tare_mass","attr.mass_method"],"option_dependencies":[]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='lysimeter' AND version=3);
INSERT INTO journal_layouts(code,version,labels_json,definition_json,active)
SELECT 'agroscope_open_field',1,'{"en":"Agroscope open field"}','{"source":{"name":"SoilManageR management-data template","version":"2.6","date":"2024-12-23","license":"CC BY","attribution":"Wittwer, Heller, Turek — Agroscope"},"activity_codes":["tillage_soil_work","seeding","fertilization","plant_protection_application","harvest","irrigation","general_observation"],"supported_templates":["research_observation"],"fields":["attr.crop","attr.agroscope.operation","attr.agroscope.device","attr.amount_operation_depth","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.amount_duration_area","attr.irrigation_volume_area","attr.machine","attr.product_uuid","attr.product","attr.agroscope.combination_group","attr.agroscope.dmc_mass_fraction","attr.agroscope.dmc_mass_volume","attr.agroscope.c_content","attr.agroscope.n_content","attr.agroscope.crop_product","attr.agroscope.crop_residue","attr.agroscope.cc_product","attr.agroscope.cc_residue"],"treatment_factors":{"plot_Parzelle":["I","II","III","IV","V","VI","all"],"tillage_system":["Plough","No-till","all"],"fertilization_regime":["GRUD","Kinsey","all"]},"option_dependencies":[{"source_category":"tillage","when":{"attribute_code":"activity_code","equals":"tillage_soil_work"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.primary_tillage","agroscope.operation.seedbed_preparation","agroscope.operation.stubble_cultivation"]}},{"source_category":"sowing","when":{"attribute_code":"activity_code","equals":"seeding"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sowing_cover_crop","agroscope.operation.sowing_main_crop"]}},{"source_category":"fertilizer_application","when":{"attribute_code":"activity_code","equals":"fertilization"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.organic_fertilization","agroscope.operation.mineral_fertilization","agroscope.operation.other_fertilization"]}},{"source_category":"crop_protection","when":{"attribute_code":"activity_code","equals":"plant_protection_application"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.biocontrol","agroscope.operation.fungicide","agroscope.operation.insecticide","agroscope.operation.growth_regulator","agroscope.operation.weed_herbicide","agroscope.operation.total_herbicide","agroscope.operation.weed_mechanical","agroscope.operation.weed_other","agroscope.operation.pest_control"]}},{"source_category":"harvest","when":{"attribute_code":"activity_code","equals":"harvest"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.harvest_main_crop","agroscope.operation.harvest_cover_crop","agroscope.operation.hay_removal","agroscope.operation.straw_removal","agroscope.operation.cleaning_cut"]}},{"source_category":"irrigation","when":{"attribute_code":"activity_code","equals":"irrigation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.watering"]}},{"source_category":"other","when":{"attribute_code":"activity_code","equals":"general_observation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sampling","agroscope.operation.note"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.primary_tillage"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.plough","agroscope.device.plough_with_packer","agroscope.device.spading_machine","agroscope.device.deep_tiller","agroscope.device.heavy_duty_cultivator","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.disk_harrow","agroscope.device.strip_tiller","agroscope.device.subsoiler","agroscope.device.paraplough","agroscope.device.separator","agroscope.device.skim_plough"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.seedbed_preparation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.stubble_cultivation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.potato_planter","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.organic_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.liquid_organic_broadcast","agroscope.device.liquid_organic_draghose","agroscope.device.liquid_organic_trailingshoe","agroscope.device.liquid_organic_injection","agroscope.device.manure_broadcast","agroscope.device.compost_broadcast","agroscope.device.other_organic_solid_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.mineral_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.solid_broadcast","agroscope.device.solid_band","agroscope.device.solid_undersown_placement","agroscope.device.liquid_injection","agroscope.device.liquid_spraying","agroscope.device.liquid_fertigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.other_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.biofertilizer","agroscope.device.liming"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.biocontrol"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.disease_biocontrol","agroscope.device.pest_biocontrol","agroscope.device.weed_biocontrol"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.fungicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.insecticide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.growth_regulator"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast","agroscope.device.sprayer_band","agroscope.device.sprayer_spot"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.total_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_mechanical"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.tine_hoe","agroscope.device.rotary_hoe","agroscope.device.finger_hoe","agroscope.device.star_hoe","agroscope.device.other_mechanical_weeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_other"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.burning","agroscope.device.electric","agroscope.device.manual"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.pest_control"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.slug_control","agroscope.device.rodent_control"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.combine_harvester","agroscope.device.beet_lifter","agroscope.device.potato_harvester","agroscope.device.maize_chopper","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.hay_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.straw_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.cleaning_cut"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.watering"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprinkler_irrigation","agroscope.device.trickle_irrigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sampling"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sampling_soil","agroscope.device.sampling_plants"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.note"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.note","agroscope.device.frost_kill_cover_crop"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.plough"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.plough_with_packer"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.spading_machine"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.deep_tiller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.heavy_duty_cultivator"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.heavy_duty_cultivator_sweeps"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disk_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.strip_tiller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.subsoiler"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.paraplough"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.separator"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.skim_plough"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.seedbed_combination"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.rotary_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tine_rotor"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tiller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.bedder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.mulching"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tine_weeder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.rotary_weeder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.ring_cutter"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.roller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.knife_roller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.short_disk_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.spade_roller_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.fine_cultivator"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.fine_cultivator_sweeps"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.straw_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_drill"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_drill"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_single_grain"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_single_grain"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_drill"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_drill"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_single_grain"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_single_grain"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.broadcast_seeder"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.broadcast_seeder"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.grassland_reseeder"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.grassland_reseeder"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_draghose"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_draghose"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_trailingshoe"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_trailingshoe"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_injection"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_injection"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.manure_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.manure_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.compost_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.compost_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.other_organic_solid_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.other_organic_solid_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.solid_broadcast"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.solid_band"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.solid_undersown_placement"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_injection"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_spraying"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_fertigation"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.biofertilizer"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.biofertilizer"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liming"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liming"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liming"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disease_biocontrol"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disease_biocontrol"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disease_biocontrol"},"restrict":{"attribute_code":"attr.amount_biological_count_area","units":["unit.biological_count_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.pest_biocontrol"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.pest_biocontrol"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.pest_biocontrol"},"restrict":{"attribute_code":"attr.amount_biological_count_area","units":["unit.biological_count_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.weed_biocontrol"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.weed_biocontrol"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.weed_biocontrol"},"restrict":{"attribute_code":"attr.amount_biological_count_area","units":["unit.biological_count_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.seed_coating"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.seed_coating"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_band"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_band"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tine_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.rotary_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.finger_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.star_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.other_mechanical_weeder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.manual"},"restrict":{"attribute_code":"attr.amount_duration_area","units":["unit.h_per_ha_labor"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprinkler_irrigation"},"restrict":{"attribute_code":"attr.irrigation_volume_area","units":["unit.m3_per_ha_water"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.trickle_irrigation"},"restrict":{"attribute_code":"attr.irrigation_volume_area","units":["unit.m3_per_ha_water"]}}]}',1
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='agroscope_open_field' AND version=1);

-- journal_products
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '2bcfa3a1-eabf-5f66-b3f1-9f6d7d390d04','core','Slurry','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='2bcfa3a1-eabf-5f66-b3f1-9f6d7d390d04');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '9dbaff6c-200f-503c-85ce-541b2d1f17ca','core','Manure','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='9dbaff6c-200f-503c-85ce-541b2d1f17ca');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '3c6f7f4d-58d0-59c5-90c9-2de704b0ed8a','core','Slurry_dairy_cow','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='3c6f7f4d-58d0-59c5-90c9-2de704b0ed8a');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '4d19b32d-8bd6-5846-8893-065f099aaccc','core','Manure_dairy_cow','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='4d19b32d-8bd6-5846-8893-065f099aaccc');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT 'f710d50c-a3b5-5e9d-b345-6f61120a5c8e','core','Slurry_pig','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='f710d50c-a3b5-5e9d-b345-6f61120a5c8e');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '1cc24052-87fd-559f-8047-3fec479019db','core','Manure_laying_hens','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='1cc24052-87fd-559f-8047-3fec479019db');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '27ba3e6a-c256-559b-83fa-384c23b98257','core','Digestate_solid','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='27ba3e6a-c256-559b-83fa-384c23b98257');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '8ec58fdd-8f76-5d07-8d97-d895f00107cd','core','Digestate_liquid','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='8ec58fdd-8f76-5d07-8d97-d895f00107cd');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT '1a708f09-a507-5523-8a44-86ec61f95b6b','core','Compost','organic_amendment','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='1a708f09-a507-5523-8a44-86ec61f95b6b');
INSERT INTO journal_products(product_uuid,scope,name,kind,composition_json,active,sync_version,created_at)
SELECT 'd6c3bd6e-a957-5925-9cd9-ae0738bc91af','core','Glyphosate','plant_protection','{}',1,0,'2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='d6c3bd6e-a957-5925-9cd9-ae0738bc91af');

-- Immutable v9 postconditions. Each mismatch deliberately attempts id=0,
-- tripping journal_catalog_state CHECK(id=1) before state can be stamped.
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='irrigation' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Irrigation"}' AND icon_key='droplets' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='fertilization' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Fertilization"}' AND icon_key='fertilizer' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='fertigation' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Fertigation"}' AND icon_key='fertigation' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=30 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='plant_protection_application' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Plant protection"}' AND icon_key='plant_protection' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=40 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='weed_control_nonchemical' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Non-chemical weed control"}' AND icon_key='weed_control' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=50 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='seeding' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Seeding"}' AND icon_key='seeding' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=60 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='planting_transplanting' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Planting / transplanting"}' AND icon_key='planting' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=70 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='pruning' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Pruning"}' AND icon_key='pruning' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=80 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='crop_care' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Crop care"}' AND icon_key='crop_care' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=90 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='tillage_soil_work' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Tillage / soil work"}' AND icon_key='tillage' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=100 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='mowing' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Mowing"}' AND icon_key='mowing' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=110 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='harvest' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Harvest"}' AND icon_key='harvest' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=120 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='sampling' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sampling"}' AND icon_key='sampling' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=130 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='general_observation' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"General observation"}' AND icon_key='observation' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=140 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='pest_disease_observation' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Pest / disease observation"}' AND icon_key='pest_disease' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=150 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='equipment_maintenance' AND kind='activity' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Equipment maintenance"}' AND icon_key='maintenance' AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=160 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_operation_depth' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='operation_depth' AND basis='operation_depth' AND default_unit_code='unit.cm_operation_depth' AND labels_json='{"en":"Operation depth"}' AND icon_key IS NULL AND constraints_json='{"min":0,"max":200}' AND scope='core' AND active=1 AND sort_order=100 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_mass_area_product' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass_area' AND basis='product' AND default_unit_code='unit.kg_per_ha_product' AND labels_json='{"en":"Product mass per area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=101 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_volume_area_product' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='volume_area' AND basis='product' AND default_unit_code='unit.l_per_ha_product' AND labels_json='{"en":"Product volume per area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=102 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_nutrient_rate' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"Nutrient rate"}' AND icon_key IS NULL AND constraints_json='{"min":0,"repeatable":true,"requires_explicit_unit":true,"semantic_discriminator":"unit_code","allow_default_unit":false}' AND scope='core' AND active=1 AND sort_order=103 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_count_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='count_area' AND basis='plant' AND default_unit_code='unit.plants_per_ha' AND labels_json='{"en":"Plant count per area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=104 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_biological_count_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='biological_count_area' AND basis='biological_agent' AND default_unit_code='unit.biological_count_per_ha' AND labels_json='{"en":"Biological-agent count per area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=105 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.amount_duration_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='duration_area' AND basis='labor' AND default_unit_code='unit.h_per_ha_labor' AND labels_json='{"en":"Labour duration per area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=106 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.irrigation_volume_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='volume_area' AND basis='water' AND default_unit_code='unit.m3_per_ha_water' AND labels_json='{"en":"Irrigation volume per area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=107 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.irrigation_depth' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='water_depth' AND basis='water' AND default_unit_code='unit.mm_water' AND labels_json='{"en":"Irrigation depth"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=108 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.duration_minutes' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='duration' AND basis='elapsed_time' AND default_unit_code='unit.min_duration' AND labels_json='{"en":"Duration"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=109 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.per_plant_volume' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='volume_per_plant' AND basis='water' AND default_unit_code='unit.l_per_plant_water' AND labels_json='{"en":"Volume per plant"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=110 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.treated_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='area' AND basis='land_area' AND default_unit_code='unit.m2_area' AND labels_json='{"en":"Treated area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=111 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.harvest_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='area' AND basis='land_area' AND default_unit_code='unit.m2_area' AND labels_json='{"en":"Harvest area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=112 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.harvest_yield_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='yield_area' AND basis='fresh_product' AND default_unit_code='unit.kg_per_ha_fresh_product' AND labels_json='{"en":"Harvest yield per area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=113 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.surface_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='area' AND basis='land_area' AND default_unit_code='unit.m2_area' AND labels_json='{"en":"Surface area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=114 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.plant_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='area' AND basis='land_area' AND default_unit_code='unit.m2_area' AND labels_json='{"en":"Plant area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=115 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.wetted_area' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='area' AND basis='land_area' AND default_unit_code='unit.m2_area' AND labels_json='{"en":"Wetted area"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=116 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.water_input' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='volume' AND basis='water' AND default_unit_code='unit.l_water' AND labels_json='{"en":"Water input"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=117 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.rain_input' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='water_depth' AND basis='water' AND default_unit_code='unit.mm_water' AND labels_json='{"en":"Rain input"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=118 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.drainage_volume' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='volume' AND basis='water' AND default_unit_code='unit.l_water' AND labels_json='{"en":"Drainage volume"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=119 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.mass_start' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass' AND basis='lysimeter' AND default_unit_code='unit.kg_mass' AND labels_json='{"en":"Start mass"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=120 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.mass_end' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass' AND basis='lysimeter' AND default_unit_code='unit.kg_mass' AND labels_json='{"en":"End mass"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=121 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.tare_mass' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass' AND basis='lysimeter' AND default_unit_code='unit.kg_mass' AND labels_json='{"en":"Tare mass"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=122 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.interval_minutes' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='duration' AND basis='elapsed_time' AND default_unit_code='unit.min_duration' AND labels_json='{"en":"Measurement interval"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=123 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.ec' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='electrical_conductivity' AND basis='solution' AND default_unit_code='unit.ds_per_m' AND labels_json='{"en":"Electrical conductivity"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=124 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.ph' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='acidity' AND basis='solution' AND default_unit_code='unit.ph' AND labels_json='{"en":"pH"}' AND icon_key IS NULL AND constraints_json='{"min":0,"max":14}' AND scope='core' AND active=1 AND sort_order=125 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.waiting_period_days' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='calendar_duration' AND basis='calendar_day' AND default_unit_code='unit.day_duration' AND labels_json='{"en":"Waiting period"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=126 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.combination_group' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='count' AND basis='operation_group' AND default_unit_code='unit.count_integer' AND labels_json='{"en":"Combination group"}' AND icon_key IS NULL AND constraints_json='{"min":1,"step":1}' AND scope='core' AND active=1 AND sort_order=127 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.dmc_mass_fraction' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass_fraction' AND basis='product_wet_mass' AND default_unit_code='unit.kg_per_t_dry_matter' AND labels_json='{"en":"Dry matter per fresh mass"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=128 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.dmc_mass_volume' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass_concentration' AND basis='product_volume' AND default_unit_code='unit.kg_per_m3_dry_matter' AND labels_json='{"en":"Dry matter per product volume"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=129 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.c_content' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass_fraction' AND basis='dry_matter_carbon' AND default_unit_code='unit.g_c_per_kg_dm' AND labels_json='{"en":"Carbon content"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=130 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.n_content' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass_fraction' AND basis='dry_matter_nitrogen' AND default_unit_code='unit.g_n_per_kg_dm' AND labels_json='{"en":"Nitrogen content"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=131 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.crop_product' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='yield_area' AND basis='dry_matter_yield' AND default_unit_code='unit.t_per_ha_dm' AND labels_json='{"en":"Exported crop product"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=132 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.crop_residue' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='yield_area' AND basis='dry_matter_yield' AND default_unit_code='unit.t_per_ha_dm' AND labels_json='{"en":"Crop residue"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=133 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.cc_product' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass_fraction' AND basis='dry_matter_carbon' AND default_unit_code='unit.g_c_per_kg_dm' AND labels_json='{"en":"Product carbon concentration"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=134 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.cc_residue' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='mass_fraction' AND basis='dry_matter_carbon' AND default_unit_code='unit.g_c_per_kg_dm' AND labels_json='{"en":"Residue carbon concentration"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=135 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.operation' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Operation"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=136 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.agroscope.device' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Device / method"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=137 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.crop' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Crop"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=138 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.machine' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Machine"}' AND icon_key IS NULL AND constraints_json='{"maxlength":500}' AND scope='core' AND active=1 AND sort_order=139 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.product_uuid' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Registered product"}' AND icon_key IS NULL AND constraints_json='{"maxlength":128,"reference":{"table":"journal_products","column":"product_uuid"}}' AND scope='core' AND active=1 AND sort_order=140 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.product' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Unregistered product"}' AND icon_key IS NULL AND constraints_json='{"maxlength":500,"unregistered_compatibility":true}' AND scope='core' AND active=1 AND sort_order=141 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.actuation_expectation_id' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Actuation expectation"}' AND icon_key IS NULL AND constraints_json='{"maxlength":128,"reference":{"table":"valve_actuation_expectations","column":"expectation_id"}}' AND scope='core' AND active=1 AND sort_order=142 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.block_bed_row' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Block / bed / row"}' AND icon_key IS NULL AND constraints_json='{"maxlength":160}' AND scope='core' AND active=1 AND sort_order=143 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.cover_type' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Cover type"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=144 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.denominator' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Application denominator"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=145 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.structure_compartment' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Structure / compartment"}' AND icon_key IS NULL AND constraints_json='{"maxlength":160}' AND scope='core' AND active=1 AND sort_order=146 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.root_zone_system' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Root-zone system"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=147 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.recirculation' AND kind='attribute' AND parent_code IS NULL AND value_type='boolean' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Recirculation"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=148 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.experimental_unit' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Experimental unit"}' AND icon_key IS NULL AND constraints_json='{"maxlength":160}' AND scope='core' AND active=1 AND sort_order=149 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.replicate' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Replicate"}' AND icon_key IS NULL AND constraints_json='{"maxlength":80}' AND scope='core' AND active=1 AND sort_order=150 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.treatment' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Treatment"}' AND icon_key IS NULL AND constraints_json='{"maxlength":160}' AND scope='core' AND active=1 AND sort_order=151 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.mass_method' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Mass method"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=152 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.irrigation_amount_kind' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Irrigation amount kind"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=153 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.measurement_source' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Measurement source"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=154 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.operator' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Operator"}' AND icon_key IS NULL AND constraints_json='{"maxlength":160}' AND scope='core' AND active=1 AND sort_order=155 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.equipment' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Equipment"}' AND icon_key IS NULL AND constraints_json='{"maxlength":300}' AND scope='core' AND active=1 AND sort_order=156 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.method' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Method"}' AND icon_key IS NULL AND constraints_json='{"maxlength":300}' AND scope='core' AND active=1 AND sort_order=157 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.target' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Target"}' AND icon_key IS NULL AND constraints_json='{"maxlength":300}' AND scope='core' AND active=1 AND sort_order=158 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.observation_text' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Observation"}' AND icon_key IS NULL AND constraints_json='{"maxlength":4000}' AND scope='core' AND active=1 AND sort_order=159 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v4-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.variety' AND kind='attribute' AND parent_code IS NULL AND value_type='text' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Variety"}' AND icon_key IS NULL AND constraints_json='{"maxlength":120,"autocomplete":"variety_by_crop"}' AND scope='core' AND active=1 AND sort_order=160 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.growth_stage_bbch' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='growth_stage' AND basis='phenology' AND default_unit_code='unit.bbch_stage' AND labels_json='{"en":"Growth stage (BBCH)"}' AND icon_key IS NULL AND constraints_json='{"min":0,"max":99,"step":1}' AND scope='core' AND active=1 AND sort_order=161 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.wind_speed' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='wind_speed' AND basis='ambient' AND default_unit_code='unit.m_per_s' AND labels_json='{"en":"Wind speed"}' AND icon_key IS NULL AND constraints_json='{"min":0}' AND scope='core' AND active=1 AND sort_order=162 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.wind_direction' AND kind='attribute' AND parent_code IS NULL AND value_type='choice' AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Wind direction"}' AND icon_key IS NULL AND constraints_json='{}' AND scope='core' AND active=1 AND sort_order=163 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.air_temperature' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='temperature' AND basis='ambient' AND default_unit_code='unit.deg_c' AND labels_json='{"en":"Air temperature"}' AND icon_key IS NULL AND constraints_json='{"min":-50,"max":60}' AND scope='core' AND active=1 AND sort_order=164 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='attr.rel_humidity' AND kind='attribute' AND parent_code IS NULL AND value_type='number' AND quantity_kind='relative_humidity' AND basis='ambient' AND default_unit_code='unit.percent' AND labels_json='{"en":"Relative humidity"}' AND icon_key IS NULL AND constraints_json='{"min":0,"max":100}' AND scope='core' AND active=1 AND sort_order=165 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.cm_operation_depth' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='operation_depth' AND basis='operation_depth' AND default_unit_code IS NULL AND labels_json='{"en":"cm"}' AND icon_key IS NULL AND constraints_json='{"dimension":"length_operation_depth","to_canonical":{"unit_code":"unit.cm_operation_depth","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=500 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.g_per_ha_product' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass_area' AND basis='product' AND default_unit_code IS NULL AND labels_json='{"en":"g/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_product_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_product","scale":0.001,"offset":0}}' AND scope='core' AND active=1 AND sort_order=501 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_ha_product' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass_area' AND basis='product' AND default_unit_code IS NULL AND labels_json='{"en":"kg/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_product_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_product","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=502 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.t_per_ha_product' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass_area' AND basis='product' AND default_unit_code IS NULL AND labels_json='{"en":"t/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_product_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_product","scale":1000,"offset":0}}' AND scope='core' AND active=1 AND sort_order=503 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.l_per_ha_product' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='volume_area' AND basis='product' AND default_unit_code IS NULL AND labels_json='{"en":"L/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"volume_product_per_area","to_canonical":{"unit_code":"unit.l_per_ha_product","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=504 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m3_per_ha_product' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='volume_area' AND basis='product' AND default_unit_code IS NULL AND labels_json='{"en":"m³/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"volume_product_per_area","to_canonical":{"unit_code":"unit.l_per_ha_product","scale":1000,"offset":0}}' AND scope='core' AND active=1 AND sort_order=505 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_ha_fresh_product' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='yield_area' AND basis='fresh_product' AND default_unit_code IS NULL AND labels_json='{"en":"kg/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"fresh_product_yield_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_fresh_product","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=506 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.t_per_ha_fresh_product' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='yield_area' AND basis='fresh_product' AND default_unit_code IS NULL AND labels_json='{"en":"t/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"fresh_product_yield_per_area","to_canonical":{"unit_code":"unit.kg_per_ha_fresh_product","scale":1000,"offset":0}}' AND scope='core' AND active=1 AND sort_order=507 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m3_per_ha_water' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='volume_area' AND basis='water' AND default_unit_code IS NULL AND labels_json='{"en":"m³/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"water_volume_per_area","to_canonical":{"unit_code":"unit.m3_per_ha_water","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=508 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.plants_per_ha' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='count_area' AND basis='plant' AND default_unit_code IS NULL AND labels_json='{"en":"plants/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"plant_count_per_area","to_canonical":{"unit_code":"unit.plants_per_ha","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=509 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.biological_count_per_ha' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='biological_count_area' AND basis='biological_agent' AND default_unit_code IS NULL AND labels_json='{"en":"unit/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"biological_agent_count_per_area","to_canonical":{"unit_code":"unit.biological_count_per_ha","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=510 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.h_per_ha_labor' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='duration_area' AND basis='labor' AND default_unit_code IS NULL AND labels_json='{"en":"hours/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"labor_time_per_area","to_canonical":{"unit_code":"unit.h_per_ha_labor","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=511 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_n_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg N/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_n_per_area","to_canonical":{"unit_code":"unit.kg_n_per_ha_nutrient","scale":1,"offset":0},"nutrient":"N"}' AND scope='core' AND active=1 AND sort_order=512 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_p2o5_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg P₂O₅/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_p2o5_per_area","to_canonical":{"unit_code":"unit.kg_p2o5_per_ha_nutrient","scale":1,"offset":0},"nutrient":"P2O5"}' AND scope='core' AND active=1 AND sort_order=513 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_k2o_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg K₂O/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_k2o_per_area","to_canonical":{"unit_code":"unit.kg_k2o_per_ha_nutrient","scale":1,"offset":0},"nutrient":"K2O"}' AND scope='core' AND active=1 AND sort_order=514 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_mg_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg Mg/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_mg_per_area","to_canonical":{"unit_code":"unit.kg_mg_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Mg"}' AND scope='core' AND active=1 AND sort_order=515 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_s_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg S/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_s_per_area","to_canonical":{"unit_code":"unit.kg_s_per_ha_nutrient","scale":1,"offset":0},"nutrient":"S"}' AND scope='core' AND active=1 AND sort_order=516 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_ca_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg Ca/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_ca_per_area","to_canonical":{"unit_code":"unit.kg_ca_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Ca"}' AND scope='core' AND active=1 AND sort_order=517 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_b_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg B/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_b_per_area","to_canonical":{"unit_code":"unit.kg_b_per_ha_nutrient","scale":1,"offset":0},"nutrient":"B"}' AND scope='core' AND active=1 AND sort_order=518 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_na_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg Na/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_na_per_area","to_canonical":{"unit_code":"unit.kg_na_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Na"}' AND scope='core' AND active=1 AND sort_order=519 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_mn_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg Mn/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_mn_per_area","to_canonical":{"unit_code":"unit.kg_mn_per_ha_nutrient","scale":1,"offset":0},"nutrient":"Mn"}' AND scope='core' AND active=1 AND sort_order=520 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_cao_per_ha_nutrient' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='nutrient_rate' AND basis='nutrient' AND default_unit_code IS NULL AND labels_json='{"en":"kg CaO/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass_cao_per_area","to_canonical":{"unit_code":"unit.kg_cao_per_ha_nutrient","scale":1,"offset":0},"nutrient":"CaO"}' AND scope='core' AND active=1 AND sort_order=521 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.mm_water' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='water_depth' AND basis='water' AND default_unit_code IS NULL AND labels_json='{"en":"mm"}' AND icon_key IS NULL AND constraints_json='{"dimension":"water_depth","to_canonical":{"unit_code":"unit.mm_water","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=522 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.min_duration' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='duration' AND basis='elapsed_time' AND default_unit_code IS NULL AND labels_json='{"en":"min"}' AND icon_key IS NULL AND constraints_json='{"dimension":"elapsed_time","to_canonical":{"unit_code":"unit.min_duration","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=523 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.hour_duration' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='duration' AND basis='elapsed_time' AND default_unit_code IS NULL AND labels_json='{"en":"h"}' AND icon_key IS NULL AND constraints_json='{"dimension":"elapsed_time","to_canonical":{"unit_code":"unit.min_duration","scale":60,"offset":0}}' AND scope='core' AND active=1 AND sort_order=524 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.day_duration' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='calendar_duration' AND basis='calendar_day' AND default_unit_code IS NULL AND labels_json='{"en":"days"}' AND icon_key IS NULL AND constraints_json='{"dimension":"calendar_day","to_canonical":{"unit_code":"unit.day_duration","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=525 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.l_per_plant_water' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='volume_per_plant' AND basis='water' AND default_unit_code IS NULL AND labels_json='{"en":"L/plant"}' AND icon_key IS NULL AND constraints_json='{"dimension":"water_volume_per_plant","to_canonical":{"unit_code":"unit.l_per_plant_water","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=526 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m2_area' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='area' AND basis='land_area' AND default_unit_code IS NULL AND labels_json='{"en":"m²"}' AND icon_key IS NULL AND constraints_json='{"dimension":"area","to_canonical":{"unit_code":"unit.m2_area","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=527 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.ha_area' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='area' AND basis='land_area' AND default_unit_code IS NULL AND labels_json='{"en":"ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"area","to_canonical":{"unit_code":"unit.m2_area","scale":10000,"offset":0}}' AND scope='core' AND active=1 AND sort_order=528 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.l_water' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='volume' AND basis='water' AND default_unit_code IS NULL AND labels_json='{"en":"L"}' AND icon_key IS NULL AND constraints_json='{"dimension":"water_volume","to_canonical":{"unit_code":"unit.l_water","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=529 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_mass' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass' AND basis='lysimeter' AND default_unit_code IS NULL AND labels_json='{"en":"kg"}' AND icon_key IS NULL AND constraints_json='{"dimension":"mass","to_canonical":{"unit_code":"unit.kg_mass","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=530 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.ds_per_m' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='electrical_conductivity' AND basis='solution' AND default_unit_code IS NULL AND labels_json='{"en":"dS/m"}' AND icon_key IS NULL AND constraints_json='{"dimension":"electrical_conductivity","to_canonical":{"unit_code":"unit.ds_per_m","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=531 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.ph' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='acidity' AND basis='solution' AND default_unit_code IS NULL AND labels_json='{"en":"pH"}' AND icon_key IS NULL AND constraints_json='{"dimension":"acidity","to_canonical":{"unit_code":"unit.ph","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=532 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.count_integer' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='count' AND basis='operation_group' AND default_unit_code IS NULL AND labels_json='{"en":"count"}' AND icon_key IS NULL AND constraints_json='{"dimension":"count","to_canonical":{"unit_code":"unit.count_integer","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=533 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_t_dry_matter' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass_fraction' AND basis='product_wet_mass' AND default_unit_code IS NULL AND labels_json='{"en":"kg/t"}' AND icon_key IS NULL AND constraints_json='{"dimension":"dry_matter_mass_per_fresh_mass","to_canonical":{"unit_code":"unit.kg_per_t_dry_matter","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=534 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.kg_per_m3_dry_matter' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass_concentration' AND basis='product_volume' AND default_unit_code IS NULL AND labels_json='{"en":"kg/m³"}' AND icon_key IS NULL AND constraints_json='{"dimension":"dry_matter_mass_per_product_volume","to_canonical":{"unit_code":"unit.kg_per_m3_dry_matter","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=535 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.g_c_per_kg_dm' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass_fraction' AND basis='dry_matter_carbon' AND default_unit_code IS NULL AND labels_json='{"en":"g C/kg DM"}' AND icon_key IS NULL AND constraints_json='{"dimension":"carbon_mass_per_dry_matter_mass","to_canonical":{"unit_code":"unit.g_c_per_kg_dm","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=536 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.g_n_per_kg_dm' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='mass_fraction' AND basis='dry_matter_nitrogen' AND default_unit_code IS NULL AND labels_json='{"en":"g N/kg DM"}' AND icon_key IS NULL AND constraints_json='{"dimension":"nitrogen_mass_per_dry_matter_mass","to_canonical":{"unit_code":"unit.g_n_per_kg_dm","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=537 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.t_per_ha_dm' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='yield_area' AND basis='dry_matter_yield' AND default_unit_code IS NULL AND labels_json='{"en":"t DM/ha"}' AND icon_key IS NULL AND constraints_json='{"dimension":"dry_matter_yield_per_area","to_canonical":{"unit_code":"unit.t_per_ha_dm","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=538 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.bbch_stage' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='growth_stage' AND basis='phenology' AND default_unit_code IS NULL AND labels_json='{"en":"BBCH"}' AND icon_key IS NULL AND constraints_json='{"dimension":"growth_stage","to_canonical":{"unit_code":"unit.bbch_stage","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=539 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.m_per_s' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='wind_speed' AND basis='ambient' AND default_unit_code IS NULL AND labels_json='{"en":"m/s"}' AND icon_key IS NULL AND constraints_json='{"dimension":"wind_speed","to_canonical":{"unit_code":"unit.m_per_s","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=540 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.deg_c' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='temperature' AND basis='ambient' AND default_unit_code IS NULL AND labels_json='{"en":"°C"}' AND icon_key IS NULL AND constraints_json='{"dimension":"temperature","to_canonical":{"unit_code":"unit.deg_c","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=541 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='unit.percent' AND kind='unit' AND parent_code IS NULL AND value_type IS NULL AND quantity_kind='relative_humidity' AND basis='ambient' AND default_unit_code IS NULL AND labels_json='{"en":"%"}' AND icon_key IS NULL AND constraints_json='{"dimension":"relative_humidity","to_canonical":{"unit_code":"unit.percent","scale":1,"offset":0}}' AND scope='core' AND active=1 AND sort_order=542 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.cover.bare' AND kind='choice' AND parent_code='attr.cover_type' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Bare soil"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.cover.crop' AND kind='choice' AND parent_code='attr.cover_type' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Crop cover"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.cover.mulch' AND kind='choice' AND parent_code='attr.cover_type' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Mulch"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=30 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.denominator.area' AND kind='choice' AND parent_code='attr.denominator' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Per area"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.denominator.plant' AND kind='choice' AND parent_code='attr.denominator' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Per plant"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.denominator.row' AND kind='choice' AND parent_code='attr.denominator' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Per row length"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=30 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.soil' AND kind='choice' AND parent_code='attr.root_zone_system' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Soil"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.container' AND kind='choice' AND parent_code='attr.root_zone_system' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Container"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.substrate' AND kind='choice' AND parent_code='attr.root_zone_system' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Substrate"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=30 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.root_zone.hydroponic' AND kind='choice' AND parent_code='attr.root_zone_system' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Hydroponic"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=40 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.mass_method.direct' AND kind='choice' AND parent_code='attr.mass_method' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Direct weighing"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.mass_method.load_cell' AND kind='choice' AND parent_code='attr.mass_method' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Load cell"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.irrigation_amount.measured' AND kind='choice' AND parent_code='attr.irrigation_amount_kind' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Measured"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.irrigation_amount.estimated' AND kind='choice' AND parent_code='attr.irrigation_amount_kind' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Estimated"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.irrigation_amount.commanded' AND kind='choice' AND parent_code='attr.irrigation_amount_kind' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Commanded"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=30 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.measurement.manual' AND kind='choice' AND parent_code='attr.measurement_source' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Manual"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.measurement.sensor' AND kind='choice' AND parent_code='attr.measurement_source' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sensor"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.measurement.controller' AND kind='choice' AND parent_code='attr.measurement_source' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Controller"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=30 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v4-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.permanent_grassland' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Permanent grassland"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=4000 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v4-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.field_vegetable' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Field vegetable"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=4010 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v4-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.green_manure_cover' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Green manure / cover crop"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=4020 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v4-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.fallow' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Fallow"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=4030 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v4-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 4
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.other' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Other"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=4040 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.n' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"North"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=10 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.ne' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Northeast"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=20 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.e' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"East"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=30 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.se' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Southeast"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=40 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.s' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"South"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=50 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.sw' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Southwest"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=60 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.w' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"West"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=70 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.wind.nw' AND kind='choice' AND parent_code='attr.wind_direction' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Northwest"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=80 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.carrot' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Carrot"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3500 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.onion' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Onion"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3504 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.leek' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Leek"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3508 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.cabbage' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Cabbage"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3512 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.cauliflower' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Cauliflower"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3516 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.broccoli' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Broccoli"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3520 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.lettuce' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Lettuce"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3524 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.spinach' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Spinach"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3528 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.celeriac' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Celeriac"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3532 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.fennel' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Fennel"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3536 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.table_beet' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Table beet"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3540 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.courgette' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Courgette / zucchini"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3544 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.pumpkin_squash' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Pumpkin / squash"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3548 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.sweetcorn' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sweetcorn"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3552 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.garden_pea' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Garden pea"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3556 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='choice.crop.green_bean' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Green bean"}' AND icon_key IS NULL AND constraints_json IS NULL AND scope='core' AND active=1 AND sort_order=3560 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.primary_tillage' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Primary Tillage"}' AND icon_key IS NULL AND constraints_json='{"description":"Primary tillage is a loosening, mixing or inverting form of cultivation with a cultivation depth between 15 cm and 35 cm. Primary tillage takes place prior to seedbed preparation and sowing.","source":"KTBL (2020)","source_category":"tillage"}' AND scope='core' AND active=1 AND sort_order=1000 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.seedbed_preparation' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Seedbed Preparation"}' AND icon_key IS NULL AND constraints_json='{"description":"Seedbed preparation or secondary tillage is limited to an operation depth of 5-10 cm. The seed horizon\nis crumbled finely, loosened and reconsolidated to ensure optimal seed germination.","source":"KTBL (2020)","source_category":"tillage"}' AND scope='core' AND active=1 AND sort_order=1001 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.stubble_cultivation' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Stubble Cultivation"}' AND icon_key IS NULL AND constraints_json='{"description":"Stubble cultivation is only a shallow cultivation method to loosen, mix or invert the soil after harvesting to promote the emergence of volunteer grain and weed seeds, with a cultivation depth of up to 15 cm. It is assumed that the implements are used as intended. Within the non-inversion method, all further operations with an operation depth of more than 10 cm represent primary tillage.","source":"KTBL (2020)","source_category":"tillage"}' AND scope='core' AND active=1 AND sort_order=1002 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.sowing_cover_crop' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sowing Cover Crop"}' AND icon_key IS NULL AND constraints_json='{"description":"Sowing is the defined placement of seed at an optimal depth for the type of cover crop.","source":"KTBL (2020)","source_category":"sowing"}' AND scope='core' AND active=1 AND sort_order=1003 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.sowing_main_crop' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sowing Main Crop"}' AND icon_key IS NULL AND constraints_json='{"description":"Sowing is the defined placement of seed at an optimal depth for the type of main crop.","source":"KTBL (2020)","source_category":"sowing"}' AND scope='core' AND active=1 AND sort_order=1004 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.organic_fertilization' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Organic Fertilization"}' AND icon_key IS NULL AND constraints_json='{"description":"Organic fertilizer: a carbon-rich fertilizer derived from organic materials, including treated or untreated livestock manures, compost, vermicompost, sewage sludge and other organic materials or mixed materials used to supply nutrients to soils.","source":"AGROVOC","source_category":"fertilizer_application"}' AND scope='core' AND active=1 AND sort_order=1005 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.mineral_fertilization' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Mineral Fertilization"}' AND icon_key IS NULL AND constraints_json='{"description":"Inorganic fertilizer: a nutrient-rich fertilizer produced industrially by chemical processes, mineral extraction or by mechanical grinding.","source":"AGROVOC","source_category":"fertilizer_application"}' AND scope='core' AND active=1 AND sort_order=1006 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.other_fertilization' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Other Fertilization"}' AND icon_key IS NULL AND constraints_json='{"description":"Other soil amendments that are applied in the intention to provide nutrient to crops or to increase soil fertility","source":"AGROVOC","source_category":"fertilizer_application"}' AND scope='core' AND active=1 AND sort_order=1007 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.biocontrol' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Biocontrol"}' AND icon_key IS NULL AND constraints_json='{"description":"Biological control: The use of biological agents (e.g. insects, micro-organisms and/or microbial metabolites) for the control of mites, pests, plant pathogens and spoilage organisms.","source":"AGROVOC","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1008 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.fungicide' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Fungicide"}' AND icon_key IS NULL AND constraints_json='{"description":"The application of chemicals aimed at killing fungi","source":"Blanchy et al. (2023)","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1009 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.insecticide' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Insecticide"}' AND icon_key IS NULL AND constraints_json='{"description":"The application of chemicals aimed at killing insects","source":"Blanchy et al. (2023)","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1010 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.growth_regulator' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Growth Regulator"}' AND icon_key IS NULL AND constraints_json='{"description":"The application of chemicals aimed at reducing vegative growth of crops","source":"Custom","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1011 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.weed_herbicide' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Weed Herbicide"}' AND icon_key IS NULL AND constraints_json='{"description":"The application of chemicals aimed at killing weeds","source":"Blanchy et al. (2023)","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1012 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.total_herbicide' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Total Herbicide"}' AND icon_key IS NULL AND constraints_json='{"description":"","source":"","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1013 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.weed_mechanical' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Weed Mechanical"}' AND icon_key IS NULL AND constraints_json='{"description":"Application of mechanical weeding operations to reduce weed preasure.","source":"Custom","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1014 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.weed_other' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Weed Other"}' AND icon_key IS NULL AND constraints_json='{"description":"Application of weeding operations other then chemical and mechanical to reduce weed preasure.","source":"Custom","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1015 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.pest_control' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Pest Control"}' AND icon_key IS NULL AND constraints_json='{"description":"","source":"","source_category":"crop_protection"}' AND scope='core' AND active=1 AND sort_order=1016 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.harvest_main_crop' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Harvest Main Crop"}' AND icon_key IS NULL AND constraints_json='{"description":"Harvest operation of the main crop","source":"Custom","source_category":"harvest"}' AND scope='core' AND active=1 AND sort_order=1017 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.harvest_cover_crop' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Harvest Cover Crop"}' AND icon_key IS NULL AND constraints_json='{"description":"Harvest operation of the cover crop, leads to killing of the cover crop and removal of the aboveground biomass","source":"Custom","source_category":"harvest"}' AND scope='core' AND active=1 AND sort_order=1018 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.hay_removal' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Hay Removal"}' AND icon_key IS NULL AND constraints_json='{"description":"Removing dried grasses (but may include legumes and herbs) that have been cut, to preserve as fodder","source":"AGROVOC","source_category":"harvest"}' AND scope='core' AND active=1 AND sort_order=1019 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.straw_removal' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Straw Removal"}' AND icon_key IS NULL AND constraints_json='{"description":"Removing straw and other crop residues from the field","source":"Custom","source_category":"harvest"}' AND scope='core' AND active=1 AND sort_order=1020 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.cleaning_cut' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Cleaning Cut"}' AND icon_key IS NULL AND constraints_json='{"description":"Cutting of grasses and other crops for aesthetic reasons","source":"Custom","source_category":"harvest"}' AND scope='core' AND active=1 AND sort_order=1021 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.watering' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Watering"}' AND icon_key IS NULL AND constraints_json='{"description":"Irrigation is the process of applying controlled amounts of water to plants at needed intervals","source":"AGROVOC","source_category":"irrigation"}' AND scope='core' AND active=1 AND sort_order=1022 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.sampling' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sampling"}' AND icon_key IS NULL AND constraints_json='{"description":"","source":"","source_category":"other"}' AND scope='core' AND active=1 AND sort_order=1023 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.operation.note' AND kind='choice' AND parent_code='attr.agroscope.operation' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Note"}' AND icon_key IS NULL AND constraints_json='{"description":"","source":"","source_category":"other"}' AND scope='core' AND active=1 AND sort_order=1024 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.plough' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Plough"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, inversion primary tillage. Intensive soil cultivation, very little covering with plant residues on the surface. Also called moldboard plough."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2000 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.plough_with_packer' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Plough With Packer"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, inversion primary tillage with consolidation and breaking of clods. Intensive soil cultivation, leaving very little covering with plant residues on the surface. Crumbling and consolidation through trailing packer."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2001 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.spading_machine' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Spading Machine"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, non-inversion primary tillage. The implement reduces covering of the surface with organic residues by 85 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2002 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.deep_tiller' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Deep Tiller"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, non-inversion primary tillage with driven tools. The implement reduces covering of the surface with organic residues by 85 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2003 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.heavy_duty_cultivator' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Heavy Duty Cultivator"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, non-inversion primary tillage. The implement reduces covering of the surface with organic residues by 50-75 %. Also called chisel plough.","Loosening and mixing, non-inversion stubble cultivation (deep). The implement reduces covering of the surface with organic residues by 50-75 %. Also called chisel plough."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2004 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.heavy_duty_cultivator_sweeps' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Heavy Duty Cultivator Sweeps"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Same as above, but with sweeps mounted at the chisel."],"sources":["Custom","KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2005 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.disk_harrow' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Disk Harrow"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, non-inversion primary tillage. The implement reduces covering of the surface with organic residues by 40-60 %.","Mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 40-60 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2006 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.strip_tiller' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Strip Tiller"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Partial strip-wise loosening, non-inversion primary tillage - strip-wise cultivation of the seed rows before sowing. Less than 50 % of the total area is cultivated. The implement reduces covering of the surface with organic residues by 60-70 %.","The seed horizon is partially strip-wise loosened and crumbled with towed, not driven implements and reconsolidated with a roller. The implement speed is equivalent to the driving speed. The implement reduces covering of the cultivated surface with organic residues by 50-60 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2007 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.subsoiler' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Subsoiler"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["The subsoiler is a primary tillage tool, that is similar to a chisel plow. It is typically designed to penetrate 30 to 55 cm deep to alleviate soil compaction."],"sources":["NRCS (2017)"]}' AND scope='core' AND active=1 AND sort_order=2008 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.paraplough' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Paraplough"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["The purpose of the Paraplough is to loosen compacted soil layers 30 to 40 cm deep and still maintain high surface residue levels. The Paraplow lifts and fractures the soil."],"sources":["NRCS (2017)"]}' AND scope='core' AND active=1 AND sort_order=2009 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.separator' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Separator"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Operation to separate stones, typcially used for potatos"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2010 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.skim_plough' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Skim Plough"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Inversion stubble cultivation. Little covering with plant residues on the surface (on < 10 % of ground covering)."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2011 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.seedbed_combination' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Seedbed Combination"}' AND icon_key IS NULL AND constraints_json='{"descriptions":[],"sources":[]}' AND scope='core' AND active=1 AND sort_order=2012 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rotary_harrow' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Rotary Harrow"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["The seed horizon is loosened and crumbled with driven implements operating around a vertical axis, and reconsolidated with a roller. The implement reduces covering of the surface with organic residues by 30 %. The implement speed is equivalent to the driving speed in interaction with the circumferential speed of 3-6 m/s. Tines are straight, trailed or \"on grip\". Also called rotary cultivator when tines are \"on grip\"."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2013 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tine_rotor' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Tine Rotor"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["The seed horizon is loosened and crumbled with driven implements operating around the transverse axis and reconsolidated with a roller. The implement reduces covering of the surface with organic residues by 50-75 %. The implement speed is equivalent to the driving speed in interaction with the circumferential speed of 4-8 m/s."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2014 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tiller' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Tiller"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["The seed horizon is loosened and crumbled with driven implements operating around the transverse axis, and reconsolidated with a roller. The implement reduces covering of the surface with organic residues by 50-75 %. The implement speed is equivalent to the driving speed in interaction with the circumferential speed of 4-8 m/s"],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2015 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.bedder' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Bedder"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Operation to form dams or beds, e.g. for potatos or carotts"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2016 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.mulching' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Mulching"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Mulching involves shredding of above-ground organic material like stubbles, grasses or cover crops and covering the soil with the shredded material without any intervention in the soil."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2017 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tine_weeder' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Tine Weeder"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Mixing, very shallow stubble cultivation. Even spreading of the straw covering and unroots weeds. The implement reduces covering of the surface with organic residues by 5 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2018 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rotary_weeder' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Rotary Weeder"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Mixing, very shallow stubble cultivation with a rotating device. Even spreading of the straw covering and unrooting weeds."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2019 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.ring_cutter' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Ring Cutter"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 10 %"],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2020 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.roller' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Roller"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Rollers firm the seed bed or consolidate loose soil. This contributes to better seed soil contact and is important for establishment of small seeded crops like forages.","Roller firm the seed bed or recompact loose soil. This contributes to better seed soil contact and is important for establishment of small seeded crops like forages.","Use of a roller to encourage tillering of cereals."],"sources":["Custom","NRCS (2017)"]}' AND scope='core' AND active=1 AND sort_order=2021 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.knife_roller' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Knife Roller"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Crushing, cutting and mixing effect on organic residues and cover crops. The implement reduces covering of the surface with organic residues by 10 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2022 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.short_disk_harrow' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Short Disk Harrow"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 40-60 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2023 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.spade_roller_harrow' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Spade Roller Harrow"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Mixing, non-inversion stubble cultivation. The implement reduces covering of the surface with organic residues by 40-60 %."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2024 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.fine_cultivator' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Fine Cultivator"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Loosening and mixing, non-inversion stubble cultivation (shallow). The implement reduces covering of the surface with organic residues by 20-40 %. Also called chisel."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2025 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.fine_cultivator_sweeps' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Fine Cultivator Sweeps"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Same as above, but with sweeps mounted at the chisel."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2026 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.straw_harrow' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Straw Harrow"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Harrow, used to distribute residues evenly and level field surface (e.g., in no-till systems)"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2027 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.direct_drill' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Direct Drill"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Seed placement in rows or bands with no prior tillage. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution. Soil disturbance is not more than needed for seed and fertiliser placement. Sowing is carried out on less than 1/3 of the row width Cultivation depth is the seed placement depth."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2028 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.direct_single_grain' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Direct Single Grain"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Seed placement is carried out without previous tillage. Seed placement in rows with defined longitudinal grain spacing at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution. Sowing is carried out on less than 1/3 of the row width Cultivation depth is the seed placement depth."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2029 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.classic_drill' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Classic Drill"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Seed placement in rows or bands at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2030 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.classic_single_grain' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Classic Single Grain"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Seed placement in rows with defined longitudinal grain spacing at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2031 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.broadcast_seeder' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Broadcast Seeder"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Broadcast seeding is a method of seeding that involves scattering seed, by hand or mechanically, over a relatively large area."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2032 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.grassland_reseeder' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Grassland Reseeder"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Seed placement is carried out without previous tillage. Seed placement in rows at the defined placement depth. Seed feed through dosing units and mechanical or pneumatic conveyance and distribution."],"sources":["KTBL (2020)"]}' AND scope='core' AND active=1 AND sort_order=2033 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.potato_planter' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Potato Planter"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Planting potatoes into ridges"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2034 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_broadcast' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liquid Organic Broadcast"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Broadcast application of liquid organic compounds like slurry with baffle plates or other distribution devices."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2035 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_draghose' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liquid Organic Draghose"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Application of liquid organic compounds like slurry with drag hose distributors."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2036 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_trailingshoe' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liquid Organic Trailingshoe"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Application of liquid organic compounds like slurry with trailingshoe distributors."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2037 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_organic_injection' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liquid Organic Injection"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Application of liquid organic compounds like slurry with injection distributors."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2038 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.manure_broadcast' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Manure Broadcast"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["An implement used to distribute manure over a field. It usually consists of a trailer towed behind a tractor with a rotating mechanism driven by the tractor''s power take off."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2039 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.compost_broadcast' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Compost Broadcast"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["An implement used to distribute compost over a field. It usually consists of a trailer towed behind a tractor with a rotating mechanism driven by the tractor''s power take off."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2040 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.other_organic_solid_broadcast' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Other Organic Solid Broadcast"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["An implement used to distribute other solid organic amendments than manure or compost over a field. It usually consists of a trailer towed behind a tractor with a rotating mechanism driven by the tractor''s power take off."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2041 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.solid_broadcast' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Solid Broadcast"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Broadcasting of solid mineral fertilizers"],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2042 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.solid_band' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Solid Band"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Band placement of solid mineral fertilizers"],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2043 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.solid_undersown_placement' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Solid Undersown Placement"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["An application method for solid mineral fertilizer in which the fertilizer is placed in the soil below the seeds."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2044 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_injection' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liquid Injection"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["An application method for liquid mineral fertilizer in which the fertilizer is injected into the soil."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2045 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_spraying' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liquid Spraying"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["An application method for liquid mineral fertilizer in which the fertilizer is sprayed on the crops and the soil surface."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2046 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liquid_fertigation' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liquid Fertigation"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Fertigation is the injection of fertilizers and other water-soluble products into an irrigation system."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2047 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.biofertilizer' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Biofertilizer"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Application of effective microorganisms, rhizobia, compost tee or biodynamic preparation like e.g. horn manure (P 500), etc."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2048 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.liming' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Liming"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["The application of lime, dolomite or gypsum. Specify the product in product colum"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2049 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.disease_biocontrol' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Disease Biocontrol"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Apllication of biocontrol agent against diseases"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2050 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.pest_biocontrol' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Pest Biocontrol"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Apllication of biocontrol agent against pests"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2051 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.weed_biocontrol' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Weed Biocontrol"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Apllication of biocontrol agent against weeds"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2052 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sprayer"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Broadcast application of synthetic fungicides by spraying","Broadcast application of synthetic insecticides by spraying","broadcast application of synthetic growth regulators by spraying"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2053 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.seed_coating' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Seed Coating"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Seed coating with synthetic fungicides","seed coating with synthetic insecticides"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2054 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer_broadcast' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sprayer Broadcast"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["broadcast application of synthetic herbizides by spraying"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2055 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer_band' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sprayer Band"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Strip or band application of synthetic herbizides by spraying"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2056 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprayer_spot' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sprayer Spot"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Spot application of synthetic herbizides by spraying, incl. manual spraying with shoulder mounted tank."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2057 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.tine_hoe' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Tine Hoe"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Inter-rows soil cultivation with shovels, sweeps or pike implements"],"sources":["Mohler et al. (2021)."]}' AND scope='core' AND active=1 AND sort_order=2058 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rotary_hoe' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Rotary Hoe"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["ground-driven implement that uses a series of wheels with metal spoons radiating out"],"sources":["Mohler et al. (2021)."]}' AND scope='core' AND active=1 AND sort_order=2059 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.finger_hoe' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Finger Hoe"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["designed to mount on a row-crop cultivator to provide in-row and near-row weeding that cannot be achieved by sweeps and shovels alone."],"sources":["Mohler et al. (2021)."]}' AND scope='core' AND active=1 AND sort_order=2060 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.star_hoe' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Star Hoe"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["sually consists of gangs of “spider” ground driven wheels with two gangs working in each inter-row. Depending on the setting of the gangs, soil flow is strictly toward or away from the row."],"sources":["Mohler et al. (2021)."]}' AND scope='core' AND active=1 AND sort_order=2061 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.other_mechanical_weeder' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Other Mechanical Weeder"}' AND icon_key IS NULL AND constraints_json='{"descriptions":[],"sources":[]}' AND scope='core' AND active=1 AND sort_order=2062 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.burning' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Burning"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["use of propane or butane flame to burn weeds"],"sources":["Mohler et al. (2021)."]}' AND scope='core' AND active=1 AND sort_order=2063 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.electric' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Electric"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["electric discharge weeder bringing a high voltage electrode into contact with weeds"],"sources":["Mohler et al. (2021)."]}' AND scope='core' AND active=1 AND sort_order=2064 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.manual' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Manual"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Manual removing of weeds"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2065 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.slug_control' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Slug Control"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Slug control, e.g. with pellets. Specify in product"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2066 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.rodent_control' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Rodent Control"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Rodent control, e.g. with traps. Specify in product."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2067 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.combine_harvester' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Combine Harvester"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["The combine harvester is a versatile machine designed to efficiently harvest a variety of grain crops. The name derives from its combining three separate harvesting operations—reaping, threshing, and winnowing—into a single process."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2068 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.beet_lifter' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Beet Lifter"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["After defoliation with a topper, a mechanical beet lifter pulls beets from the soil, removing much of the soil from the root. Beet lifter-loader harvesters can also load roots onto trucks, but simple two-wheeled, bladed beet lifters may also be followed by hand labourers."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2069 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.potato_harvester' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Potato Harvester"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Potato harvesters are machines that harvest potatoes."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2070 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.maize_chopper' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Maize Chopper"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Maize choppers are machines to harvest maize plants."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2071 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.mower' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Mower"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["An agricultural implement that is used to cut grass or any plant that grows on the ground.","An agricultural implement used to cut grass or other ground vegetation."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2072 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.self_loading_wagon' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Self Loading Wagon"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["A machine used to collect grass or hay from a field."],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2073 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.square_baler' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Square Baler"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["A machine used to compress hay or straw into round square bales for easy transport and storage. A bale is the simplest minimum package for marketing."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2074 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.round_baler' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Round Baler"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["A machine used to compress hay or straw into round bales for easy transport and storage. A bale is the simplest minimum package for marketing."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2075 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sprinkler_irrigation' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sprinkler Irrigation"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Spraying water into the air and allowing it to fall on to plants and soil as simulated rainfall."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2076 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.trickle_irrigation' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Trickle Irrigation"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Dripping water on to a fraction of the ground surface so as to infiltrate it into the root zone."],"sources":["AGROVOC"]}' AND scope='core' AND active=1 AND sort_order=2077 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sampling_soil' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sampling Soil"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Date of soil sampling, specify in comments"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2078 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.sampling_plants' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Sampling Plants"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["Date of plant sampling, specific in comments"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2079 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.note' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Note"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["No real opeartion, but an important note (e.g. BBCH stage), use with causion"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2080 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.device.frost_kill_cover_crop' AND kind='choice' AND parent_code='attr.agroscope.device' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"Frost Kill Cover Crop"}' AND icon_key IS NULL AND constraints_json='{"descriptions":["No real opeartion, but a note that the cover crop was killed by a frost event"],"sources":["Custom"]}' AND scope='core' AND active=1 AND sort_order=2081 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.barley_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"barley, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3000 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.barley_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"barley, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3001 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.beet_fodder' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"beet, fodder"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3002 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.beet_sugar' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"beet, sugar"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3003 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.faba_bean_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"faba bean, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3004 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.faba_bean_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"faba bean, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3005 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.ley_temporary' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"ley, temporary"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3006 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.maize_grain' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"maize, grain"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3007 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.maize_silage' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"maize, silage"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3008 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.oat_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"oat, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3009 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.oat_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"oat, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3010 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.pea_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"pea, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3011 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.pea_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"pea, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3012 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.potato' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"potato"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3013 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rapeseed_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"rapeseed, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3014 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rapeseed_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"rapeseed, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3015 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rye_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"rye, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3016 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.rye_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"rye, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3017 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.sorghum' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"sorghum"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3018 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.soybean' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"soybean"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3019 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.sunflower' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"sunflower"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3020 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.triticale_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"triticale, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3021 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.triticale_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"triticale, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3022 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.wheat_durum' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"wheat, durum"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3023 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.wheat_spring' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"wheat, spring"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3024 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab WHERE code='agroscope.crop.wheat_winter' AND kind='choice' AND parent_code='attr.crop' AND value_type IS NULL AND quantity_kind IS NULL AND basis IS NULL AND default_unit_code IS NULL AND labels_json='{"en":"wheat, winter"}' AND icon_key IS NULL AND constraints_json='{"source":"SoilManageR management-data template v2.6"}' AND scope='core' AND active=1 AND sort_order=3025 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='irrigation' AND scheme_uri='https://github.com/ADAPT/Standard' AND scheme_version='1.0.0' AND mapping_role='operation_type' AND external_id='APPLICATION_IRRIGATION' AND external_parent_id IS NULL AND mapping_relation='exact' AND source_uri='https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='fertilization' AND scheme_uri='https://github.com/ADAPT/Standard' AND scheme_version='1.0.0' AND mapping_role='operation_type' AND external_id='APPLICATION_FERTILIZING' AND external_parent_id IS NULL AND mapping_relation='exact' AND source_uri='https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='plant_protection_application' AND scheme_uri='https://github.com/ADAPT/Standard' AND scheme_version='1.0.0' AND mapping_role='operation_type' AND external_id='APPLICATION_CROP_PROTECTION' AND external_parent_id IS NULL AND mapping_relation='exact' AND source_uri='https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='seeding' AND scheme_uri='https://github.com/ADAPT/Standard' AND scheme_version='1.0.0' AND mapping_role='operation_type' AND external_id='APPLICATION_SOWING_AND_PLANTING' AND external_parent_id IS NULL AND mapping_relation='close' AND source_uri='https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='planting_transplanting' AND scheme_uri='https://github.com/ADAPT/Standard' AND scheme_version='1.0.0' AND mapping_role='operation_type' AND external_id='APPLICATION_SOWING_AND_PLANTING' AND external_parent_id IS NULL AND mapping_relation='close' AND source_uri='https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='tillage_soil_work' AND scheme_uri='https://github.com/ADAPT/Standard' AND scheme_version='1.0.0' AND mapping_role='operation_type' AND external_id='FIELD_PREPARATION_TILLAGE' AND external_parent_id IS NULL AND mapping_relation='exact' AND source_uri='https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_vocab_mappings WHERE term_code='harvest' AND scheme_uri='https://github.com/ADAPT/Standard' AND scheme_version='1.0.0' AND mapping_role='operation_type' AND external_id='HARVEST' AND external_parent_id IS NULL AND mapping_relation='exact' AND source_uri='https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=1 AND labels_json='{"en":"Quick"}' AND definition_json='{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"key_values","fields":["attr.irrigation_depth","attr.amount_mass_area_product","attr.amount_volume_area_product","note"]}],"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v2-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 2
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=2 AND labels_json='{"en":"Quick"}' AND definition_json='{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"key_values","fields":["attr.irrigation_depth","attr.amount_mass_area_product","attr.amount_volume_area_product","note"]},{"code":"carried_forward_details","fields":["attr.operator","attr.equipment","attr.method"]}],"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v3-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=3 AND labels_json='{"en":"Quick"}' AND definition_json='{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"carried_forward_details","fields":["attr.operator","attr.equipment","attr.method"]}],"quick_fields":{"irrigation":["attr.irrigation_depth","note"],"fertilization":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"fertigation":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"plant_protection_application":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","note"],"weed_control_nonchemical":["note"],"seeding":["attr.crop","attr.amount_mass_area_product","attr.amount_count_area","note"],"planting_transplanting":["attr.crop","attr.amount_count_area","note"],"pruning":["note"],"crop_care":["note"],"tillage_soil_work":["attr.amount_operation_depth","note"],"mowing":["note"],"harvest":["attr.harvest_yield_area","note"],"sampling":["note"],"general_observation":["attr.observation_text","note"],"pest_disease_observation":["attr.observation_text","note"],"equipment_maintenance":["note"]},"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=6 AND labels_json='{"en":"Quick"}' AND definition_json='{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"carried_forward_details","fields":["attr.operator","attr.equipment","attr.method"]}],"quick_fields":{"irrigation":["attr.irrigation_depth","note"],"fertilization":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"fertigation":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"plant_protection_application":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","note"],"weed_control_nonchemical":["note"],"seeding":["attr.crop","attr.amount_mass_area_product","attr.amount_count_area","note"],"planting_transplanting":["attr.crop","attr.amount_count_area","note"],"pruning":["note"],"crop_care":["attr.growth_stage_bbch","note"],"tillage_soil_work":["attr.amount_operation_depth","note"],"mowing":["note"],"harvest":["attr.harvest_yield_area","attr.growth_stage_bbch","note"],"sampling":["note"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"equipment_maintenance":["note"]},"max_primary_fields":5,"carry_forward":["attr.operator","attr.equipment","attr.method"]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v9-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 9
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='farmer_quick' AND version=9 AND labels_json='{"en":"Quick"}' AND definition_json='{"sections":[{"code":"what_where_when","fields":["activity_code","plot_uuid","occurred_start"]},{"code":"carried_forward_details","fields":["attr.operator"]}],"quick_fields":{"irrigation":["attr.irrigation_depth","note"],"fertilization":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"fertigation":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","note"],"plant_protection_application":["attr.product_uuid","attr.product","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","note"],"weed_control_nonchemical":["note"],"seeding":["attr.crop","attr.amount_mass_area_product","attr.amount_count_area","note"],"planting_transplanting":["attr.crop","attr.amount_count_area","note"],"pruning":["note"],"crop_care":["attr.growth_stage_bbch","note"],"tillage_soil_work":["attr.amount_operation_depth","note"],"mowing":["note"],"harvest":["attr.harvest_yield_area","attr.growth_stage_bbch","note"],"sampling":["note"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","note"],"equipment_maintenance":["note"]},"max_primary_fields":5,"carry_forward":["attr.operator"]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=1 AND labels_json='{"en":"Full record"}' AND definition_json='{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days"]},{"code":"notes","fields":["note"]}],"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.actuation_expectation_id"]}],"certified_compliance_profile":null}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v5-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 5
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=5 AND labels_json='{"en":"Full record"}' AND definition_json='{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.actuation_expectation_id"]}],"certified_compliance_profile":null}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v6-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 6
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=6 AND labels_json='{"en":"Full record"}' AND definition_json='{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v7-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 7
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=7 AND labels_json='{"en":"Full record"}' AND definition_json='{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.treated_area"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop","attr.treated_area"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.measurement_source","attr.denominator","attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v8-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 8
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=8 AND labels_json='{"en":"Full record"}' AND definition_json='{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method","attr.treated_area"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.equipment","attr.method"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.equipment","attr.method"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.equipment","attr.method"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator","attr.equipment","attr.method"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator","attr.equipment","attr.method"],"pruning":["attr.operator","attr.equipment","attr.method"],"crop_care":["attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.equipment","attr.method"],"mowing":["attr.treated_area","attr.operator","attr.equipment","attr.method"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"sampling":["attr.measurement_source","attr.operator","attr.equipment","attr.method"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.equipment","attr.method"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator","attr.equipment","attr.method"],"equipment_maintenance":["attr.equipment","attr.operator","attr.method"]},"activity_requirements":{"fertilization":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.measurement_source","attr.denominator","attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v9-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 9
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='full_record' AND version=9 AND labels_json='{"en":"Full record"}' AND definition_json='{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","occurred_end"]},{"code":"operation","scoped_by_activity":true,"fields":["attr.crop","attr.product_uuid","attr.product","attr.treated_area","attr.harvest_area","attr.harvest_yield_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.target","attr.waiting_period_days","attr.amount_operation_depth","attr.observation_text","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.agroscope.operation","attr.agroscope.device"]},{"code":"notes","fields":["note"]}],"operation_fields_by_activity":{"irrigation":["attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator","attr.treated_area","attr.agroscope.operation","attr.agroscope.device"],"fertilization":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"fertigation":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.irrigation_amount_kind","attr.measurement_source","attr.denominator","attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume","attr.actuation_expectation_id","attr.operator"],"plant_protection_application":["attr.product_uuid","attr.product","attr.treated_area","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area","attr.target","attr.waiting_period_days","attr.growth_stage_bbch","attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"weed_control_nonchemical":["attr.treated_area","attr.target","attr.operator"],"seeding":["attr.crop","attr.treated_area","attr.amount_mass_area_product","attr.amount_count_area","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"planting_transplanting":["attr.crop","attr.treated_area","attr.amount_count_area","attr.operator"],"pruning":["attr.operator"],"crop_care":["attr.growth_stage_bbch","attr.operator"],"tillage_soil_work":["attr.treated_area","attr.amount_operation_depth","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"mowing":["attr.treated_area","attr.operator"],"harvest":["attr.crop","attr.harvest_area","attr.harvest_yield_area","attr.growth_stage_bbch","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"sampling":["attr.measurement_source","attr.operator"],"general_observation":["attr.observation_text","attr.growth_stage_bbch","attr.operator","attr.agroscope.operation","attr.agroscope.device"],"pest_disease_observation":["attr.observation_text","attr.growth_stage_bbch","attr.target","attr.operator"],"equipment_maintenance":["attr.operator"]},"activity_requirements":{"fertilization":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"fertigation":{"required":[],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate"]]},"plant_protection_application":{"required":["attr.agroscope.device","attr.agroscope.operation"],"required_any":[["attr.product_uuid","attr.product"],["attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_biological_count_area"]]},"seeding":{"required":["attr.crop","attr.agroscope.device","attr.agroscope.operation"],"required_any":[["attr.amount_mass_area_product","attr.amount_count_area"]]},"planting_transplanting":{"required":["attr.crop"],"required_any":[["attr.amount_count_area"]]},"harvest":{"required":["attr.crop","attr.harvest_area","attr.harvest_yield_area"],"required_any":[]},"tillage_soil_work":{"required":["attr.agroscope.device","attr.agroscope.operation"],"required_any":[]}},"conditional_groups":[{"code":"irrigation_details","activity_codes":["irrigation","fertigation"],"required":["attr.irrigation_amount_kind"],"required_any":[["attr.irrigation_depth","attr.irrigation_volume_area","attr.per_plant_volume"]],"optional":["attr.measurement_source","attr.denominator","attr.actuation_expectation_id"]},{"code":"weather_at_application","activity_codes":["plant_protection_application"],"required":[],"required_any":[],"optional":["attr.wind_speed","attr.wind_direction","attr.air_temperature","attr.rel_humidity"]}],"certified_compliance_profile":null}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_templates WHERE code='research_observation' AND version=1 AND labels_json='{"en":"Research"}' AND definition_json='{"sections":[{"code":"identity","fields":["activity_code","plot_uuid","occurred_start","campaign_uuid","protocol_code","protocol_version","observation_unit_code"]},{"code":"standard_values","fields":["attr.observation_text"]},{"code":"custom_values","include_scope":"custom"}],"require_explicit_choices":true,"show_standard_mappings":true}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=1 AND labels_json='{"en":"Open field"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.treated_area","attr.cover_type","attr.denominator"],"denominator_contract":["area","plant","row"],"option_dependencies":[]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='greenhouse' AND version=1 AND labels_json='{"en":"Greenhouse"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.structure_compartment","attr.root_zone_system","attr.plant_area","attr.wetted_area","attr.drainage_volume","attr.recirculation"],"conditional_fields":{"solution_managed":["attr.ec","attr.ph"]},"option_dependencies":[]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='lysimeter' AND version=1 AND labels_json='{"en":"Lysimeter"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.experimental_unit","attr.replicate","attr.treatment","attr.surface_area","attr.interval_minutes","attr.water_input","attr.rain_input","attr.drainage_volume","attr.mass_start","attr.mass_end","attr.tare_mass","attr.mass_method"],"option_dependencies":[]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v3-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=3 AND labels_json='{"en":"Open field"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.treated_area","attr.cover_type","attr.denominator"],"static_context_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"reading_fields":[],"denominator_contract":["area","plant","row"],"option_dependencies":[]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v8-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 8
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=8 AND labels_json='{"en":"Open field"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"static_context_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"reading_fields":[],"denominator_contract":["area","plant","row"],"option_dependencies":[]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v9-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 9
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='open_field' AND version=9 AND labels_json='{"en":"Open field"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"static_context_fields":["attr.block_bed_row","attr.cover_type","attr.denominator"],"reading_fields":[],"denominator_contract":["area","plant","row"],"picker_targets":["attr.agroscope.operation"],"option_dependencies":[{"source_category":"tillage","when":{"attribute_code":"activity_code","equals":"tillage_soil_work"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.primary_tillage","agroscope.operation.seedbed_preparation","agroscope.operation.stubble_cultivation"]}},{"source_category":"sowing","when":{"attribute_code":"activity_code","equals":"seeding"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sowing_cover_crop","agroscope.operation.sowing_main_crop"]}},{"source_category":"fertilizer_application","when":{"attribute_code":"activity_code","equals":"fertilization"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.organic_fertilization","agroscope.operation.mineral_fertilization","agroscope.operation.other_fertilization"]}},{"source_category":"crop_protection","when":{"attribute_code":"activity_code","equals":"plant_protection_application"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.biocontrol","agroscope.operation.fungicide","agroscope.operation.insecticide","agroscope.operation.growth_regulator","agroscope.operation.weed_herbicide","agroscope.operation.total_herbicide","agroscope.operation.weed_mechanical","agroscope.operation.weed_other","agroscope.operation.pest_control"]}},{"source_category":"harvest","when":{"attribute_code":"activity_code","equals":"harvest"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.harvest_main_crop","agroscope.operation.harvest_cover_crop","agroscope.operation.hay_removal","agroscope.operation.straw_removal","agroscope.operation.cleaning_cut"]}},{"source_category":"irrigation","when":{"attribute_code":"activity_code","equals":"irrigation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.watering"]}},{"source_category":"other","when":{"attribute_code":"activity_code","equals":"general_observation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sampling","agroscope.operation.note"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.primary_tillage"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.plough","agroscope.device.plough_with_packer","agroscope.device.spading_machine","agroscope.device.deep_tiller","agroscope.device.heavy_duty_cultivator","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.disk_harrow","agroscope.device.strip_tiller","agroscope.device.subsoiler","agroscope.device.paraplough","agroscope.device.separator","agroscope.device.skim_plough"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.seedbed_preparation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.stubble_cultivation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.potato_planter","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.organic_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.liquid_organic_broadcast","agroscope.device.liquid_organic_draghose","agroscope.device.liquid_organic_trailingshoe","agroscope.device.liquid_organic_injection","agroscope.device.manure_broadcast","agroscope.device.compost_broadcast","agroscope.device.other_organic_solid_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.mineral_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.solid_broadcast","agroscope.device.solid_band","agroscope.device.solid_undersown_placement","agroscope.device.liquid_injection","agroscope.device.liquid_spraying","agroscope.device.liquid_fertigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.other_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.biofertilizer","agroscope.device.liming"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.biocontrol"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.disease_biocontrol","agroscope.device.pest_biocontrol","agroscope.device.weed_biocontrol"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.fungicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.insecticide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.growth_regulator"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast","agroscope.device.sprayer_band","agroscope.device.sprayer_spot"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.total_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_mechanical"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.tine_hoe","agroscope.device.rotary_hoe","agroscope.device.finger_hoe","agroscope.device.star_hoe","agroscope.device.other_mechanical_weeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_other"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.burning","agroscope.device.electric","agroscope.device.manual"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.pest_control"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.slug_control","agroscope.device.rodent_control"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.combine_harvester","agroscope.device.beet_lifter","agroscope.device.potato_harvester","agroscope.device.maize_chopper","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.hay_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.straw_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.cleaning_cut"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.watering"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprinkler_irrigation","agroscope.device.trickle_irrigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sampling"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sampling_soil","agroscope.device.sampling_plants"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.note"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.note","agroscope.device.frost_kill_cover_crop"]}}]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v3-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='greenhouse' AND version=3 AND labels_json='{"en":"Greenhouse"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.structure_compartment","attr.root_zone_system","attr.plant_area"],"static_context_fields":["attr.structure_compartment","attr.root_zone_system","attr.plant_area"],"reading_fields":["attr.wetted_area","attr.drainage_volume","attr.recirculation"],"conditional_fields":{"solution_managed":["attr.ec","attr.ph"]},"option_dependencies":[]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v3-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 3
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='lysimeter' AND version=3 AND labels_json='{"en":"Lysimeter"}' AND definition_json='{"activity_codes":["irrigation","fertilization","fertigation","plant_protection_application","weed_control_nonchemical","seeding","planting_transplanting","pruning","crop_care","tillage_soil_work","mowing","harvest","sampling","general_observation","pest_disease_observation","equipment_maintenance"],"supported_templates":["farmer_quick","full_record","research_observation"],"minimum_fields":["attr.experimental_unit","attr.replicate","attr.treatment","attr.surface_area"],"static_context_fields":["attr.experimental_unit","attr.replicate","attr.treatment","attr.surface_area"],"reading_fields":["attr.interval_minutes","attr.water_input","attr.rain_input","attr.drainage_volume","attr.mass_start","attr.mass_end","attr.tare_mass","attr.mass_method"],"option_dependencies":[]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_layouts WHERE code='agroscope_open_field' AND version=1 AND labels_json='{"en":"Agroscope open field"}' AND definition_json='{"source":{"name":"SoilManageR management-data template","version":"2.6","date":"2024-12-23","license":"CC BY","attribution":"Wittwer, Heller, Turek — Agroscope"},"activity_codes":["tillage_soil_work","seeding","fertilization","plant_protection_application","harvest","irrigation","general_observation"],"supported_templates":["research_observation"],"fields":["attr.crop","attr.agroscope.operation","attr.agroscope.device","attr.amount_operation_depth","attr.amount_mass_area_product","attr.amount_volume_area_product","attr.amount_nutrient_rate","attr.amount_count_area","attr.amount_biological_count_area","attr.amount_duration_area","attr.irrigation_volume_area","attr.machine","attr.product_uuid","attr.product","attr.agroscope.combination_group","attr.agroscope.dmc_mass_fraction","attr.agroscope.dmc_mass_volume","attr.agroscope.c_content","attr.agroscope.n_content","attr.agroscope.crop_product","attr.agroscope.crop_residue","attr.agroscope.cc_product","attr.agroscope.cc_residue"],"treatment_factors":{"plot_Parzelle":["I","II","III","IV","V","VI","all"],"tillage_system":["Plough","No-till","all"],"fertilization_regime":["GRUD","Kinsey","all"]},"option_dependencies":[{"source_category":"tillage","when":{"attribute_code":"activity_code","equals":"tillage_soil_work"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.primary_tillage","agroscope.operation.seedbed_preparation","agroscope.operation.stubble_cultivation"]}},{"source_category":"sowing","when":{"attribute_code":"activity_code","equals":"seeding"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sowing_cover_crop","agroscope.operation.sowing_main_crop"]}},{"source_category":"fertilizer_application","when":{"attribute_code":"activity_code","equals":"fertilization"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.organic_fertilization","agroscope.operation.mineral_fertilization","agroscope.operation.other_fertilization"]}},{"source_category":"crop_protection","when":{"attribute_code":"activity_code","equals":"plant_protection_application"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.biocontrol","agroscope.operation.fungicide","agroscope.operation.insecticide","agroscope.operation.growth_regulator","agroscope.operation.weed_herbicide","agroscope.operation.total_herbicide","agroscope.operation.weed_mechanical","agroscope.operation.weed_other","agroscope.operation.pest_control"]}},{"source_category":"harvest","when":{"attribute_code":"activity_code","equals":"harvest"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.harvest_main_crop","agroscope.operation.harvest_cover_crop","agroscope.operation.hay_removal","agroscope.operation.straw_removal","agroscope.operation.cleaning_cut"]}},{"source_category":"irrigation","when":{"attribute_code":"activity_code","equals":"irrigation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.watering"]}},{"source_category":"other","when":{"attribute_code":"activity_code","equals":"general_observation"},"restrict":{"attribute_code":"attr.agroscope.operation","choices":["agroscope.operation.sampling","agroscope.operation.note"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.primary_tillage"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.plough","agroscope.device.plough_with_packer","agroscope.device.spading_machine","agroscope.device.deep_tiller","agroscope.device.heavy_duty_cultivator","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.disk_harrow","agroscope.device.strip_tiller","agroscope.device.subsoiler","agroscope.device.paraplough","agroscope.device.separator","agroscope.device.skim_plough"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.seedbed_preparation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.stubble_cultivation"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.seedbed_combination","agroscope.device.strip_tiller","agroscope.device.rotary_harrow","agroscope.device.tine_rotor","agroscope.device.tiller","agroscope.device.bedder","agroscope.device.mulching","agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.ring_cutter","agroscope.device.roller","agroscope.device.knife_roller","agroscope.device.short_disk_harrow","agroscope.device.disk_harrow","agroscope.device.spade_roller_harrow","agroscope.device.fine_cultivator","agroscope.device.fine_cultivator_sweeps","agroscope.device.heavy_duty_cultivator_sweeps","agroscope.device.heavy_duty_cultivator","agroscope.device.skim_plough","agroscope.device.straw_harrow"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sowing_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.direct_drill","agroscope.device.direct_single_grain","agroscope.device.classic_drill","agroscope.device.classic_single_grain","agroscope.device.broadcast_seeder","agroscope.device.grassland_reseeder","agroscope.device.potato_planter","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.organic_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.liquid_organic_broadcast","agroscope.device.liquid_organic_draghose","agroscope.device.liquid_organic_trailingshoe","agroscope.device.liquid_organic_injection","agroscope.device.manure_broadcast","agroscope.device.compost_broadcast","agroscope.device.other_organic_solid_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.mineral_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.solid_broadcast","agroscope.device.solid_band","agroscope.device.solid_undersown_placement","agroscope.device.liquid_injection","agroscope.device.liquid_spraying","agroscope.device.liquid_fertigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.other_fertilization"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.biofertilizer","agroscope.device.liming"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.biocontrol"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.disease_biocontrol","agroscope.device.pest_biocontrol","agroscope.device.weed_biocontrol"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.fungicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.insecticide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer","agroscope.device.seed_coating"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.growth_regulator"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast","agroscope.device.sprayer_band","agroscope.device.sprayer_spot"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.total_herbicide"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprayer_broadcast"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_mechanical"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.tine_weeder","agroscope.device.rotary_weeder","agroscope.device.tine_hoe","agroscope.device.rotary_hoe","agroscope.device.finger_hoe","agroscope.device.star_hoe","agroscope.device.other_mechanical_weeder","agroscope.device.roller"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.weed_other"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.burning","agroscope.device.electric","agroscope.device.manual"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.pest_control"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.slug_control","agroscope.device.rodent_control"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_main_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.combine_harvester","agroscope.device.beet_lifter","agroscope.device.potato_harvester","agroscope.device.maize_chopper","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.harvest_cover_crop"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.hay_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.straw_removal"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.self_loading_wagon","agroscope.device.square_baler","agroscope.device.round_baler","agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.cleaning_cut"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.mower"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.watering"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sprinkler_irrigation","agroscope.device.trickle_irrigation"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.sampling"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.sampling_soil","agroscope.device.sampling_plants"]}},{"when":{"attribute_code":"attr.agroscope.operation","equals":"agroscope.operation.note"},"restrict":{"attribute_code":"attr.agroscope.device","choices":["agroscope.device.note","agroscope.device.frost_kill_cover_crop"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.plough"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.plough_with_packer"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.spading_machine"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.deep_tiller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.heavy_duty_cultivator"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.heavy_duty_cultivator_sweeps"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disk_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.strip_tiller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.subsoiler"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.paraplough"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.separator"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.skim_plough"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.seedbed_combination"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.rotary_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tine_rotor"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tiller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.bedder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.mulching"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tine_weeder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.rotary_weeder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.ring_cutter"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.roller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.knife_roller"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.short_disk_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.spade_roller_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.fine_cultivator"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.fine_cultivator_sweeps"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.straw_harrow"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_drill"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_drill"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_single_grain"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.direct_single_grain"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_drill"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_drill"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_single_grain"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.classic_single_grain"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.broadcast_seeder"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.broadcast_seeder"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.grassland_reseeder"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.kg_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.grassland_reseeder"},"restrict":{"attribute_code":"attr.amount_count_area","units":["unit.plants_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_draghose"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_draghose"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_trailingshoe"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_trailingshoe"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_injection"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_organic_injection"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.manure_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.manure_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.compost_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.compost_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.other_organic_solid_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.other_organic_solid_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.solid_broadcast"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.solid_band"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.solid_undersown_placement"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_injection"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_spraying"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liquid_fertigation"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_n_per_ha_nutrient","unit.kg_p2o5_per_ha_nutrient","unit.kg_k2o_per_ha_nutrient","unit.kg_mg_per_ha_nutrient","unit.kg_s_per_ha_nutrient","unit.kg_ca_per_ha_nutrient","unit.kg_b_per_ha_nutrient","unit.kg_na_per_ha_nutrient","unit.kg_mn_per_ha_nutrient","unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.biofertilizer"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.biofertilizer"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liming"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.m3_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liming"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.t_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.liming"},"restrict":{"attribute_code":"attr.amount_nutrient_rate","units":["unit.kg_cao_per_ha_nutrient"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disease_biocontrol"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disease_biocontrol"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.disease_biocontrol"},"restrict":{"attribute_code":"attr.amount_biological_count_area","units":["unit.biological_count_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.pest_biocontrol"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.pest_biocontrol"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.pest_biocontrol"},"restrict":{"attribute_code":"attr.amount_biological_count_area","units":["unit.biological_count_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.weed_biocontrol"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.weed_biocontrol"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.weed_biocontrol"},"restrict":{"attribute_code":"attr.amount_biological_count_area","units":["unit.biological_count_per_ha"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.seed_coating"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.seed_coating"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_broadcast"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_broadcast"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_band"},"restrict":{"attribute_code":"attr.amount_volume_area_product","units":["unit.l_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprayer_band"},"restrict":{"attribute_code":"attr.amount_mass_area_product","units":["unit.g_per_ha_product"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.tine_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.rotary_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.finger_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.star_hoe"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.other_mechanical_weeder"},"restrict":{"attribute_code":"attr.amount_operation_depth","units":["unit.cm_operation_depth"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.manual"},"restrict":{"attribute_code":"attr.amount_duration_area","units":["unit.h_per_ha_labor"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.sprinkler_irrigation"},"restrict":{"attribute_code":"attr.irrigation_volume_area","units":["unit.m3_per_ha_water"]}},{"when":{"attribute_code":"attr.agroscope.device","equals":"agroscope.device.trickle_irrigation"},"restrict":{"attribute_code":"attr.irrigation_volume_area","units":["unit.m3_per_ha_water"]}}]}' AND active=1);
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='2bcfa3a1-eabf-5f66-b3f1-9f6d7d390d04' AND scope='core' AND name='Slurry' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='9dbaff6c-200f-503c-85ce-541b2d1f17ca' AND scope='core' AND name='Manure' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='3c6f7f4d-58d0-59c5-90c9-2de704b0ed8a' AND scope='core' AND name='Slurry_dairy_cow' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='4d19b32d-8bd6-5846-8893-065f099aaccc' AND scope='core' AND name='Manure_dairy_cow' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='f710d50c-a3b5-5e9d-b345-6f61120a5c8e' AND scope='core' AND name='Slurry_pig' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='1cc24052-87fd-559f-8047-3fec479019db' AND scope='core' AND name='Manure_laying_hens' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='27ba3e6a-c256-559b-83fa-384c23b98257' AND scope='core' AND name='Digestate_solid' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='8ec58fdd-8f76-5d07-8d97-d895f00107cd' AND scope='core' AND name='Digestate_liquid' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='1a708f09-a507-5523-8a44-86ec61f95b6b' AND scope='core' AND name='Compost' AND kind='organic_amendment' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');
INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at)
SELECT 0,0,'catalog-v1-postcondition-failed','2026-07-12T00:00:00.000Z'
WHERE COALESCE((SELECT catalog_version FROM journal_catalog_state WHERE id=1),0) <= 1
  AND NOT EXISTS (SELECT 1 FROM journal_products WHERE product_uuid='d6c3bd6e-a957-5925-9cd9-ae0738bc91af' AND scope='core' AND name='Glyphosate' AND kind='plant_protection' AND composition_json='{}' AND active=1 AND sync_version=0 AND created_at='2026-07-12T00:00:00.000Z');

-- journal_catalog_state
INSERT OR IGNORE INTO journal_catalog_state(id,catalog_version,catalog_hash,updated_at) VALUES (1,9,'42a7e36f097ef6b3989c67636d663bcaf18fff27bfc6dc805ebdfa922166f9cc','2026-07-12T00:00:00.000Z');
UPDATE journal_catalog_state SET catalog_version=9,catalog_hash='42a7e36f097ef6b3989c67636d663bcaf18fff27bfc6dc805ebdfa922166f9cc',updated_at='2026-07-12T00:00:00.000Z' WHERE id=1 AND catalog_version <= 9;
-- END GENERATED JOURNAL CATALOG V1
