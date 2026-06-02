import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HistoryCardDataResponse, HistorySeriesPoint } from '../../../history/types';

interface DailyMinMaxViewProps {
  data: HistoryCardDataResponse | undefined;
  window?: { fromMs: number; toMs: number };
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type ChartRow = {
  timestamp: string;
  tMs: number;
  label: string;
} & Record<string, number | string | null>;
type ChartWindow = { fromMs: number; toMs: number };
type DailyPoint = {
  t: string;
  min: number | null;
  max: number | null;
  mean: number | null;
};
type DailySeries = {
  key: string;
  label: string;
  unit: string;
  points: DailyPoint[];
};

const SERIES_COLORS = ['#0284c7', '#16a34a', '#ca8a04', '#7c3aed'];

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

function validTimestamp(value: unknown): string | null {
  const text = normalizedText(value);
  if (!text) return null;
  return Number.isNaN(new Date(text).getTime()) ? null : text;
}

function sourceText(series: unknown): string {
  if (!isRecord(series)) return '';
  return [normalizedText(series.id), normalizedText(series.label)].filter(Boolean).join(' ');
}

function fallbackSeriesLabel(t: HistoryTranslate, source: string): string {
  const normalized = source.toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.includes('temp')) return t('history.dailyMinMax.series.airTemperature');
  return t('history.dailyMinMax.series.environment');
}

function looksLikeRawSourceToken(value: string): boolean {
  return (
    /env-src-/i.test(value) ||
    /\b[0-9a-f]{16}\b/i.test(value) ||
    value.includes('_') ||
    /\b(dev[\s_-]?eui|device[\s_-]?eui|raw|channel|adc|rssi|snr|firmware|calibration)\b/i.test(value)
  );
}

function displaySeriesLabel(t: HistoryTranslate, series: unknown, source: string): string {
  const label = normalizedText(isRecord(series) ? series.label : null);
  if (label && !looksLikeRawSourceToken(label)) return label;
  return fallbackSeriesLabel(t, source);
}

function displayUnit(series: unknown): string {
  const explicitUnit = normalizedText(isRecord(series) ? series.unit : null);
  if (explicitUnit && !looksLikeRawSourceToken(explicitUnit)) return explicitUnit;
  return '';
}

function normalizeSeriesList(t: HistoryTranslate, seriesList: readonly unknown[]): DailySeries[] {
  return seriesList.map((series, index) => {
    const source = sourceText(series);
    const rawPoints = isRecord(series) ? series.points : null;
    const points = Array.isArray(rawPoints)
      ? rawPoints.reduce<DailyPoint[]>((accumulator, point) => {
          const timestamp = validTimestamp(isRecord(point) ? point.t : null);
          if (!timestamp) return accumulator;
          accumulator.push({
            t: timestamp,
            min: finiteNumber((point as Partial<HistorySeriesPoint>).min),
            max: finiteNumber((point as Partial<HistorySeriesPoint>).max),
            mean: finiteNumber((point as Partial<HistorySeriesPoint>).mean),
          });
          return accumulator;
        }, [])
      : [];

    return {
      key: `daily-series-${index}`,
      label: displaySeriesLabel(t, series, source),
      unit: displayUnit(series),
      points,
    };
  });
}

function hasDailyRange(series: DailySeries): boolean {
  return series.points.some((point) => point.min !== null && point.max !== null);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatTimestampMs(value: unknown): string {
  const ms = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(ms) ? formatTimestamp(new Date(ms).toISOString()) : '-';
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatTooltipValue(value: unknown, unit: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return formatValue(value, unit);
  return '-';
}

export function buildNumericRows(series: DailySeries): ChartRow[] {
  return series.points
    .reduce<ChartRow[]>((rows, point) => {
      const tMs = Date.parse(point.t);
      if (!Number.isFinite(tMs)) return rows;
      rows.push({
        timestamp: point.t,
        tMs,
        label: formatTimestamp(point.t),
        [`${series.key}-min`]: point.min,
        [`${series.key}-max`]: point.max,
        [`${series.key}-mean`]: point.mean,
      });
      return rows;
    }, [])
    .sort((left, right) => left.tMs - right.tMs);
}

export function expandSinglePointRows(rows: ChartRow[]): ChartRow[] {
  if (rows.length !== 1) return rows;

  const center = rows[0].tMs;
  const preferredHalfSegmentMs = 6 * 60 * 60 * 1000;
  const left = center - preferredHalfSegmentMs;
  const right = center + preferredHalfSegmentMs;

  return [left, right].map((tMs) => ({
    ...rows[0],
    timestamp: new Date(tMs).toISOString(),
    tMs,
    label: formatTimestamp(new Date(tMs).toISOString()),
  }));
}

function visualWindowsEqual(left: ChartWindow | undefined, right: ChartWindow | undefined): boolean {
  return left?.fromMs === right?.fromMs && left?.toMs === right?.toMs;
}

const DailyMinMaxViewComponent: React.FC<DailyMinMaxViewProps> = ({ data, window: chartWindow }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const visibleSeries = React.useMemo(() => {
    const rawSeries = Array.isArray(data?.series) ? data.series : [];
    return normalizeSeriesList(t, rawSeries).filter(hasDailyRange).map((series, seriesIndex) => ({
      series,
      rows: expandSinglePointRows(buildNumericRows(series)),
      color: SERIES_COLORS[seriesIndex % SERIES_COLORS.length],
    }));
  }, [data, t]);

  if (visibleSeries.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.dailyMinMax.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">{t('history.dailyMinMax.emptyTitle')}</h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">{t('history.dailyMinMax.emptyBody')}</p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.dailyMinMax.title')}
      className="mt-4 space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      {visibleSeries.map(({ series, rows, color }) => {
        return (
          <div key={series.key}>
            <div className="h-56 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="tMs"
                    type="number"
                    scale="time"
                    domain={chartWindow ? [chartWindow.fromMs, chartWindow.toMs] : ['dataMin', 'dataMax']}
                    allowDataOverflow
                    tickFormatter={formatTimestampMs}
                    minTickGap={24}
                  />
                  <YAxis
                    width={52}
                    label={
                      series.unit
                        ? { value: t('history.dailyMinMax.axisLabel', { unit: series.unit }), angle: -90, position: 'insideLeft' }
                        : { value: t('history.dailyMinMax.axisNoUnit'), angle: -90, position: 'insideLeft' }
                    }
                  />
                  <Tooltip
                    isAnimationActive={false}
                    labelFormatter={formatTimestampMs}
                    formatter={(value, name) => [
                      formatTooltipValue(value, series.unit),
                      String(name),
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey={`${series.key}-max`}
                    name={t('history.dailyMinMax.tooltipMax')}
                    stroke={color}
                    fill={color}
                    fillOpacity={0.16}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey={`${series.key}-min`}
                    name={t('history.dailyMinMax.tooltipMin')}
                    stroke={color}
                    strokeDasharray="4 3"
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey={`${series.key}-mean`}
                    name={t('history.dailyMinMax.tooltipMean')}
                    stroke="#111827"
                    strokeWidth={2}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </section>
  );
};

export const DailyMinMaxView = React.memo(
  DailyMinMaxViewComponent,
  (previous, next) => previous.data === next.data && visualWindowsEqual(previous.window, next.window),
);
