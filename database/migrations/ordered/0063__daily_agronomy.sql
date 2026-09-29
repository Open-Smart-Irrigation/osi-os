-- risk: additive
-- 0063: daily agronomy record (spec 2026-09-26-daily-agronomy-design): the
-- Kc snapshot and provenance columns on zone_daily_agronomy, the MeteoSwiss
-- station per provider hour, and the local weather station hourly aggregates.
-- et0_tier: 'station_fao56' | 'provider_hourly_sum' | 'hargreaves_station'.
-- et0_station_id: the station deveui for a station tier, the MeteoSwiss
-- station id for a MeteoSwiss provider day, NULL for Open-Meteo.
-- null_reason: 'no_source' | 'partial_day' | 'mixed_station' |
-- 'unknown_station' | 'pending' | 'no_location'.

ALTER TABLE zone_daily_agronomy ADD COLUMN crop_type TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN phenological_stage TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN et0_tier TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN et0_station_id TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN location_key TEXT;
ALTER TABLE zone_daily_agronomy ADD COLUMN hours_present INTEGER;
ALTER TABLE zone_daily_agronomy ADD COLUMN expected_hours INTEGER;
ALTER TABLE zone_daily_agronomy ADD COLUMN null_reason TEXT;

ALTER TABLE weather_provider_hours ADD COLUMN station_id TEXT;

CREATE TABLE IF NOT EXISTS weather_station_hours (
  deveui                TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE,
  hour_start            TEXT NOT NULL,
  air_temperature_c     REAL,
  air_temperature_min_c REAL,
  air_temperature_max_c REAL,
  relative_humidity_pct REAL,
  wind_speed_mps        REAL,
  pressure_hpa          REAL,
  light_lux             REAL,
  global_radiation_wm2  REAL,
  rain_mm               REAL,
  sample_count          INTEGER NOT NULL,
  computed_at           TEXT NOT NULL,
  PRIMARY KEY (deveui, hour_start)
);
