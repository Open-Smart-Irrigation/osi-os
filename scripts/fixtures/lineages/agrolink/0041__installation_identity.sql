-- risk: additive
-- Installation identity and local recovery audit schema.

CREATE TABLE installation_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  installation_uuid TEXT NOT NULL UNIQUE
    CHECK (
      length(installation_uuid) = 36
      AND installation_uuid = lower(installation_uuid)
      AND substr(installation_uuid, 9, 1) = '-'
      AND substr(installation_uuid, 14, 1) = '-'
      AND substr(installation_uuid, 15, 1) = '4'
      AND substr(installation_uuid, 19, 1) = '-'
      AND substr(installation_uuid, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(installation_uuid, 24, 1) = '-'
      AND replace(installation_uuid, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  current_gateway_device_eui TEXT,
  previous_gateway_device_euis_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(previous_gateway_device_euis_json)
      AND json_type(previous_gateway_device_euis_json) = 'array'
    ),
  recovery_state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (recovery_state IN ('ACTIVE', 'RESTORING', 'RECONCILING', 'BLOCKED')),
  recovery_operation_uuid TEXT,
  restore_started_at TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (recovery_state = 'ACTIVE' AND recovery_operation_uuid IS NULL)
    OR (recovery_state <> 'ACTIVE' AND recovery_operation_uuid IS NOT NULL)
  )
);

ALTER TABLE sync_link_state ADD COLUMN installation_uuid TEXT;

CREATE TABLE installation_recovery_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_uuid TEXT NOT NULL,
  event_type TEXT NOT NULL,
  installation_uuid TEXT NOT NULL,
  gateway_device_eui TEXT,
  bundle_sha256 TEXT,
  detail_json TEXT
    CHECK (detail_json IS NULL OR json_valid(detail_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_installation_recovery_audit_operation
  ON installation_recovery_audit(operation_uuid, occurred_at, id);
