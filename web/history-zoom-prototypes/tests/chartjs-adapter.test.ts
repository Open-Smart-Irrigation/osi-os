import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_VIEWPORT,
  PLOT_INSETS,
  type SensorSeries,
} from '../src/shared/types';

type FakeChartLike = {
  canvas: HTMLCanvasElement;
  data: { datasets: unknown[] };
  options: Record<string, unknown>;
  scales: { x: { min: number; max: number; type: string } };
  chartArea: { left: number; right: number; top: number; bottom: number };
  width: number;
  height: number;
  destroyCalls: number;
  resizeCalls: number;
};

const chartState = vi.hoisted(() => ({ instances: [] as FakeChartLike[] }));

vi.mock('chart.js', () => {
  class FakeChart {
    static register() {}
    canvas: HTMLCanvasElement;
    data: { datasets: unknown[] };
    options: Record<string, unknown>;
    scales: { x: { min: number; max: number; type: string } };
    chartArea = { left: 52, right: 388, top: 16, bottom: 324 };
    width = 400;
    height = 360;
    destroyCalls = 0;
    resizeCalls = 0;

    constructor(canvas: HTMLCanvasElement, config: { data: { datasets: unknown[] }; options: Record<string, unknown> }) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      const scales = config.options.scales as { x: { min: number; max: number } };
      this.scales = { x: { min: scales.x.min, max: scales.x.max, type: 'linear' } };
      chartState.instances.push(this);
    }

    update() {
      const scales = this.options.scales as { x: { min: number; max: number } };
      this.scales.x.min = Number(scales.x.min);
      this.scales.x.max = Number(scales.x.max);
    }

    resize() {
      this.resizeCalls += 1;
      this.update();
    }

    destroy() {
      this.destroyCalls += 1;
    }
  }

  return {
    Chart: FakeChart,
    LinearScale: {},
    LineController: {},
    LineElement: {},
    PointElement: {},
  };
});

const { chartjsOptions, mountChartjs, toChartjsDatasets, formatChartjsTimeTick } = await import('../src/adapters/chartjs');

const series: readonly SensorSeries[] = [{
  id: 'swt-1', label: '20 cm', unit: 'kPa',
  points: [
    { t: 1_700_000_000_000, value: 12 },
    { t: 1_700_003_600_000, value: null },
    { t: 1_700_010_800_000, value: 0 },
  ],
}];

beforeEach(() => {
  chartState.instances.length = 0;
});

describe('Chart.js data and options', () => {
  it('formats ticks by viewport span', () => {
    const start = new Date(2026, 9, 2, 8, 0).getTime();
    expect(formatChartjsTimeTick(start, 48 * 60 * 60 * 1000)).toBe('08:00');
    expect(formatChartjsTimeTick(start, 48 * 60 * 60 * 1000 + 1)).toBe('02 Oct');
    expect(formatChartjsTimeTick(start, 90 * 24 * 60 * 60 * 1000)).toBe('02 Oct');
  });

  it('keeps epoch spacing, explicit null timestamps, and real zeroes', () => {
    const [dataset] = toChartjsDatasets(series);
    expect(dataset.data).toEqual([
      { x: 1_700_000_000_000, y: 12 },
      { x: 1_700_003_600_000, y: null },
      { x: 1_700_010_800_000, y: 0 },
    ]);
    expect(dataset.parsing).toBe(false);
    expect(dataset.spanGaps).toBe(false);
  });

  it('shows sparse markers but keeps dense series line-only', () => {
    const single = toChartjsDatasets([{ ...series[0], points: [series[0].points[0]] }])[0];
    const many = toChartjsDatasets([{ ...series[0], points: Array.from({ length: 501 }, (_, i) => ({ t: i * 1000, value: 20 })) }])[0];
    expect((single.pointRadius as (context: { dataset: { data: unknown[] } }) => number)({ dataset: { data: single.data as unknown[] } })).toBe(2);
    expect((many.pointRadius as (context: { dataset: { data: unknown[] } }) => number)({ dataset: { data: many.data as unknown[] } })).toBe(0);
  });

  it('uses proportional epoch time and fixed y', () => {
    const options = chartjsOptions(INITIAL_VIEWPORT, vi.fn());
    expect(options.scales?.x).toMatchObject({ type: 'linear', min: INITIAL_VIEWPORT.from, max: INITIAL_VIEWPORT.to });
    expect(options.scales?.x?.ticks).toMatchObject({ autoSkip: true, maxTicksLimit: 4, maxRotation: 0 });
    expect(options.scales?.y).toMatchObject({ type: 'linear', min: 0, max: 100 });
    expect((options.plugins as Record<string, unknown> | undefined)?.zoom).toBeUndefined();
  });

  it('pins chart-area insets and disables interpolation and animation', () => {
    const options = chartjsOptions(INITIAL_VIEWPORT, vi.fn());
    expect(options.animation).toBe(false);
    expect(options.plugins?.legend?.display).toBe(false);
    expect(options.plugins?.tooltip?.enabled).toBe(false);
    expect(options.layout).toEqual({ autoPadding: false, padding: { top: PLOT_INSETS.top, right: PLOT_INSETS.right } });
    expect(options.layout?.autoPadding).toBe(false);
    const x = options.scales?.x;
    const y = options.scales?.y;
    if (!x || !y || typeof x === 'string' || typeof y === 'string') throw new Error('scales missing');
    const xAxis = { height: 0 };
    const yAxis = { width: 0 };
    x.afterFit?.(xAxis as never);
    y.afterFit?.(yAxis as never);
    expect(xAxis.height).toBe(PLOT_INSETS.bottom);
    expect(yAxis.width).toBe(PLOT_INSETS.left);
  });

  it('aligns edge ticks inward so labels cannot expand the fixed plot area', () => {
    const options = chartjsOptions(INITIAL_VIEWPORT, vi.fn());
    const x = options.scales?.x;
    if (!x || typeof x === 'string') throw new Error('x scale missing');
    expect(x.ticks?.align).toBe('inner');
  });
});

describe('Chart.js adapter lifecycle', () => {
  it('mounts empty, reads renderer state, and does not echo setViewport', () => {
    const host = document.createElement('div');
    const notify = vi.fn();
    const adapter = mountChartjs(host, INITIAL_VIEWPORT, notify);
    expect(host.querySelectorAll('canvas[data-chart="chartjs"]')).toHaveLength(1);
    expect(adapter.getViewport()).toEqual(INITIAL_VIEWPORT);
    const shifted = { from: INITIAL_VIEWPORT.from - 6 * 60 * 60 * 1000, to: INITIAL_VIEWPORT.to - 6 * 60 * 60 * 1000 };
    adapter.setViewport(shifted);
    expect(adapter.getViewport()).toEqual(shifted);
    expect(notify).not.toHaveBeenCalled();
  });

  it('updates tick formatting when the viewport changes span', () => {
    const adapter = mountChartjs(document.createElement('div'), INITIAL_VIEWPORT, vi.fn());
    const chart = chartState.instances.at(-1)!;
    const ticks = chart.options.scales as { x: { ticks: { callback: (value: string | number) => string } } };
    expect(ticks.x.ticks.callback(new Date(2026, 9, 2, 8, 0).getTime())).toBe('08:00');
    adapter.setViewport({ from: INITIAL_VIEWPORT.from, to: INITIAL_VIEWPORT.from + 90 * 24 * 60 * 60 * 1000 });
    expect(ticks.x.ticks.callback(new Date(2026, 9, 2, 8, 0).getTime())).toBe('02 Oct');
  });

  it('keeps the plot rectangle fixed across 24-hour and 90-day spans', () => {
    const adapter = mountChartjs(document.createElement('div'), INITIAL_VIEWPORT, vi.fn());
    const shortRect = adapter.getPlotRect().toJSON();
    adapter.setViewport({ from: INITIAL_VIEWPORT.from, to: INITIAL_VIEWPORT.from + 90 * 24 * 60 * 60 * 1000 });
    expect(adapter.getPlotRect().toJSON()).toEqual(shortRect);
  });

  it('retains the live viewport through data replacement and resize without notifications', () => {
    const notify = vi.fn();
    const adapter = mountChartjs(document.createElement('div'), INITIAL_VIEWPORT, notify);
    const chart = chartState.instances.at(-1)!;
    chart.scales.x.min -= 7_200_000;
    chart.scales.x.max -= 7_200_000;
    const before = adapter.getViewport();
    adapter.setData(series);
    adapter.resize();
    expect(adapter.getViewport()).toEqual(before);
    expect(chart.data.datasets).toEqual(toChartjsDatasets(series));
    expect(chart.resizeCalls).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('returns the real viewport plot rectangle after backing-store scaling', () => {
    const adapter = mountChartjs(document.createElement('div'), INITIAL_VIEWPORT, vi.fn());
    const chart = chartState.instances.at(-1)!;
    vi.spyOn(chart.canvas, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 740, width: 800, height: 720, toJSON: () => ({}) });
    expect(adapter.getPlotRect().toJSON()).toMatchObject({ x: 114, y: 52, width: 672, height: 616 });
  });

  it('destroys Chart.js and removes the canvas exactly once', () => {
    const host = document.createElement('div');
    const adapter = mountChartjs(host, INITIAL_VIEWPORT, vi.fn());
    const chart = chartState.instances.at(-1)!;
    adapter.destroy();
    adapter.destroy();
    expect(chart.destroyCalls).toBe(1);
    expect(host.querySelector('canvas')).toBeNull();
  });
});
