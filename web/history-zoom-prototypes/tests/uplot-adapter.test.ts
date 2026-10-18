import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorSeries, Viewport } from '../src/shared/types';

const initialViewport: Viewport = {
  from: 1_700_000_000_000,
  to: 1_700_086_400_000,
};

function sensor(
  id: string,
  label: string,
  points: SensorSeries['points'],
): SensorSeries {
  return { id, label, unit: 'kPa', points };
}

const emptyThreeSeries: readonly SensorSeries[] = [
  sensor('swt-1', 'Upper', []),
  sensor('swt-2', 'Middle', []),
  sensor('swt-3', 'Lower', []),
];
const populatedThreeSeries: readonly SensorSeries[] = [
  sensor('swt-1', 'Upper', [{ t: 12_000, value: 0 }]),
  sensor('swt-2', 'Middle', [{ t: 13_000, value: null }]),
  sensor('swt-3', 'Lower', [{ t: 14_000, value: 96 }]),
];
const relabeledThreeSeries: readonly SensorSeries[] = [
  sensor('swt-1', 'SWT 10 cm', [{ t: 12_000, value: 0 }]),
  sensor('swt-2', 'SWT 30 cm', [{ t: 13_000, value: null }]),
  sensor('swt-3', 'SWT 60 cm', [{ t: 14_000, value: 96 }]),
];

const constructed: FakeUPlot[] = [];

class FakeUPlot {
  static join = vi.fn(() => [[]]);
  options: Record<string, any>;
  series: Array<Record<string, any>>;
  scales = { x: { min: null as number | null, max: null as number | null } };
  rect = new DOMRect(52, 16, 348, 308);
  over = document.createElement('div');
  setData = vi.fn();
  setSeries = vi.fn();
  setSize = vi.fn();
  destroy = vi.fn();
  batch = vi.fn((run: () => void) => run());
  setScale = vi.fn(
    (_key: string, limits: { min: number; max: number }) => {
      this.scales.x = { ...limits };
    },
  );
  addSeries = vi.fn((options: Record<string, any>) => {
    this.series.push(options);
  });
  delSeries = vi.fn((index: number) => {
    this.series.splice(index, 1);
  });

  constructor(
    options: Record<string, any>,
    _data: unknown,
    _host: HTMLElement,
  ) {
    this.over.getBoundingClientRect = () => this.rect;
    this.options = options;
    this.series = [...options.series];
    constructed.push(this);
  }
}

vi.doMock('uplot', () => ({ default: FakeUPlot }));
const { mountUplot, formatUplotTimeTick } = await import('../src/adapters/uplot');

function mountAt(
  size: { width: number; height: number },
  onViewportChange = vi.fn(),
) {
  const host = document.createElement('div');
  Object.defineProperties(host, {
    clientWidth: { value: size.width, configurable: true },
    clientHeight: { value: size.height, configurable: true },
  });
  const adapter = mountUplot(host, initialViewport, onViewportChange);
  const plot = constructed.at(-1)!;
  return { adapter, host, onViewportChange, options: plot.options, plot };
}

beforeEach(() => {
  constructed.length = 0;
});

describe('uPlot time labels', () => {
  it('uses one-line clock labels for windows up to 48 hours', () => {
    expect(formatUplotTimeTick(1_700_000_000, 1_700_000_000, 1_700_000_000 + 48 * 60 * 60)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('uses one-line day-month labels for longer windows', () => {
    expect(formatUplotTimeTick(1_700_000_000, 1_700_000_000, 1_700_000_000 + 49 * 60 * 60)).toMatch(/^\d{2} [A-Z][a-z]{2}$/);
  });
});

it('configures fixed geometry and a fixed 0..100 kPa y scale', () => {
  const { options } = mountAt({ width: 412, height: 360 });
  expect(options.padding).toEqual([16, 12, 0, 0]);
  expect(options.axes[0].size).toBe(36);
  expect(options.axes[1].size).toBe(52);
  expect(options.scales.y).toMatchObject({ auto: false, range: [0, 100] });
  expect(options.cursor.drag.setScale).toBe(false);
  expect(options.legend.show).toBe(false);
  expect(options.axes[0].space).toBe(64);
  expect(options.axes[0].values).toEqual(expect.any(Function));
});

it('derives a finite padded y range for negative, zero, and flat values', () => {
  const { adapter, options, plot } = mountAt({ width: 412, height: 360 });
  const auto = mountUplot(document.createElement('div'), initialViewport, vi.fn(), { yRange: 'auto' });
  const autoPlot = constructed.at(-1)!;
  auto.setData([
    sensor('negative', 'Negative', [{ t: 1, value: -10 }, { t: 2, value: 0 }]),
    sensor('positive', 'Positive', [{ t: 1, value: 20 }, { t: 2, value: null }]),
  ]);
  const range = autoPlot.options.scales.y.range(autoPlot, 0, 0);
  expect(range[0]).toBeLessThan(-10);
  expect(range[1]).toBeGreaterThan(20);
  expect(range.every((value: number) => Number.isFinite(value))).toBe(true);
  auto.setData([sensor('flat', 'Flat', [{ t: 1, value: 0 }, { t: 2, value: 0 }])]);
  const flatRange = autoPlot.options.scales.y.range(autoPlot, 0, 0);
  expect(flatRange).toEqual([-1, 1]);
  adapter.destroy();
  plot.destroy.mockClear();
});

it('handles large series sets and finite numeric extremes without collapsing the range', () => {
  const auto = mountUplot(document.createElement('div'), initialViewport, vi.fn(), { yRange: 'auto' });
  const autoPlot = constructed.at(-1)!;
  auto.setData([sensor('large', 'Large', Array.from({ length: 200_000 }, (_, index) => ({ t: index, value: index - 100_000 })))]);
  const largeRange = autoPlot.options.scales.y.range(autoPlot, 0, 0);
  expect(largeRange.every((value: number) => Number.isFinite(value))).toBe(true);
  expect(largeRange[0]).toBeLessThan(largeRange[1]);
  auto.setData([sensor('extremes', 'Extremes', [{ t: 1, value: -Number.MAX_VALUE }, { t: 2, value: Number.MAX_VALUE }])]);
  const extremeRange = autoPlot.options.scales.y.range(autoPlot, 0, 0);
  expect(extremeRange).toEqual([-Number.MAX_VALUE, Number.MAX_VALUE]);
  auto.setData([sensor('flat-large', 'Flat large', [{ t: 1, value: Number.MAX_VALUE }, { t: 2, value: Number.MAX_VALUE }])]);
  const flatRange = autoPlot.options.scales.y.range(autoPlot, 0, 0);
  expect(flatRange.every((value: number) => Number.isFinite(value))).toBe(true);
  expect(flatRange[0]).toBeLessThan(flatRange[1]);
  auto.destroy();
});

it('writes seconds to uPlot and reads the renderer scale back as milliseconds', () => {
  const { adapter, plot } = mountAt({ width: 412, height: 360 });
  adapter.setViewport({ from: 1_700_000_000_000, to: 1_700_086_400_000 });
  expect(plot.setScale).toHaveBeenLastCalledWith('x', {
    min: 1_700_000_000,
    max: 1_700_086_400,
  });
  expect(plot.batch).toHaveBeenCalled();

  plot.scales.x.min = 1_700_000_123;
  plot.scales.x.max = 1_700_086_523;
  expect(adapter.getViewport()).toEqual({
    from: 1_700_000_123_000,
    to: 1_700_086_523_000,
  });
});

it('keeps the renderer viewport when asynchronous data arrives', () => {
  const { adapter, plot } = mountAt({ width: 412, height: 360 });
  adapter.setViewport({ from: 10_000, to: 20_000 });
  adapter.setData(emptyThreeSeries);
  adapter.setData(populatedThreeSeries);
  expect(plot.setData).toHaveBeenLastCalledWith(expect.any(Array), false);
  expect(adapter.getViewport()).toEqual({ from: 10_000, to: 20_000 });
});

it('measures the real CSS plot rectangle again after resize', () => {
  const { adapter, host, plot } = mountAt({ width: 412, height: 360 });
  Object.defineProperty(host, 'clientWidth', { value: 824 });
  plot.rect = new DOMRect(52, 16, 760, 308);
  expect(adapter.getPlotRect()).toEqual(plot.rect);
  adapter.resize();
  expect(plot.setSize).toHaveBeenLastCalledWith({ width: 824, height: 360 });
  expect(adapter.getPlotRect()).toEqual(plot.rect);
  expect(adapter.getViewport()).toEqual(initialViewport);
});

it('reconciles series metadata without mounting a second chart', () => {
  const { adapter, plot } = mountAt({ width: 412, height: 360 });
  adapter.setData(populatedThreeSeries);
  adapter.setData(relabeledThreeSeries);
  expect(constructed).toHaveLength(1);
  expect(plot.series).toHaveLength(4);
  expect(plot.series.slice(1).map((item) => item.label)).toEqual([
    'SWT 10 cm (kPa)',
    'SWT 30 cm (kPa)',
    'SWT 60 cm (kPa)',
  ]);
  expect(plot.series[1].points.show).toBe(true);
  adapter.setData([
    sensor(
      'swt-1',
      'Upper',
      Array.from({ length: 501 }, (_, i) => ({ t: i * 1000, value: 20 })),
    ),
  ]);
  expect(plot.series[1].points.show).toBe(false);
});

it('focuses a stable series id through uPlot public setSeries', () => {
  const { adapter, plot } = mountAt({ width: 412, height: 360 });
  adapter.setData(populatedThreeSeries);
  adapter.setFocusedSeries?.('swt-2');
  expect(plot.setSeries).toHaveBeenLastCalledWith(2, { focus: true });
  adapter.setFocusedSeries?.(null);
  expect(plot.setSeries).toHaveBeenLastCalledWith(null, { focus: false });
});

it('destroys uPlot once and never emits a viewport callback', () => {
  const onViewportChange = vi.fn();
  const { adapter, plot } = mountAt(
    { width: 412, height: 360 },
    onViewportChange,
  );
  adapter.setViewport({ from: 10_000, to: 20_000 });
  adapter.destroy();
  adapter.destroy();
  expect(plot.destroy).toHaveBeenCalledTimes(1);
  expect(onViewportChange).not.toHaveBeenCalled();
});
