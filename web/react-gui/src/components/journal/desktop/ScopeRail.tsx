import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { JournalPlot, PlotGroup } from '../../../types/journal';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

export type ScopeSelection =
  | { kind: 'all' }
  | { kind: 'station'; stationCode: string }
  | { kind: 'group'; groupUuid: string }
  | { kind: 'plot'; plotUuid: string };

export type EntryStatusFilter = 'all' | 'draft' | 'final' | 'voided';

export interface ScopeRailFilters {
  activityCode: string;
  status: EntryStatusFilter;
  occurredFrom: string;
  occurredTo: string;
  campaignUuid: string;
  protocolCode: string;
}

export const DEFAULT_SCOPE_RAIL_FILTERS: ScopeRailFilters = {
  activityCode: '',
  status: 'all',
  occurredFrom: '',
  occurredTo: '',
  campaignUuid: '',
  protocolCode: '',
};

const STATUS_OPTIONS: readonly Exclude<EntryStatusFilter, 'all'>[] = ['draft', 'final', 'voided'];

export interface ScopeRailActivityOption {
  code: string;
}

export interface ScopeRailProps {
  plots: readonly JournalPlot[];
  activeGroups: readonly PlotGroup[];
  activities: readonly ScopeRailActivityOption[];
  sensorCountByZoneUuid: Readonly<Record<string, number>>;
  scope: ScopeSelection;
  onScopeChange: (scope: ScopeSelection) => void;
  filters: ScopeRailFilters;
  onFiltersChange: (filters: ScopeRailFilters) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

function humanPlotLabel(plot: JournalPlot): string {
  return plot.name?.trim() || plot.plot_code;
}

function matchesSearch(query: string, ...values: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => value?.toLowerCase().includes(needle));
}

function sumSensors(
  zoneUuids: Iterable<string>,
  sensorCountByZoneUuid: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const zoneUuid of new Set(zoneUuids)) {
    total += sensorCountByZoneUuid[zoneUuid] ?? 0;
  }
  return total;
}

export function ScopeRail({
  plots,
  activeGroups,
  activities,
  sensorCountByZoneUuid,
  scope,
  onScopeChange,
  filters,
  onFiltersChange,
  search,
  onSearchChange,
}: ScopeRailProps) {
  const { t } = useTranslation('journal');

  const visiblePlots = useMemo(
    () => plots.filter((plot) => plot.active === 1 && plot.deleted_at === null),
    [plots],
  );
  const plotByUuid = useMemo(
    () => new Map(visiblePlots.map((plot) => [plot.plot_uuid, plot])),
    [visiblePlots],
  );
  const stationCodes = useMemo(() => [...new Set(
    visiblePlots
      .map((plot) => plot.station_code)
      .filter((code): code is string => code !== null),
  )].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })), [visiblePlots]);
  const unstationedPlots = useMemo(
    () => visiblePlots.filter((plot) => plot.station_code === null),
    [visiblePlots],
  );
  const visibleGroups = useMemo(
    () => activeGroups.filter((group) => group.deleted_at === null),
    [activeGroups],
  );

  const sensorsLabel = (count: number): string => (count > 0
    ? t('workspace.scope.sensors', { count })
    : t('workspace.scope.noSensors'));

  const rowButtonClass = (selected: boolean) => [
    'flex w-full min-h-[44px] flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left text-sm transition-colors hover:border-[var(--primary)]',
    selected
      ? 'border-[var(--primary)] bg-[var(--secondary-bg)] text-[var(--text)]'
      : 'border-[var(--border)] bg-[var(--card)] text-[var(--text)]',
    FOCUS_RING,
  ].join(' ');

  const filteredStationCodes = stationCodes.filter((code) => matchesSearch(search, code));
  const filteredGroups = visibleGroups.filter((group) => matchesSearch(search, group.label));
  const filteredUnstationed = unstationedPlots.filter(
    (plot) => matchesSearch(search, humanPlotLabel(plot), plot.plot_code),
  );

  return (
    <nav
      aria-label={t('title')}
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
    >
      <div>
        <label htmlFor="journal-scope-search" className="mb-1 block text-sm font-bold text-[var(--text)]">
          {t('workspace.search')}
        </label>
        <input
          id="journal-scope-search"
          type="search"
          aria-label={t('workspace.search')}
          value={search}
          placeholder={t('workspace.searchPlaceholder')}
          onChange={(event) => onSearchChange(event.target.value)}
          className={`w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] outline-none ${FOCUS_RING}`}
        />
      </div>

      <fieldset className="space-y-3 border-t border-[var(--border)] pt-3">
        <legend className="sr-only">{t('filters.activity')}</legend>

        <label className="block text-sm font-bold text-[var(--text)]">
          {t('filters.activity')}
          <select
            aria-label={t('filters.activity')}
            value={filters.activityCode}
            onChange={(event) => onFiltersChange({ ...filters, activityCode: event.target.value })}
            className={`mt-1 w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
          >
            <option value="">{t('filters.allActivities')}</option>
            {activities.map((activity) => (
              <option key={activity.code} value={activity.code}>
                {t(`activity.${activity.code}`, activity.code)}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm font-bold text-[var(--text)]">
          {t('filters.status')}
          <select
            aria-label={t('filters.status')}
            value={filters.status}
            onChange={(event) => onFiltersChange({ ...filters, status: event.target.value as EntryStatusFilter })}
            className={`mt-1 w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
          >
            <option value="all">{t('filters.allStatuses')}</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{t(`row.status.${status}`)}</option>
            ))}
          </select>
        </label>

        <div className="flex gap-2">
          <label className="block min-w-0 flex-1 text-sm font-bold text-[var(--text)]">
            {t('filters.dateFrom')}
            <input
              type="date"
              aria-label={t('filters.dateFrom')}
              value={filters.occurredFrom}
              onChange={(event) => onFiltersChange({ ...filters, occurredFrom: event.target.value })}
              className={`mt-1 w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 text-[var(--text)] ${FOCUS_RING}`}
            />
          </label>
          <label className="block min-w-0 flex-1 text-sm font-bold text-[var(--text)]">
            {t('filters.dateTo')}
            <input
              type="date"
              aria-label={t('filters.dateTo')}
              value={filters.occurredTo}
              onChange={(event) => onFiltersChange({ ...filters, occurredTo: event.target.value })}
              className={`mt-1 w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 text-[var(--text)] ${FOCUS_RING}`}
            />
          </label>
        </div>

        <label className="block text-sm font-bold text-[var(--text)]">
          {t('filters.campaign')}
          <input
            type="text"
            aria-label={t('filters.campaign')}
            value={filters.campaignUuid}
            onChange={(event) => onFiltersChange({ ...filters, campaignUuid: event.target.value })}
            className={`mt-1 w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
          />
        </label>

        <label className="block text-sm font-bold text-[var(--text)]">
          {t('filters.protocol')}
          <input
            type="text"
            aria-label={t('filters.protocol')}
            value={filters.protocolCode}
            onChange={(event) => onFiltersChange({ ...filters, protocolCode: event.target.value })}
            className={`mt-1 w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
          />
        </label>
      </fieldset>

      <div className="space-y-3 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          aria-pressed={scope.kind === 'all'}
          onClick={() => onScopeChange({ kind: 'all' })}
          className={rowButtonClass(scope.kind === 'all')}
        >
          {t('filters.allPlots')}
        </button>

        {filteredStationCodes.length > 0 && (
          <section aria-label={t('workspace.scope.stations')} className="space-y-2">
            <h2 className="text-sm font-bold text-[var(--text-secondary)]">{t('workspace.scope.stations')}</h2>
            {filteredStationCodes.map((code) => {
              const stationPlots = visiblePlots.filter((plot) => plot.station_code === code);
              const zoneUuids = stationPlots
                .map((plot) => plot.zone_uuid)
                .filter((uuid): uuid is string => uuid != null);
              const selected = scope.kind === 'station' && scope.stationCode === code;

              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onScopeChange({ kind: 'station', stationCode: code })}
                  className={rowButtonClass(selected)}
                >
                  <span className="font-bold">{code}</span>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {t('where.rangePlotCount', { count: stationPlots.length })}
                    {' · '}
                    {sensorsLabel(sumSensors(zoneUuids, sensorCountByZoneUuid))}
                  </span>
                </button>
              );
            })}
          </section>
        )}

        {filteredGroups.length > 0 && (
          <section aria-label={t('workspace.scope.groups')} className="space-y-2">
            <h2 className="text-sm font-bold text-[var(--text-secondary)]">{t('workspace.scope.groups')}</h2>
            {filteredGroups.map((group) => {
              const zoneUuids = group.members
                .map((plotUuid) => plotByUuid.get(plotUuid)?.zone_uuid)
                .filter((uuid): uuid is string => uuid != null);
              const selected = scope.kind === 'group' && scope.groupUuid === group.group_uuid;

              return (
                <button
                  key={group.group_uuid}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onScopeChange({ kind: 'group', groupUuid: group.group_uuid })}
                  className={rowButtonClass(selected)}
                >
                  <span className="font-bold">{group.label}</span>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {t('group.members', { count: group.members.length })}
                    {' · '}
                    {sensorsLabel(sumSensors(zoneUuids, sensorCountByZoneUuid))}
                  </span>
                </button>
              );
            })}
          </section>
        )}

        {filteredUnstationed.length > 0 && (
          <section aria-label={t('where.unstationed')} className="space-y-2">
            <h2 className="text-sm font-bold text-[var(--text-secondary)]">{t('where.unstationed')}</h2>
            {filteredUnstationed.map((plot) => {
              const selected = scope.kind === 'plot' && scope.plotUuid === plot.plot_uuid;

              return (
                <button
                  key={plot.plot_uuid}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onScopeChange({ kind: 'plot', plotUuid: plot.plot_uuid })}
                  className={rowButtonClass(selected)}
                >
                  {humanPlotLabel(plot)}
                </button>
              );
            })}
          </section>
        )}
      </div>
    </nav>
  );
}
