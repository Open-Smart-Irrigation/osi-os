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

interface SoilLineChartViewProps {
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

const SERIES_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed'];

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
    /\b[0-9a-f]{16}\b/i.test(value)
    || /(?:dev[\s_-]?eui|device[\s_-]?eui|raw|channel|adc|rssi|snr|firmware|source)/i.test(value)
    || /swt_\d/i.test(value)
    || /^swt\s*\d$/i.test(value.trim())
    || value.includes('_')
  );
}

function fallbackSeriesLabel(t: HistoryTranslate, source: string, index: number): string {
  const normalized = source.toLowerCase();
  if (/swt[_\s-]*1/.test(normalized)) return t('history.soilLineChart.series.soil1');
  if (/swt[_\s-]*2/.test(normalized)) return t('history.soilLineChart.series.soil2');
  if (/swt[_\s-]*3/.test(normalized)) return t('history.soilLineChart.series.soil3');
  return t('history.soilLineChart.series.soil', { index: index + 1, defaultValue: `Soil ${index + 1}` });
}

function displaySeriesLabel(t: HistoryTranslate, series: unknown, index: number): string {
  const id = normalizedText(isRecord(series) ? series.id : null) ?? '';
  const label = normalizedText(isRecord(series) ? series.label : null);
  if (label && !looksLikeRawSourceToken(label)) return label;
  return fallbackSeriesLabel(t, `${id} ${label ?? ''}`, index);
}

function displayUnit(series: unknown): string {
  const unit = normalizedText(isRecord(series) ? series.unit : null);
  return unit && !looksLikeRawSourceToken(unit) ? unit : 'kPa';
}

function normalizeSeriesList(t: HistoryTranslate, seriesList: readonly unknown[]): RenderSeries[] {
  return seriesList.map((series, index) => {
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
      label: displaySeriesLabel(t, series, index),
      unit: displayUnit(series),
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

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatTooltipValue(value: unknown, unit: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatValue(value, unit) : '-';
}

export const SoilLineChartView: React.FC<SoilLineChartViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const rawSeries = Array.isArray(data?.series) ? data.series : [];
  const visibleSeries = normalizeSeriesList(t, rawSeries).filter(hasVisiblePoints);
  const rows = buildRows(visibleSeries);
  const seriesByKey = new Map(visibleSeries.map((series) => [series.key, series]));

  if (visibleSeries.length === 0 || rows.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.soilLineChart.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.soilLineChart.emptyTitle')}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          {t('history.soilLineChart.emptyBody')}
        </p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.soilLineChart.title')}
      className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div className="h-64 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="timestamp" tickFormatter={formatTimestamp} minTickGap={24} />
            <YAxis width={52} label={{ value: 'kPa', angle: -90, position: 'insideLeft' }} />
            <Tooltip
              labelFormatter={(value) => formatTimestamp(String(value))}
              formatter={(value, _name, item) => {
                const series = seriesByKey.get(String(item.dataKey));
                return [formatTooltipValue(value, series?.unit ?? 'kPa'), series?.label ?? t('history.soilLineChart.series.soil')];
              }}
            />
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
