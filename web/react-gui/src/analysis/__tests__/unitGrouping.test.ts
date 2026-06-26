import { describe, it, expect } from 'vitest';
import { groupByUnit, isOverlay } from '../unitGrouping';
import type { AnalysisSeries } from '../types';

function s(seriesId: string, unit: string | null): AnalysisSeries {
  return {
    seriesId,
    resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
    label: seriesId, unit, coveragePct: 100, points: [], truncated: false,
  };
}

describe('unitGrouping', () => {
  it('puts same-unit series in one overlay panel', () => {
    const panels = groupByUnit([s('a', 'kPa'), s('b', 'kPa')]);
    expect(panels).toHaveLength(1);
    expect(panels[0]).toEqual({ unit: 'kPa', seriesIds: ['a', 'b'] });
    expect(isOverlay(panels)).toBe(true);
  });

  it('splits mixed units into stacked panels in first-seen order', () => {
    const panels = groupByUnit([s('a', 'kPa'), s('b', 'C'), s('c', 'kPa')]);
    expect(panels.map((p) => p.unit)).toEqual(['kPa', 'C']);
    expect(panels[0].seriesIds).toEqual(['a', 'c']);
    expect(panels[1].seriesIds).toEqual(['b']);
    expect(isOverlay(panels)).toBe(false);
  });
});
