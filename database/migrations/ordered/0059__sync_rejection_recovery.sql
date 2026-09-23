-- risk: additive
-- 0059: Track one controlled recovery generation for rejected outbox events.

ALTER TABLE sync_outbox ADD COLUMN rejection_code TEXT;
ALTER TABLE sync_outbox ADD COLUMN rejection_class TEXT;
ALTER TABLE sync_outbox ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_generation IN (0, 1));

CREATE TABLE sync_outbox_recovery_audit (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid                  TEXT NOT NULL,
  generation                  INTEGER NOT NULL CHECK (generation = 1),
  actor                       TEXT NOT NULL,
  attempted_at                TEXT NOT NULL,
  previous_rejection_code     TEXT,
  previous_rejection_class    TEXT,
  previous_rejection_reason   TEXT,
  envelope_sha256             TEXT NOT NULL,
  receipt_json                TEXT NOT NULL,
  UNIQUE (event_uuid, generation)
);

CREATE INDEX idx_sync_outbox_recovery_audit_event
  ON sync_outbox_recovery_audit(event_uuid, attempted_at, id);
