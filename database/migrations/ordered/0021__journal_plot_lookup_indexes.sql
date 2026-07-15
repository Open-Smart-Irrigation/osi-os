-- risk: additive
-- 0021: Add plot-scoped journal lookup indexes for D10 duplicate and sticky queries.

CREATE INDEX IF NOT EXISTS idx_journal_entries_plot_duplicate
  ON journal_entries(plot_uuid, activity_code, occurred_start, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_plot_sticky
  ON journal_entries(author_principal_uuid, plot_uuid, recorded_at DESC, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_plot_time
  ON journal_entries (plot_uuid, occurred_start DESC, entry_uuid)
  WHERE deleted_at IS NULL;
