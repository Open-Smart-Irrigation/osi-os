export type HistoryAggregation = 'raw' | '15m' | 'hourly' | 'daily';
export type HistoryReadPolicy = 'card-default' | 'edge-hourly' | 'cloud-raw-hourly' | 'cloud-rollup-hourly';

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
  buckets?: readonly MobileBucket[];
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
  readPolicy?: HistoryReadPolicy;
  selectionKey?: string;
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
  readPolicy?: HistoryReadPolicy;
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
  rangeStrategy?: import('../history/rangeStrategy').HistoryRangeStrategy;
  viewportIdentity?: string;
  maxSpanMs?: number;
  readPolicy?: (request: HistoryWindowRequest) => Exclude<HistoryReadPolicy, 'card-default'> | HistoryReadPolicy;
  selectedIds?: readonly string[];
  onDiagnostics?: (snapshot: HistoryDiagnostics) => void;
}

export interface HistoryDiagnostics {
  reason: HistoryWindowReason;
  foregroundActive: boolean;
  prefetchActive: boolean;
  entries: number;
  points: number;
}

export interface MobileSelectionState {
  selectedIds: readonly string[];
  displayedIds: readonly string[];
  requestRevision: number;
}

export interface MobileTensionSource {
  seriesId: string;
  sourceKey: string;
  channelKey: string;
  label: string;
  unit: 'kPa';
  zoneId: string;
  deviceId?: string;
  depthCm?: number | null;
  available: boolean;
  legacy?: boolean;
  status?: 'current' | 'other_supported' | 'unknown';
  measurementKind?: 'soil' | 'other';
}

export interface MobileBucket {
  from: number;
  to: number;
  value: number | null;
  count: number;
  quality: string | null;
}

export interface MobileAnalysisSeries {
  seriesId: string;
  buckets: readonly MobileBucket[];
  latestFiniteBucket: number | null;
}

export interface MobileAnalysisWindow {
  series: readonly MobileAnalysisSeries[];
  coverage: { from: number; to: number };
  complete: boolean;
  invalidHourlyAverageCount: number;
}

export interface MobileNormalizedResponse {
  response: HistoryWindowResponse;
  window: MobileAnalysisWindow;
}

export type MobileHistoryFailureKind = 'auth' | 'size' | 'missing' | 'protocol' | 'transient';
export interface MobileHistoryFailure {
  kind: MobileHistoryFailureKind;
  status?: number;
  missingIds?: readonly string[];
  reason: string;
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
  locale?: string;
  timeZone?: string;
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
