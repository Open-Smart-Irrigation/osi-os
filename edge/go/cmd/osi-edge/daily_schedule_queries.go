package main

import "fmt"

// The legacy tick excludes a zone with any live policy and chooses its first
// owner-matching STREGA by creation time.
const dailyZonesQuery = `SELECT
    iz.id AS zone_id,
    iz.name AS zone_name,
    iz.user_id,
    COALESCE(iz.scheduling_mode, 'local') AS scheduling_mode,

    s.trigger_metric,
    s.threshold_kpa,
    s.duration_minutes,
    s.enabled,
    s.last_triggered_at,
    (
      SELECT COUNT(DISTINCT u.id)
      FROM users u
      WHERE u.disabled_at IS NULL
        AND (
          u.id = iz.user_id
          OR u.user_uuid IN (
            SELECT uza.user_uuid
            FROM user_zone_assignments uza
            WHERE uza.zone_uuid = iz.zone_uuid
              AND uza.deleted_at IS NULL
          )
        )
    ) AS enabled_scope_holders,

    (
      SELECT d.deveui
      FROM devices d
      WHERE d.irrigation_zone_id = iz.id
        AND d.type_id = 'STREGA_VALVE'
        AND d.user_id = iz.user_id
      ORDER BY d.created_at ASC
      LIMIT 1
    ) AS valve_deveui

    ,
    zse.summary_json AS shared_environment_json,
    zse.last_received_at AS shared_environment_received_at

  FROM irrigation_zones iz
  INNER JOIN irrigation_schedules s
    ON s.irrigation_zone_id = iz.id
  LEFT JOIN zone_shared_environment zse
    ON zse.zone_uuid = iz.zone_uuid

  WHERE s.enabled = 1
    AND iz.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM irrigation_policies p
      WHERE p.zone_uuid = iz.zone_uuid
        AND p.deleted_at IS NULL
    )

  ORDER BY iz.id ASC;`

func dailySWTQuery(metric string) string {
	rowValue := "v1"
	switch metric {
	case "SWT_WM2", "SWT_2":
		rowValue = "v2"
	case "SWT_WM3", "SWT_3":
		rowValue = "v3"
	case "SWT_AVG":
		rowValue = `CASE WHEN (v1 IS NOT NULL) + (v2 IS NOT NULL) + (v3 IS NOT NULL) = 0 THEN NULL
			ELSE (COALESCE(v1,0) + COALESCE(v2,0) + COALESCE(v3,0)) * 1.0 /
			((v1 IS NOT NULL) + (v2 IS NOT NULL) + (v3 IS NOT NULL)) END`
	}
	// The durable reading link and WATERMARK exclusion stay in the SQL so
	// inclusion does not depend on a timestamp match or a legacy device flag.
	return fmt.Sprintf(`SELECT
    AVG(row_value) AS mean_kpa,
    COUNT(row_value) AS n_points,
    MIN(CASE WHEN row_value IS NOT NULL THEN recorded_at END) AS min_recorded_at,
    MAX(CASE WHEN row_value IS NOT NULL THEN recorded_at END) AS max_recorded_at
  FROM (
    SELECT recorded_at, %s AS row_value
    FROM (
      SELECT
        recorded_at,
        CASE WHEN row_ok = 1 AND ch1_ok = 1 AND typeof(raw1) IN ('integer','real') AND raw1 BETWEEN 0 AND max_kpa THEN raw1 END AS v1,
        CASE WHEN row_ok = 1 AND ch2_ok = 1 AND typeof(raw2) IN ('integer','real') AND raw2 BETWEEN 0 AND max_kpa THEN raw2 END AS v2,
        CASE WHEN row_ok = 1 AND ch3_ok = 1 AND typeof(raw3) IN ('integer','real') AND raw3 BETWEEN 0 AND max_kpa THEN raw3 END AS v3
      FROM (
        SELECT
          dd.recorded_at,
          COALESCE(dd.swt_1, dd.swt_wm1) AS raw1,
          COALESCE(dd.swt_2, dd.swt_wm2) AS raw2,
          dd.swt_3 AS raw3,
          CASE
            WHEN ds.type_id <> 'DRAGINO_LSN50' THEN 1
            WHEN cr.id IS NOT NULL AND cr.i2c_missing IS NOT 1 AND cr.timeout IS NOT 1 AND cr.data_invalid IS NOT 1 THEN 1
            ELSE 0
          END AS row_ok,
          CASE WHEN ds.type_id <> 'DRAGINO_LSN50' OR cr.ch1_open IS NOT 1 THEN 1 ELSE 0 END AS ch1_ok,
          CASE WHEN ds.type_id <> 'DRAGINO_LSN50' OR cr.ch2_open IS NOT 1 THEN 1 ELSE 0 END AS ch2_ok,
          CASE WHEN ds.type_id <> 'DRAGINO_LSN50' OR cr.ch3_open IS NOT 1 THEN 1 ELSE 0 END AS ch3_ok,
          CASE WHEN ds.type_id = 'DRAGINO_LSN50' THEN 300 ELSE 1000000 END AS max_kpa

        FROM devices ds
        INNER JOIN device_data dd
          ON dd.deveui = ds.deveui
        LEFT JOIN chameleon_reading_links crl
          ON crl.device_data_id = dd.id
        LEFT JOIN chameleon_readings cr
          ON cr.id = crl.chameleon_reading_id AND cr.deveui = dd.deveui

        WHERE ds.irrigation_zone_id = ?
          AND (
            ds.type_id IN ('KIWI_SENSOR', 'TEKTELIC_CLOVER', 'DRAGINO_SDI12')
            OR (ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1)
          )
          AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)
          AND dd.recorded_at >= ?
      ) AS candidate
    ) AS eligible
  ) AS row_values;`, rowValue)
}
