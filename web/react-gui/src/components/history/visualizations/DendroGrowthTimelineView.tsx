import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  HistoryCardDataResponse,
  HistoryEvent,
  HistorySeries,
  HistorySeriesPoint,
} from '../../../history/types';

interface DendroGrowthTimelineViewProps {
  data: HistoryCardDataResponse | undefined;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type ChartRow = {
  timestamp: string;
  label: string;
} & Record<string, number | string | null>;

const SERIES_COLORS = ['#047857', '#0f766e', '#b45309', '#2563eb'];

function pointValue(point: HistorySeriesPoint): number | null {
  return point.value ?? point.latest ?? point.mean ?? point.median ?? null;
}

function hasVisiblePoints(series: HistorySeries): boolean {
  return series.points.some((point) => pointValue(point) !== null);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function fallbackSeriesLabel(t: HistoryTranslate, seriesId: string): string {
  const normalized = seriesId.toLowerCase();
  if (normalized.includes('shrink')) return t('history.dendroTimeline.series.shrinkage');
  if (normalized.includes('growth')) return t('history.dendroTimeline.series.growth');
  if (normalized.includes('stem')) return t('history.dendroTimeline.series.stemChange');
  return t('history.dendroTimeline.series.dendrometer');
}

function displaySeriesLabel(t: HistoryTranslate, series: HistorySeries): string {
  const label = series.label.trim();
  if (label && !label.includes('dendro-src-') && !label.includes('_')) return label;
  return fallbackSeriesLabel(t, series.id);
}

function displayUnit(series: HistorySeries): string {
  return series.unit?.trim() || '';
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function latestVisibleValue(series: HistorySeries): number | null {
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const value = pointValue(series.points[index]);
    if (value !== null) return value;
  }
  return null;
}

function buildRows(seriesList: HistorySeries[]): ChartRow[] {
  const rows = new Map<string, ChartRow>();

  seriesList.forEach((series) => {
    series.points.forEach((point) => {
      const existing = rows.get(point.t) ?? {
        timestamp: point.t,
        label: formatTimestamp(point.t),
      };
      existing[series.id] = pointValue(point);
      rows.set(point.t, existing);
    });
  });

  return [...rows.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function eventTone(event: HistoryEvent): string {
  if (event.severity === 'warning') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (event.severity === 'critical') return 'border-red-300 bg-red-50 text-red-900';
  if (event.severity === 'success') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  return 'border-[var(--border)] bg-[var(--secondary-bg)] text-[var(--text)]';
}

export const DendroGrowthTimelineView: React.FC<DendroGrowthTimelineViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const visibleSeries = (data?.series ?? []).filter(hasVisiblePoints);
  const rows = buildRows(visibleSeries);
  const events = data?.events ?? [];

  if (visibleSeries.length === 0 || rows.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.dendroTimeline.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.dendroTimeline.emptyTitle')}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          {t('history.dendroTimeline.emptyBody')}
        </p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.dendroTimeline.title')}
      className="mt-4 space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">
            {t('history.dendroTimeline.title')}
          </h3>
          <p className="text-sm text-[var(--text-tertiary)]">
            {t('history.dendroTimeline.pointsCount', { count: rows.length })}
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {visibleSeries.map((series) => {
          const unit = displayUnit(series);
          return (
            <div
              key={series.id}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <p className="text-sm font-semibold text-[var(--text)]">{displaySeriesLabel(t, series)}</p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                {formatValue(latestVisibleValue(series), unit)}
              </p>
              {unit && <p className="sr-only">{unit}</p>}
            </div>
          );
        })}
      </div>

      <div className="h-64 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="timestamp" tickFormatter={formatTimestamp} minTickGap={24} />
            <YAxis width={44} />
            <Tooltip labelFormatter={(value) => formatTimestamp(String(value))} />
            {events.map((event) => (
              <ReferenceLine key={event.id} x={event.t} stroke="#b45309" strokeDasharray="4 4" />
            ))}
            {visibleSeries.map((series, index) => (
              <Line
                key={series.id}
                type="monotone"
                dataKey={series.id}
                name={displaySeriesLabel(t, series)}
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-[var(--text)]">
          {t('history.dendroTimeline.eventsTitle')}
        </h4>
        {events.length > 0 ? (
          <ol className="mt-2 space-y-2">
            {events.map((event) => (
              <li
                key={event.id}
                className={`rounded-md border px-3 py-2 text-sm ${eventTone(event)}`}
              >
                <span className="font-semibold">{event.label}</span>
                <span className="ml-2 text-xs opacity-75">{formatTimestamp(event.t)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">
            {t('history.dendroTimeline.noEvents')}
          </p>
        )}
      </div>
    </section>
  );
};
