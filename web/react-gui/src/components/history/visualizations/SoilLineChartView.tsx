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
import { classifyHistoryChannel, displayHistorySeriesLabel, historySeriesStyles, historySeriesValue } from '../../../history/sourceIdentity';
import { HISTORY_CHART_MARGIN, formatDisplayUnit, formatTimeTick, historyTimeXAxis, historyValueYAxis } from './chartAxis';

interface SoilLineChartViewProps {
  data: HistoryCardDataResponse | undefined;
  window?: { fromMs: number; toMs: number };
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type ChartRow = { timestamp: string; tMs: number; __seriesMeta?: Record<string, { statisticAvailability?: Record<string, string>; coverageAvailability?: string | null }> } & Record<string, unknown>;
type ChartWindow = { fromMs: number; toMs: number };
export type RenderSeries = {
  key: string;
  label: string;
  unit: string;
  depthCm: number | null;
  deviceSourceId?: string | null;
  sourceKey?: string | null;
  channelKey?: string;
  points: Array<{ t: string; value: number | null; statisticAvailability?: Record<string, string>; coverageAvailability?: string | null }>;
};

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
          ? rawPoints.reduce<Array<{ t: string; value: number | null; statisticAvailability?: Record<string, string>; coverageAvailability?: string | null }>>((accumulator, point) => {
          const timestamp = validTimestamp(isRecord(point) ? point.t : null);
          if (!timestamp) return accumulator;
          accumulator.push({ t: timestamp, value: pointValue(point), statisticAvailability: isRecord(point) ? point.statisticAvailability as Record<string, string> | undefined : undefined, coverageAvailability: isRecord(point) ? typeof point.coverageAvailability === 'string' ? point.coverageAvailability : null : null });
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
  return soilSeriesMarkerIndices(series).size > 0;
}

export function soilSeriesMarkerIndices(series: RenderSeries): Set<number> {
  let visibleCount = 0;
  const visibleIndices: number[] = [];

  for (let index = 0; index < series.points.length; index += 1) {
    const point = series.points[index];
    if (point.value === null) continue;
    visibleCount += 1;
    visibleIndices.push(index);

  }

  const markers = new Set<number>();
  if (visibleCount === 1) {
    markers.add(visibleIndices[0]);
    return markers;
  }
  visibleIndices.forEach((index) => {
    if (series.points[index - 1]?.value === null || series.points[index + 1]?.value === null
    ) {
      markers.add(index);
    }
  });
  return markers;
}

export function buildNumericRows(seriesList: RenderSeries[]): ChartRow[] {
  const rows = new Map<string, ChartRow>();
  seriesList.forEach((series) => {
    series.points.forEach((point) => {
      const tMs = Date.parse(point.t);
      if (!Number.isFinite(tMs)) return;
      const row = rows.get(point.t) ?? { timestamp: point.t, tMs };
      row[series.key] = point.value;
      row.__seriesMeta ??= {};
      row.__seriesMeta[series.key] = {
        statisticAvailability: point.statisticAvailability,
        coverageAvailability: point.coverageAvailability,
      };
      rows.set(point.t, row);
    });
  });
  return [...rows.values()].sort((left, right) => left.tMs - right.tMs);
}

export function seriesPlotPoints(series: RenderSeries): Array<{ tMs: number; timestamp: string; statisticAvailability?: Record<string, string>; coverageAvailability?: string | null } & Record<string, unknown>> {
  return series.points.map((point) => ({
    tMs: Date.parse(point.t),
    timestamp: point.t,
    statisticAvailability: point.statisticAvailability,
    coverageAvailability: point.coverageAvailability,
    [series.key]: point.value,
  }));
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

export function HistorySeriesTooltip({ active, payload, label, byKey, rows }: { active?: boolean; payload?: Array<{ dataKey?: string; value?: unknown; name?: string; payload?: Record<string, unknown> }>; label?: unknown; byKey: Map<string, RenderSeries>; rows?: ChartRow[]; locale?: string }) {
  if (!active || !payload?.length) return null;
  const labelMs = Number(label);
  const targetMs = Number.isFinite(labelMs) ? labelMs : Number(payload[0]?.payload?.tMs);
  const row = rows?.find((candidate) => candidate.tMs === targetMs);
  const entries = row
    ? [...byKey.entries()]
      .filter(([key]) => Object.prototype.hasOwnProperty.call(row, key) || Boolean(row.__seriesMeta?.[key]))
      .map(([key, series]) => ({ key, series, value: row[key], metadata: row.__seriesMeta?.[key] }))
    : payload.filter((item) => Number(item.payload?.tMs) === targetMs).map((item) => ({
      key: String(item.dataKey),
      series: byKey.get(String(item.dataKey)),
      value: item.value,
      metadata: {
        statisticAvailability: item.payload?.statisticAvailability as Record<string, string> | undefined,
        coverageAvailability: item.payload?.coverageAvailability as string | null | undefined,
      },
    }));
  if (entries.length === 0) return null;
  return <div className="rounded border border-slate-200 bg-white p-2 text-xs shadow"><p className="mb-1 font-semibold">{formatTimestamp(new Date(targetMs).toISOString())}</p>{entries.map(({ key, series, value, metadata }) => { const statistics = metadata?.statisticAvailability ?? {}; const reason = statistics.latest ?? statistics.value ?? statistics.mean ?? statistics.median ?? metadata?.coverageAvailability ?? null; return <p key={key}><span className="font-semibold">{series?.label ?? 'Source'}:</span> {value === null || value === undefined ? `Unavailable${reason ? `: ${reason}` : ''}` : formatTooltipValue(value, series?.unit ?? '')}</p>; })}</div>;
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
  const styles = historySeriesStyles(visibleSeries.map((series) => series.key));
  const markerSets = new Map(visibleSeries.map((series) => [series.key, new Set([...soilSeriesMarkerIndices(series)].map((index) => Date.parse(series.points[index]?.t ?? '')))]));
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
            <svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8" className="shrink-0"><line x1="1" y1="4" x2="27" y2="4" stroke={styles.get(series.key)?.color} strokeWidth="2" strokeDasharray={styles.get(series.key)?.dash} /></svg>
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
                      filterNull={false}
                      content={<HistorySeriesTooltip byKey={group.seriesByKey} rows={group.rows} />}
                    />
                  )}
                  {group.series.map((series) => (
                    <Line
                      key={series.key}
                      type="monotone"
                      data={seriesPlotPoints(series)}
                      dataKey={series.key}
                      name={series.label}
                      stroke={styles.get(series.key)?.color}
                      strokeDasharray={styles.get(series.key)?.dash}
                      strokeWidth={2}
                      dot={(props) => {
                        const tMs = Number((props as { payload?: { tMs?: number } }).payload?.tMs);
                          return markerSets.get(series.key)?.has(tMs)
                          ? <circle cx={(props as { cx?: number }).cx} cy={(props as { cy?: number }).cy} r={3} strokeWidth={1} fill={styles.get(series.key)?.color} />
                          : <React.Fragment />;
                      }}
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
