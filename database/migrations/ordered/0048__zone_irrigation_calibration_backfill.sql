-- risk: data
-- 0048: Publish existing zone irrigation calibration at version one.

UPDATE zone_irrigation_calibration
   SET sync_version = 1
 WHERE COALESCE(sync_version, 0) = 0;
