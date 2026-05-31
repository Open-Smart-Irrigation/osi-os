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
  HistorySeries,
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

const SERIES_COLORS = ['#0284c7', '#16a34a', '#ca8a04', '#7c3aed', '#dc2626', '#0891b2'];
const DEVICE_EUI_PATTERN = /\b[A-F0-9]{16}\b/i;

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

function fallbackSeriesLabel(t: HistoryTranslate, series: HistorySeries): string {
  const normalized = `${series.id} ${series.label}`.toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.includes('humidity')) return t('history.environmentLineChart.series.humidity');
  if (normalized.includes('rain') || normalized.includes('precip')) return t('history.environmentLineChart.series.rain');
  if (normalized.includes('light') || normalized.includes('lux') || normalized.includes('illuminance')) {
    return t('history.environmentLineChart.series.light');
  }
  if (normalized.includes('temp')) return t('history.environmentLineChart.series.airTemperature');
  return t('history.environmentLineChart.series.environment');
}

function displaySeriesLabel(t: HistoryTranslate, series: HistorySeries): string {
  const label = series.label.trim();
  if (label && !label.includes('env-src-') && !label.includes('_') && !DEVICE_EUI_PATTERN.test(label)) {
    return label;
  }
  return fallbackSeriesLabel(t, series);
}

function displayUnit(series: HistorySeries): string {
  return series.unit?.trim() || series.points.find((point) => point.unit?.trim())?.unit?.trim() || '';
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatTooltipValue(value: unknown, unit: string): string {
  if (typeof value === 'number') return formatValue(value, unit);
  if (typeof value === 'string') {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return formatValue(numericValue, unit);
    return value;
  }
  return '-';
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

export const EnvironmentLineChartView: React.FC<EnvironmentLineChartViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const visibleSeries = (data?.series ?? []).filter(hasVisiblePoints);
  const rows = buildRows(visibleSeries);
  const seriesById = new Map(visibleSeries.map((series) => [series.id, series]));

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
            <Tooltip
              labelFormatter={(value) => formatTimestamp(String(value))}
              formatter={(value, _name, item) => {
                const series = seriesById.get(String(item.dataKey));
                return [
                  formatTooltipValue(value, series ? displayUnit(series) : ''),
                  series ? displaySeriesLabel(t, series) : String(_name),
                ];
              }}
            />
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
    </section>
  );
};
