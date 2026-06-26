import { describe, it, expect } from 'vitest';
import { zonePairs } from '../correlation';
import type { AnalysisSeries } from '../types';

function series(zoneId: number, channelKey: string, values: (number | null)[]): AnalysisSeries {
  return {
    seriesId: `${zoneId}-${channelKey}`,
    resolved: { hubEui: null, zoneId, cardType: 'soil', sourceKey: 'root-zone', channelKey },
    label: `Zone ${zoneId} ${channelKey}`,
    unit: 'x',
    coveragePct: 100,
    points: values.map((v, i) => ({
      t: `2026-06-18T0${i}:00:00Z`,
      value: v,
      count: v === null ? 0 : 1,
      quality: v === null ? 'gap' : 'ok',
    })),
    truncated: false,
  };
}

describe('zonePairs', () => {
  it('returns pairwise-deleted points per zone and skips zones missing a channel', () => {
    const result = zonePairs([
      series(1, 'soil', [1, 2, null, 4]),
      series(1, 'dendro', [10, null, 30, 40]),
      series(2, 'soil', [5, 6]),
    ], 'soil', 'dendro');

    expect(result).toHaveLength(1);
    expect(result[0].zoneId).toBe(1);
    expect(result[0].points).toEqual([[1, 10], [4, 40]]);
  });

  it('matches canonical series even when the requested channel key is a legacy alias', () => {
    const result = zonePairs([
      series(1, 'ambient_temperature', [1, 2]),
      series(1, 'dendro', [10, 20]),
    ], 'temperature', 'dendro');

    expect(result).toEqual([{ zoneId: 1, label: 'Zone 1', points: [[1, 10], [2, 20]] }]);
  });
});
