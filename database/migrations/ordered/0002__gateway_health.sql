-- risk: additive
-- 0002: Persist aggregated gateway CPU health reporting (osi-os issue #68).
-- Raw 60s heartbeat samples + hourly min/mean/max rollups, pruned daily by the
-- Node-RED "Gateway Health Rollup" job (gateway-health-rollup-fn).
-- IF NOT EXISTS on purpose: live Pis receive this DDL via deploy.sh
-- (ensure_gateway_health_schema) before the migration-runner ledger is wired
-- into deploy; when ledger adoption happens later, re-running 0002 is a no-op.

CREATE TABLE IF NOT EXISTS gateway_health_samples (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_device_eui TEXT NOT NULL,
  sampled_at         TEXT NOT NULL,
  cpu_temp_c         REAL,
  mem_percent        REAL,
  load_1             REAL,
  load_5             REAL,
  load_15            REAL,
  fan_value          REAL,
  throttled          INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_gateway_health_samples_eui_time
  ON gateway_health_samples(gateway_device_eui, sampled_at);

CREATE INDEX IF NOT EXISTS idx_gateway_health_samples_time
  ON gateway_health_samples(sampled_at);

CREATE TABLE IF NOT EXISTS gateway_health_hourly (
  gateway_device_eui TEXT NOT NULL,
  hour_start         TEXT NOT NULL,
  sample_count       INTEGER NOT NULL DEFAULT 0,
  cpu_temp_c_min     REAL,
  cpu_temp_c_mean    REAL,
  cpu_temp_c_max     REAL,
  mem_percent_min    REAL,
  mem_percent_mean   REAL,
  mem_percent_max    REAL,
  load_1_min         REAL,
  load_1_mean        REAL,
  load_1_max         REAL,
  load_5_min         REAL,
  load_5_mean        REAL,
  load_5_max         REAL,
  load_15_min        REAL,
  load_15_mean       REAL,
  load_15_max        REAL,
  fan_value_min      REAL,
  fan_value_mean     REAL,
  fan_value_max      REAL,
  throttled_max      INTEGER,
  computed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (gateway_device_eui, hour_start)
);

CREATE INDEX IF NOT EXISTS idx_gateway_health_hourly_time
  ON gateway_health_hourly(hour_start);
