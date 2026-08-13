-- risk: destructive
-- 0046: Add DRAGINO_SDI12 to devices.type_id and rebuild the parent table.
-- SQLite cannot ALTER a CHECK in place. The migration runner fences this
-- rename-old/create/copy/drop swap with foreign_keys=OFF and writers stopped.
-- Trigger bodies are copied from the current seed so telemetry and device
-- configuration changes retain the same outbox contracts after the rebuild.

DROP TRIGGER IF EXISTS trg_sync_devices_defaults_ai;
DROP TRIGGER IF EXISTS trg_sync_devices_outbox_au;
DROP TRIGGER IF EXISTS trg_dp_device_data_outbox_ai;
DROP TABLE IF EXISTS devices_old;

PRAGMA legacy_alter_table=ON;
ALTER TABLE devices RENAME TO devices_old;

CREATE TABLE devices (
  id                                    INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui                                TEXT UNIQUE NOT NULL,
  name                                  TEXT NOT NULL,
  type_id                               TEXT NOT NULL CHECK(type_id IN (
                                          'KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50',
                                          'TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN',
                                          'MILESIGHT_UC512','DRAGINO_SDI12')),
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
  sdi12_probe_profile                   TEXT,
  sdi12_probe_status                    TEXT CHECK(sdi12_probe_status IN ('pending_identify','identified','unmatched','manual')),
  sdi12_identity                        TEXT,
  FOREIGN KEY (user_id)  REFERENCES users(id)             ON DELETE SET NULL,
  FOREIGN KEY (farm_id)  REFERENCES farms(farm_id)        ON DELETE SET NULL
);

INSERT INTO devices (id, deveui, name, type_id, user_id, farm_id, current_state, target_state, created_at, updated_at, claimed_at, chirpstack_app_id, irrigation_zone_id, dendro_enabled, temp_enabled, is_reference_tree, sync_version, deleted_at, gateway_device_eui, strega_model, rain_gauge_enabled, flow_meter_enabled, soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured, dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_force_legacy, dendro_stroke_mm, dendro_ratio_zero, dendro_ratio_span, dendro_baseline_position_mm, dendro_baseline_mode_used, dendro_baseline_calibration_signature, dendro_baseline_pending, dendro_invert_direction, device_mode, chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm, sdi12_probe_profile, sdi12_probe_status, sdi12_identity)
SELECT id, deveui, name, type_id, user_id, farm_id, current_state, target_state, created_at, updated_at, claimed_at, chirpstack_app_id, irrigation_zone_id, dendro_enabled, temp_enabled, is_reference_tree, sync_version, deleted_at, gateway_device_eui, strega_model, rain_gauge_enabled, flow_meter_enabled, soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured, dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_force_legacy, dendro_stroke_mm, dendro_ratio_zero, dendro_ratio_span, dendro_baseline_position_mm, dendro_baseline_mode_used, dendro_baseline_calibration_signature, dendro_baseline_pending, dendro_invert_direction, device_mode, chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm, sdi12_probe_profile, sdi12_probe_status, sdi12_identity FROM devices_old;

DROP TABLE devices_old;
PRAGMA legacy_alter_table=OFF;

CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_deveui ON devices(deveui);
CREATE INDEX idx_devices_farm_id ON devices(farm_id);
CREATE INDEX idx_devices_irrigation_zone_id ON devices(irrigation_zone_id);

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
    COALESCE(NEW.sdi12_probe_profile,'') <> COALESCE(OLD.sdi12_probe_profile,'') OR
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
      'sdi12_probe_profile',               NEW.sdi12_probe_profile,
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
      'bat_pct',               NEW.bat_pct,
      'vwc_1',                 NEW.vwc_1,
      'vwc_2',                 NEW.vwc_2,
      'vwc_3',                 NEW.vwc_3,
      'vwc_4',                 NEW.vwc_4,
      'vwc_5',                 NEW.vwc_5,
      'vwc_6',                 NEW.vwc_6,
      'vwc_7',                 NEW.vwc_7,
      'vwc_8',                 NEW.vwc_8,
      'soil_temp_1',           NEW.soil_temp_1,
      'soil_temp_2',           NEW.soil_temp_2,
      'soil_temp_3',           NEW.soil_temp_3,
      'soil_temp_4',           NEW.soil_temp_4,
      'soil_temp_5',           NEW.soil_temp_5,
      'soil_temp_6',           NEW.soil_temp_6,
      'soil_temp_7',           NEW.soil_temp_7,
      'soil_temp_8',           NEW.soil_temp_8,
      'soil_ec_1',             NEW.soil_ec_1,
      'soil_ec_2',             NEW.soil_ec_2,
      'soil_ec_3',             NEW.soil_ec_3,
      'soil_ec_4',             NEW.soil_ec_4,
      'soil_ec_5',             NEW.soil_ec_5,
      'soil_ec_6',             NEW.soil_ec_6,
      'soil_ec_7',             NEW.soil_ec_7,
      'soil_ec_8',             NEW.soil_ec_8
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;
