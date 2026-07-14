-- risk: additive
-- 0016: Chameleon-enabled LSN50 devices never synced chameleon_enabled to the
-- cloud (osi-os issue #5). trg_sync_devices_outbox_au's change-detection WHEN
-- clause and json_object payload omitted chameleon_enabled entirely, and (a
-- pre-existing drift from the sync-init-fn boot node, which already carries
-- the three chameleon_swt*_depth_cm columns per commit e3758b9b) also omitted
-- them from database/seed-blank.sql / the migration-owned copy of this
-- trigger. Fix: drop and recreate trg_sync_devices_outbox_au verbatim from
-- database/seed-blank.sql (0003/0015 precedent) so replaying 0001..0016
-- reproduces the seed schema exactly (see scripts/verify-seed-replay.js),
-- with chameleon_enabled added to both the WHEN clause and the payload, and
-- the three depth columns added to the WHEN clause and payload to match what
-- sync-init-fn already emits at runtime.

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
