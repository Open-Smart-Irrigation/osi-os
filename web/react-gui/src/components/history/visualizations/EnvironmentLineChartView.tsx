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
import type {
  HistoryCardDataResponse,
  HistorySeriesPoint,
} from '../../../history/types';
import { HISTORY_CHART_MARGIN, formatTimeTick, historyTimeXAxis, historyValueYAxis } from './chartAxis';

interface EnvironmentLineChartViewProps {
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

const SERIES_COLORS = ['#0284c7', '#16a34a', '#ca8a04', '#7c3aed', '#dc2626', '#0891b2'];

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

function validTimestamp(value: unknown): string | null {
  const text = normalizedText(value);
  if (!text) return null;
  return Number.isNaN(new Date(text).getTime()) ? null : text;
}

function hasVisiblePoints(series: RenderSeries): boolean {
  return series.points.some((point) => point.value !== null);
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

function sourceText(series: unknown): string {
  if (!isRecord(series)) return '';
  return [normalizedText(series.id), normalizedText(series.label)].filter(Boolean).join(' ');
}

function fallbackSeriesLabel(t: HistoryTranslate, source: string): string {
  const normalized = source.toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.includes('humidity')) return t('history.environmentLineChart.series.humidity');
  if (normalized.includes('rain') || normalized.includes('precip')) return t('history.environmentLineChart.series.rain');
  if (normalized.includes('light') || normalized.includes('lux') || normalized.includes('illuminance')) {
    return t('history.environmentLineChart.series.light');
  }
  if (normalized.includes('pressure') || normalized.includes('barometric')) {
    return t('history.environmentLineChart.series.pressure');
  }
  if (normalized.includes('wind')) return t('history.environmentLineChart.series.wind');
  if (normalized.includes('uv')) return t('history.environmentLineChart.series.uv');
  if (normalized.includes('temp')) return t('history.environmentLineChart.series.airTemperature');
  return t('history.environmentLineChart.series.environment');
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

function fallbackUnit(source: string): string {
  const normalized = source.toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.includes('humidity')) return '%';
  if (normalized.includes('rain') || normalized.includes('precip')) return 'mm';
  if (normalized.includes('light') || normalized.includes('lux') || normalized.includes('illuminance')) return 'lx';
  if (normalized.includes('pressure') || normalized.includes('barometric')) return 'hPa';
  if (normalized.includes('wind')) return 'm/s';
  if (normalized.includes('uv')) return 'index';
  if (normalized.includes('temp')) return 'C';
  return '';
}

function displayUnit(series: unknown, source: string): string {
  const explicitUnit = normalizedText(isRecord(series) ? series.unit : null);
  if (explicitUnit && !looksLikeRawSourceToken(explicitUnit)) return explicitUnit;
  const rawPoints = isRecord(series) ? series.points : null;
  if (Array.isArray(rawPoints)) {
    const pointUnit = rawPoints
      .map((point) => (isRecord(point) ? normalizedText(point.unit) : null))
      .find((unit) => unit !== null && !looksLikeRawSourceToken(unit));
    if (pointUnit) return pointUnit;
  }
  return fallbackUnit(source);
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

function normalizeSeriesList(t: HistoryTranslate, seriesList: readonly unknown[]): RenderSeries[] {
  return seriesList.map((series, index) => {
    const source = sourceText(series);
    const rawPoints = isRecord(series) ? series.points : null;
    const points = Array.isArray(rawPoints)
      ? rawPoints.reduce<RenderPoint[]>((accumulator, point) => {
          const timestamp = validTimestamp(isRecord(point) ? point.t : null);
          if (!timestamp) return accumulator;
          accumulator.push({ t: timestamp, value: pointValue(point) });
          return accumulator;
        }, [])
      : [];

    return {
      key: `series-${index}`,
      label: displaySeriesLabel(t, series, source),
      unit: displayUnit(series, source),
      points,
    };
  });
}

export function buildNumericRows(seriesList: RenderSeries[]): ChartRow[] {
  const rows = new Map<string, ChartRow>();

  seriesList.forEach((series) => {
    series.points.forEach((point) => {
      const tMs = Date.parse(point.t);
      if (!Number.isFinite(tMs)) return;
      const existing = rows.get(point.t) ?? {
        timestamp: point.t,
        tMs,
        label: formatTimestamp(point.t),
      };
      existing[series.key] = point.value;
      rows.set(point.t, existing);
    });
  });

  return [...rows.values()].sort((left, right) => left.tMs - right.tMs);
}

function groupSeriesByUnit(seriesList: RenderSeries[]): Array<{ unit: string; series: RenderSeries[] }> {
  const groups = new Map<string, RenderSeries[]>();
  seriesList.forEach((series) => {
    const key = series.unit || 'unitless';
    groups.set(key, [...(groups.get(key) ?? []), series]);
  });
  return [...groups.entries()].map(([unit, series]) => ({
    unit: unit === 'unitless' ? '' : unit,
    series,
  }));
}

function visualWindowsEqual(left: ChartWindow | undefined, right: ChartWindow | undefined): boolean {
  return left?.fromMs === right?.fromMs && left?.toMs === right?.toMs;
}

const EnvironmentLineChartViewComponent: React.FC<EnvironmentLineChartViewProps> = ({
  data,
  window: chartWindow,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const { visibleSeries, rows, groups } = React.useMemo(() => {
    const rawSeries = Array.isArray(data?.series) ? data.series : [];
    const nextVisibleSeries = normalizeSeriesList(t, rawSeries).filter(hasVisiblePoints);
    return {
      visibleSeries: nextVisibleSeries,
      rows: buildNumericRows(nextVisibleSeries),
      groups: groupSeriesByUnit(nextVisibleSeries).map((group) => ({
        ...group,
        rows: buildNumericRows(group.series),
        seriesByKey: new Map(group.series.map((series) => [series.key, series])),
      })),
    };
  }, [data, t]);
  const spanMs = chartWindow
    ? chartWindow.toMs - chartWindow.fromMs
    : (rows.length ? rows[rows.length - 1].tMs - rows[0].tMs : 0);

  if (visibleSeries.length === 0 || rows.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.environmentLineChart.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.environmentLineChart.emptyTitle')}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          {t('history.environmentLineChart.emptyBody')}
        </p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.environmentLineChart.title')}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {groups.map((group, groupIndex) => {
          return (
            <div key={group.unit || 'unitless'} className="flex min-h-0 flex-1 flex-col gap-1">
              <h4 className="text-xs font-semibold text-[var(--text-tertiary)]">
                {group.unit
                  ? t('history.environmentLineChart.axisLabel', { unit: group.unit })
                  : t('history.environmentLineChart.axisNoUnit')}
              </h4>
              <div className="relative min-h-0 min-w-0 flex-1"><div className="absolute inset-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={group.rows} margin={HISTORY_CHART_MARGIN}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      {...historyTimeXAxis}
                      domain={chartWindow ? [chartWindow.fromMs, chartWindow.toMs] : ['dataMin', 'dataMax']}
                      tickFormatter={(value) => formatTimeTick(Number(value), spanMs)}
                    />
                    <YAxis {...historyValueYAxis(group.unit || undefined, 52)} />
                    <Tooltip
                      isAnimationActive={false}
                      labelFormatter={formatTimestampMs}
                      formatter={(value, _name, item) => {
                        const series = group.seriesByKey.get(String(item.dataKey));
                        return [
                          formatTooltipValue(value, series?.unit ?? ''),
                          series?.label ?? t('history.environmentLineChart.series.environment'),
                        ];
                      }}
                    />
                    {group.series.map((series, index) => (
                      <Line
                        key={series.key}
                        type="monotone"
                        dataKey={series.key}
                        name={series.label}
                        stroke={SERIES_COLORS[(groupIndex + index) % SERIES_COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer></div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export const EnvironmentLineChartView = React.memo(
  EnvironmentLineChartViewComponent,
  (previous, next) => previous.data === next.data && visualWindowsEqual(previous.window, next.window),
);
