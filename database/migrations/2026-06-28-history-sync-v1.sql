CREATE TABLE IF NOT EXISTS sync_link_state (
  peer_node TEXT PRIMARY KEY,
  linked INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  cloud_user_id TEXT,
  gateway_device_eui TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_history_cursors (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'backfill',
  snapshot_high_id INTEGER,
  last_acked_id INTEGER,
  last_acked_key TEXT,
  last_shadow_acked_id INTEGER,
  last_shadow_acked_key TEXT,
  last_shadow_error TEXT,
  backfill_started_at TEXT,
  backfill_completed_at TEXT,
  last_batch_id TEXT,
  last_batch_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name)
);

CREATE TABLE IF NOT EXISTS sync_history_dirty_keys (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  change_kind TEXT NOT NULL DEFAULT 'correction',
  source_row_id INTEGER,
  changed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (peer_node, table_name, row_key)
);

CREATE TABLE IF NOT EXISTS sync_history_segments (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  hash_version INTEGER NOT NULL,
  canonical_row_count INTEGER NOT NULL,
  syncable_row_count INTEGER NOT NULL,
  syncable_payload_hash TEXT NOT NULL,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  covered_max_id INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (peer_node, table_name, segment_key, hash_version)
);

CREATE TABLE IF NOT EXISTS sync_history_quarantine (
  peer_node TEXT NOT NULL,
  table_name TEXT NOT NULL,
  history_key TEXT NOT NULL,
  payload_hash TEXT,
  reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (peer_node, table_name, history_key)
);

ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT;
UPDATE irrigation_events
SET event_uuid = 'irrig-' || COALESCE(
  (SELECT gateway_device_eui FROM irrigation_zones WHERE irrigation_zones.id = irrigation_events.irrigation_zone_id AND deleted_at IS NULL),
  lower(hex(randomblob(8)))
) || '-' || printf('%012d', id)
WHERE event_uuid IS NULL OR event_uuid = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_irrigation_events_event_uuid
  ON irrigation_events(event_uuid);

DROP TRIGGER IF EXISTS trg_sync_irrigation_events_uuid_ai;
CREATE TRIGGER trg_sync_irrigation_events_uuid_ai
AFTER INSERT ON irrigation_events
FOR EACH ROW
WHEN NEW.event_uuid IS NULL OR NEW.event_uuid = ''
BEGIN
  UPDATE irrigation_events
  SET event_uuid = 'irrig-' || COALESCE(
    (SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'),
    lower(hex(randomblob(8)))
  ) || '-' || printf('%012d', NEW.id)
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_dp_irrigation_events_outbox_ai;
DROP TRIGGER IF EXISTS trg_dp_irrigation_events_outbox_au_event_uuid;

CREATE TRIGGER trg_dp_irrigation_events_outbox_ai
AFTER INSERT ON irrigation_events
FOR EACH ROW
WHEN NEW.event_uuid IS NOT NULL
 AND NEW.event_uuid <> ''
 AND EXISTS (
   SELECT 1 FROM sync_link_state
    WHERE peer_node = 'cloud' AND linked = 1
 )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_EVENT',
    NEW.event_uuid,
    'IRRIGATION_EVENT_APPENDED',
    json_object(
      'event_uuid',          NEW.event_uuid,
      'event_id',            NEW.id,
      'user_id',             NEW.user_id,
      'irrigation_zone_id',  NEW.irrigation_zone_id,
      'zone_uuid',           (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),
      'gateway_device_eui',  COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),(SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),
      'action',              NEW.action,
      'reason',              NEW.reason,
      'aggregate_kpa',       NEW.aggregate_kpa,
      'threshold_kpa',       NEW.threshold_kpa,
      'duration_minutes',    NEW.duration_minutes,
      'valve_deveui',        NEW.valve_deveui,
      'payload_json',        NEW.payload_json
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),(SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'))
  );
END;

CREATE TRIGGER trg_dp_irrigation_events_outbox_au_event_uuid
AFTER UPDATE OF event_uuid ON irrigation_events
FOR EACH ROW
WHEN (OLD.event_uuid IS NULL OR OLD.event_uuid = '')
 AND NEW.event_uuid IS NOT NULL
 AND NEW.event_uuid <> ''
 AND EXISTS (
   SELECT 1 FROM sync_link_state
    WHERE peer_node = 'cloud' AND linked = 1
 )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_EVENT',
    NEW.event_uuid,
    'IRRIGATION_EVENT_APPENDED',
    json_object(
      'event_uuid',          NEW.event_uuid,
      'event_id',            NEW.id,
      'user_id',             NEW.user_id,
      'irrigation_zone_id',  NEW.irrigation_zone_id,
      'zone_uuid',           (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),
      'gateway_device_eui',  COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),(SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),
      'action',              NEW.action,
      'reason',              NEW.reason,
      'aggregate_kpa',       NEW.aggregate_kpa,
      'threshold_kpa',       NEW.threshold_kpa,
      'duration_minutes',    NEW.duration_minutes,
      'valve_deveui',        NEW.valve_deveui,
      'payload_json',        NEW.payload_json
    ),
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.irrigation_zone_id AND deleted_at IS NULL),(SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'))
  );
END;
