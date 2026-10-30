-- risk: additive
-- 0078: Durable link from a Chameleon diagnostic to the device_data row of the same uplink (issue #356).
CREATE TABLE IF NOT EXISTS chameleon_reading_links (
  chameleon_reading_id INTEGER PRIMARY KEY
    REFERENCES chameleon_readings(id) ON DELETE CASCADE,
  device_data_id INTEGER NOT NULL
    REFERENCES device_data(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chameleon_reading_links_device_data
  ON chameleon_reading_links(device_data_id);
CREATE TRIGGER IF NOT EXISTS trg_chameleon_reading_links_identity_bi
BEFORE INSERT ON chameleon_reading_links
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM chameleon_readings cr
    JOIN device_data dd ON dd.deveui = cr.deveui
   WHERE cr.id = NEW.chameleon_reading_id
     AND dd.id = NEW.device_data_id
)
BEGIN
  SELECT RAISE(ABORT, 'chameleon reading link must join rows of one device');
END;
CREATE TRIGGER IF NOT EXISTS trg_chameleon_reading_links_immutable_bu
BEFORE UPDATE ON chameleon_reading_links
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'chameleon reading link is immutable');
END;
