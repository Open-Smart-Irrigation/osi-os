-- risk: additive
-- 0062: Provider weather store (spec 2026-09-25-weather-provider-store-design):
-- hourly rows per farm location from Open-Meteo or MeteoSwiss, the daily
-- ET0/ETc record written by sub-project 2, and the per-zone provider override.
-- Every measurement column is nullable: an hour the provider did not deliver
-- stays NULL, never 0.

CREATE TABLE IF NOT EXISTS weather_locations (
  location_key        TEXT PRIMARY KEY,
  provider            TEXT NOT NULL CHECK (provider IN ('open_meteo', 'meteoswiss')),
  latitude            REAL NOT NULL,
  longitude           REAL NOT NULL,
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  station_id          TEXT,
  station_name        TEXT,
  station_distance_km REAL,
  station_resolved_at TEXT,
  last_fetch_at       TEXT,
  last_success_at     TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS weather_provider_hours (
  location_key          TEXT NOT NULL REFERENCES weather_locations(location_key) ON DELETE CASCADE,
  hour_start            TEXT NOT NULL,
  air_temperature_c     REAL,
  relative_humidity_pct REAL,
  rain_mm               REAL,
  wind_speed_mps        REAL,
  global_radiation_wm2  REAL,
  et0_mm                REAL,
  fetched_at            TEXT NOT NULL,
  PRIMARY KEY (location_key, hour_start)
);

CREATE TABLE IF NOT EXISTS zone_daily_agronomy (
  zone_id     INTEGER NOT NULL REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  et0_mm      REAL,
  et0_source  TEXT,
  kc          REAL,
  kc_source   TEXT,
  etc_mm      REAL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (zone_id, date)
);

ALTER TABLE irrigation_zones ADD COLUMN weather_source TEXT NOT NULL DEFAULT 'auto';
