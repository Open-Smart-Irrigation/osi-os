import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  HistoryCalendar,
  HistoryCalendarDay,
  HistoryCalendarMarker,
  HistoryCardType,
  HistoryCalendarState,
} from '../../history/types';

interface CalendarViewProps {
  cardType: HistoryCardType;
  calendar: HistoryCalendar | null | undefined;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

const stateTone: Record<HistoryCalendarState, string> = {
  dry_stress: 'border-amber-400 bg-amber-50 text-amber-950',
  optimal: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  wet_excess: 'border-sky-300 bg-sky-50 text-sky-950',
  mixed: 'border-purple-300 bg-purple-50 text-purple-950',
  normal_growth: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  reduced_growth: 'border-amber-300 bg-amber-50 text-amber-950',
  high_shrinkage_stress: 'border-amber-400 bg-amber-50 text-amber-950',
  incomplete_night_recovery: 'border-amber-400 bg-amber-50 text-amber-950',
  normal: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  heat_stress: 'border-red-300 bg-red-50 text-red-950',
  cold_stress: 'border-sky-300 bg-sky-50 text-sky-950',
  high_humidity: 'border-cyan-300 bg-cyan-50 text-cyan-950',
  rain_day: 'border-blue-300 bg-blue-50 text-blue-950',
  no_irrigation: 'border-slate-300 bg-slate-50 text-slate-900',
  irrigation_event: 'border-blue-300 bg-blue-50 text-blue-950',
  high_irrigation_frequency: 'border-amber-400 bg-amber-50 text-amber-950',
  possible_ineffective_irrigation: 'border-amber-400 bg-amber-50 text-amber-950',
  manual_override: 'border-violet-300 bg-violet-50 text-violet-950',
  offline: 'border-red-300 bg-red-50 text-red-950',
  no_data: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)]',
};

function translateParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return params && typeof params === 'object' ? params : {};
}

function formatDate(date: string): string {
  return date;
}

function stateLabel(t: HistoryTranslate, state: HistoryCalendarState): string {
  return t(`history.calendar.state.${state}`);
}

function summaryLabel(t: HistoryTranslate, day: HistoryCalendarDay, cardType: HistoryCardType): string {
  if (day.summary?.key) return t(day.summary.key, translateParams(day.summary.params));
  return t(`history.calendar.summary.${cardType}.${day.state}`, translateParams(day.metrics));
}

function markerLabel(t: HistoryTranslate, marker: HistoryCalendarMarker): string {
  return t(marker.labelKey, translateParams(marker.params));
}

function coverageLabel(t: HistoryTranslate, day: HistoryCalendarDay): string {
  if (day.coveragePct === null || day.coveragePct === undefined) return t('history.metadata.coverageUnknown');
  return t('history.metadata.coverageKnown', { coverage: Math.round(day.coveragePct) });
}

export const CalendarView: React.FC<CalendarViewProps> = ({ cardType, calendar }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const days = Array.isArray(calendar?.days) ? calendar.days : [];

  if (days.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.calendar.title')}
        className="mt-4 flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6 text-center"
      >
        <p className="text-sm font-semibold text-[var(--text)]">{t('history.calendar.emptyTitle')}</p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.calendar.title')}
      className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-[var(--text)]">{t('history.calendar.title')}</h3>
        <span className="text-xs font-semibold text-[var(--text-tertiary)]">{calendar?.timezone || 'UTC'}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {days.map((day) => (
          <article
            key={day.date}
            className={`min-h-[9rem] rounded-md border p-3 ${stateTone[day.state] ?? stateTone.no_data}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-bold">{formatDate(day.date)}</p>
              <p className="text-xs font-semibold">{coverageLabel(t, day)}</p>
            </div>
            <p className="mt-3 text-sm font-semibold">{stateLabel(t, day.state)}</p>
            <p className="mt-1 text-xs leading-5">{summaryLabel(t, day, cardType)}</p>
            {Array.isArray(day.markers) && day.markers.length > 0 && (
              <ul className="mt-2 space-y-1">
                {day.markers.map((marker, index) => (
                  <li key={`${marker.labelKey}-${index}`} className="text-xs font-medium">
                    {markerLabel(t, marker)}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </section>
  );
};
