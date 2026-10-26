import { describe, expect, it } from 'vitest';
import { buildCorrelationOption, buildSmallMultiplesOption, buildTimeSeriesOption } from '../echartsOptions';
import { smallMultiplesColumns } from '../chartGeometry';
import { groupByUnit } from '../unitGrouping';
import { estimateTextWidth, valueAxisLabelWidth } from '../../charts/axisLayout';
import type { AnalysisSeries } from '../types';

type Axis = {
  name: string;
  nameGap: number;
  nameRotate?: number;
  nameLocation?: string;
  offset?: number;
  position?: string;
  tooltip?: { show: boolean; formatter: (params?: { name?: string; tickIndex?: number }) => string };
  nameTextStyle?: { fontSize: number; align?: string };
};
type Grid = { left: number; right?: number; top: number; height: number; width?: number };

const NAME_BAND = 16;

function mk(id: string, channelKey: string, unit: string | null, values: (number | null)[]): AnalysisSeries {
  return {
    seriesId: id,
    resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 's', channelKey },
    label: id,
    unit,
    coveragePct: 100,
    points: values.map((value, i) => ({ t: `2026-06-18T0${i}:00:00Z`, value, count: 1, quality: 'ok' as const })),
    truncated: false,
    cadence: 'hourly',
    timezone: null,
  };
}

const longTitle = (_key: string, unit: string | null) => `Soil water tension at the deepest probe (${unit})`;

describe('time-series axis bands', () => {
  it('sizes the left band to the tick labels so the rotated title stays inside the canvas', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1200, 15400])];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false, viewport: { width: 390, height: 360 } });
    const y = (opt.yAxis as Axis[])[0];
    const grid = (opt.grid as Grid[])[0];
    expect(y.nameGap).toBeGreaterThanOrEqual(valueAxisLabelWidth([1200, 15400]) + 8);
    expect(grid.left).toBeGreaterThanOrEqual(y.nameGap + NAME_BAND);
  });

  it('does not reserve 80 px for one-digit labels on a phone', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1, 8])];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false, viewport: { width: 320, height: 360 } });
    expect((opt.grid as Grid[])[0].left).toBeLessThan(80);
  });

  it('stacks extra right-hand axes side by side inside the grid margin (overlaid layout)', () => {
    const s = [
      mk('a', 'swt_1', 'kPa', [10, 90]),
      mk('b', 'dendro_stem_change_um', 'um', [-1200, 300]),
      mk('c', 'ext_temperature_c', 'C', [5, 30]),
      mk('d', 'vwc_1', '%', [10, 40]),
    ];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: true, viewport: { width: 1200, height: 360 } });
    const axes = opt.yAxis as Axis[];
    const grid = (opt.grid as Grid[])[0];
    expect(axes.map((a) => a.position)).toEqual(['left', 'right', 'right', 'right']);
    expect(axes[1].offset).toBe(0);
    // Each further axis starts where the previous one's title band ends.
    for (let i = 2; i < axes.length; i += 1) {
      expect(axes[i].offset).toBeGreaterThanOrEqual((axes[i - 1].offset ?? 0) + axes[i - 1].nameGap + NAME_BAND);
    }
    const last = axes[axes.length - 1];
    expect(grid.right).toBeGreaterThanOrEqual((last.offset ?? 0) + last.nameGap + NAME_BAND);
  });

  it('gives stacked panels a fixed pixel gap instead of a gap that grows with the panel count', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1]), mk('b', 'ext_temperature_c', 'C', [2]), mk('c', 'vwc_1', '%', [3]), mk('d', 'x', 'mm', [4]), mk('e', 'y', 'lx', [5])];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false, viewport: { width: 390, height: 1200 } });
    const grids = opt.grid as Grid[];
    expect(grids).toHaveLength(5);
    for (const grid of grids) expect(grid.height).toBeGreaterThanOrEqual(150);
    for (let i = 1; i < grids.length; i += 1) {
      expect(grids[i].top).toBeGreaterThanOrEqual(grids[i - 1].top + grids[i - 1].height + 24);
    }
  });

  it('shortens a title that is longer than its panel to the unit and keeps the full title as a tooltip', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1]), mk('b', 'ext_temperature_c', 'C', [2]), mk('c', 'vwc_1', '%', [3])];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false, resolveAxisLabel: longTitle, viewport: { width: 390, height: 420 } });
    const axes = opt.yAxis as Axis[];
    const grids = opt.grid as Grid[];
    axes.forEach((axis, i) => {
      expect(estimateTextWidth(axis.name, 12)).toBeLessThanOrEqual(grids[i].height);
    });
    expect(axes[0].name).toBe('kPa');
    expect(axes[0].tooltip?.show).toBe(true);
    expect(axes[0].tooltip?.formatter()).toBe('Soil water tension at the deepest probe (kPa)');
  });

  // ECharts 5.6 gives the axis tooltip to the name and to every tick label (AxisBuilder
  // setTooltipConfig); a tick label keeps its own text, only the name shows the full title.
  it('shows the full title only on the axis name, a tick label keeps its own value', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1])];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false, resolveAxisLabel: longTitle, viewport: { width: 390, height: 200 } });
    const formatter = (opt.yAxis as Axis[])[0].tooltip?.formatter;
    expect(formatter?.({ name: 'kPa' })).toBe('Soil water tension at the deepest probe (kPa)');
    expect(formatter?.({ name: '40', tickIndex: 2 })).toBe('40');
    expect(formatter?.({ name: '<b>', tickIndex: 0 })).toBe('&lt;b&gt;');
  });

  it('keeps a title that fits and adds no tooltip', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1])];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false, resolveAxisLabel: (_k, u) => `SWT (${u})`, viewport: { width: 1200, height: 360 } });
    const y = (opt.yAxis as Axis[])[0];
    expect(y.name).toBe('SWT (kPa)');
    expect(y.tooltip).toBeUndefined();
  });

  it('escapes a user-renamed title before it reaches the HTML tooltip', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1])];
    const opt = buildTimeSeriesOption({
      panels: groupByUnit(s), series: s, normalize: false, multiAxis: false,
      resolveAxisLabel: () => '<img src=x onerror=alert(1)> a very long renamed axis title that will not fit',
      viewport: { width: 390, height: 200 },
    });
    const formatted = (opt.yAxis as Axis[])[0].tooltip?.formatter() ?? '';
    expect(formatted).not.toContain('<img');
    expect(formatted).toContain('&lt;img');
  });

  it('works without a measured viewport (first render)', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1, 2])];
    const opt = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false });
    expect((opt.grid as Grid[])[0].left).toBeGreaterThan(0);
  });
});

describe('small multiples', () => {
  it('uses one column on a phone and several on a wide screen', () => {
    expect(smallMultiplesColumns(4, 320)).toBe(1);
    expect(smallMultiplesColumns(4, 390)).toBe(1);
    expect(smallMultiplesColumns(4, 1440)).toBe(2);
    expect(smallMultiplesColumns(9, 1440)).toBe(3);
    expect(smallMultiplesColumns(0, 1440)).toBe(1);
    expect(smallMultiplesColumns(4)).toBe(2);
  });

  it('places each cell title above its plot, horizontal and cut to the cell width', () => {
    const s = [mk('a', 'swt_1', 'kPa', [1200, 9000]), mk('b', 'swt_2', 'kPa', [3])];
    const opt = buildSmallMultiplesOption(s, false, longTitle, undefined, { width: 320, height: 440 });
    const axes = opt.yAxis as Axis[];
    const grids = opt.grid as Grid[];
    axes.forEach((axis, i) => {
      expect(axis.nameRotate).toBe(0);
      expect(axis.nameLocation).toBe('end');
      expect(axis.nameTextStyle?.align).toBe('left');
      expect(grids[i].left + estimateTextWidth(axis.name, 12)).toBeLessThanOrEqual(320);
    });
    // The tick labels of the first cell fit left of its plot.
    expect(grids[0].left).toBeGreaterThanOrEqual(valueAxisLabelWidth([1200, 9000]) + 8);
    // One column: the second cell sits below the first.
    expect(grids[1].top).toBeGreaterThan(grids[0].top + grids[0].height);
  });
});

describe('correlation', () => {
  it('sizes the y band to the y values and fits both titles', () => {
    const opt = buildCorrelationOption({
      zonePairs: [{ groupId: 'zone:1', zoneId: 1, label: 'Zone 1', points: [[10, -1500], [80, 2500]] }],
      channelXLabel: 'Soil water tension at the deepest probe (kPa)',
      channelYLabel: 'Stem diameter change over the whole day (µm)',
      channelXUnit: 'kPa',
      channelYUnit: 'um',
      viewport: { width: 320, height: 360 },
    });
    const y = (opt.yAxis as Axis[])[0];
    const x = (opt.xAxis as Axis[])[0];
    const grid = (opt.grid as Grid[])[0];
    expect(y.nameGap).toBeGreaterThanOrEqual(valueAxisLabelWidth([-1500, 2500]) + 8);
    expect(grid.left).toBeGreaterThanOrEqual(y.nameGap + NAME_BAND);
    expect(estimateTextWidth(x.name, 12)).toBeLessThanOrEqual(320 - grid.left - (grid.right ?? 0));
    expect(x.tooltip?.formatter()).toBe('Soil water tension at the deepest probe (kPa)');
  });
});
