-- 2026-05-17: WS3 applied_commands retry column migration.
-- This file documents intended schema; idempotent application is handled by
-- scripts/migrate-applied-commands.js and scripts/repair-pi-schema.js.
-- Do not pipe directly to sqlite3.

ALTER TABLE applied_commands ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE applied_commands ADD COLUMN last_error TEXT;
ALTER TABLE applied_commands ADD COLUMN last_ack_attempt_at TEXT;
ALTER TABLE applied_commands ADD COLUMN expires_at TEXT;
