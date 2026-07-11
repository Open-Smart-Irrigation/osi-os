import React from 'react';
import { useTranslation } from 'react-i18next';
import { useHoverCapable } from '../../../history/useHoverCapable';
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
import { HISTORY_CHART_MARGIN, consistentUnit, formatTimeTick, historyTimeXAxis, historyValueYAxis } from './chartAxis';

interface DendroGrowthTimelineViewProps {
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
  sourceId: string;
  label: string;
  unit: string;
  points: RenderPoint[];
};
type RenderEvent = {
  key: string;
  t: string;
  tMs: number;
  label: string;
  severity: HistoryEvent['severity'];
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

function normalizeSeriesList(t: HistoryTranslate, seriesList: readonly unknown[]): RenderSeries[] {
  return seriesList.map((series, index) => {
    const sourceId = normalizedText(isRecord(series) ? series.id : null) ?? '';
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
      sourceId,
      label: displaySeriesLabel(t, series, sourceId),
      unit: displayUnit(series),
      points,
    };
  });
}

/**
 * The Growth Timeline shows cumulative stem growth only. Recovery ratio, raw position,
 * and per-interval delta are different metrics on incompatible scales (they flatten the
 * growth curve against a shared axis) and live in Stress Events / Advanced instead.
 */
export function isGrowthSeries(series: { sourceId?: string; label?: string; unit?: string }): boolean {
  const unit = (series.unit ?? '').toLowerCase().trim();
  if (unit === 'um' || unit === 'µm') return true;
  const identity = `${series.sourceId ?? ''} ${series.label ?? ''}`.toLowerCase();
  if (/ratio|position|delta|shrink/.test(identity)) return false;
  return /stem|growth/.test(identity);
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

function normalizeSeverity(value: unknown): HistoryEvent['severity'] {
  if (value === 'info' || value === 'warning' || value === 'critical' || value === 'success') return value;
  return 'unknown';
}

function displayEventLabel(t: HistoryTranslate, event: unknown): string {
  const label = normalizedText(isRecord(event) ? event.label : null);
  if (label && !looksLikeRawSourceToken(label)) return label;
  return t('history.dendroTimeline.eventFallback');
}

function normalizeEvents(t: HistoryTranslate, events: unknown): RenderEvent[] {
  if (!Array.isArray(events)) return [];
  return events.reduce<RenderEvent[]>((accumulator, event, index) => {
    if (!isRecord(event)) return accumulator;
    const timestamp = validTimestamp(event.t);
    if (!timestamp) return accumulator;
    const tMs = Date.parse(timestamp);
    if (!Number.isFinite(tMs)) return accumulator;
    accumulator.push({
      key: normalizedText(event.id) ?? `dendro-event-${index}`,
      t: timestamp,
      tMs,
      label: displayEventLabel(t, event),
      severity: normalizeSeverity(event.severity),
    });
    return accumulator;
  }, []);
}

function visualWindowsEqual(left: ChartWindow | undefined, right: ChartWindow | undefined): boolean {
  return left?.fromMs === right?.fromMs && left?.toMs === right?.toMs;
}

const DendroGrowthTimelineViewComponent: React.FC<DendroGrowthTimelineViewProps> = ({
  data,
  window: chartWindow,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const hoverCapable = useHoverCapable();
  const { visibleSeries, rows, events } = React.useMemo(() => {
    const rawSeries = Array.isArray(data?.series) ? data.series : [];
    const withPoints = normalizeSeriesList(t, rawSeries).filter(hasVisiblePoints);
    const growthOnly = withPoints.filter(isGrowthSeries);
    // Safety: never blank the chart if units/identities are unexpected.
    const nextVisibleSeries = growthOnly.length > 0 ? growthOnly : withPoints;
    return {
      visibleSeries: nextVisibleSeries,
      rows: buildNumericRows(nextVisibleSeries),
      events: normalizeEvents(t, data?.events),
    };
  }, [data, t]);
  const spanMs = chartWindow
    ? chartWindow.toMs - chartWindow.fromMs
    : (rows.length ? rows[rows.length - 1].tMs - rows[0].tMs : 0);

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
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="relative min-h-0 min-w-0 flex-1"><div className="absolute inset-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={HISTORY_CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              {...historyTimeXAxis}
              domain={chartWindow ? [chartWindow.fromMs, chartWindow.toMs] : ['dataMin', 'dataMax']}
              tickFormatter={(value) => formatTimeTick(Number(value), spanMs)}
            />
            <YAxis {...historyValueYAxis(consistentUnit(visibleSeries), 48)} />
            {hoverCapable && <Tooltip isAnimationActive={false} labelFormatter={formatTimestampMs} />}
            {events.map((event) => (
              <ReferenceLine key={event.key} x={event.tMs} stroke="#b45309" strokeDasharray="4 4" />
            ))}
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

export const DendroGrowthTimelineView = React.memo(
  DendroGrowthTimelineViewComponent,
  (previous, next) => previous.data === next.data && visualWindowsEqual(previous.window, next.window),
);
