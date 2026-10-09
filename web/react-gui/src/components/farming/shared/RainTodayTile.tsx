import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { msUntilNextFarmMidnight, rainTodayState, type RainTodayState } from '../../../utils/rainDay';

/** The rain fields of a device's latest data; the gateway dates `rain_mm_today` with `rain_day`. */
export type RainTodayData = {
  rain_mm_today?: unknown;
  rain_day?: unknown;
  rain_day_timezone?: unknown;
  rain_day_timezone_basis?: unknown;
} | null | undefined;

const asString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

interface RainTodayView {
  state: RainTodayState;
  /** Main value: the amount only when it belongs to the farm's today, else "—". */
  shown: string;
  /** "so far", or the dated last report, plus "(UTC)" for a device without a zone; null when empty. */
  detail: string | null;
}

/**
 * Decides what a rain "today" value may say. The farm date comes from the gateway's timezone,
 * never the browser; a timer re-renders at the next farm midnight, so a tab left open overnight
 * switches without a reload. `Date.now()` is read on every render, so any re-render (a data
 * refresh, a tab waking from sleep) also re-evaluates.
 */
function useRainToday(data: RainTodayData): RainTodayView {
  const { t, i18n } = useTranslation('devices');
  const timezone = asString(data?.rain_day_timezone) || 'UTC';
  const [tick, setTick] = useState(0);
  const nowMs = Date.now();
  useEffect(() => {
    const id = window.setTimeout(() => setTick((n) => n + 1), msUntilNextFarmMidnight(timezone, Date.now()) + 1000);
    return () => window.clearTimeout(id);
  }, [timezone, tick]);

  const rainMmToday = typeof data?.rain_mm_today === 'number' ? data.rain_mm_today : null;
  const state = rainTodayState({ rainMmToday, rainDay: asString(data?.rain_day), timezone, nowMs });
  const shown = state.kind === 'today' && state.value !== null ? `${state.value.toFixed(1)} mm` : '—';
  const dayLabel = state.day
    ? new Date(`${state.day}T12:00:00Z`).toLocaleDateString(i18n?.language, { timeZone: 'UTC', month: 'short', day: 'numeric' })
    : null;
  const parts: string[] = [];
  if (state.kind === 'today') parts.push(t('rain.soFar', { defaultValue: 'so far' }));
  if (state.kind === 'previous') {
    parts.push(t('rain.lastReportOn', { date: dayLabel, value: state.value?.toFixed(1), defaultValue: 'Last report {{date}}: {{value}} mm' }));
  }
  if (timezone === 'UTC' && data?.rain_day_timezone_basis === 'unassigned_default') parts.push('(UTC)');
  return { state, shown, detail: parts.length ? parts.join(' ') : null };
}

const VALUE_CLASS = 'cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)]';

interface RainTodayTileProps {
  data: RainTodayData;
  onOpenHistory?: () => void;
  className?: string;
  valueClassName?: string;
  valueStyle?: React.CSSProperties;
  /** Further lines of the card's tile (interval rate, status), rendered under the dated line. */
  children?: React.ReactNode;
}

/** A full "Rain recorded today" tile: label, value (opens the history), dated detail line. */
export const RainTodayTile: React.FC<RainTodayTileProps> = ({ data, onOpenHistory, className, valueClassName, valueStyle, children }) => {
  const { t } = useTranslation('devices');
  const { shown, detail } = useRainToday(data);
  return (
    <div className={className ?? 'rounded-lg bg-[var(--card)] p-3'}>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        {t('rain.recordedToday', { defaultValue: 'Rain recorded today' })}
      </p>
      <button
        type="button"
        onClick={onOpenHistory}
        className={valueClassName ?? VALUE_CLASS}
        title={t('common.viewHistory', { defaultValue: 'View history' })}
        style={valueStyle}
      >
        {shown}
      </button>
      {detail && <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{detail}</p>}
      {children}
    </div>
  );
};

/** The compact "Rain recorded today: <value>" line of a tile whose main value is something else. */
export const RainTodayLine: React.FC<{ data: RainTodayData }> = ({ data }) => {
  const { t } = useTranslation('devices');
  const { shown, detail } = useRainToday(data);
  return (
    <>
      <p className="mb-2 text-xs text-[var(--text-secondary)]">
        {t('rain.recordedToday', { defaultValue: 'Rain recorded today' })}:{' '}
        <span className="font-semibold text-[var(--text)]">{shown}</span>
      </p>
      {detail && <p className="-mt-1 mb-2 text-xs text-[var(--text-tertiary)]">{detail}</p>}
    </>
  );
};
