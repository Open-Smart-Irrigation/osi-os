-- risk: additive
-- Covers the size-cap eviction query: WHERE aggregate_type IN (...)
-- ORDER BY (delivered_at IS NULL), occurred_at
CREATE INDEX IF NOT EXISTS idx_sync_outbox_eviction
  ON sync_outbox(aggregate_type, delivered_at, occurred_at);
