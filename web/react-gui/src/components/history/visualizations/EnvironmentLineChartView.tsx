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

interface EnvironmentLineChartViewProps {
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
  if (explicitUnit) return explicitUnit;
  const rawPoints = isRecord(series) ? series.points : null;
  if (Array.isArray(rawPoints)) {
    const pointUnit = rawPoints.map((point) => (isRecord(point) ? normalizedText(point.unit) : null)).find(Boolean);
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

function latestVisibleValue(series: RenderSeries): number | null {
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const value = series.points[index].value;
    if (value !== null) return value;
  }
  return null;
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

export const EnvironmentLineChartView: React.FC<EnvironmentLineChartViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const rawSeries = Array.isArray(data?.series) ? data.series : [];
  const visibleSeries = normalizeSeriesList(t, rawSeries).filter(hasVisiblePoints);
  const rows = buildRows(visibleSeries);
  const groups = groupSeriesByUnit(visibleSeries);

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
      className="mt-4 space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">
            {t('history.environmentLineChart.title')}
          </h3>
          <p className="text-sm text-[var(--text-tertiary)]">
            {t('history.environmentLineChart.pointsCount', { count: rows.length })}
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {visibleSeries.map((series) => (
          <div
            key={series.key}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <p className="text-sm font-semibold text-[var(--text)]">{series.label}</p>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {formatValue(latestVisibleValue(series), series.unit)}
            </p>
          </div>
        ))}
      </div>

      <div className="space-y-4">
        {groups.map((group, groupIndex) => {
          const groupRows = buildRows(group.series);
          const seriesByKey = new Map(group.series.map((series) => [series.key, series]));
          return (
            <div key={group.unit || 'unitless'} className="space-y-2">
              <h4 className="text-sm font-semibold text-[var(--text)]">
                {group.unit
                  ? t('history.environmentLineChart.axisLabel', { unit: group.unit })
                  : t('history.environmentLineChart.axisNoUnit')}
              </h4>
              <div className="h-56 min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={groupRows} margin={{ top: 10, right: 12, bottom: 0, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="timestamp" tickFormatter={formatTimestamp} minTickGap={24} />
                    <YAxis
                      width={52}
                      label={group.unit ? { value: group.unit, angle: -90, position: 'insideLeft' } : undefined}
                    />
                    <Tooltip
                      labelFormatter={(value) => formatTimestamp(String(value))}
                      formatter={(value, _name, item) => {
                        const series = seriesByKey.get(String(item.dataKey));
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
                        dot={{ r: 3 }}
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
