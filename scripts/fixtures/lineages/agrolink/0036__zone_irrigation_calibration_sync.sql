-- risk: additive
-- 0036: Version zone irrigation calibration and mirror portable changes.

ALTER TABLE zone_irrigation_calibration
  ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE zone_irrigation_calibration
  ADD COLUMN deleted_at DATETIME;

ALTER TABLE zone_irrigation_calibration
  ADD COLUMN last_applied_at DATETIME;

CREATE TRIGGER trg_sync_zone_irrigation_calibration_defaults_ai
AFTER INSERT ON zone_irrigation_calibration
FOR EACH ROW
WHEN COALESCE(NEW.sync_version, 0) = 0
BEGIN
  UPDATE zone_irrigation_calibration
     SET sync_version = 1
   WHERE zone_id = NEW.zone_id;
END;

CREATE TRIGGER trg_sync_zone_irrigation_calibration_outbox_au
AFTER UPDATE ON zone_irrigation_calibration
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND EXISTS (
    SELECT 1
      FROM irrigation_zones
     WHERE id = NEW.zone_id
       AND zone_uuid IS NOT NULL
       AND trim(zone_uuid) <> ''
       AND gateway_device_eui IS NOT NULL
       AND trim(gateway_device_eui) <> ''
       AND deleted_at IS NULL
  )
  AND (
    NEW.measured_flow_rate_lpm IS NOT OLD.measured_flow_rate_lpm OR
    NEW.measurement_method IS NOT OLD.measurement_method OR
    NEW.measured_at IS NOT OLD.measured_at OR
    NEW.sync_version IS NOT OLD.sync_version OR
    NEW.deleted_at IS NOT OLD.deleted_at OR
    NEW.last_applied_at IS NOT OLD.last_applied_at
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_CALIBRATION',
    (
      SELECT zone_uuid
        FROM irrigation_zones
       WHERE id = NEW.zone_id
         AND deleted_at IS NULL
    ),
    'ZONE_IRRIGATION_CALIBRATION_UPSERTED',
    json_object(
      'contract_version',        1,
      'zone_uuid',               (
        SELECT zone_uuid
          FROM irrigation_zones
         WHERE id = NEW.zone_id
           AND deleted_at IS NULL
      ),
      'gateway_device_eui',      (
        SELECT gateway_device_eui
          FROM irrigation_zones
         WHERE id = NEW.zone_id
           AND deleted_at IS NULL
      ),
      'measured_flow_rate_lpm',  NEW.measured_flow_rate_lpm,
      'measurement_method',      NEW.measurement_method,
      'measured_at',             NEW.measured_at,
      'sync_version',            NEW.sync_version,
      'deleted_at',              NEW.deleted_at,
      'last_applied_at',         NEW.last_applied_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    (
      SELECT gateway_device_eui
        FROM irrigation_zones
       WHERE id = NEW.zone_id
         AND deleted_at IS NULL
    )
  );
END;
