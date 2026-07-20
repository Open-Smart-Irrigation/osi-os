-- risk: additive
-- 0024: Add journal_plot_settings.context_json (Slice BC / R1 Part 2) — the
-- plot's static context values (block/bed/row, structure/compartment,
-- experimental unit, ... per the active layout's static_context_fields),
-- carried at the plot level and rendered read-only on each capture entry
-- instead of forcing them as a per-entry required input.

ALTER TABLE journal_plot_settings ADD COLUMN context_json TEXT;
