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
type RenderPoint = {
  t: string;
  value: number | null;
};
type RenderSeries = {
  key: string;
  label: string;
  unit: string;
  points: RenderPoint[];
};

const SERIES_COLORS = ['#047857', '#0f766e', '#b45309', '#2563eb'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pointValue(point: Partial<HistorySeriesPoint> | null | undefined): number | null {
  if (!isRecord(point)) return null;
  return (
    finiteNumber(point.value) ??
    finiteNumber(point.latest) ??
    finiteNumber(point.mean) ??
    finiteNumber(point.median)
  );
}

function hasVisiblePoints(series: RenderSeries): boolean {
  return series.points.some((point) => point.value !== null);
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

function looksLikeRawSourceToken(value: string): boolean {
  return (
    /dendro-src-/i.test(value) ||
    /\b[0-9a-f]{16}\b/i.test(value) ||
    value.includes('_') ||
    /\b(dev[\s_-]?eui|device[\s_-]?eui|raw|channel|adc|rssi|snr|firmware|calibration)\b/i.test(value)
  );
}

function displaySeriesLabel(t: HistoryTranslate, series: unknown, sourceId: string): string {
  const label = normalizedText(isRecord(series) ? series.label : null);
  if (label && !looksLikeRawSourceToken(label)) return label;
  return fallbackSeriesLabel(t, sourceId);
}

function displayUnit(series: unknown): string {
  return normalizedText(isRecord(series) ? series.unit : null) ?? '';
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function latestVisibleValue(series: RenderSeries): number | null {
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const value = series.points[index].value;
    if (value !== null) return value;
  }
  return null;
}

function normalizeSeriesList(t: HistoryTranslate, seriesList: readonly unknown[]): RenderSeries[] {
  return seriesList.map((series, index) => {
    const sourceId = normalizedText(isRecord(series) ? series.id : null) ?? '';
    const rawPoints = isRecord(series) ? series.points : null;
    const points = Array.isArray(rawPoints)
      ? rawPoints.reduce<RenderPoint[]>((accumulator, point) => {
          const timestamp = normalizedText(isRecord(point) ? point.t : null);
          if (!timestamp) return accumulator;
          accumulator.push({ t: timestamp, value: pointValue(point) });
          return accumulator;
        }, [])
      : [];

    return {
      key: `series-${index}`,
      label: displaySeriesLabel(t, series, sourceId),
      unit: displayUnit(series),
      points,
    };
  });
}

function buildRows(seriesList: RenderSeries[]): ChartRow[] {
  const rows = new Map<string, ChartRow>();

  seriesList.forEach((series) => {
    series.points.forEach((point) => {
      const existing = rows.get(point.t) ?? {
        timestamp: point.t,
        label: formatTimestamp(point.t),
      };
      existing[series.key] = point.value;
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
  const rawSeries = Array.isArray(data?.series) ? data.series : [];
  const visibleSeries = normalizeSeriesList(t, rawSeries).filter(hasVisiblePoints);
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
          return (
            <div
              key={series.key}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <p className="text-sm font-semibold text-[var(--text)]">{series.label}</p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                {formatValue(latestVisibleValue(series), series.unit)}
              </p>
              {series.unit && <p className="sr-only">{series.unit}</p>}
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
                key={series.key}
                type="monotone"
                dataKey={series.key}
                name={series.label}
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
