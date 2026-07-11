-- risk: additive
-- 0007: Fold analysis_views into the ordered-migration reference (Option B
-- Stage 0, issue #88; spec 2026-07-07-option-b-stage0-canonicalization-design.md section D(a)).
-- The table has existed on every live gateway via deploy.sh's
-- ensure_analysis_views_schema but was never in seed-blank.sql or a migration.
-- DDL below is semantically identical to the deploy.sh shape (live shape wins)
-- and idempotent (IF NOT EXISTS) so applyPending no-ops over the early-arrived
-- live table when a baselined device replays 0007.

CREATE TABLE IF NOT EXISTS analysis_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  owner_user_uuid TEXT,
  name TEXT NOT NULL,
  view_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
