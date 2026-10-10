-- risk: additive
-- 0071: durable rainfall observation identity (rain correctness programme). One row per
-- received rain-capable uplink, linked to its device_data row; identity is the ChirpStack
-- deduplicationId per device. Zone, timezone and policy are snapshots taken at ingestion.
-- No trigger: observations do not sync; raw telemetry already does through device_data.
CREATE TABLE IF NOT EXISTS rain_observations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  device_data_id        INTEGER REFERENCES device_data(id) ON DELETE SET NULL,
  deveui                TEXT NOT NULL,
  instrument_type       TEXT NOT NULL CHECK (instrument_type IN ('AQUASCOPE_LORAIN','SENSECAP_S2120','DRAGINO_LSN50')),
  event_id              TEXT,
  dev_addr              TEXT,
  f_cnt                 INTEGER,
  payload_digest        TEXT NOT NULL,
  received_at           TEXT NOT NULL,
  measured_start        TEXT,
  measured_end          TEXT,
  interval_basis        TEXT NOT NULL CHECK (interval_basis IN ('protocol_verified','reception_gap','unknown')),
  frame_kind            TEXT NOT NULL CHECK (frame_kind IN ('ordinary','heartbeat_zero','button','alarm','config','status','counter')),
  tips                  INTEGER,
  amount_mm             REAL,
  status                TEXT NOT NULL CHECK (status IN ('accepted','ambiguous_identity','rejected_invalid','not_additive','overlap_unqualified')),
  quality_reasons       TEXT NOT NULL DEFAULT '[]',
  config_json           TEXT,
  zone_id               INTEGER,
  zone_uuid             TEXT,
  timezone              TEXT,
  source_policy_version INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rain_observations_event ON rain_observations(deveui, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rain_observations_deveui_received ON rain_observations(deveui, received_at);
CREATE INDEX IF NOT EXISTS idx_rain_observations_zone_received ON rain_observations(zone_id, received_at);
-- The device_data foreign key needs a child index, or every device_data delete scans this table.
CREATE INDEX IF NOT EXISTS idx_rain_observations_device_data ON rain_observations(device_data_id);
