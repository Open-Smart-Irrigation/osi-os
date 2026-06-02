import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HistoryCardDataResponse, HistorySeriesPoint } from '../../../history/types';

interface DendroLineChartViewProps {
  data: HistoryCardDataResponse | undefined;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type ChartRow = { timestamp: string } & Record<string, number | string | null>;
type RenderSeries = {
  key: string;
  label: string;
  unit: string;
  points: Array<{ t: string; value: number | null }>;
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
  return finiteNumber(point.value) ?? finiteNumber(point.latest) ?? finiteNumber(point.mean) ?? finiteNumber(point.median);
}

function validTimestamp(value: unknown): string | null {
  const text = normalizedText(value);
  if (!text) return null;
  return Number.isNaN(new Date(text).getTime()) ? null : text;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function looksLikeRawSourceToken(value: string): boolean {
  return (
    /dendro-src-/i.test(value)
    || /\b[0-9a-f]{16}\b/i.test(value)
    || value.includes('_')
    || /\b(dev[\s_-]?eui|device[\s_-]?eui|raw|channel|adc|rssi|snr|firmware|calibration)\b/i.test(value)
  );
}

function fallbackSeriesLabel(t: HistoryTranslate, source: string): string {
  const normalized = source.toLowerCase();
  if (normalized.includes('shrink')) return t('history.dendroLineChart.series.shrinkage');
  if (normalized.includes('growth')) return t('history.dendroLineChart.series.growth');
  if (normalized.includes('stem')) return t('history.dendroLineChart.series.stemChange');
  if (normalized.includes('position')) return t('history.dendroLineChart.series.position');
  return t('history.dendroLineChart.series.dendrometer');
}

function normalizeSeriesList(t: HistoryTranslate, seriesList: readonly unknown[]): RenderSeries[] {
  return seriesList.map((series, index) => {
    const source = [normalizedText(isRecord(series) ? series.id : null), normalizedText(isRecord(series) ? series.label : null)]
      .filter(Boolean)
      .join(' ');
    const label = normalizedText(isRecord(series) ? series.label : null);
    const rawPoints = isRecord(series) ? series.points : null;
    const points = Array.isArray(rawPoints)
      ? rawPoints.reduce<Array<{ t: string; value: number | null }>>((accumulator, point) => {
          const timestamp = validTimestamp(isRecord(point) ? point.t : null);
          if (!timestamp) return accumulator;
          accumulator.push({ t: timestamp, value: pointValue(point) });
          return accumulator;
        }, [])
      : [];
    return {
      key: `series-${index}`,
      label: label && !looksLikeRawSourceToken(label) ? label : fallbackSeriesLabel(t, source),
      unit: normalizedText(isRecord(series) ? series.unit : null) ?? '',
      points,
    };
  });
}

function hasVisiblePoints(series: RenderSeries): boolean {
  return series.points.some((point) => point.value !== null);
}

function buildRows(seriesList: RenderSeries[]): ChartRow[] {
  const rows = new Map<string, ChartRow>();
  seriesList.forEach((series) => {
    series.points.forEach((point) => {
      const row = rows.get(point.t) ?? { timestamp: point.t };
      row[series.key] = point.value;
      rows.set(point.t, row);
    });
  });
  return [...rows.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function latestVisibleValue(series: RenderSeries): number | null {
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const value = series.points[index].value;
    if (value !== null) return value;
  }
  return null;
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

export const DendroLineChartView: React.FC<DendroLineChartViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const rawSeries = Array.isArray(data?.series) ? data.series : [];
  const visibleSeries = normalizeSeriesList(t, rawSeries).filter(hasVisiblePoints);
  const rows = buildRows(visibleSeries);

  if (visibleSeries.length === 0 || rows.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.dendroLineChart.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.dendroLineChart.emptyTitle')}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          {t('history.dendroLineChart.emptyBody')}
        </p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.dendroLineChart.title')}
      className="mt-4 space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.dendroLineChart.title')}
        </h3>
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('history.dendroLineChart.pointsCount', { count: rows.length })}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {visibleSeries.map((series) => (
          <div key={series.key} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <p className="text-sm font-semibold text-[var(--text)]">{series.label}</p>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {formatValue(latestVisibleValue(series), series.unit)}
            </p>
          </div>
        ))}
      </div>
      <div className="h-64 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="timestamp" tickFormatter={formatTimestamp} minTickGap={24} />
            <YAxis width={44} />
            <Tooltip labelFormatter={(value) => formatTimestamp(String(value))} />
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
    </section>
  );
};
