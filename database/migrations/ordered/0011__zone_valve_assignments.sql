-- risk: additive
-- 0011: Channel-per-zone support for multi-channel valve controllers (3.1).
-- Junction table maps (zone_id, deveui, valve_channel) so a single UC512
-- can serve two irrigation zones with independent valve channels.
-- Also adds valve_channel to valve_actuation_expectations for per-channel
-- expectation tracking.

CREATE TABLE IF NOT EXISTS zone_valve_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL,
  deveui TEXT NOT NULL,
  valve_channel INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE,
  UNIQUE (zone_id, valve_channel)
);

CREATE INDEX IF NOT EXISTS idx_zone_valve_zone ON zone_valve_assignments(zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_valve_deveui ON zone_valve_assignments(deveui);

ALTER TABLE valve_actuation_expectations ADD COLUMN valve_channel INTEGER;
