-- risk: additive
-- 0020: Persist private owner scope on journal plots and plot groups.

ALTER TABLE journal_plots ADD COLUMN owner_user_uuid TEXT;
ALTER TABLE journal_plot_groups ADD COLUMN owner_user_uuid TEXT;

CREATE INDEX IF NOT EXISTS idx_journal_plots_owner_gateway
  ON journal_plots(owner_user_uuid, gateway_device_eui, deleted_at, zone_uuid, active);
CREATE INDEX IF NOT EXISTS idx_journal_plot_groups_owner_gateway
  ON journal_plot_groups(owner_user_uuid, gateway_device_eui, deleted_at, resolved_at);
