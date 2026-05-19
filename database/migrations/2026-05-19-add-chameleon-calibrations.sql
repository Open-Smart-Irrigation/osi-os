-- Chameleon calibration global table + retire per-device coefficients

CREATE TABLE IF NOT EXISTS chameleon_calibrations (
  array_id                TEXT PRIMARY KEY,
  sensor_id               TEXT NOT NULL,
  sensor1_a               REAL NOT NULL,
  sensor1_b               REAL NOT NULL,
  sensor1_c               REAL NOT NULL,
  sensor1_r2              REAL,
  sensor2_a               REAL NOT NULL,
  sensor2_b               REAL NOT NULL,
  sensor2_c               REAL NOT NULL,
  sensor2_r2              REAL,
  sensor3_a               REAL NOT NULL,
  sensor3_b               REAL NOT NULL,
  sensor3_c               REAL NOT NULL,
  sensor3_r2              REAL,
  test_rig_run_start_date TEXT,
  source                  TEXT NOT NULL,
  fetched_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chameleon_calibrations_sensor_id
  ON chameleon_calibrations(sensor_id);

CREATE TABLE IF NOT EXISTS chameleon_calibration_misses (
  array_id   TEXT PRIMARY KEY,
  last_tried TEXT NOT NULL,
  reason     TEXT
);

ALTER TABLE chameleon_readings ADD COLUMN calibration_status TEXT;

-- Drop the 9 per-device coefficient columns. SQLite >= 3.35 supports DROP COLUMN.
ALTER TABLE devices DROP COLUMN chameleon_swt1_a;
ALTER TABLE devices DROP COLUMN chameleon_swt1_b;
ALTER TABLE devices DROP COLUMN chameleon_swt1_c;
ALTER TABLE devices DROP COLUMN chameleon_swt2_a;
ALTER TABLE devices DROP COLUMN chameleon_swt2_b;
ALTER TABLE devices DROP COLUMN chameleon_swt2_c;
ALTER TABLE devices DROP COLUMN chameleon_swt3_a;
ALTER TABLE devices DROP COLUMN chameleon_swt3_b;
ALTER TABLE devices DROP COLUMN chameleon_swt3_c;

-- NULL kPa for rows joined to chameleon readings; edge recomputes from calibration.
UPDATE device_data
   SET swt_1 = NULL, swt_2 = NULL, swt_3 = NULL
 WHERE EXISTS (
   SELECT 1 FROM chameleon_readings cr
    WHERE cr.deveui = device_data.deveui
      AND cr.recorded_at = device_data.recorded_at
 );
