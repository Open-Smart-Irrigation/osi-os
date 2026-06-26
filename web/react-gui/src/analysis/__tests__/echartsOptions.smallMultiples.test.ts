import { describe, it, expect } from 'vitest';
import { buildSmallMultiplesOption } from '../echartsOptions';
import { SERIES_PALETTE } from '../seriesColors';
import type { AnalysisSeries } from '../types';

function series(id: string): AnalysisSeries {
  return {
    seriesId: id,
    resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
    label: id, unit: 'kPa', coveragePct: 100,
    points: [{ t: '2026-06-18T00:00:00Z', value: 1, count: 1, quality: 'ok' }],
    truncated: false,
  };
}

describe('buildSmallMultiplesOption', () => {
  it('renders one grid, x-axis, y-axis and line series per series', () => {
    const option = buildSmallMultiplesOption([series('a'), series('b'), series('c')], false);
    expect(option.color).toEqual(SERIES_PALETTE);
    expect((option.grid as unknown[])).toHaveLength(3);
    expect((option.xAxis as unknown[])).toHaveLength(3);
    expect((option.yAxis as unknown[])).toHaveLength(3);
    expect((option.series as Array<Record<string, unknown>>)).toHaveLength(3);
    expect((option.series as Array<Record<string, unknown>>)[2].xAxisIndex).toBe(2);
    expect((option.series as Array<Record<string, unknown>>)[0].connectNulls).toBe(false);
  });

  it('handles an empty selection', () => {
    const option = buildSmallMultiplesOption([], false);
    expect((option.grid as unknown[])).toHaveLength(0);
    expect((option.series as unknown[])).toHaveLength(0);
  });
});
