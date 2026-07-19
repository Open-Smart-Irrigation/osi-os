import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { IrrigationZone } from '../../../types/farming';
import type { JournalPlot, JournalVocabRow, PlotGroup } from '../../../types/journal';
import { DraftsQueue } from '../DraftsQueue';
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

export function JournalWorkspace({ plots, activeGroups, zones, activities }: JournalWorkspaceProps) {
  const { t } = useTranslation('journal');
  const [scope, setScope] = useState<ScopeSelection>({ kind: 'all' });
  const [filters, setFilters] = useState<ScopeRailFilters>(DEFAULT_SCOPE_RAIL_FILTERS);
  const [search, setSearch] = useState('');

  const sensorCountByZoneUuid = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const zone of zones) {
      const uuid = zoneUuidOf(zone);
      if (uuid) counts[uuid] = zoneDeviceCount(zone);
    }
    return counts;
  }, [zones]);

  return (
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-4 px-4 py-6 lg:grid-cols-[320px_1fr_360px]">
      <div className="flex flex-col gap-4">
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
        <DraftsQueue />
      </div>

      <section
        aria-label={t('title')}
        className="min-h-[240px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--text-secondary)]"
      >
        {t('workspace.table.placeholder')}
      </section>

      <aside className="min-h-[240px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--text-secondary)]">
        {t('workspace.detail.placeholder')}
      </aside>
    </div>
  );
}
