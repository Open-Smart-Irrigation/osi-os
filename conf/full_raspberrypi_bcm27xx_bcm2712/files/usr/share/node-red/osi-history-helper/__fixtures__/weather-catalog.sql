-- Fixture for osi-history-helper/analysis.test.js (spec
-- docs/superpowers/specs/2026-09-27-weather-data-view-design.md). Applied on
-- top of database/seed-blank.sql. Zones 1 and 2 share one Open-Meteo
-- location; zone 3 is 'local'; zone 4 has no location row yet; zone 5 is
-- MeteoSwiss; zone 6 belongs to another user.
INSERT INTO users (id, username, password_hash, created_at, user_uuid, role, sync_version) VALUES
  (1, 'grower', 'x', '2026-09-01T00:00:00Z', 'u-grower', 'admin', 1),
  (2, 'other', 'x', '2026-09-01T00:00:00Z', 'u-other', 'researcher', 1);
INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, timezone, latitude, longitude, weather_source, created_at, updated_at) VALUES
  (1, 'North', 1, 'z-north', 'Europe/Zurich', 46.8, 6.95, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (2, 'South', 1, 'z-south', 'Europe/Zurich', 46.8, 6.95, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (3, 'Local', 1, 'z-local', 'Europe/Zurich', 46.8, 6.95, 'local', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (4, 'Fresh', 1, 'z-fresh', 'Europe/Zurich', 47.0, 7.0, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (5, 'Payerne', 1, 'z-payerne', 'Europe/Zurich', 46.81, 6.94, 'meteoswiss', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (6, 'Foreign', 2, 'z-foreign', 'Europe/Zurich', 46.8, 6.95, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
  ('A840410000000001', 'Kiwi North', 'KIWI_SENSOR', 1, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('A840410000002120', 'demo-s2120', 'SENSECAP_S2120', 1, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('A840410000002121', 'foreign-s2120', 'SENSECAP_S2120', 2, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO weather_station_zones (deveui, zone_id) VALUES
  ('A840410000002120', 1),
  ('A840410000002121', 1);
INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone, station_id, station_name, station_distance_km) VALUES
  ('open_meteo:46.80:6.95', 'open_meteo', 46.8, 6.95, 'Europe/Zurich', NULL, NULL, NULL),
  ('meteoswiss:46.81:6.94', 'meteoswiss', 46.81, 6.94, 'Europe/Zurich', 'PAY', 'Payerne', 12.4);
