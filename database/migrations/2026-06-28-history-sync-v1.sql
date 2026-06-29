CREATE TABLE IF NOT EXISTS sync_link_state (
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

CREATE TABLE IF NOT EXISTS sync_history_cursors (
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

CREATE TABLE IF NOT EXISTS sync_history_dirty_keys (
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

CREATE TABLE IF NOT EXISTS sync_history_segments (
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

CREATE TABLE IF NOT EXISTS sync_history_quarantine (
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

ALTER TABLE chameleon_readings ADD COLUMN data_invalid INTEGER DEFAULT 0;
ALTER TABLE chameleon_readings ADD COLUMN comp_pending INTEGER DEFAULT 0;

ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT;
UPDATE irrigation_events
SET event_uuid = 'irrig-' || COALESCE(
  NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE irrigation_zones.id = irrigation_events.irrigation_zone_id AND deleted_at IS NULL)), ''),
  NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
) || '-' || printf('%015d', id)
WHERE (event_uuid IS NULL OR event_uuid = '')
  AND COALESCE(
    NULLIF(trim((SELECT gateway_device_eui FROM irrigation_zones WHERE irrigation_zones.id = irrigation_events.irrigation_zone_id AND deleted_at IS NULL)), ''),
    NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
  ) IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_irrigation_events_event_uuid
  ON irrigation_events(event_uuid);



-- Reinstall link-gated structural outbox triggers for upgraded databases.
DROP TRIGGER IF EXISTS trg_sync_zones_outbox_au;
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

DROP TRIGGER IF EXISTS trg_sync_devices_outbox_au;
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

DROP TRIGGER IF EXISTS trg_sync_schedules_outbox_au;
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

DROP TRIGGER IF EXISTS trg_gateway_locations_outbox_ai;
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

DROP TRIGGER IF EXISTS trg_gateway_locations_outbox_au;
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

-- Reinstall link-gated legacy history/outbox triggers for upgraded databases.
DROP TRIGGER IF EXISTS trg_dp_device_data_outbox_ai;
CREATE TRIGGER trg_dp_device_data_outbox_ai
AFTER INSERT ON device_data
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
    'DEVICE_DATA',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.recorded_at,''),
    'DEVICE_DATA_APPENDED',
    json_object(
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

DROP TRIGGER IF EXISTS trg_dp_chameleon_readings_outbox_ai;
CREATE TRIGGER trg_dp_chameleon_readings_outbox_ai
AFTER INSERT ON chameleon_readings
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
    'CHAMELEON_READING',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.recorded_at,''),
    'CHAMELEON_READING_APPENDED',
    json_object(
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

DROP TRIGGER IF EXISTS trg_dp_dendro_readings_outbox_ai;
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

DROP TRIGGER IF EXISTS trg_sync_device_data_dirty_au;
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

DROP TRIGGER IF EXISTS trg_sync_chameleon_readings_dirty_au;
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

DROP TRIGGER IF EXISTS trg_sync_dendro_readings_dirty_au;
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

DROP TRIGGER IF EXISTS trg_sync_zone_env_dirty_ai;
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

DROP TRIGGER IF EXISTS trg_sync_zone_env_dirty_au;
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

DROP TRIGGER IF EXISTS trg_sync_zone_recs_dirty_ai;
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

DROP TRIGGER IF EXISTS trg_sync_zone_recs_dirty_au;
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

DROP TRIGGER IF EXISTS trg_sync_dendro_daily_dirty_ai;
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

DROP TRIGGER IF EXISTS trg_sync_dendro_daily_dirty_au;
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

DROP TRIGGER IF EXISTS trg_dp_dendro_daily_outbox_ai;
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

DROP TRIGGER IF EXISTS trg_dp_dendro_daily_outbox_au;
CREATE TRIGGER trg_dp_dendro_daily_outbox_au
AFTER UPDATE ON dendrometer_daily
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

DROP TRIGGER IF EXISTS trg_dp_zone_env_outbox_ai;
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

DROP TRIGGER IF EXISTS trg_dp_zone_env_outbox_au;
CREATE TRIGGER trg_dp_zone_env_outbox_au
AFTER UPDATE ON zone_daily_environment
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

DROP TRIGGER IF EXISTS trg_dp_zone_recs_outbox_ai;
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

DROP TRIGGER IF EXISTS trg_dp_zone_recs_outbox_au;
CREATE TRIGGER trg_dp_zone_recs_outbox_au
AFTER UPDATE ON zone_daily_recommendations
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

DROP TRIGGER IF EXISTS trg_sync_irrigation_events_uuid_ai;
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

DROP TRIGGER IF EXISTS trg_dp_irrigation_events_outbox_ai;
DROP TRIGGER IF EXISTS trg_dp_irrigation_events_outbox_au_event_uuid;

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
