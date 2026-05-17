-- 2026-05-17: WS2 sync_outbox v2 selective delivery columns.
-- Idempotent; safe to re-run.

ALTER TABLE sync_outbox ADD COLUMN rejected_at TEXT;
ALTER TABLE sync_outbox ADD COLUMN rejection_reason TEXT;
ALTER TABLE sync_outbox ADD COLUMN last_retryable_failure_at TEXT;
