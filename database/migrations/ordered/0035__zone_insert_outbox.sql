-- risk: additive
-- 0035: Emit the initial ZONE_UPSERTED event for fully identified zone rows.

CREATE TRIGGER IF NOT EXISTS trg_sync_zones_outbox_ai
AFTER INSERT ON irrigation_zones
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND NEW.zone_uuid IS NOT NULL
  AND trim(NEW.zone_uuid) <> ''
  AND NEW.gateway_device_eui IS NOT NULL
  AND trim(NEW.gateway_device_eui) <> ''
  AND COALESCE(NEW.sync_version, 0) > 0
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE',
    NEW.zone_uuid,
    'ZONE_UPSERTED',
    json_object(
      'contract_version', 1,
      'zone_uuid',                 NEW.zone_uuid,
      'name',                      NEW.name,
      'gateway_device_eui',        NEW.gateway_device_eui,
      'timezone',                  NEW.timezone,
      'latitude',                  NEW.latitude,
      'longitude',                 NEW.longitude,
      'phenological_stage',        NEW.phenological_stage,
      'calibration_key',           NEW.calibration_key,
      'crop_type',                 NEW.crop_type,
      'variety',                   NEW.variety,
      'soil_type',                 NEW.soil_type,
      'irrigation_method',         NEW.irrigation_method,
      'area_m2',                   NEW.area_m2,
      'irrigation_efficiency_pct', NEW.irrigation_efficiency_pct,
      'scheduling_mode',           COALESCE(NEW.scheduling_mode, 'local'),
      'prediction_card_enabled',   COALESCE(NEW.prediction_card_enabled, 0),
      'notes',                     NEW.notes,
      'sync_version',              NEW.sync_version,
      'deleted_at',                NEW.deleted_at,
      'user', json_object(
        'user_uuid',   (SELECT user_uuid FROM users WHERE id = NEW.user_id),
        'username',    (SELECT username FROM users WHERE id = NEW.user_id),
        'cloudUserId', (SELECT cloud_user_id FROM users WHERE id = NEW.user_id)
      )
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NEW.gateway_device_eui
  );
END;
