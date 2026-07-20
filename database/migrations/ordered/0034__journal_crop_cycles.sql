-- risk: additive
-- 0025: Crop-cycle lifecycle tables (Slice D / D1.1, spec
-- docs/superpowers/specs/2026-07-20-journal-capture-streamlining-design.md §5.1).
-- Seeding a plot opens a crop cycle (crop + variety); later activities on that
-- plot inherit the crop read-only; harvest/reseed/manual close it. Per-plot
-- membership carries the CLOSE state so partial harvest and per-plot re-seed
-- are first-class; a plot's cycle is "open" when ends_on IS NULL.

CREATE TABLE IF NOT EXISTS journal_crop_cycles (
  cycle_uuid TEXT PRIMARY KEY,
  crop_code TEXT NOT NULL REFERENCES journal_vocab(code),   -- kind='choice', parent 'attr.crop'
  variety TEXT,
  group_uuid TEXT REFERENCES journal_plot_groups(group_uuid),  -- cohort that opened it, nullable
  opened_by_entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid),
  starts_on TEXT NOT NULL,                                  -- = seeding occurred date (local)
  gateway_device_eui TEXT,
  created_by_principal_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Per-plot membership carries the CLOSE state, so partial harvest (D10) and
-- per-plot re-seed (D9) are first-class. A plot's cycle is "open" when ends_on IS NULL.
CREATE TABLE IF NOT EXISTS journal_crop_cycle_plots (
  cycle_uuid TEXT NOT NULL REFERENCES journal_crop_cycles(cycle_uuid) ON DELETE CASCADE,
  plot_uuid  TEXT NOT NULL REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  ends_on TEXT,                                             -- NULL = open on this plot
  closed_by_entry_uuid TEXT REFERENCES journal_entries(entry_uuid),
  close_reason TEXT CHECK (close_reason IN ('harvest','reseed','manual')),
  PRIMARY KEY (cycle_uuid, plot_uuid)
);
CREATE INDEX IF NOT EXISTS idx_ccp_plot_open ON journal_crop_cycle_plots(plot_uuid) WHERE ends_on IS NULL;
