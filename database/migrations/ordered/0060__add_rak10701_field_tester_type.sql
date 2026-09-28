-- risk: destructive
-- 0060: Add RAK10701_FIELD_TESTER to devices.type_id and rebuild the parent table.
-- The runner supplies the foreign_keys fence and the writers-stopped gate; this
-- file must not toggle foreign_keys itself.
--
-- SQLite cannot ALTER a CHECK in place, so the ninth device type needs the same
-- rename-old/create/copy/drop swap 0027__add_dragino_sdi12_type.sql used for the
-- eighth. Three things differ from that precedent and are deliberate:
--
--   1. The table declaration, its four indexes and its two triggers below are
--      transcribed from database/seed-blank.sql at this version, NOT copied from
--      0027. devices has gained sdi12_value_count (0028) and
--      sdi12_channel_layout_json (0029) since then, and 0058 replaced the
--      hardcoded gateway_device_eui fallbacks in both triggers with
--      sync_link_state attribution (osi-os#157/#153). Reusing 0027's text would
--      silently drop two columns and reintroduce Silvan's EUI on every gateway.
--   2. Only the two triggers ATTACHED TO devices are dropped and recreated.
--      0027 also dropped trg_dp_device_data_outbox_ai, which is attached to
--      device_data: it survives the swap untouched under legacy_alter_table=ON,
--      and recreating a boot-owned trigger body that does not need to change is
--      how trigger text drifts (see 0028's header).
--   3. legacy_alter_table=ON is load-bearing, not cosmetic. Eleven tables now
--      carry ON DELETE CASCADE foreign keys to devices and fourteen triggers
--      reference it by name. Without it, ALTER TABLE RENAME rewrites every one
--      of those references to devices_old, and the subsequent DROP TABLE takes
--      the children with it.
--
-- Two properties of this swap are deliberate rather than overlooked. This file is
-- checksummed and immutable once any gateway applies it, so they are recorded here
-- and not only in the review trail:
--
--   a. DROP TABLE devices_old does not preserve sqlite_sequence. devices is
--      INTEGER PRIMARY KEY AUTOINCREMENT, so the rebuilt table's high-water mark
--      re-seeds to MAX(id) among the COPIED rows, and any id above the last
--      surviving row becomes reusable by a future insert. Measured on a scratch
--      database: three rows inserted, two deleted, sqlite_sequence 3 -> 1 across
--      the swap, and the next insert took id 2 -- an id a deleted row had held.
--      This is inherited from 0027 and shared with the boot node's own rebuild,
--      not introduced here. It is benign in this schema: every child of devices
--      cascades on hard delete, so no orphan row can be re-parented by a reused
--      id, and sync keys devices on deveui (the DEVICE outbox payload's
--      aggregate_key), never on the integer id.
--   b. DROP TABLE IF EXISTS devices_old above is a crash-recovery pre-clean, and
--      it is destructive in one narrow case: if a previous attempt died between
--      the RENAME and the copy, the only surviving copy of the table is sitting
--      in devices_old, and this statement drops it. The runner's pre-migration
--      backup (destructive risk class, backupDb before applyPending) is the real
--      net for that case -- not this file. Do not turn the pre-clean into a
--      conditional rescue: a half-rebuilt state needs an operator and a restore,
--      not a migration guessing which of two tables is authoritative.

DROP TRIGGER IF EXISTS trg_sync_devices_defaults_ai;
DROP TRIGGER IF EXISTS trg_sync_devices_outbox_au;
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
                                          'MILESIGHT_UC512','DRAGINO_SDI12','RAK10701_FIELD_TESTER')),
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
  sdi12_value_count                     INTEGER CHECK(sdi12_value_count IS NULL OR (sdi12_value_count BETWEEN 1 AND 8)),
  sdi12_channel_layout_json             TEXT,
  FOREIGN KEY (user_id)  REFERENCES users(id)             ON DELETE SET NULL,
  FOREIGN KEY (farm_id)  REFERENCES farms(farm_id)        ON DELETE SET NULL
);

INSERT INTO devices (id, deveui, name, type_id, user_id, farm_id, current_state, target_state, created_at, updated_at, claimed_at, chirpstack_app_id, irrigation_zone_id, dendro_enabled, temp_enabled, is_reference_tree, sync_version, deleted_at, gateway_device_eui, strega_model, rain_gauge_enabled, flow_meter_enabled, soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured, dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_force_legacy, dendro_stroke_mm, dendro_ratio_zero, dendro_ratio_span, dendro_baseline_position_mm, dendro_baseline_mode_used, dendro_baseline_calibration_signature, dendro_baseline_pending, dendro_invert_direction, device_mode, chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm, sdi12_probe_profile, sdi12_probe_status, sdi12_identity, sdi12_value_count, sdi12_channel_layout_json)
SELECT id, deveui, name, type_id, user_id, farm_id, current_state, target_state, created_at, updated_at, claimed_at, chirpstack_app_id, irrigation_zone_id, dendro_enabled, temp_enabled, is_reference_tree, sync_version, deleted_at, gateway_device_eui, strega_model, rain_gauge_enabled, flow_meter_enabled, soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured, dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_force_legacy, dendro_stroke_mm, dendro_ratio_zero, dendro_ratio_span, dendro_baseline_position_mm, dendro_baseline_mode_used, dendro_baseline_calibration_signature, dendro_baseline_pending, dendro_invert_direction, device_mode, chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm, sdi12_probe_profile, sdi12_probe_status, sdi12_identity, sdi12_value_count, sdi12_channel_layout_json FROM devices_old;

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
    gateway_device_eui = COALESCE(gateway_device_eui, NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')),
    sync_version       = CASE WHEN COALESCE(sync_version,0)=0 THEN 1 ELSE sync_version END
  WHERE deveui = NEW.deveui;
END;

CREATE TRIGGER trg_sync_devices_outbox_au AFTER UPDATE ON devices FOR EACH ROW WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node='cloud' AND linked=1) AND (COALESCE(NEW.user_id,'') <> COALESCE(OLD.user_id,'') OR
    COALESCE(NEW.irrigation_zone_id,'') <> COALESCE(OLD.irrigation_zone_id,'') OR
    COALESCE(NEW.dendro_enabled,0) <> COALESCE(OLD.dendro_enabled,0) OR
    COALESCE(NEW.temp_enabled,0) <> COALESCE(OLD.temp_enabled,0) OR
    COALESCE(NEW.rain_gauge_enabled,0) <> COALESCE(OLD.rain_gauge_enabled,0) OR
    COALESCE(NEW.flow_meter_enabled,0) <> COALESCE(OLD.flow_meter_enabled,0) OR
    COALESCE(NEW.is_reference_tree,0) <> COALESCE(OLD.is_reference_tree,0) OR
    COALESCE(NEW.name,'') <> COALESCE(OLD.name,'') OR
    COALESCE(NEW.strega_model,'') <> COALESCE(OLD.strega_model,'') OR
    COALESCE(NEW.sdi12_probe_profile,'') <> COALESCE(OLD.sdi12_probe_profile,'') OR
    COALESCE(NEW.sdi12_value_count,-1) <> COALESCE(OLD.sdi12_value_count,-1) OR
    COALESCE(NEW.soil_moisture_probe_depths_json,'') <> COALESCE(OLD.soil_moisture_probe_depths_json,'') OR
    COALESCE(NEW.soil_moisture_probe_depths_configured,0) <> COALESCE(OLD.soil_moisture_probe_depths_configured,0) OR
    COALESCE(NEW.chameleon_enabled,0) <> COALESCE(OLD.chameleon_enabled,0) OR
    COALESCE(NEW.chameleon_swt1_depth_cm,-1) <> COALESCE(OLD.chameleon_swt1_depth_cm,-1) OR
    COALESCE(NEW.chameleon_swt2_depth_cm,-1) <> COALESCE(OLD.chameleon_swt2_depth_cm,-1) OR
    COALESCE(NEW.chameleon_swt3_depth_cm,-1) <> COALESCE(OLD.chameleon_swt3_depth_cm,-1) OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)) BEGIN INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui) VALUES (lower(hex(randomblob(16))), 'DEVICE', NEW.deveui, CASE WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN 'DEVICE_UNCLAIMED' WHEN COALESCE(OLD.irrigation_zone_id,'') <> COALESCE(NEW.irrigation_zone_id,'') AND NEW.irrigation_zone_id IS NULL THEN 'DEVICE_UNASSIGNED' WHEN COALESCE(OLD.irrigation_zone_id,'') <> COALESCE(NEW.irrigation_zone_id,'') AND NEW.irrigation_zone_id IS NOT NULL THEN 'DEVICE_ASSIGNED' ELSE 'DEVICE_FLAGS_UPDATED' END, json_object('contract_version', 1, 'device_eui', NEW.deveui, 'name', NEW.name, 'type', NEW.type_id, 'claimed_user_uuid', (SELECT user_uuid FROM users WHERE id = NEW.user_id), 'claimed_by_username', (SELECT COALESCE(server_username, username) FROM users WHERE id = NEW.user_id), 'zone_uuid', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL), 'dendro_enabled', NEW.dendro_enabled, 'temp_enabled', NEW.temp_enabled, 'rain_gauge_enabled', NEW.rain_gauge_enabled, 'flow_meter_enabled', NEW.flow_meter_enabled, 'is_reference_tree', NEW.is_reference_tree, 'current_state', NEW.current_state, 'target_state', NEW.target_state, 'strega_model', NEW.strega_model, 'sdi12_probe_profile', NEW.sdi12_probe_profile, 'sdi12_value_count', NEW.sdi12_value_count, 'soil_moisture_probe_depths_json', json(COALESCE(NEW.soil_moisture_probe_depths_json, '{}')), 'soil_moisture_probe_depths_configured', COALESCE(NEW.soil_moisture_probe_depths_configured, 0), 'chameleon_enabled', NEW.chameleon_enabled, 'chameleon_swt1_depth_cm', NEW.chameleon_swt1_depth_cm, 'chameleon_swt2_depth_cm', NEW.chameleon_swt2_depth_cm, 'chameleon_swt3_depth_cm', NEW.chameleon_swt3_depth_cm, 'gateway_device_eui', COALESCE(NEW.gateway_device_eui, NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')), 'sync_version', NEW.sync_version, 'deleted_at', NEW.deleted_at), NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ','now'), COALESCE(NEW.gateway_device_eui, NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))); END;
