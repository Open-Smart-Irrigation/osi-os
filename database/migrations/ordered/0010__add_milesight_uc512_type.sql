-- risk: destructive
-- 0010: Add MILESIGHT_UC512 to devices.type_id CHECK constraint (3.1).
-- SQLite cannot ALTER a CHECK in place, so this is a rename-old → create-new
-- → copy-rows → drop-old table rebuild. Triggers on devices are dropped first
-- and recreated after (same text as seed-blank.sql). The runner wraps this in
-- PRAGMA foreign_keys=OFF / BEGIN IMMEDIATE / COMMIT / PRAGMA foreign_keys=ON
-- and requires writersStopped=true.

DROP TRIGGER IF EXISTS trg_sync_devices_defaults_ai;
DROP TRIGGER IF EXISTS trg_sync_devices_outbox_au;

DROP TABLE IF EXISTS devices_old;

-- Keep child-table foreign keys targeting devices during the rename/rebuild.
-- Without this, modern SQLite rewrites child FKs to devices_old and leaves
-- them broken after devices_old is dropped.
PRAGMA legacy_alter_table=ON;

ALTER TABLE devices RENAME TO devices_old;

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

INSERT INTO devices (
  id, deveui, name, type_id, user_id, farm_id, current_state, target_state,
  created_at, updated_at, claimed_at, chirpstack_app_id, irrigation_zone_id,
  dendro_enabled, temp_enabled, is_reference_tree, sync_version, deleted_at,
  gateway_device_eui, strega_model, rain_gauge_enabled, flow_meter_enabled,
  soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured,
  dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_force_legacy,
  dendro_stroke_mm, dendro_ratio_zero, dendro_ratio_span,
  dendro_baseline_position_mm, dendro_baseline_mode_used,
  dendro_baseline_calibration_signature, dendro_baseline_pending,
  dendro_invert_direction, device_mode, chameleon_enabled,
  chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm
)
SELECT
  id, deveui, name, type_id, user_id, farm_id, current_state, target_state,
  created_at, updated_at, claimed_at, chirpstack_app_id, irrigation_zone_id,
  dendro_enabled, temp_enabled, is_reference_tree, sync_version, deleted_at,
  gateway_device_eui, strega_model, rain_gauge_enabled, flow_meter_enabled,
  soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured,
  dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_force_legacy,
  dendro_stroke_mm, dendro_ratio_zero, dendro_ratio_span,
  dendro_baseline_position_mm, dendro_baseline_mode_used,
  dendro_baseline_calibration_signature, dendro_baseline_pending,
  dendro_invert_direction, device_mode, chameleon_enabled,
  chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm
FROM devices_old;

DROP TABLE devices_old;

PRAGMA legacy_alter_table=OFF;

CREATE INDEX idx_devices_user_id          ON devices(user_id);
CREATE INDEX idx_devices_deveui           ON devices(deveui);
CREATE INDEX idx_devices_farm_id          ON devices(farm_id);
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
      'gateway_device_eui',                COALESCE(NEW.gateway_device_eui,'0016C001F11715E2'),
      'sync_version',                      NEW.sync_version,
      'deleted_at',                        NEW.deleted_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(NEW.gateway_device_eui,'0016C001F11715E2')
  );
END;
