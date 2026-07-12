-- risk: additive
-- 0013: Shadow diff table for LSN50 narrow-waist validation (3.3/DD7).
-- Captures per-field divergence between the old lsn50-sql-fn path and
-- the new normalize+writer path. Local-only, not synced.

CREATE TABLE IF NOT EXISTS lsn50_shadow_diff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  diff_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
