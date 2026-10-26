import {
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  type ChartDataset,
  type ChartOptions,
} from 'chart.js';
import {
  PLOT_INSETS,
  SERIES_COLORS,
  type ChartAdapter,
  type MountAdapter,
  type SensorSeries,
  type Viewport,
} from '../shared/types';
import { sameViewport } from '../shared/viewport';

Chart.register(LineController, LineElement, PointElement, LinearScale);

type NullablePoint = { x: number; y: number | null };
type PointRadiusContext = { dataset: { data: unknown[] } };

const pointRadius = (context: PointRadiusContext): number =>
  context.dataset.data.length <= 500 ? 2 : 0;

const SHORT_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const LONG_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short',
});

export function formatChartjsTimeTick(value: string | number, spanMs: number): string {
  return (spanMs <= 48 * 60 * 60 * 1000 ? SHORT_TIME_FORMATTER : LONG_DATE_FORMATTER).format(new Date(Number(value)));
}

function buildTicks(viewport: Viewport): Record<string, unknown> {
  return {
    align: 'inner',
    callback: (value: string | number) => formatChartjsTimeTick(value, viewport.to - viewport.from),
    maxRotation: 0,
    autoSkip: true,
    maxTicksLimit: 4,
  };
}

export function toChartjsDatasets(series: readonly SensorSeries[]): ChartDataset<'line'>[] {
  return series.map((sensor, index) => ({
    label: `${sensor.label} (${sensor.unit})`,
    data: sensor.points.map((point): NullablePoint => ({ x: point.t, y: point.value })) as unknown as ChartDataset<'line'>['data'],
    parsing: false,
    normalized: false,
    spanGaps: false,
    pointRadius,
    pointHitRadius: 8,
    borderWidth: 2,
    borderColor: SERIES_COLORS[index % SERIES_COLORS.length],
    backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length],
  }));
}

function rendererViewport(chart: Pick<Chart, 'scales'>): Viewport {
  const x = chart.scales.x;
  if (!x || !Number.isFinite(x.min) || !Number.isFinite(x.max)) {
    throw new Error('Chart.js x scale has no finite rendered viewport');
  }
  return { from: x.min, to: x.max };
}

export function chartjsOptions(
  initial: Viewport,
  _onViewportChange: (viewport: Viewport) => void,
): ChartOptions<'line'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    layout: { autoPadding: false, padding: { top: PLOT_INSETS.top, right: PLOT_INSETS.right } },
    interaction: { intersect: false, mode: 'nearest' },
    scales: {
      x: {
        type: 'linear',
        min: initial.from,
        max: initial.to,
        bounds: 'ticks',
        afterFit(axis) {
          axis.height = PLOT_INSETS.bottom;
        },
        ticks: buildTicks(initial),
      },
      y: {
        type: 'linear',
        min: 0,
        max: 100,
        afterFit(axis) {
          axis.width = PLOT_INSETS.left;
        },
        title: { display: false },
      },
    },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  };
}

export const mountChartjs: MountAdapter = (host, initial, onViewportChange): ChartAdapter => {
  void onViewportChange;
  const canvas = document.createElement('canvas');
  canvas.dataset.chart = 'chartjs';
  host.replaceChildren(canvas);

  let destroyed = false;
  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    options: chartjsOptions(initial, onViewportChange),
  });

  const assertLive = () => {
    if (destroyed) throw new Error('Chart.js adapter is destroyed');
  };

  return {
    setData(nextSeries) {
      assertLive();
      const before = rendererViewport(chart);
      chart.data.datasets = toChartjsDatasets(nextSeries);
      chart.options.scales!.x!.min = before.from;
      chart.options.scales!.x!.max = before.to;
      chart.update('none');
    },
    setViewport(viewport) {
      assertLive();
      if (sameViewport(rendererViewport(chart), viewport)) return;
      chart.options.scales!.x!.min = viewport.from;
      chart.options.scales!.x!.max = viewport.to;
      chart.options.scales!.x!.ticks = buildTicks(viewport);
      chart.update('none');
    },
    getViewport() {
      assertLive();
      return rendererViewport(chart);
    },
    getPlotRect() {
      assertLive();
      const bounds = canvas.getBoundingClientRect();
      const area = chart.chartArea;
      const xRatio = bounds.width / chart.width;
      const yRatio = bounds.height / chart.height;
      return new DOMRectReadOnly(
        bounds.left + area.left * xRatio,
        bounds.top + area.top * yRatio,
        (area.right - area.left) * xRatio,
        (area.bottom - area.top) * yRatio,
      );
    },
    resize() {
      assertLive();
      const before = rendererViewport(chart);
      chart.resize();
      chart.options.scales!.x!.min = before.from;
      chart.options.scales!.x!.max = before.to;
      chart.update('none');
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      chart.destroy();
      canvas.remove();
    },
  };
};

export default mountChartjs;
