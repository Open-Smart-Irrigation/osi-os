-- risk: additive
-- Durable history cursor promotion, manifest tombstones, and dirty-key coverage.

ALTER TABLE sync_history_cursors ADD COLUMN snapshot_high_key TEXT;
ALTER TABLE sync_history_cursors ADD COLUMN shadow_completed_at TEXT;
ALTER TABLE sync_history_cursors ADD COLUMN durable_enabled_at TEXT;

ALTER TABLE sync_history_segments
  ADD COLUMN tombstone_count INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER trg_sync_irrigation_events_dirty_ai
AFTER INSERT ON irrigation_events
FOR EACH ROW
WHEN NEW.event_uuid IS NOT NULL
  AND trim(NEW.event_uuid) <> ''
  AND EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
BEGIN
  INSERT INTO sync_history_dirty_keys(
    peer_node, table_name, row_key, change_kind, source_row_id, changed_at
  ) VALUES (
    'cloud',
    'irrigation_events',
    'IRRIGATION_EVENT|' || NEW.event_uuid || '|' || NEW.id,
    'correction',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_irrigation_events_dirty_au
AFTER UPDATE ON irrigation_events
FOR EACH ROW
WHEN NEW.event_uuid IS NOT NULL
  AND trim(NEW.event_uuid) <> ''
  AND EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
BEGIN
  INSERT INTO sync_history_dirty_keys(
    peer_node, table_name, row_key, change_kind, source_row_id, changed_at
  ) VALUES (
    'cloud',
    'irrigation_events',
    'IRRIGATION_EVENT|' || NEW.event_uuid || '|' || NEW.id,
    'correction',
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    source_row_id = excluded.source_row_id,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_valve_actuation_dirty_ai
AFTER INSERT ON valve_actuation_expectations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(
    peer_node, table_name, row_key, change_kind, changed_at
  ) VALUES (
    'cloud',
    'valve_actuation_expectations',
    'VALVE_ACTUATION|' ||
      COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), ''),
        'UNKNOWN'
      ) || '|' || NEW.expectation_id,
    'correction',
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;

CREATE TRIGGER trg_sync_valve_actuation_dirty_au
AFTER UPDATE ON valve_actuation_expectations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_history_dirty_keys(
    peer_node, table_name, row_key, change_kind, changed_at
  ) VALUES (
    'cloud',
    'valve_actuation_expectations',
    'VALVE_ACTUATION|' ||
      COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), ''),
        'UNKNOWN'
      ) || '|' || NEW.expectation_id,
    'correction',
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  )
  ON CONFLICT(peer_node, table_name, row_key) DO UPDATE SET
    change_kind = excluded.change_kind,
    changed_at = excluded.changed_at,
    status = 'pending',
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL;
END;
