import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type {
  ChartAdapter,
  MountAdapter,
  SensorSeries,
  Viewport,
  ChartRenderOptions,
} from '../shared/types';
import {
  CHART_HEIGHT,
  PLOT_INSETS,
} from '../shared/types';
import { getSeriesAppearance } from '../shared/seriesAppearance';
import { toUplotData } from './uplot-data';

const EMPTY_DATA: uPlot.AlignedData = [[]];
const MAX_MARKER_POINTS = 500;

const timeTick = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateTick = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
});

export function formatUplotTimeTick(value: number, min: number, max: number, locale = 'en-GB', timeZone?: string): string {
  const date = new Date(value * 1_000);
  const formatter = max - min <= 48 * 60 * 60 ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }) : new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone });
  return formatter.format(date);
}

function seconds(viewport: Viewport): { min: number; max: number } {
  return { min: viewport.from / 1_000, max: viewport.to / 1_000 };
}

function seriesKey(series: readonly SensorSeries[]): string {
  return series
    .map((item) =>
      `${item.id}\u0000${item.label}\u0000${item.unit}\u0000${item.points.length <= MAX_MARKER_POINTS}` +
      `\u0000${item.appearance?.color ?? ''}\u0000${item.appearance?.dash.join(',') ?? ''}\u0000${item.appearance?.marker ?? ''}`,
    )
    .join('\u0001');
}

export function markerPaths(marker: NonNullable<SensorSeries['appearance']>['marker']): uPlot.Series.Points.PathBuilder {
  return (u, seriesIdx, idx0, idx1) => {
    const xs = u.data[0] as ArrayLike<number>;
    const ys = u.data[seriesIdx] as ArrayLike<number | null | undefined>;
    const radius = 3 * uPlot.pxRatio;
    const fill = new Path2D();
    const clip = new Path2D();
    clip.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    for (let index = idx0; index <= idx1; index += 1) {
      const xValue = xs[index];
      const yValue = ys[index];
      if (!Number.isFinite(xValue) || yValue == null || !Number.isFinite(yValue)) continue;
      const x = u.valToPos(xValue, 'x', true);
      const y = u.valToPos(yValue, u.series[seriesIdx].scale ?? 'y', true);
      if (marker === 'circle') {
        fill.moveTo(x + radius, y);
        fill.arc(x, y, radius, 0, Math.PI * 2);
        fill.closePath();
      }
      else if (marker === 'square') fill.rect(x - radius, y - radius, radius * 2, radius * 2);
      else if (marker === 'triangle') {
        fill.moveTo(x, y - radius);
        fill.lineTo(x + radius, y + radius);
        fill.lineTo(x - radius, y + radius);
        fill.closePath();
      } else {
        fill.moveTo(x, y - radius);
        fill.lineTo(x + radius, y);
        fill.lineTo(x, y + radius);
        fill.lineTo(x - radius, y);
        fill.closePath();
      }
    }
    return { fill, clip };
  };
}

function clampFinite(value: number): number {
  return Math.min(Number.MAX_VALUE, Math.max(-Number.MAX_VALUE, value));
}

function autoYRange(series: readonly SensorSeries[]): [number, number] {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const item of series) {
    for (const point of item.points) {
      const value = point.value;
      if (value == null || !Number.isFinite(value)) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  if (low === Number.POSITIVE_INFINITY) return [0, 1];
  if (low === high) {
    const padding = Math.max(Math.abs(low) * Number.EPSILON, 1);
    let lower = clampFinite(low - padding);
    let upper = clampFinite(high + padding);
    if (!(lower < upper)) {
      if (low === Number.MAX_VALUE) lower = low - padding;
      else upper = high + padding;
    }
    return [lower, upper];
  }
  const span = high - low;
  if (!Number.isFinite(span)) return [low, high];
  const padding = Math.max(span * 0.05, Number.MIN_VALUE);
  const lower = clampFinite(low - padding);
  const upper = clampFinite(high + padding);
  return lower < upper ? [lower, upper] : [low, high];
}

export const mountUplot: MountAdapter = (
  host,
  initial,
  onViewportChange,
  options: ChartRenderOptions = {},
): ChartAdapter => {
  void onViewportChange;

  let cachedYRange: [number, number] = [0, 1];
  const plot = new uPlot(
    {
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight || CHART_HEIGHT),
      ms: 1e-3,
      padding: [PLOT_INSETS.top, PLOT_INSETS.right, 0, 0],
      legend: { show: false },
      cursor: {
        show: false,
        drag: { setScale: false, x: false, y: false },
      },
      focus: { alpha: 0.3 },
      scales: {
        x: { time: true, auto: false },
        y: options.yRange === 'auto' ? { auto: true, range: () => cachedYRange } : { auto: false, range: [0, 100] },
      },
      axes: [
        {
          size: PLOT_INSETS.bottom,
          space: 64,
          values: (u, values) => {
            const min = u.scales.x.min ?? values[0] ?? 0;
            const max = u.scales.x.max ?? values[values.length - 1] ?? min;
            return values.map((value) => formatUplotTimeTick(value, min, max, options.locale, options.timeZone));
          },
        },
        { size: PLOT_INSETS.left },
      ],
      series: [{}],
    },
    EMPTY_DATA,
    host,
  );

  let mountedSeriesKey = '';
  let currentSeries: readonly SensorSeries[] = [];
  let focusedSeriesId: string | null = null;
  let destroyed = false;

  function applyViewport(viewport: Viewport): void {
    plot.batch(() => {
      plot.setScale('x', seconds(viewport));
    });
  }

  function readViewport(): Viewport {
    const { min, max } = plot.scales.x;
    if (min == null || max == null) {
      throw new Error('uPlot x scale is unavailable');
    }
    return { from: min * 1_000, to: max * 1_000 };
  }

  function reconcileSeries(series: readonly SensorSeries[]): void {
    currentSeries = series;
    const nextKey = seriesKey(series);
    if (nextKey === mountedSeriesKey) return;

    for (let index = plot.series.length - 1; index >= 1; index -= 1) {
      plot.delSeries(index);
    }

    series.forEach((item, index) => {
      plot.addSeries({
        label: `${item.label} (${item.unit})`,
        stroke: (item.appearance ?? getSeriesAppearance(index)).color,
        dash: [...(item.appearance ?? getSeriesAppearance(index)).dash],
        width: 2,
        spanGaps: false,
        points: {
          show: item.points.length <= MAX_MARKER_POINTS,
          size: 4,
          width: 0,
          fill: (item.appearance ?? getSeriesAppearance(index)).color,
          stroke: (item.appearance ?? getSeriesAppearance(index)).color,
          paths: markerPaths((item.appearance ?? getSeriesAppearance(index)).marker),
        },
      });
    });

    mountedSeriesKey = nextKey;
    applyFocus();
  }

  function applyFocus(): void {
    plot.setSeries(null, { focus: false });
    if (focusedSeriesId == null) return;
    const index = currentSeries.findIndex((item) => item.id === focusedSeriesId);
    if (index >= 0) plot.setSeries(index + 1, { focus: true });
  }

  applyViewport(initial);

  return {
    setData(series) {
      if (options.yRange === 'auto') cachedYRange = autoYRange(series);
      reconcileSeries(series);
      const visible = readViewport();
      plot.setData(toUplotData(series), false);
      applyViewport(visible);
    },
    setFocusedSeries(id) {
      focusedSeriesId = id;
      applyFocus();
    },
    setViewport(viewport) {
      applyViewport(viewport);
    },
    getViewport() {
      return readViewport();
    },
    getPlotRect() {
      return plot.over.getBoundingClientRect();
    },
    resize() {
      const visible = readViewport();
      plot.setSize({
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight || CHART_HEIGHT),
      });
      applyViewport(visible);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      plot.destroy();
    },
  };
};

export default mountUplot;
