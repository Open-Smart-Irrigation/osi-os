export interface Viewport {
  from: number;
  to: number;
}

export interface Point {
  t: number;
  value: number | null;
}

export interface SensorSeries {
  id: string;
  label: string;
  unit: string;
  points: readonly Point[];
}

export interface ChartAdapter {
  setData(series: readonly SensorSeries[]): void;
  setViewport(viewport: Viewport): void;
  getViewport(): Viewport;
  getPlotRect(): DOMRectReadOnly;
  resize(): void;
  destroy(): void;
}

export interface ChartRenderOptions {
  extent?: Viewport;
  minSpanMs?: number;
  yRange?: 'fixed-0-100' | 'auto';
}

export type MountAdapter = (
  host: HTMLElement,
  initial: Viewport,
  onViewportChange: (viewport: Viewport) => void,
  options?: ChartRenderOptions,
) => ChartAdapter;

export type Candidate = 'echarts' | 'uplot' | 'chartjs';
export type FixtureKind = 'nominal' | 'sparse' | 'stress' | 'empty' | 'single';
export type ViewportSource = 'gesture' | 'external';

export interface FrameSummary {
  sampleCount: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  over16_7: number;
  over33_3: number;
}

export interface HistoryZoomProbe {
  route: Candidate;
  requestedViewport: Viewport;
  renderedViewport: Viewport;
  plotRect: { left: number; top: number; width: number; height: number };
  adapterSetViewportCalls: number;
  viewportNotifications: number;
  reactRenderCount: number;
  frameSamples: readonly FrameSummary[];
  startFrameSampling(): void;
  stopFrameSampling(): FrameSummary;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const FIXTURE_START = Date.UTC(2026, 6, 1);
export const FIXTURE_EXTENT = {
  from: FIXTURE_START,
  to: FIXTURE_START + 90 * DAY_MS,
} as const;
export const INITIAL_VIEWPORT = {
  from: FIXTURE_EXTENT.to - DAY_MS,
  to: FIXTURE_EXTENT.to,
} as const;
export const MIN_SPAN_MS = HOUR_MS;
export const MAX_SPAN_MS = FIXTURE_EXTENT.to - FIXTURE_EXTENT.from;
export const PLOT_INSETS = { top: 16, right: 12, bottom: 36, left: 52 } as const;
export const CHART_HEIGHT = 360;
export const SERIES_COLORS = ['#2563eb', '#059669', '#d97706'] as const;
export const SUITABILITY_CRITERIA = [
  'pinch-step-invariance',
  'moving-anchor',
  'pinch-axis-orientation',
  'reverse-pinch',
  'initial-pan',
  'partial-lift-id-1',
  'partial-lift-id-2',
  'cancel-recovery',
  'device-orientation-resize',
] as const;
