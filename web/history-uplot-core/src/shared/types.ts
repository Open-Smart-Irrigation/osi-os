export type HistoryAggregation = 'raw' | '15m' | 'hourly' | 'daily';

export interface Viewport {
  from: number;
  to: number;
}

export type ViewportSource = 'gesture' | 'external';

export interface Point {
  t: number;
  value: number | null;
}

export interface SeriesAppearance {
  color: string;
  dash: readonly number[];
  marker: 'circle' | 'square' | 'triangle' | 'diamond';
}

export interface SensorSeries {
  id: string;
  label: string;
  unit: string;
  points: readonly Point[];
  appearance?: SeriesAppearance;
}

export interface HistoryUnitGroup {
  unit: string;
  label: string;
  seriesIds: readonly string[];
}

export interface HistoryWindowContext {
  sessionKey: string;
  scopeKey: string;
  cardId: string;
  sourceKey?: string | null;
}

export interface HistoryWindowRequest {
  from: number;
  to: number;
  rangeLabel: '24h' | '7d' | '30d';
  aggregation: HistoryAggregation;
}

export interface HistoryWindowResponse {
  cardId?: string;
  request: HistoryWindowRequest;
  coverage: { from: number; to: number };
  series: readonly SensorSeries[];
  unitGroups: readonly HistoryUnitGroup[];
  aggregation: {
    level: string;
    pointCount: number;
    coveragePct?: number | null;
  };
  limits: { maxPointsPerSeries: number; truncated: boolean };
  freshness?: { dataAsOf?: string | null; syncState?: string | null };
}

export interface HistoryWindowOptions {
  enabled: boolean;
  context: HistoryWindowContext | null;
  load(request: HistoryWindowRequest, signal: AbortSignal): Promise<HistoryWindowResponse>;
  now?: () => number;
  navigationStartMs?: number;
  initialViewport?: Viewport;
  minSpanMs?: number;
  loader?: import('../history/types').HistoryLoader;
  onAuthError?: (error: unknown) => void;
}

export type HistoryWindowReason =
  | 'initial'
  | 'gesture'
  | 'preset'
  | 'back'
  | 'forward'
  | 'latest'
  | 'retry'
  | 'visibility'
  | 'prefetch';

export interface ChartAdapter {
  setData(series: readonly SensorSeries[]): void;
  setFocusedSeries?(id: string | null): void;
  setViewport(viewport: Viewport): void;
  getViewport(): Viewport;
  getPlotRect(): DOMRectReadOnly;
  resize(): void;
  destroy(): void;
}

export interface ChartRenderOptions {
  extent?: Viewport;
  minSpanMs?: number;
  maxSpanMs?: number;
  yRange?: 'fixed-0-100' | 'auto';
}

export interface CoverageWindow {
  from: number;
  to: number;
}

export type MountAdapter = (
  host: HTMLElement,
  initial: Viewport,
  onViewportChange: (viewport: Viewport) => void,
  options?: ChartRenderOptions,
) => ChartAdapter;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const HISTORY_MAX_VIEWPORT_SPAN_MS = 90 * DAY_MS;
export const MIN_SPAN_MS = HOUR_MS;
export const MAX_SPAN_MS = HISTORY_MAX_VIEWPORT_SPAN_MS;
export const CHART_HEIGHT = 360;
export const PLOT_INSETS = { top: 16, right: 12, bottom: 36, left: 52 } as const;
export const SERIES_COLORS = ['#2563eb', '#059669', '#d97706'] as const;

export const DEFAULT_HISTORY_HORIZON: Viewport = {
  from: 0,
  to: Date.now(),
};
export const INITIAL_VIEWPORT: Viewport = {
  from: Date.now() - DAY_MS,
  to: Date.now(),
};
