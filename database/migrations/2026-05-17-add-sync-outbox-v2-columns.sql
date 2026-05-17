-- 2026-05-17: WS2 sync_outbox v2 selective delivery columns.
-- This file documents intended schema; idempotent application is handled by
-- scripts/migrate-sync-outbox.js. Do not pipe directly to sqlite3.

ALTER TABLE sync_outbox ADD COLUMN rejected_at TEXT;
ALTER TABLE sync_outbox ADD COLUMN rejection_reason TEXT;
ALTER TABLE sync_outbox ADD COLUMN last_retryable_failure_at TEXT;
