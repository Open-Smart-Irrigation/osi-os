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
import { HISTORY_CHART_MARGIN, historyTimeXAxis, historyValueYAxis } from './chartAxis';

interface SoilLineChartViewProps {
  data: HistoryCardDataResponse | undefined;
  window?: { fromMs: number; toMs: number };
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type ChartRow = { timestamp: string; tMs: number } & Record<string, number | string | null>;
type ChartWindow = { fromMs: number; toMs: number };
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

function formatTimestampMs(value: unknown): string {
  const ms = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(ms) ? formatTimestamp(new Date(ms).toISOString()) : '-';
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

export function buildNumericRows(seriesList: RenderSeries[]): ChartRow[] {
  const rows = new Map<string, ChartRow>();
  seriesList.forEach((series) => {
    series.points.forEach((point) => {
      const tMs = Date.parse(point.t);
      if (!Number.isFinite(tMs)) return;
      const row = rows.get(point.t) ?? { timestamp: point.t, tMs };
      row[series.key] = point.value;
      rows.set(point.t, row);
    });
  });
  return [...rows.values()].sort((left, right) => left.tMs - right.tMs);
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatTooltipValue(value: unknown, unit: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatValue(value, unit) : '-';
}

function visualWindowsEqual(left: ChartWindow | undefined, right: ChartWindow | undefined): boolean {
  return left?.fromMs === right?.fromMs && left?.toMs === right?.toMs;
}

const SoilLineChartViewComponent: React.FC<SoilLineChartViewProps> = ({ data, window: chartWindow }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const { visibleSeries, rows, seriesByKey } = React.useMemo(() => {
    const rawSeries = Array.isArray(data?.series) ? data.series : [];
    const nextVisibleSeries = normalizeSeriesList(t, rawSeries).filter(hasVisiblePoints);
    return {
      visibleSeries: nextVisibleSeries,
      rows: buildNumericRows(nextVisibleSeries),
      seriesByKey: new Map(nextVisibleSeries.map((series) => [series.key, series])),
    };
  }, [data, t]);

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
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="relative min-h-0 min-w-0 flex-1"><div className="absolute inset-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={HISTORY_CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              {...historyTimeXAxis}
              domain={chartWindow ? [chartWindow.fromMs, chartWindow.toMs] : ['dataMin', 'dataMax']}
              tickFormatter={formatTimestampMs}
            />
            <YAxis {...historyValueYAxis('kPa', 52)} />
            <Tooltip
              isAnimationActive={false}
              labelFormatter={formatTimestampMs}
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
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer></div>
      </div>
    </section>
  );
};

export const SoilLineChartView = React.memo(
  SoilLineChartViewComponent,
  (previous, next) => previous.data === next.data && visualWindowsEqual(previous.window, next.window),
);
