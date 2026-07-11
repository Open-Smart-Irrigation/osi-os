import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatHistoryCalendarMonthLabel, isFutureCalendarDate, latestCalendarMonth } from '../../../history/calendarMonth';
import { soilStatusVisual } from '../../../history/soilStatus';
import type {
  HistoryCalendar,
  HistoryCalendarDay,
  HistoryCalendarMarker,
  HistoryCalendarState,
  HistoryCardType,
} from '../../../history/types';

export interface HistoryCalendarDateSelection {
  kind: 'date';
  date: string;
  timestamp: string;
  day: HistoryCalendarDay;
}

interface HistoryMonthCalendarViewProps {
  cardType: HistoryCardType;
  calendar: HistoryCalendar | null | undefined;
  onInspectDate?: (selection: HistoryCalendarDateSelection) => void;
  selectedDate?: string | null;
  todayIso?: string;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

type CalendarCell =
  | { kind: 'blank'; key: string }
  | { kind: 'day'; key: string; date: string; dayOfMonth: number; day: HistoryCalendarDay };

const WEEKDAY_KEYS = [
  'history.calendar.weekday.mon',
  'history.calendar.weekday.tue',
  'history.calendar.weekday.wed',
  'history.calendar.weekday.thu',
  'history.calendar.weekday.fri',
  'history.calendar.weekday.sat',
  'history.calendar.weekday.sun',
] as const;

const stateTone: Record<HistoryCalendarState, string> = {
  dry_stress: 'border-amber-300 bg-amber-50 text-amber-950',
  optimal: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  wet_excess: 'border-sky-300 bg-sky-50 text-sky-950',
  mixed: 'border-purple-300 bg-purple-50 text-purple-950',
  normal_growth: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  reduced_growth: 'border-amber-300 bg-amber-50 text-amber-950',
  high_shrinkage_stress: 'border-red-300 bg-red-50 text-red-950',
  incomplete_night_recovery: 'border-orange-300 bg-orange-50 text-orange-950',
  normal: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  heat_stress: 'border-red-300 bg-red-50 text-red-950',
  cold_stress: 'border-sky-300 bg-sky-50 text-sky-950',
  high_humidity: 'border-cyan-300 bg-cyan-50 text-cyan-950',
  rain_day: 'border-blue-300 bg-blue-50 text-blue-950',
  no_irrigation: 'border-slate-300 bg-slate-50 text-slate-900',
  irrigation_event: 'border-blue-300 bg-blue-50 text-blue-950',
  high_irrigation_frequency: 'border-amber-300 bg-amber-50 text-amber-950',
  possible_ineffective_irrigation: 'border-orange-300 bg-orange-50 text-orange-950',
  manual_override: 'border-violet-300 bg-violet-50 text-violet-950',
  offline: 'border-red-300 bg-red-50 text-red-950',
  no_data: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)] opacity-70',
};

const markerTone: Record<string, string> = {
  irrigation: 'bg-blue-500',
  irrigation_event: 'bg-blue-500',
  rain: 'bg-sky-500',
  heat_event: 'bg-red-500',
  sensor_gap: 'bg-slate-400',
  data_gap: 'bg-slate-400',
  manual_override: 'bg-violet-500',
};

const soilCalendarBackgroundByTone = {
  wet: 'var(--soil-wet-bg)',
  moist: 'var(--soil-moist-bg)',
  dry: 'var(--soil-dry-bg)',
} as const;

function translateParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return params && typeof params === 'object' ? params : {};
}

function weekdayOffsetForMondayStart(year: number, month: number): number {
  const day = new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay();
  return (day + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
}

function buildCells(calendar: HistoryCalendar, month: { year: number; month: number }): CalendarCell[] {
  const daysByDate = new Map(calendar.days.map((day) => [day.date, day]));
  const leadingBlanks = weekdayOffsetForMondayStart(month.year, month.month);
  const totalDays = daysInMonth(month.year, month.month);
  const cells: CalendarCell[] = [];

  for (let index = 0; index < leadingBlanks; index += 1) {
    cells.push({ kind: 'blank', key: `blank-leading-${index}` });
  }

  for (let dayOfMonth = 1; dayOfMonth <= totalDays; dayOfMonth += 1) {
    const date = `${month.year}-${String(month.month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
    cells.push({
      kind: 'day',
      key: date,
      date,
      dayOfMonth,
      day: daysByDate.get(date) ?? {
        date,
        state: 'no_data',
        coveragePct: null,
        coverageConfidence: 'unknown',
        markers: [],
      },
    });
  }

  while (cells.length % 7 !== 0) {
    cells.push({ kind: 'blank', key: `blank-trailing-${cells.length}` });
  }

  return cells;
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

function markerClass(marker: HistoryCalendarMarker): string {
  return markerTone[marker.type] ?? 'bg-[var(--text-tertiary)]';
}

function dayAriaLabel(
  t: HistoryTranslate,
  monthLabel: string,
  dayOfMonth: number,
  day: HistoryCalendarDay,
  cardType: HistoryCardType,
): string {
  const markers = Array.isArray(day.markers) ? day.markers.map((marker) => markerLabel(t, marker)) : [];
  return [
    `${monthLabel.replace(/\s+\d{4}$/, '')} ${dayOfMonth}`,
    stateLabel(t, day.state),
    summaryLabel(t, day, cardType),
    coverageLabel(t, day),
    ...markers,
  ].filter(Boolean).join(', ');
}

export const HistoryMonthCalendarView: React.FC<HistoryMonthCalendarViewProps> = ({
  cardType,
  calendar,
  onInspectDate,
  selectedDate,
  todayIso,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const days = Array.isArray(calendar?.days) ? calendar.days : [];
  const month = latestCalendarMonth(calendar);
  const monthLabel = formatHistoryCalendarMonthLabel(calendar) ?? t('history.calendar.title');
  const cells = useMemo(() => (calendar && month ? buildCells(calendar, month) : []), [calendar, month]);
  const [internalSelectedDate, setInternalSelectedDate] = useState<string | null>(null);
  const touchTapRef = React.useRef<{ date: string; pointerId: number; x: number; y: number } | null>(null);
  const suppressNextClickRef = React.useRef(false);
  const TOUCH_TAP_SLOP_PX = 10;
  const todayIsoDate = todayIso ?? new Date().toISOString().slice(0, 10);

  if (!calendar || !month || days.length === 0) {
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
      className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 sm:p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-[var(--text)]">{monthLabel}</h3>
        <span className="text-xs font-semibold text-[var(--text-tertiary)]">{calendar.timezone || 'UTC'}</span>
      </div>
      <div role="grid" aria-label={monthLabel} className="grid grid-cols-7 gap-1 sm:gap-2">
        {WEEKDAY_KEYS.map((key) => (
          <div
            key={key}
            role="columnheader"
            className="pb-1 text-center text-[0.65rem] font-bold uppercase text-[var(--text-tertiary)] sm:text-xs"
          >
            {t(key)}
          </div>
        ))}
        {cells.map((cell) => {
          if (cell.kind === 'blank') {
            return (
              <div
                key={cell.key}
                role="gridcell"
                aria-label="blank"
                className="aspect-square rounded-md border border-transparent"
              />
            );
          }

          if (isFutureCalendarDate(cell.date, todayIsoDate)) {
            return (
              <div
                key={cell.key}
                role="gridcell"
                aria-label={`${cell.dayOfMonth}`}
                data-testid={`calendar-cell-${cell.date}`}
                data-state="future"
                className="flex aspect-square min-h-12 flex-col rounded-md border border-transparent p-1 text-left opacity-40 sm:p-1.5"
              >
                <span className="text-xs font-bold leading-none text-[var(--text-tertiary)] sm:text-sm">
                  {cell.dayOfMonth}
                </span>
              </div>
            );
          }

          const markers = Array.isArray(cell.day.markers) ? cell.day.markers : [];
          const label = stateLabel(t, cell.day.state);
          const soilVisual = cardType === 'soil' ? soilStatusVisual(cell.day.state) : null;
          const soilBackground = soilVisual ? soilCalendarBackgroundByTone[soilVisual.tone] : null;
          const style = soilBackground
            ? {
                '--calendar-cell-bg': soilBackground,
                background: soilBackground,
              } as React.CSSProperties
            : undefined;
          const inspectSelection = {
            kind: 'date' as const,
            date: cell.date,
            timestamp: cell.date,
            day: cell.day,
          };
          const selectCell = () => {
            setInternalSelectedDate(cell.date);
            onInspectDate?.(inspectSelection);
          };
          const stopCalendarGesture = (event: React.SyntheticEvent) => {
            event.stopPropagation();
          };

          return (
            <button
              key={cell.key}
              type="button"
              role="gridcell"
              aria-label={dayAriaLabel(t, monthLabel, cell.dayOfMonth, cell.day, cardType)}
              aria-selected={(selectedDate ?? internalSelectedDate) === cell.date}
              data-testid={`calendar-cell-${cell.date}`}
              data-state={cell.day.state}
              data-card-type={cardType}
              data-history-calendar-date={cell.date}
              style={style}
              onClick={(event) => {
                stopCalendarGesture(event);
                if (suppressNextClickRef.current) {
                  suppressNextClickRef.current = false;
                  return;
                }
                selectCell();
              }}
              onPointerDown={(event) => {
                stopCalendarGesture(event);
                if (event.pointerType === 'touch' || event.pointerType === 'pen') {
                  touchTapRef.current = { date: cell.date, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
                }
              }}
              onPointerMove={(event) => {
                stopCalendarGesture(event);
                const tap = touchTapRef.current;
                if (tap && tap.pointerId === event.pointerId
                  && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TOUCH_TAP_SLOP_PX) {
                  touchTapRef.current = null;
                }
              }}
              onPointerUp={(event) => {
                stopCalendarGesture(event);
                const tap = touchTapRef.current;
                touchTapRef.current = null;
                if (!tap || tap.date !== cell.date || tap.pointerId !== event.pointerId) return;
                if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TOUCH_TAP_SLOP_PX) return;
                suppressNextClickRef.current = true;
                selectCell();
              }}
              onPointerCancel={(event) => {
                stopCalendarGesture(event);
                touchTapRef.current = null;
              }}
              className={`flex aspect-square min-h-12 flex-col rounded-md border p-1.5 text-left transition focus:outline-none focus:ring-2 focus:ring-[var(--primary)] ${stateTone[cell.day.state] ?? stateTone.no_data}`}
            >
              <span className="text-xs font-bold leading-none sm:text-sm">{cell.dayOfMonth}</span>
              <span className="mt-auto line-clamp-2 text-[0.58rem] font-semibold leading-tight sm:text-[0.68rem]">
                {label}
              </span>
              {markers.length > 0 && (
                <span className="mt-1 flex gap-0.5" aria-hidden="true">
                  {markers.slice(0, 5).map((marker, index) => (
                    <span
                      key={`${marker.type}-${marker.labelKey}-${index}`}
                      data-marker-dot="true"
                      data-marker-type={marker.type}
                      className={`h-1.5 w-1.5 rounded-full ${markerClass(marker)}`}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
};
