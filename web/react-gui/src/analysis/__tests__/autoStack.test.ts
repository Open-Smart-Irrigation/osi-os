import { describe, expect, it } from 'vitest';
import { AUTO_STACK_MIN_PLOT_PX, overlaidPlotWidth, shouldAutoStack } from '../axisBands';
import { buildTimeSeriesOption } from '../echartsOptions';
import { groupByUnit } from '../unitGrouping';
import type { AnalysisSeries } from '../types';

function mk(id: string, unit: string, values: number[]): AnalysisSeries {
  return {
    seriesId: id,
    resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 's', channelKey: id },
    label: id,
    unit,
    coveragePct: 100,
    points: values.map((value, i) => ({ t: `2026-06-18T0${i}:00:00Z`, value, count: 1, quality: 'ok' as const })),
    truncated: false,
    cadence: 'hourly',
    timezone: null,
  };
}

const twoUnits = [mk('swt_1', 'kPa', [10, 90]), mk('temp', 'C', [5, 30])];
const threeUnits = [...twoUnits, mk('stem', 'um', [-1200, 300])];

describe('overlaidPlotWidth', () => {
  it('equals the plot width the overlaid option leaves after its axis bands', () => {
    const panels = groupByUnit(threeUnits);
    const option = buildTimeSeriesOption({ panels, series: threeUnits, normalize: false, multiAxis: true, viewport: { width: 900, height: 360 } });
    const grid = (option.grid as Array<{ left: number; right: number }>)[0];
    const groups = panels.map((p) => threeUnits.filter((s) => p.seriesIds.includes(s.seriesId)));
    expect(overlaidPlotWidth(groups, 900)).toBe(900 - grid.left - grid.right);
  });
});

describe('shouldAutoStack', () => {
  const base = { layout: 'overlaid' as const, normalize: false };

  it('stacks three units on a 390 px phone', () => {
    expect(shouldAutoStack({ ...base, panels: groupByUnit(threeUnits), series: threeUnits, width: 390 })).toBe(true);
  });

  it('keeps three units overlaid on a 1440 px screen', () => {
    expect(shouldAutoStack({ ...base, panels: groupByUnit(threeUnits), series: threeUnits, width: 1440 })).toBe(false);
  });

  it(`stacks when the plot drops under ${AUTO_STACK_MIN_PLOT_PX} px even if that is half the frame`, () => {
    // Two units at 320 px: about 220 px plot, which is over 50 % but under 280 px.
    const plot = overlaidPlotWidth(groupByUnit(twoUnits).map((p) => twoUnits.filter((s) => p.seriesIds.includes(s.seriesId))), 320);
    expect(plot).toBeGreaterThan(160);
    expect(plot).toBeLessThan(AUTO_STACK_MIN_PLOT_PX);
    expect(shouldAutoStack({ ...base, panels: groupByUnit(twoUnits), series: twoUnits, width: 320 })).toBe(true);
  });

  it('stacks when the axes take more than half the frame', () => {
    const many = [...threeUnits, mk('vwc', '%', [10, 40]), mk('lux', 'lx', [0, 98000]), mk('rain', 'mm', [0, 12])];
    expect(shouldAutoStack({ ...base, panels: groupByUnit(many), series: many, width: 600 })).toBe(true);
  });

  it('never stacks a single unit, a normalized chart, another layout, or before measurement', () => {
    const one = [mk('a', 'kPa', [1]), mk('b', 'kPa', [2])];
    expect(shouldAutoStack({ ...base, panels: groupByUnit(one), series: one, width: 320 })).toBe(false);
    expect(shouldAutoStack({ ...base, normalize: true, panels: groupByUnit(threeUnits), series: threeUnits, width: 320 })).toBe(false);
    expect(shouldAutoStack({ ...base, layout: 'stacked', panels: groupByUnit(threeUnits), series: threeUnits, width: 320 })).toBe(false);
    expect(shouldAutoStack({ ...base, panels: groupByUnit(threeUnits), series: threeUnits, width: undefined })).toBe(false);
  });
});
