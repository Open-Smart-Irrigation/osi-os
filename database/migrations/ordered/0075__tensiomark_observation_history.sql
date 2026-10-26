-- risk: additive
-- 0075: Queue corrections to native Tensiomark observation evidence.
CREATE TRIGGER IF NOT EXISTS trg_sync_tensiomark_observations_dirty_au
AFTER UPDATE ON tensiomark_observations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
AND COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') <> ''
BEGIN
  INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, change_kind, source_row_id, changed_at)
  VALUES(
    'cloud',
    'tensiomark_observations',
    'TENSIOMARK_OBSERVATION|' || COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL), (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'), '') || '|' || NEW.id,
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
