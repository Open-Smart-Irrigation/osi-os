-- risk: additive
-- Bound sync progress reads by pending work and unresolved repair segments.
CREATE INDEX IF NOT EXISTS idx_sync_history_pending
  ON sync_history_dirty_keys(table_name, change_kind)
  WHERE peer_node='cloud' AND status='pending';
CREATE INDEX IF NOT EXISTS idx_sync_history_repair_unresolved
  ON sync_history_quarantine(table_name)
  WHERE peer_node='cloud' AND reason='manifest_repair_exhausted';
