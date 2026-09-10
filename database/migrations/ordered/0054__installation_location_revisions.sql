-- risk: additive
-- 0054: Immutable device installation location and radio configuration revisions.

CREATE TABLE IF NOT EXISTS device_installation_location_revisions (
  revision_uuid TEXT PRIMARY KEY,
  device_eui TEXT NOT NULL,
  installation_uuid TEXT NOT NULL,
  source_gateway_device_eui TEXT,
  base_revision_uuid TEXT,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  latitude REAL NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude REAL NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  altitude_m REAL,
  vertical_reference TEXT,
  accuracy_m REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  antenna_height_agl_m REAL CHECK (antenna_height_agl_m IS NULL OR antenna_height_agl_m >= 0),
  coordinate_source TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_user_uuid TEXT,
  supersedes_revision_uuid TEXT,
  sync_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (device_eui, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_device_location_revisions_device_time
  ON device_installation_location_revisions(device_eui, effective_from, revision_no);
CREATE INDEX IF NOT EXISTS idx_device_location_revisions_installation_device
  ON device_installation_location_revisions(installation_uuid, device_eui, effective_from);
CREATE INDEX IF NOT EXISTS idx_device_location_revisions_supersedes
  ON device_installation_location_revisions(supersedes_revision_uuid);

CREATE TABLE IF NOT EXISTS device_radio_configuration_revisions (
  revision_uuid TEXT PRIMARY KEY,
  device_eui TEXT NOT NULL,
  installation_uuid TEXT NOT NULL,
  source_gateway_device_eui TEXT,
  base_revision_uuid TEXT,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  tx_power_dbm REAL,
  antenna_gain_dbi REAL,
  feeder_loss_db REAL,
  configuration_source TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_user_uuid TEXT,
  supersedes_revision_uuid TEXT,
  sync_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (device_eui, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_device_radio_revisions_device_time
  ON device_radio_configuration_revisions(device_eui, effective_from, revision_no);
CREATE INDEX IF NOT EXISTS idx_device_radio_revisions_installation_device
  ON device_radio_configuration_revisions(installation_uuid, device_eui, effective_from);
CREATE INDEX IF NOT EXISTS idx_device_radio_revisions_supersedes
  ON device_radio_configuration_revisions(supersedes_revision_uuid);
