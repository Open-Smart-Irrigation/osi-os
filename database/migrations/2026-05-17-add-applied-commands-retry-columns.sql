-- 2026-05-17: WS3 applied_commands retry column migration.
-- Apply once with sqlite3, or use scripts/migrate-applied-commands.js for
-- idempotent live repair against DBs that may already have some columns.

ALTER TABLE applied_commands ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE applied_commands ADD COLUMN last_error TEXT;
ALTER TABLE applied_commands ADD COLUMN last_ack_attempt_at TEXT;
ALTER TABLE applied_commands ADD COLUMN expires_at TEXT;
