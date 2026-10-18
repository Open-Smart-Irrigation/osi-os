import React from 'react';
import { useTranslation } from 'react-i18next';
import { useHoverCapable } from '../../../history/useHoverCapable';
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
import { classifyHistoryChannel, displayHistorySeriesLabel, historySeriesColor, historySeriesDash, historySeriesValue } from '../../../history/sourceIdentity';
import { HISTORY_CHART_MARGIN, formatDisplayUnit, formatTimeTick, historyTimeXAxis, historyValueYAxis } from './chartAxis';

interface SoilLineChartViewProps {
  data: HistoryCardDataResponse | undefined;
  window?: { fromMs: number; toMs: number };
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type ChartRow = { timestamp: string; tMs: number } & Record<string, number | string | null>;
type ChartWindow = { fromMs: number; toMs: number };
export type RenderSeries = {
  key: string;
  label: string;
  unit: string;
  depthCm: number | null;
  deviceSourceId?: string | null;
  sourceKey?: string | null;
  channelKey?: string;
  points: Array<{ t: string; value: number | null }>;
};

const MAX_CONTINUOUS_GAP_MS = 90 * 60 * 1000;

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
  return historySeriesValue(point);
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

function formatDepthLabel(depthCm: number): string {
  return `${Number.isInteger(depthCm) ? String(depthCm) : depthCm.toFixed(1)} cm`;
}

function seriesDepthCm(series: unknown): number | null {
  if (!isRecord(series)) return null;
  return finiteNumber(series.depthCm) ?? finiteNumber(series.depth_cm);
}

function depthKey(depthCm: number | null): string | null {
  return depthCm === null ? null : String(depthCm);
}

function fallbackSeriesLabel(t: HistoryTranslate, index: number): string {
  return t('history.soilLineChart.series.sensor', { index: index + 1, defaultValue: `Sensor ${index + 1}` });
}

export function soilSeriesDisplayLabel(
  t: HistoryTranslate,
  series: unknown,
  index: number,
  duplicateDepth = false,
): string {
  const depthCm = seriesDepthCm(series);
  if (depthCm !== null) {
    const depthLabel = formatDepthLabel(depthCm);
    return duplicateDepth
      ? `${depthLabel} - ${fallbackSeriesLabel(t, index)}`
      : depthLabel;
  }

  const label = normalizedText(isRecord(series) ? series.label : null);
  if (label && !looksLikeRawSourceToken(label)) return label;
  return fallbackSeriesLabel(t, index);
}

function displayUnit(series: unknown): string {
  const unit = normalizedText(isRecord(series) ? series.unit : null);
  if (unit && !looksLikeRawSourceToken(unit)) return unit;
  const channelKey = normalizedText(isRecord(series) ? series.channelKey : null)?.toLowerCase();
  return channelKey && /^(vwc)(?:_\d+)?$/.test(channelKey) ? '%' : 'kPa';
}

function normalizeSeriesList(t: HistoryTranslate, seriesList: readonly unknown[]): RenderSeries[] {
  const records = seriesList.filter(isRecord);
  const depthCounts = new Map<string, number>();
  seriesList.forEach((series) => {
    const key = depthKey(seriesDepthCm(series));
    if (key) depthCounts.set(key, (depthCounts.get(key) ?? 0) + 1);
  });

  return seriesList.map((series, index) => {
    if (isRecord(series) && typeof series.channelKey === 'string' && series.channelKey && classifyHistoryChannel(series.channelKey) !== 'soil') return null;
    const rawPoints = isRecord(series) ? series.points : null;
    const seriesDepth = seriesDepthCm(series);
    const duplicateDepth = (depthCounts.get(depthKey(seriesDepth) ?? '') ?? 0) > 1;
    const points = Array.isArray(rawPoints)
      ? rawPoints.reduce<Array<{ t: string; value: number | null }>>((accumulator, point) => {
          const timestamp = validTimestamp(isRecord(point) ? point.t : null);
          if (!timestamp) return accumulator;
          accumulator.push({ t: timestamp, value: pointValue(point) });
          return accumulator;
        }, [])
      : [];
    const id = normalizedText(isRecord(series) ? series.id : null) ?? `series-${index}`;
    const sourceAwareLabel = isRecord(series) && (normalizedText(series.sourceLabel) || normalizedText(series.deviceSourceId))
      ? displayHistorySeriesLabel(series, records)
      : soilSeriesDisplayLabel(t, series, index, duplicateDepth);
    return {
      key: id,
      label: sourceAwareLabel,
      unit: displayUnit(series),
      depthCm: seriesDepth,
      deviceSourceId: normalizedText(isRecord(series) ? series.deviceSourceId : null),
      sourceKey: normalizedText(isRecord(series) ? series.sourceKey : null),
      channelKey: normalizedText(isRecord(series) ? series.channelKey : null) ?? '',
      points,
    };
  }).filter(Boolean) as RenderSeries[];
}

function hasVisiblePoints(series: RenderSeries): boolean {
  return series.points.some((point) => point.value !== null);
}

export function soilSeriesShouldShowDots(series: RenderSeries): boolean {
  let previousVisibleIndex: number | null = null;
  let previousVisibleMs: number | null = null;
  let visibleCount = 0;

  for (let index = 0; index < series.points.length; index += 1) {
    const point = series.points[index];
    if (point.value === null) continue;
    const currentMs = Date.parse(point.t);
    if (!Number.isFinite(currentMs)) continue;

    visibleCount += 1;
    if (previousVisibleIndex !== null && previousVisibleMs !== null) {
      if (index - previousVisibleIndex > 1) return true;
      if (currentMs - previousVisibleMs > MAX_CONTINUOUS_GAP_MS) return true;
    }

    previousVisibleIndex = index;
    previousVisibleMs = currentMs;
  }

  return visibleCount === 1;
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

export function seriesPlotPoints(series: RenderSeries): Array<{ tMs: number } & Record<string, number | null>> {
  return series.points
    .map((point) => ({ tMs: Date.parse(point.t), [series.key]: point.value }))
    .filter((point) => Number.isFinite(point.tMs));
}

function groupSeriesByUnit(seriesList: RenderSeries[]): Array<{ unit: string; series: RenderSeries[] }> {
  const groups = new Map<string, RenderSeries[]>();
  seriesList.forEach((series) => {
    const unit = series.unit || 'unitless';
    groups.set(unit, [...(groups.get(unit) ?? []), series]);
  });
  return [...groups.entries()].map(([unit, series]) => ({ unit: unit === 'unitless' ? '' : unit, series }));
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '-';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${formatDisplayUnit(unit)}` : formatted;
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
  const hoverCapable = useHoverCapable();
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
      <div data-testid="history-series-legend" className="mb-3 flex flex-wrap gap-2">
        {visibleSeries.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-2 rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)]">
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: historySeriesColor(series.key) }} />
            {series.label}
          </span>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {groups.map((group) => (
          <div key={group.unit || 'unitless'} className="relative min-h-0 min-w-0 flex-1">
            {groups.length > 1 && group.unit && (
              <h4 className="mb-1 text-xs font-semibold text-[var(--text-tertiary)]">{group.unit}</h4>
            )}
            <div className="absolute inset-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={group.rows} margin={HISTORY_CHART_MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    {...historyTimeXAxis}
                    domain={chartWindow ? [chartWindow.fromMs, chartWindow.toMs] : ['dataMin', 'dataMax']}
                    tickFormatter={(value) => formatTimeTick(Number(value), spanMs)}
                  />
                  <YAxis {...historyValueYAxis(group.unit || undefined, 52)} />
                  {hoverCapable && (
                    <Tooltip
                      isAnimationActive={false}
                      labelFormatter={formatTimestampMs}
                      formatter={(value, _name, item) => {
                        const series = group.seriesByKey.get(String(item.dataKey));
                        return [formatTooltipValue(value, series?.unit ?? ''), series?.label ?? t('history.soilLineChart.series.soil')];
                      }}
                    />
                  )}
                  {group.series.map((series) => (
                    <Line
                      key={series.key}
                      type="monotone"
                      data={seriesPlotPoints(series)}
                      dataKey={series.key}
                      name={series.label}
                      stroke={historySeriesColor(series.key)}
                      strokeDasharray={historySeriesDash(series.key)}
                      strokeWidth={2}
                      dot={soilSeriesShouldShowDots(series) ? { r: 3, strokeWidth: 1 } : false}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

export const SoilLineChartView = React.memo(
  SoilLineChartViewComponent,
  (previous, next) => previous.data === next.data && visualWindowsEqual(previous.window, next.window),
);
