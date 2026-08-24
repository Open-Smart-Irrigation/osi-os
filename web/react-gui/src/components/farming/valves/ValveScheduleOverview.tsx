import React from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import type { ValveSchedule, ValveSummary } from '../../../types/farming';
import { valvesAPI } from '../../../services/api';
import { sortWeekdaysForDisplay, weekdaysFromMask, windowEnd } from './valveState';

export interface ValveScheduleOverviewProps {
  valves: ValveSummary[];
  onOpenValve: (valve: ValveSummary) => void;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * One valve's schedules, fetched under the SAME SWR key `ValveScheduleDialog` uses
 * (`/api/valves/{eui}/schedules`). That is deliberate: SWR dedupes and caches by key, so the
 * overview and the dialog share one fetch — opening a valve's dialog after reading the
 * overview costs nothing, and editing there revalidates here.
 *
 * Fetching per valve rather than through a new fleet-wide endpoint keeps this frontend-only:
 * no flows.json route, no gateway deploy. The per-valve query is served from the
 * (device_eui) index and measured ~3 ms at 100-device scale, so the request count is the only
 * cost, and it is paid once per valve on one screen.
 */
const ValveScheduleRow: React.FC<{ valve: ValveSummary; onOpen: () => void }> = ({ valve, onOpen }) => {
  const { t } = useTranslation('valves');
  const td = t as Translate;
  const { data, error } = useSWR(
    `/api/valves/${valve.deviceEui}/schedules`,
    () => valvesAPI.schedules(valve.deviceEui),
  );

  const describe = (s: ValveSchedule): string => {
    if (s.kind === 'WEEKLY') {
      const days = sortWeekdaysForDisplay(weekdaysFromMask(s.weekdaysMask ?? 0))
        .map((d) => td(`weekdays.${d}`))
        .join(' ');
      const window = s.startTime ? `${s.startTime}–${windowEnd(s.startTime, s.durationMinutes)}` : '—';
      return `${days} · ${window} · ${s.durationMinutes} min`;
    }
    return `${s.fireAt ?? '—'} · ${s.durationMinutes} min`;
  };

  // A schedule the farmer switched off still exists and still matters — show it, marked off,
  // rather than hiding it and leaving them wondering where it went. Soft-deleted rows never
  // reach here: GET /api/valves/{eui}/schedules already filters them, and ValveSchedule
  // carries no deletedAt field as a result.
  const live = data?.schedules ?? [];

  return (
    <li className="border-t border-[var(--border)] py-3 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="truncate text-left text-sm font-semibold text-[var(--text)] underline decoration-transparent transition hover:decoration-inherit"
        >
          {valve.name}
        </button>
        <span className="shrink-0 text-xs text-[var(--text-tertiary)]">
          {valve.zoneName ?? t('unassignedZone')}
        </span>
      </div>

      {error && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('scheduleDialog.loadFailed')}</p>}
      {!error && !data && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('overview.loading')}</p>}
      {!error && data && live.length === 0 && (
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('noSchedule')}</p>
      )}

      {live.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {live.map((s) => (
            <li key={s.scheduleUuid} className="text-xs text-[var(--text-secondary)]">
              <span className="font-mono">{describe(s)}</span>
              {s.label && <span className="text-[var(--text-tertiary)]"> · {s.label}</span>}
              {!s.enabled && <span className="text-[var(--text-tertiary)]"> · {t('overview.off')}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

export const ValveScheduleOverview: React.FC<ValveScheduleOverviewProps> = ({ valves, onOpenValve }) => {
  const { t } = useTranslation('valves');
  if (valves.length === 0) return null;

  return (
    <section className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold text-[var(--text)]">{t('overview.title')}</h3>
      <ul className="mt-2">
        {valves.map((valve) => (
          <ValveScheduleRow key={valve.deviceEui} valve={valve} onOpen={() => onOpenValve(valve)} />
        ))}
      </ul>
    </section>
  );
};

export default ValveScheduleOverview;
