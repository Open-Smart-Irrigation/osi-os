-- risk: additive
-- 0072: per-instrument rainfall days with coverage, explicit zone gauge selection, and the
-- quality columns of the zone daily projection. Existing zone rows are not rewritten; a NULL
-- rain_coverage marks a legacy, unvalidated value.
-- Contract: docs/contracts/rainfall/zone-day-projection.md. No trigger here: the
-- zone_daily_environment outbox payload is unchanged by this migration.
CREATE TABLE IF NOT EXISTS rain_instrument_days (
  deveui          TEXT NOT NULL,
  date            TEXT NOT NULL,
  timezone        TEXT NOT NULL,
  amount_mm       REAL,
  received_mm     REAL,
  coverage        TEXT NOT NULL CHECK (coverage IN ('complete','complete_so_far','partial','unknown')),
  reasons         TEXT NOT NULL DEFAULT '[]',
  accepted_count  INTEGER NOT NULL DEFAULT 0,
  observed_cutoff TEXT,
  policy_version  INTEGER NOT NULL,
  computed_at     TEXT NOT NULL,
  PRIMARY KEY (deveui, date, timezone)
);
CREATE TABLE IF NOT EXISTS zone_rain_source (
  zone_id          INTEGER PRIMARY KEY REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  selected_deveui  TEXT,
  selected_at      TEXT,
  selected_by_uuid TEXT,
  updated_at       TEXT NOT NULL
);
ALTER TABLE zone_daily_environment ADD COLUMN rain_coverage TEXT;
ALTER TABLE zone_daily_environment ADD COLUMN rain_selected_deveui TEXT;
ALTER TABLE zone_daily_environment ADD COLUMN rain_policy_version INTEGER;
ALTER TABLE zone_daily_environment ADD COLUMN rain_quality_reasons TEXT;
ALTER TABLE zone_daily_environment ADD COLUMN rain_received_mm REAL;
