import { useTranslation } from 'react-i18next';

import type { JournalPlot, PlotGroup } from '../../../types/journal';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';

export interface PlotGroupChipsProps {
  groups: readonly PlotGroup[];
  plots: readonly JournalPlot[];
  selectedPlotUuids: ReadonlySet<string>;
  onSelectGroup: (group: PlotGroup) => void;
  onTogglePlot: (plotUuid: string) => void;
  onEditGroup: (group: PlotGroup) => void;
  disabled?: boolean;
}

function plotLabel(plot: JournalPlot): string {
  return plot.name?.trim() || plot.plot_code;
}

export function PlotGroupChips({
  groups,
  plots,
  selectedPlotUuids,
  onSelectGroup,
  onTogglePlot,
  onEditGroup,
  disabled = false,
}: PlotGroupChipsProps) {
  const { t } = useTranslation('journal');
  const plotByUuid = new Map(
    plots
      .filter((plot) => plot.active === 1 && plot.deleted_at === null)
      .map((plot) => [plot.plot_uuid, plot]),
  );
  const visibleGroups = groups.filter((group) => group.deleted_at === null && group.resolved_at === null);

  if (visibleGroups.length === 0) return null;

  return (
    <section aria-label={t('group.members', { defaultValue: 'Plot groups' })} className="w-full space-y-3">
      <div className="flex flex-wrap gap-3">
        {visibleGroups.map((group) => {
          const validMembers = group.members
            .map((plotUuid) => plotByUuid.get(plotUuid))
            .filter((plot): plot is JournalPlot => plot !== undefined);
          const hasStaleMembers = validMembers.length !== group.members.length;
          const selected = !hasStaleMembers
            && validMembers.length > 0
            && validMembers.every((plot) => selectedPlotUuids.has(plot.plot_uuid));

          return (
            <div key={group.group_uuid} className="min-w-0 max-w-full rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-label={group.label}
                  aria-pressed={selected}
                  disabled={disabled}
                  onClick={() => onSelectGroup(group)}
                  className={`flex ${TOUCH_CONTROL} min-w-0 max-w-full flex-1 items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left font-bold text-[var(--text)] hover:border-[var(--primary)] ${FOCUS_RING}`}
                >
                  <span className="min-w-0 truncate">{group.label}</span>
                  <span aria-hidden="true" className="shrink-0 text-sm text-[var(--text-secondary)]">{group.members.length}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${t('where.editGroup', { defaultValue: 'Edit group' })} ${group.label}`}
                  disabled={disabled}
                  onClick={() => onEditGroup(group)}
                  className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-bold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
                >
                  {t('where.editGroup', { defaultValue: 'Edit group' })}
                  <span className="sr-only"> {group.label}</span>
                </button>
              </div>

              <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={group.label}>
                {validMembers.map((plot) => (
                  <button
                    key={plot.plot_uuid}
                    type="button"
                    aria-pressed={selectedPlotUuids.has(plot.plot_uuid)}
                    disabled={disabled}
                    onClick={() => onTogglePlot(plot.plot_uuid)}
                    className={`rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING} ${selectedPlotUuids.has(plot.plot_uuid) ? 'bg-[var(--secondary-bg)]' : 'bg-[var(--surface)]'}`}
                  >
                    {plotLabel(plot)}
                  </button>
                ))}
              </div>
              {hasStaleMembers && (
                <p role="alert" className="mt-2 text-sm font-semibold text-[var(--error-text)]">
                  {t('group.unavailableMembers', { defaultValue: 'Some group members are unavailable.' })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
