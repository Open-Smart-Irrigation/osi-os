'use strict';

// The SWT query of the legacy threshold scheduler ("Build mean query (last
// hour, all datapoints)"). Issue #356 moved it out of that function node
// unchanged; the node keeps the DENDRO query and the one-hour cutoff.
//
// buildSwtMeanQuery(metric, zoneId, cutoffIso) returns the SQL that "Decide +
// build actuator cmd" reads: mean_kpa, n_points, min_recorded_at and
// max_recorded_at over the zone's eligible rows since cutoffIso. metric is the
// zone's upper-case trigger_metric; an unknown metric reads channel 1, as
// before. zoneId and cutoffIso are interpolated into the SQL text, so both are
// checked: a finite number and an ISO-8601 UTC timestamp (the recorded_at
// format).

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function buildSwtMeanQuery(metric, zoneId, cutoffIso) {
  if (!Number.isFinite(zoneId)) throw new TypeError('zoneId must be a finite number');
  if (typeof cutoffIso !== 'string' || !ISO_UTC.test(cutoffIso)) {
    throw new TypeError('cutoffIso must be an ISO-8601 UTC timestamp');
  }

  // Issue #356: which channel values may drive this legacy threshold
  // scheduler. A value counts only when it is a finite number inside its
  // source's domain: 0..300 kPa for a Chameleon LSN50 (the converter's output
  // range), 0..1,000,000 kPa for KIWI, CLOVER and SDI-12 (the shared consumer
  // domain). A Chameleon row counts only through its chameleon_reading_links
  // row, written at ingest from the row's own id; timestamps never associate a
  // diagnostic. That diagnostic drops the row on I2C, timeout or data-invalid,
  // and one channel on its open flag. An invalid canonical value never falls
  // back to its legacy alias.
  let rowValue = "v1";
  if (metric === "SWT_WM2" || metric === "SWT_2") rowValue = "v2";
  if (metric === "SWT_WM3" || metric === "SWT_3") rowValue = "v3";
  if (metric === "SWT_AVG") {
    rowValue = "CASE WHEN (v1 IS NOT NULL) + (v2 IS NOT NULL) + (v3 IS NOT NULL) = 0 THEN NULL ELSE (COALESCE(v1,0) + COALESCE(v2,0) + COALESCE(v3,0)) * 1.0 / ((v1 IS NOT NULL) + (v2 IS NOT NULL) + (v3 IS NOT NULL)) END";
  }

  // WATERMARK phase 1 interlock: WATERMARK observations never drive irrigation
  // until phase 3's explicit enable (spec 2026-09-25 section 8).
  return `
  SELECT
    AVG(row_value) AS mean_kpa,
    COUNT(row_value) AS n_points,
    MIN(CASE WHEN row_value IS NOT NULL THEN recorded_at END) AS min_recorded_at,
    MAX(CASE WHEN row_value IS NOT NULL THEN recorded_at END) AS max_recorded_at
  FROM (
    SELECT recorded_at, ${rowValue} AS row_value
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

        WHERE ds.irrigation_zone_id = ${zoneId}
          AND (
            ds.type_id IN ('KIWI_SENSOR', 'TEKTELIC_CLOVER', 'DRAGINO_SDI12')
            OR (ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1)
          )
          AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)
          AND dd.recorded_at >= '${cutoffIso}'
      ) AS candidate
    ) AS eligible
  ) AS row_values;
`.trim();
}

module.exports = { buildSwtMeanQuery };
