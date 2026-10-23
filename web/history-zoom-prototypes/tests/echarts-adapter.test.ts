import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_VIEWPORT,
  PLOT_INSETS,
  type SensorSeries,
  type Viewport,
} from '../src/shared/types';

type EchartsOption = {
  animation?: boolean;
  grid?: Record<string, unknown>;
  xAxis?: Record<string, unknown>;
  yAxis?: Record<string, unknown>;
  series?: Array<Record<string, unknown>>;
};

type FakeChart = {
  options: EchartsOption[];
  setOptionCalls: number;
  resizeCalls: number;
  disposeCalls: number;
  setOption(option: EchartsOption): void;
  resize(): void;
  convertFromPixel(axis: { xAxisIndex: number }, pixel: number): number;
  dispose(): void;
  getWidth(): number;
  getHeight(): number;
};

const chartState = vi.hoisted(() => ({ instances: [] as FakeChart[] }));

vi.mock('echarts/core', () => ({
  init: (host: HTMLElement): FakeChart => {
    let from = INITIAL_VIEWPORT.from;
    let to = INITIAL_VIEWPORT.to;
    const chart: FakeChart = {
      options: [],
      setOptionCalls: 0,
      resizeCalls: 0,
      disposeCalls: 0,
      setOption(option) {
        this.options.push(option);
        this.setOptionCalls += 1;
        const xAxis = option.xAxis;
        if (typeof xAxis?.min === 'number') from = xAxis.min;
        if (typeof xAxis?.max === 'number') to = xAxis.max;
      },
      resize() { this.resizeCalls += 1; },
      convertFromPixel(_axis, pixel) {
        return pixel === PLOT_INSETS.left ? from : to;
      },
      dispose() { this.disposeCalls += 1; },
      getWidth() { return host.clientWidth; },
      getHeight() { return host.clientHeight; },
    };
    chartState.instances.push(chart);
    return chart;
  },
  use: vi.fn(),
}));

const { mountEcharts, formatEchartsTimeTick } = await import('../src/adapters/echarts');

const sparseSeries: readonly SensorSeries[] = [{
  id: 'swt-1', label: '20 cm', unit: 'kPa',
  points: [
    { t: 1_700_000_000_000, value: 12 },
    { t: 1_700_003_600_000, value: null },
    { t: 1_700_010_800_000, value: 0 },
    { t: 1_700_014_400_000, value: 96 },
  ],
}];

const stressSeries: readonly SensorSeries[] = [{
  id: 'stress', label: 'Stress', unit: 'kPa',
  points: Array.from({ length: 501 }, (_, index) => ({ t: index * 1_000, value: index === 250 ? 96 : 20 })),
}];

function hostWithSize(width = 400, height = 360): HTMLDivElement {
  const host = document.createElement('div');
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
    x: 10, y: 20, left: 10, top: 20, right: 10 + width, bottom: 20 + height,
    width, height, toJSON: () => ({}),
  });
  return host;
}

beforeEach(() => { chartState.instances.length = 0; });

describe('ECharts option and lifecycle adapter', () => {
  it('formats ticks by viewport span', () => {
    const start = new Date(2026, 9, 2, 8, 0).getTime();
    expect(formatEchartsTimeTick(start, 48 * 60 * 60 * 1000)).toBe('08:00');
    expect(formatEchartsTimeTick(start, 48 * 60 * 60 * 1000 + 1)).toBe('02 Oct');
    expect(formatEchartsTimeTick(start, 90 * 24 * 60 * 60 * 1000)).toBe('02 Oct');
  });

  it('mounts with numeric time and fixed y geometry', () => {
    const adapter = mountEcharts(hostWithSize(), INITIAL_VIEWPORT, vi.fn());
    const [option] = chartState.instances[0].options;
    expect(option.xAxis).toMatchObject({ type: 'value', min: INITIAL_VIEWPORT.from, max: INITIAL_VIEWPORT.to });
    expect(option.xAxis).toMatchObject({
      splitNumber: 3,
      axisLabel: { hideOverlap: true, alignMinLabel: 'left', alignMaxLabel: 'right' },
    });
    expect(option.yAxis).toMatchObject({ type: 'value', min: 0, max: 100 });
    expect(option.yAxis).not.toHaveProperty('name');
    expect(option.grid).toEqual({ ...PLOT_INSETS, containLabel: false });
    expect(option.animation).toBe(false);
    expect(adapter.getViewport()).toEqual(INITIAL_VIEWPORT);
  });

  it('updates tick formatting when the viewport changes span', () => {
    const adapter = mountEcharts(hostWithSize(), INITIAL_VIEWPORT, vi.fn());
    const chart = chartState.instances[0];
    const shortFormatter = (chart.options[0].xAxis?.axisLabel as { formatter: (value: number) => string }).formatter;
    expect(shortFormatter(new Date(2026, 9, 2, 8, 0).getTime())).toBe('08:00');
    adapter.setViewport({ from: INITIAL_VIEWPORT.from, to: INITIAL_VIEWPORT.from + 90 * 24 * 60 * 60 * 1000 });
    const longFormatter = (chart.options.at(-1)?.xAxis?.axisLabel as { formatter: (value: number) => string }).formatter;
    expect(longFormatter(new Date(2026, 9, 2, 8, 0).getTime())).toBe('02 Oct');
  });

  it('keeps the plot rectangle fixed across 24-hour and 90-day spans', () => {
    const adapter = mountEcharts(hostWithSize(), INITIAL_VIEWPORT, vi.fn());
    const shortRect = adapter.getPlotRect().toJSON();
    adapter.setViewport({ from: INITIAL_VIEWPORT.from, to: INITIAL_VIEWPORT.from + 90 * 24 * 60 * 60 * 1000 });
    expect(adapter.getPlotRect().toJSON()).toEqual(shortRect);
  });

  it('keeps null, zero, and spike values without smoothing', () => {
    const adapter = mountEcharts(hostWithSize(), INITIAL_VIEWPORT, vi.fn());
    adapter.setData(sparseSeries);
    const series = chartState.instances[0].options.at(-1)?.series?.[0];
    expect(series).toMatchObject({ type: 'line', showSymbol: true, symbolSize: 4, connectNulls: false, smooth: false });
    expect(series?.data).toEqual(sparseSeries[0].points.map((point) => [point.t, point.value]));
    expect(series).not.toHaveProperty('sampling');
    adapter.setData(stressSeries);
    const dense = chartState.instances[0].options.at(-1)?.series?.[0];
    expect(dense).toMatchObject({ type: 'line', showSymbol: false, connectNulls: false, smooth: false });
    expect(dense?.data).toEqual(stressSeries[0].points.map((point) => [point.t, point.value]));
  });

  it('reads the rendered viewport through convertFromPixel', () => {
    const adapter = mountEcharts(hostWithSize(), INITIAL_VIEWPORT, vi.fn());
    adapter.setViewport({ from: INITIAL_VIEWPORT.from - 1000, to: INITIAL_VIEWPORT.to + 1000 });
    expect(adapter.getViewport()).toEqual({ from: INITIAL_VIEWPORT.from - 1000, to: INITIAL_VIEWPORT.to + 1000 });
  });

  it('preserves the rendered viewport when data changes', () => {
    const adapter = mountEcharts(hostWithSize(), INITIAL_VIEWPORT, vi.fn());
    const shifted = { from: INITIAL_VIEWPORT.from - 1000, to: INITIAL_VIEWPORT.to - 1000 };
    adapter.setViewport(shifted);
    adapter.setData(sparseSeries);
    expect(adapter.getViewport()).toEqual(shifted);
  });

  it('keeps the extent for empty and single-point data', () => {
    const adapter = mountEcharts(hostWithSize(), INITIAL_VIEWPORT, vi.fn());
    adapter.setData([]);
    expect(adapter.getViewport()).toEqual(INITIAL_VIEWPORT);
    adapter.setData([{ ...sparseSeries[0], points: [sparseSeries[0].points[0]] }]);
    expect(adapter.getViewport()).toEqual(INITIAL_VIEWPORT);
    expect(chartState.instances[0].options.at(-1)?.series?.[0]).toMatchObject({ showSymbol: true, symbolSize: 4 });
  });

  it('resizes and reports the inset plot rectangle', () => {
    const host = hostWithSize();
    const adapter = mountEcharts(host, INITIAL_VIEWPORT, vi.fn());
    adapter.resize();
    expect(chartState.instances[0].resizeCalls).toBe(1);
    expect(adapter.getPlotRect().toJSON()).toMatchObject({
      x: 10 + PLOT_INSETS.left,
      y: 20 + PLOT_INSETS.top,
      width: 400 - PLOT_INSETS.left - PLOT_INSETS.right,
      height: 360 - PLOT_INSETS.top - PLOT_INSETS.bottom,
    });

    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 740,
      width: 800, height: 720, toJSON: () => ({}),
    });
    expect(adapter.getPlotRect().toJSON()).toMatchObject({
      x: 10 + PLOT_INSETS.left * 2,
      y: 20 + PLOT_INSETS.top * 2,
      width: (400 - PLOT_INSETS.left - PLOT_INSETS.right) * 2,
      height: (360 - PLOT_INSETS.top - PLOT_INSETS.bottom) * 2,
    });
  });

  it('disposes exactly once and never emits a gesture callback', () => {
    const host = hostWithSize();
    const notify = vi.fn();
    const adapter = mountEcharts(host, INITIAL_VIEWPORT, notify);
    adapter.destroy();
    adapter.destroy();
    expect(chartState.instances[0].disposeCalls).toBe(1);
    expect(host.childNodes).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
