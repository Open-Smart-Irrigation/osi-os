-- risk: additive
-- 0038: Version and mirror complete S2120 weather-station assignment sets.

CREATE TABLE weather_station_zone_state (
  deveui         TEXT PRIMARY KEY,
  sync_version   INTEGER NOT NULL DEFAULT 0,
  last_applied_at DATETIME,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
);

CREATE TRIGGER trg_sync_weather_station_zone_state_defaults_ai
AFTER INSERT ON weather_station_zone_state
FOR EACH ROW
WHEN COALESCE(NEW.sync_version, 0) = 0
BEGIN
  UPDATE weather_station_zone_state
     SET sync_version = 1
   WHERE deveui = NEW.deveui;
END;

CREATE TRIGGER trg_sync_weather_station_zones_outbox_au
AFTER UPDATE ON weather_station_zone_state
FOR EACH ROW
WHEN
  NEW.sync_version IS NOT OLD.sync_version
  AND EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND EXISTS (
    SELECT 1
      FROM devices
     WHERE deveui = NEW.deveui
       AND type_id = 'SENSECAP_S2120'
       AND deleted_at IS NULL
       AND gateway_device_eui IS NOT NULL
       AND trim(gateway_device_eui) <> ''
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'WEATHER_STATION_ZONES',
    NEW.deveui,
    'WEATHER_STATION_ZONES_REPLACED',
    json_object(
      'contract_version',   1,
      'device_eui',         NEW.deveui,
      'gateway_device_eui', (
        SELECT gateway_device_eui
          FROM devices
         WHERE deveui = NEW.deveui
      ),
      'zone_uuids',         json(COALESCE((
        SELECT json_group_array(zone_uuid)
          FROM (
            SELECT iz.zone_uuid AS zone_uuid
              FROM weather_station_zones wsz
              JOIN irrigation_zones iz ON iz.id = wsz.zone_id
             WHERE wsz.deveui = NEW.deveui
               AND iz.deleted_at IS NULL
             ORDER BY iz.zone_uuid
          )
      ), '[]')),
      'sync_version',       NEW.sync_version,
      'last_applied_at',    NEW.last_applied_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    (
      SELECT gateway_device_eui
        FROM devices
       WHERE deveui = NEW.deveui
    )
  );
END;
