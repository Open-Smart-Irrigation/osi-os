-- risk: data
-- 0039: Publish current S2120 assignment sets at version one.

INSERT OR IGNORE INTO weather_station_zone_state(deveui, sync_version)
SELECT deveui, 0
  FROM devices
 WHERE type_id = 'SENSECAP_S2120'
   AND deleted_at IS NULL;

UPDATE weather_station_zone_state
   SET sync_version = 1
 WHERE COALESCE(sync_version, 0) = 0;
