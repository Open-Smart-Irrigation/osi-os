ALTER TABLE retention_prune_intents
  ADD COLUMN target_dev INTEGER CHECK (target_dev IS NULL OR target_dev >= 0);

ALTER TABLE retention_prune_intents
  ADD COLUMN target_ino INTEGER CHECK (
    (target_dev IS NULL AND target_ino IS NULL)
    OR (target_dev IS NOT NULL AND target_ino IS NOT NULL AND target_ino >= 0)
  );
