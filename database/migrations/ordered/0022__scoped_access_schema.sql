-- risk: additive
-- 0022: Scoped multi-user access (AgroLink) — roles, grants, emit gate,
-- migration-owned outbox triggers. Spec:
-- docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md §5.
-- All triggers here are migration-owned: registered in
-- scripts/verify-runtime-schema-parity.js MIGRATION_OWNED_TRIGGERS and never
-- added to the frozen sync-init-fn boot node.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'researcher'
  CHECK (role IN ('admin','researcher','viewer'));
ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_zone_assignments (
  assignment_uuid       TEXT PRIMARY KEY,
  user_uuid             TEXT NOT NULL,
  zone_uuid             TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui    TEXT,
  sync_version          INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT,
  deleted_at            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_zone_active
  ON user_zone_assignments(user_uuid, zone_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_zone_by_zone
  ON user_zone_assignments(zone_uuid) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_plot_assignments (
  assignment_uuid       TEXT PRIMARY KEY,
  user_uuid             TEXT NOT NULL,
  plot_uuid             TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui    TEXT,
  sync_version          INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT,
  deleted_at            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_plot_active
  ON user_plot_assignments(user_uuid, plot_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_plot_by_plot
  ON user_plot_assignments(plot_uuid) WHERE deleted_at IS NULL;

-- Single-row emit gate: Phase A installs schema with producers OFF.
-- Phase E flips enabled=1 only after the cloud accepts the new aggregates.
CREATE TABLE IF NOT EXISTS scoped_access_emit (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO scoped_access_emit (id, enabled) VALUES (1, 0);

-- Grant triggers: upsert on insert, delete on tombstone.
CREATE TRIGGER IF NOT EXISTS trg_dp_user_zone_assign_outbox_ai
AFTER INSERT ON user_zone_assignments
FOR EACH ROW
WHEN (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_ZONE_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_ZONE_ASSIGNMENT_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'zone_uuid', NEW.zone_uuid,
      'assigned_by_user_uuid', NEW.assigned_by_user_uuid,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.created_at
    ),
    NEW.sync_version,
    NEW.created_at,
    NEW.gateway_device_eui
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_user_zone_assign_outbox_au
AFTER UPDATE OF deleted_at ON user_zone_assignments
FOR EACH ROW
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_ZONE_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_ZONE_ASSIGNMENT_DELETED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'zone_uuid', NEW.zone_uuid,
      'deleted_at', NEW.deleted_at,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.deleted_at
    ),
    NEW.sync_version,
    NEW.deleted_at,
    NEW.gateway_device_eui
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_user_plot_assign_outbox_ai
AFTER INSERT ON user_plot_assignments
FOR EACH ROW
WHEN (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_PLOT_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_PLOT_ASSIGNMENT_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'plot_uuid', NEW.plot_uuid,
      'assigned_by_user_uuid', NEW.assigned_by_user_uuid,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.created_at
    ),
    NEW.sync_version,
    NEW.created_at,
    NEW.gateway_device_eui
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_user_plot_assign_outbox_au
AFTER UPDATE OF deleted_at ON user_plot_assignments
FOR EACH ROW
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_PLOT_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_PLOT_ASSIGNMENT_DELETED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'plot_uuid', NEW.plot_uuid,
      'deleted_at', NEW.deleted_at,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.deleted_at
    ),
    NEW.sync_version,
    NEW.deleted_at,
    NEW.gateway_device_eui
  );
END;

-- USER aggregate, three arms (spec §5.2: sibling-trigger UPDATEs are
-- invisible to other AFTER INSERT triggers, so no bare-INSERT arm may rely
-- on trg_sync_users_uuid_ai having filled user_uuid).
-- user_uuid is treated as write-once: this arm intentionally only emits on
-- the unset->assigned transition (OLD null/empty -> NEW set), never on a
-- no-op rewrite (OLD=NEW, both non-empty) -- a no-op would otherwise re-emit
-- USER_UPSERTED at the same sync_version with a different payload
-- occurred_at, which the cloud watermark rejects terminally as
-- equal_version_payload_conflict (same issue-#10 class as the literal-0 fix).
-- A dedicated uuid-immutability guard (reject any user_uuid change post
-- first-assignment) is left as a follow-up; this arm only controls emission.
CREATE TRIGGER IF NOT EXISTS trg_dp_users_outbox_uuid_au
AFTER UPDATE OF user_uuid ON users
FOR EACH ROW
WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != ''
AND (OLD.user_uuid IS NULL OR OLD.user_uuid = '')
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER',
    NEW.user_uuid,
    'USER_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'user_uuid', NEW.user_uuid,
      'username', NEW.username,
      'role', NEW.role,
      'disabled_at', NEW.disabled_at,
      'sync_version', NEW.sync_version,
      'gateway_device_eui', (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'),
      'occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_users_outbox_ai
AFTER INSERT ON users
FOR EACH ROW
WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != ''
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER',
    NEW.user_uuid,
    'USER_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'user_uuid', NEW.user_uuid,
      'username', NEW.username,
      'role', NEW.role,
      'disabled_at', NEW.disabled_at,
      'sync_version', NEW.sync_version,
      'gateway_device_eui', (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'),
      'occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_users_outbox_role_au
AFTER UPDATE OF role, disabled_at ON users
FOR EACH ROW
WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != ''
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER',
    NEW.user_uuid,
    'USER_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'user_uuid', NEW.user_uuid,
      'username', NEW.username,
      'role', NEW.role,
      'disabled_at', NEW.disabled_at,
      'sync_version', NEW.sync_version,
      'gateway_device_eui', (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'),
      'occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
  );
END;
