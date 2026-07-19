import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { IrrigationZone } from '../../../types/farming';
import type { EntryListFilters, JournalPlot, JournalVocabRow, PlotGroup } from '../../../types/journal';
import { EntryTable } from './EntryTable';
import {
  DEFAULT_SCOPE_RAIL_FILTERS,
  ScopeRail,
  type ScopeRailFilters,
  type ScopeSelection,
} from './ScopeRail';

export interface JournalWorkspaceProps {
  plots: readonly JournalPlot[];
  activeGroups: readonly PlotGroup[];
  zones: readonly IrrigationZone[];
  activities: readonly JournalVocabRow[];
}

type ZoneLike = Pick<IrrigationZone, 'zone_uuid' | 'zoneUuid' | 'device_count' | 'deviceCount'>;

function zoneUuidOf(zone: ZoneLike): string | null {
  return zone.zone_uuid ?? zone.zoneUuid ?? null;
}

function zoneDeviceCount(zone: ZoneLike): number {
  return zone.device_count ?? zone.deviceCount ?? 0;
}

// Combines the rail's scope selection and filter fields into the
// EntryListFilters the shipped `/api/journal/entries` (and export) routes
// accept, so the entry table's active scope is exactly what the rail shows.
//
// Station and group scope span multiple plots, but the edge API only accepts
// a single plot_uuid/zone_uuid filter (osi-journal/api.js
// `normalizeEntryFilters`) — there is no multi-plot filter to send without
// inventing a new endpoint. Narrowing the entry list to a station's or
// group's plots is left unfiltered here as a known, deliberate gap; only
// single-plot scope narrows the query.
function toEntryListFilters(scope: ScopeSelection, filters: ScopeRailFilters): EntryListFilters {
  const result: EntryListFilters = { status: filters.status };
  if (scope.kind === 'plot') result.plot_uuid = scope.plotUuid;
  if (filters.activityCode) result.activity_code = filters.activityCode;
  if (filters.occurredFrom) result.occurred_from = filters.occurredFrom;
  if (filters.occurredTo) result.occurred_to = filters.occurredTo;
  if (filters.campaignUuid) result.campaign_uuid = filters.campaignUuid;
  if (filters.protocolCode) result.protocol_code = filters.protocolCode;
  return result;
}

export function JournalWorkspace({ plots, activeGroups, zones, activities }: JournalWorkspaceProps) {
  const { t } = useTranslation('journal');
  const [scope, setScope] = useState<ScopeSelection>({ kind: 'all' });
  const [filters, setFilters] = useState<ScopeRailFilters>(DEFAULT_SCOPE_RAIL_FILTERS);
  const [search, setSearch] = useState('');
  const [selectedEntryUuid, setSelectedEntryUuid] = useState<string | null>(null);

  const sensorCountByZoneUuid = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const zone of zones) {
      const uuid = zoneUuidOf(zone);
      if (uuid) counts[uuid] = zoneDeviceCount(zone);
    }
    return counts;
  }, [zones]);

  const entryListFilters = useMemo(
    () => toEntryListFilters(scope, filters),
    [scope, filters],
  );

  // Station and group scope cannot be sent to the shipped single-plot_uuid
  // API (see toEntryListFilters above), so the list and every export are
  // silently unfiltered for those two scopes. Surface that honestly instead
  // of leaving it as an undisclosed gap.
  const scopeNotNarrowed = scope.kind === 'station' || scope.kind === 'group';

  return (
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-4 px-4 py-6 lg:grid-cols-[320px_1fr_360px]">
      <ScopeRail
        plots={plots}
        activeGroups={activeGroups}
        activities={activities}
        sensorCountByZoneUuid={sensorCountByZoneUuid}
        scope={scope}
        onScopeChange={setScope}
        filters={filters}
        onFiltersChange={setFilters}
        search={search}
        onSearchChange={setSearch}
      />

      <div className="flex h-full min-h-0 flex-col gap-2">
        {scopeNotNarrowed && (
          <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text-secondary)]">
            {t('workspace.table.scopeNotNarrowed')}
          </p>
        )}
        <div className="min-h-0 flex-1">
          <EntryTable
            filters={entryListFilters}
            plots={plots}
            selectedEntryUuid={selectedEntryUuid}
            onSelectEntry={setSelectedEntryUuid}
          />
        </div>
      </div>

      <aside className="min-h-[240px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--text-secondary)]">
        {t('workspace.detail.placeholder')}
      </aside>
    </div>
  );
}
