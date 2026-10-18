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

describe('uPlot adapter', () => {
  test('encodes supplied appearance and focuses by stable series id', () => {
    const host = document.createElement('div');
    const adapter = mountUplot(host, { from: 0, to: 10_000 }, vi.fn());
    const appearance = { color: '#123456', dash: [3, 2] as const, marker: 'diamond' as const };
    adapter.setData([{ id: 'a', label: 'A', unit: 'kPa', appearance, points: [{ t: 1_000, value: 4 }] }]);
    adapter.setFocusedSeries?.('a');
    expect(plots[0].series[1]).toMatchObject({ stroke: '#123456', dash: [3, 2] });
    expect(plots[0].series[1].points).toMatchObject({ fill: '#123456', stroke: '#123456', width: 0 });
    expect((plots[0].series[1].points as { paths: unknown }).paths).toEqual(expect.any(Function));
    expect(plots[0].setSeries).toHaveBeenLastCalledWith(1, { focus: true });
    adapter.setFocusedSeries?.(null);
    expect(plots[0].setSeries).toHaveBeenLastCalledWith(null, { focus: false });
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
