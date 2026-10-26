import { describe, expect, test, vi } from 'vitest';

const { plots, FakePlot } = vi.hoisted(() => {
  const created: any[] = [];
  class Plot {
    series: Array<Record<string, unknown>> = [{}];
    scales = { x: { min: 0, max: 10 } };
    over = { getBoundingClientRect: () => new DOMRect(0, 0, 100, 100) };
    setSeries = vi.fn();
    setData = vi.fn();
    constructor(public options: Record<string, unknown>) { created.push(this); }
    batch(callback: () => void) { callback(); }
    setScale(_key: string, range: { min: number; max: number }) { this.scales.x = range; }
    addSeries(options: Record<string, unknown>) { this.series.push(options); }
    delSeries(index: number) { this.series.splice(index, 1); }
    setSize() {}
    destroy() {}
  }
  (Plot as any).join = (tables: any[]) => {
    const rows = tables.flatMap((table) => table.slice(1));
    return [tables[0]?.[0] ?? [], ...rows];
  };
  return { plots: created, FakePlot: Plot };
});

vi.mock('uplot', () => ({ default: FakePlot }));
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

import { markerPaths, mountUplot } from '../src/adapters/uplot';

type AxisConfig = {
  size: number | ((u: unknown, values?: string[] | null) => number);
  values: (u: { scales: { x: { min?: number; max?: number } } }, values: number[]) => string[];
};
type PaddingConfig = [number, number | ((u: unknown, side: number, sidesWithAxes: unknown, cycleNum: number) => number), number, number];

function capturedAxis(): AxisConfig {
  return (plots.at(-1)?.options.axes as AxisConfig[])[0];
}

function capturedRightPadding(): Exclude<PaddingConfig[1], number> {
  const right = (plots.at(-1)?.options.padding as PaddingConfig)[1];
  expect(typeof right).toBe('function');
  return right as Exclude<PaddingConfig[1], number>;
}

describe('uPlot adapter', () => {
  test('qualifies repeated Zurich rollback ticks through the captured axis callback', () => {
    const host = document.createElement('div');
    mountUplot(host, { from: Date.parse('2026-10-25T00:00:00Z'), to: Date.parse('2026-10-25T01:00:00Z') }, vi.fn(), { locale: 'en-GB', timeZone: 'Europe/Zurich' });
    const axis = capturedAxis();
    const values = [Date.parse('2026-10-25T00:00:00Z') / 1_000, Date.parse('2026-10-25T01:00:00Z') / 1_000];
    const labels = axis.values({ scales: { x: { min: values[0], max: values[1] } } }, values);
    expect(labels[0]).toContain('02:00');
    expect(labels[0]).toContain('GMT+2');
    expect(labels[1]).toContain('02:00');
    expect(labels[1]).toContain('GMT+1');
    expect(typeof axis.size === 'function' ? axis.size({}, labels) : axis.size).toBe(52);

    const rightPadding = capturedRightPadding();
    expect(rightPadding({}, 1, [], 0)).toBe(12);
    expect(rightPadding({}, 1, [], 1)).toBe(28);

    const ordinaryLabels = axis.values({ scales: { x: { min: values[0] + 86_400, max: values[1] + 86_400 } } }, values.map((value) => value + 86_400));
    expect(ordinaryLabels.every((label) => !label.includes('\n'))).toBe(true);
    expect(rightPadding({}, 1, [], 2)).toBe(28);
    expect(rightPadding({}, 1, [], 1)).toBe(12);
  });

  test('keeps ordinary Kampala ticks and wide ranges in their legacy forms', () => {
    const host = document.createElement('div');
    mountUplot(host, { from: 0, to: 86_400_000 }, vi.fn(), { locale: 'en-GB', timeZone: 'Africa/Kampala' });
    const axis = capturedAxis();
    const narrow = [Date.parse('2026-10-25T00:00:00Z') / 1_000, Date.parse('2026-10-25T01:00:00Z') / 1_000];
    const narrowLabels = axis.values({ scales: { x: { min: narrow[0], max: narrow[1] } } }, narrow);
    expect(narrowLabels).toEqual(['03:00', '04:00']);
    expect(typeof axis.size === 'function' ? axis.size({}, narrowLabels) : axis.size).toBe(36);
    expect(typeof axis.size === 'function' ? axis.size({}, null) : axis.size).toBe(36);
    const wide = [Date.parse('2026-10-01T00:00:00Z') / 1_000, Date.parse('2026-10-04T00:00:00Z') / 1_000];
    const wideLabels = axis.values({ scales: { x: { min: wide[0], max: wide[1] } } }, wide);
    expect(wideLabels).toEqual(['01 Oct', '04 Oct']);

    const rightPadding = capturedRightPadding();
    expect(rightPadding({}, 1, [], 0)).toBe(12);
    expect(rightPadding({}, 1, [], 1)).toBe(12);
  });

  test('does not qualify equal wall times on different calendar days', () => {
    const host = document.createElement('div');
    mountUplot(host, { from: Date.parse('2026-10-24T00:00:00Z'), to: Date.parse('2026-10-25T00:00:00Z') }, vi.fn(), { locale: 'en-GB', timeZone: 'Europe/Zurich' });
    const axis = capturedAxis();
    const values = [Date.parse('2026-10-24T00:00:00Z') / 1_000, Date.parse('2026-10-25T00:00:00Z') / 1_000];
    const labels = axis.values({ scales: { x: { min: values[0], max: values[1] } } }, values);
    expect(labels).toEqual(['02:00', '02:00']);
    expect(labels.every((label) => !label.includes('\n'))).toBe(true);
    expect(typeof axis.size === 'function' ? axis.size({}, labels) : axis.size).toBe(36);
  });

  test('encodes supplied appearance and focuses by stable series id', () => {
    const host = document.createElement('div');
    const adapter = mountUplot(host, { from: 0, to: 10_000 }, vi.fn());
    const appearance = { color: '#123456', dash: [3, 2] as const, marker: 'diamond' as const };
    adapter.setData([{ id: 'a', label: 'A', unit: 'kPa', appearance, points: [{ t: 1_000, value: 4 }] }]);
    adapter.setFocusedSeries?.('a');
    const plot = plots.at(-1)!;
    expect(plot.series[1]).toMatchObject({ stroke: '#123456', dash: [3, 2] });
    expect(plot.series[1].points).toMatchObject({ fill: '#123456', stroke: '#123456', width: 0 });
    expect((plot.series[1].points as { paths: unknown }).paths).toEqual(expect.any(Function));
    expect(plot.setSeries).toHaveBeenLastCalledWith(1, { focus: true });
    adapter.setFocusedSeries?.(null);
    expect(plot.setSeries).toHaveBeenLastCalledWith(null, { focus: false });
  });

  test('returns a finite DPR-scaled marker path and skips null samples', () => {
    class TestPath {
      commands: Array<number[] | string> = [];
      arc(...values: number[]) { this.commands.push(values); }
      rect(...values: number[]) { this.commands.push(values); }
      moveTo(...values: number[]) { this.commands.push(values); }
      lineTo(...values: number[]) { this.commands.push(values); }
      closePath() { this.commands.push('close'); }
    }
    vi.stubGlobal('Path2D', TestPath);
    (FakePlot as any).pxRatio = 2;
    const path = markerPaths('triangle')({
      data: [[0, 1, 2], [0, null, 4]],
      valToPos: (value: number) => value * 10,
      ctx: {},
      bbox: { left: 0, top: 0, width: 100, height: 100 },
      series: [{}, { scale: 'y' }],
    } as any, 1, 0, 2);
    expect(path?.fill).toBeInstanceOf(TestPath);
    expect(path?.clip).toBeInstanceOf(TestPath);
    expect((path?.fill as unknown as { commands: Array<number[] | string> }).commands).toEqual([
      [0, -6], [6, 6], [-6, 6], 'close', [20, 34], [26, 46], [14, 46], 'close',
    ]);
    vi.unstubAllGlobals();
  });
});
