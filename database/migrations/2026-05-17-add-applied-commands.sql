-- 2026-05-17: WS3 edge applied_commands ledger.
-- Deduplicates command replay by command_id and effect_key.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS applied_commands (
    command_id          TEXT PRIMARY KEY,
    device_eui          TEXT NOT NULL,
    command_type        TEXT NOT NULL,
    effect_key          TEXT,
    applied_at          TEXT NOT NULL,
    result              TEXT NOT NULL,
    result_detail       TEXT,
    originator          TEXT
);

CREATE INDEX IF NOT EXISTS idx_applied_commands_device_eui
    ON applied_commands(device_eui);

CREATE INDEX IF NOT EXISTS idx_applied_commands_effect_key
    ON applied_commands(effect_key);

CREATE INDEX IF NOT EXISTS idx_applied_commands_applied_at
    ON applied_commands(applied_at);
