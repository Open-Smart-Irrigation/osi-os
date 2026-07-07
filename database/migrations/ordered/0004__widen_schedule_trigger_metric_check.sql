-- risk: destructive
-- 0004: Widen irrigation_schedules.trigger_metric CHECK to the full live
-- vocabulary (osi-os issue #92). The flows API and GUI accept
-- SWT_1/2/3 and DENDRO since 2026-06-24/25 but the CHECK still carried the
-- original 3-value vocabulary, so every non-SWT_AVG schedule save fails
-- with a CHECK violation (HTTP 500).
--
-- SQLite cannot ALTER a CHECK in place, so this is a fail-closed table
-- rebuild. Pattern is rename-old-first: the replacement table is created
-- under its final name with DDL text byte-identical to seed-blank.sql, so
-- the stored sqlite_master text (which scripts/verify-seed-replay.js
-- fingerprint-compares against a fresh seed apply) stays pristine. Rows
-- are copied with a plain INSERT: any row violating the widened CHECK
-- throws and rolls back the whole migration (the runner wraps this file
-- in PRAGMA foreign_keys=OFF / BEGIN IMMEDIATE ... COMMIT /
-- PRAGMA foreign_keys=ON and requires writersStopped=true).
-- Both schedule triggers are dropped first (ALTER TABLE RENAME would
-- otherwise rewrite their bodies) and recreated verbatim from the seed.
-- No other trigger, view, or FK references irrigation_schedules.

DROP TRIGGER IF EXISTS trg_sync_schedules_defaults_ai;
DROP TRIGGER IF EXISTS trg_sync_schedules_outbox_au;

DROP TABLE IF EXISTS irrigation_schedules_old;

ALTER TABLE irrigation_schedules RENAME TO irrigation_schedules_old;

CREATE TABLE irrigation_schedules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  irrigation_zone_id  INTEGER NOT NULL,
  trigger_metric      TEXT NOT NULL CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO')),
  threshold_kpa       REAL NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_triggered_at   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  duration_minutes    INTEGER,
  response_mode       TEXT,
  sync_version        INTEGER DEFAULT 0,
  deleted_at          DATETIME,
  last_applied_at     DATETIME,
  FOREIGN KEY (irrigation_zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  UNIQUE (irrigation_zone_id)
);

INSERT INTO irrigation_schedules (
  id, irrigation_zone_id, trigger_metric, threshold_kpa, enabled,
  last_triggered_at, created_at, updated_at, duration_minutes,
  response_mode, sync_version, deleted_at, last_applied_at
)
SELECT
  id, irrigation_zone_id, trigger_metric, threshold_kpa, enabled,
  last_triggered_at, created_at, updated_at, duration_minutes,
  response_mode, sync_version, deleted_at, last_applied_at
FROM irrigation_schedules_old;

DROP TABLE irrigation_schedules_old;

CREATE TRIGGER trg_sync_schedules_defaults_ai
AFTER INSERT ON irrigation_schedules
FOR EACH ROW
BEGIN
  UPDATE irrigation_schedules
  SET
    sync_version  = CASE WHEN COALESCE(sync_version,0)=0 THEN 1 ELSE sync_version END,
    response_mode = COALESCE(response_mode,'proportional')
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sync_schedules_outbox_au
AFTER UPDATE ON irrigation_schedules
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND (
    COALESCE(NEW.trigger_metric,'') <> COALESCE(OLD.trigger_metric,'') OR
    COALESCE(NEW.threshold_kpa,0) <> COALESCE(OLD.threshold_kpa,0) OR
    COALESCE(NEW.enabled,0) <> COALESCE(OLD.enabled,0) OR
    COALESCE(NEW.duration_minutes,0) <> COALESCE(OLD.duration_minutes,0) OR
    COALESCE(NEW.response_mode,'') <> COALESCE(OLD.response_mode,'') OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'SCHEDULE',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),''),
    'SCHEDULE_UPSERTED',
    json_object(
      'contract_version', 1,
      'zone_uuid',       (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
      'trigger_metric',  NEW.trigger_metric,
      'threshold_kpa',   NEW.threshold_kpa,
      'enabled',         NEW.enabled,
      'duration_minutes', NEW.duration_minutes,
      'response_mode',   NEW.response_mode,
      'sync_version',    NEW.sync_version,
      'deleted_at',      NEW.deleted_at,
      'last_applied_at', NEW.last_applied_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)
  );
END;
