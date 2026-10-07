import { describe, it, expect } from 'vitest';
import { computeCorrelation, zonePairs, MIN_CORRELATION_SAMPLES } from '../correlation';
import type { AnalysisSeries, AnalysisPoint } from '../types';

function series(zoneId: number | null, channelKey: string, values: (number | null)[], deviceSourceId?: string): AnalysisSeries {
  const points: AnalysisPoint[] = values.map((v, i) => ({
    t: `2026-06-18T${String(i).padStart(2, '0')}:00:00Z`,
    value: v, count: v === null ? 0 : 1, quality: v === null ? 'gap' : 'ok',
  }));
  return {
    seriesId: `${zoneId}-${channelKey}`,
    resolved: { hubEui: null, zoneId, cardType: 'soil', sourceKey: 'root-zone', channelKey, deviceSourceId },
    label: zoneId === null ? `Unassigned device - ${channelKey}` : `Zone ${zoneId} ${channelKey}`,
    unit: 'x', coveragePct: 100, points, truncated: false, cadence: 'hourly', timezone: null,
  };
}

function timestampedSeries(zoneId: number, channelKey: string, values: Array<[string, number | null]>): AnalysisSeries {
  return {
    seriesId: `${zoneId}-${channelKey}`,
    resolved: { hubEui: null, zoneId, cardType: 'soil', sourceKey: 'root-zone', channelKey },
    label: `Zone ${zoneId} ${channelKey}`,
    unit: 'x',
    coveragePct: 100,
    points: values.map(([hour, value]) => ({
      t: `2026-06-18T${hour}:00:00Z`,
      value,
      count: value === null ? 0 : 1,
      quality: value === null ? 'gap' : 'ok',
    })),
    truncated: false, cadence: 'hourly', timezone: null,
  };
}

function ramp(n: number, f: (i: number) => number): (number | null)[] {
  return Array.from({ length: n }, (_, i) => f(i));
}

function mkSeries(
  seriesId: string,
  channelKey: string,
  unit: string | null,
  overrides?: { zoneId?: number },
): AnalysisSeries {
  const n = MIN_CORRELATION_SAMPLES;
  return {
    seriesId,
    resolved: {
      hubEui: null,
      zoneId: overrides?.zoneId ?? 1,
      cardType: 'soil',
      sourceKey: 's',
      channelKey,
    },
    label: seriesId,
    unit,
    coveragePct: null,
    points: Array.from({ length: n }, (_, i) => ({
      t: `2026-06-18T${String(i).padStart(2, '0')}:00:00Z`,
      value: i,
      count: 1,
      quality: 'ok',
    })),
    truncated: false, cadence: 'hourly', timezone: null,
  };
}

describe('zonePairs', () => {
  it('pairs unassigned channels only within the same device source', () => {
    const x = { ...series(1, 'soil', [1]), resolved: { ...series(1, 'soil', [1]).resolved, zoneId: null, deviceSourceId: 'device-a' } };
    const y = { ...series(1, 'dendro', [2]), resolved: { ...series(1, 'dendro', [2]).resolved, zoneId: null, deviceSourceId: 'device-b' } };
    expect(zonePairs([x, y], 'soil', 'dendro')).toEqual([]);
  });

  it('pairs unassigned channels when they share one device source', () => {
    const x = series(null, 'soil', [1, 2], 'device-a');
    const y = series(null, 'dendro', [3, 4], 'device-a');

    expect(zonePairs([x, y], 'soil', 'dendro')).toEqual([
      { groupId: 'device:device-a', zoneId: null, label: 'Unassigned device', points: [[1, 3], [2, 4]] },
    ]);
  });

  it('keeps same-name unassigned device sources as separate groups', () => {
    const xA = { ...series(null, 'soil', [1, 2], 'device-a'), seriesId: 'device-a-soil', label: 'Rain - soil' };
    const yA = { ...series(null, 'dendro', [3, 4], 'device-a'), seriesId: 'device-a-dendro', label: 'Rain - dendro' };
    const xB = { ...series(null, 'soil', [5, 6], 'device-b'), seriesId: 'device-b-soil', label: 'Rain - soil' };
    const yB = { ...series(null, 'dendro', [7, 8], 'device-b'), seriesId: 'device-b-dendro', label: 'Rain - dendro' };

    expect(zonePairs([xA, yA, xB, yB], 'soil', 'dendro')).toEqual([
      { groupId: 'device:device-a', zoneId: null, label: 'Rain', points: [[1, 3], [2, 4]] },
      { groupId: 'device:device-b', zoneId: null, label: 'Rain', points: [[5, 7], [6, 8]] },
    ]);
  });

  it('labels groups by the catalog zone name, falling back to "Zone {id}"', () => {
    const series = [
      mkSeries('x', 'dendro_stem_change_um', 'um', { zoneId: 9 }),
      mkSeries('y', 'ext_temperature_c', 'C', { zoneId: 9 }),
    ];
    const zoneNames = new Map<number, string>([[9, 'North Block']]);
    expect(zonePairs(series, 'dendro_stem_change_um', 'ext_temperature_c', zoneNames)[0].label).toBe('North Block');
    // no catalog name → fallback
    expect(zonePairs(series, 'dendro_stem_change_um', 'ext_temperature_c')[0].label).toBe('Zone 9');
  });

  it('pairs sparse series by matching timestamps instead of array index', () => {
    const x = timestampedSeries(1, 'soil', [['00', 1], ['01', 2], ['02', 3]]);
    const y = timestampedSeries(1, 'dendro', [['01', 20], ['02', 30], ['03', 40]]);

    expect(zonePairs([x, y], 'soil', 'dendro')).toEqual([
      { groupId: 'zone:1', zoneId: 1, label: 'Zone 1', points: [[2, 20], [3, 30]] },
    ]);

    const result = computeCorrelation([x, y], 'soil', 'dendro', { minSamples: 1 });
    expect(result.groups[0].n).toBe(2);
    expect(result.groups[0].droppedPairs).toBe(2);
  });
});

describe('computeCorrelation', () => {
  it('suppresses unassigned channels without a device source identity', () => {
    const x = series(null, 'soil', [1, 2]);
    const y = series(null, 'dendro', [3, 4]);
    const result = computeCorrelation([x, y], 'soil', 'dendro', { minSamples: 1 });

    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((group) => group.suppressed && group.suppressionReason === 'missing_device_source')).toBe(true);
    expect(result.pooled).toBeNull();
  });

  it('suppresses an assigned group with multiple candidate channels', () => {
    const x1 = series(7, 'soil', [1, 2]);
    const x2 = { ...series(7, 'soil', [2, 3]), seriesId: '7-soil-second' };
    const y = series(7, 'dendro', [3, 4]);
    const result = computeCorrelation([x1, x2, y], 'soil', 'dendro', { minSamples: 1 });

    expect(result.groups).toEqual([
      expect.objectContaining({ groupId: 'zone:7', zoneId: 7, suppressed: true, suppressionReason: 'ambiguous' }),
    ]);
  });

  it('excludes ambiguous groups from pooled output while retaining valid groups', () => {
    const ambiguousX = series(1, 'soil', [1, 2]);
    const ambiguousX2 = { ...series(1, 'soil', [2, 3]), seriesId: '1-soil-second' };
    const ambiguousY = series(1, 'dendro', [3, 4]);
    const validX = series(2, 'soil', [4, 5]);
    const validY = series(2, 'dendro', [8, 10]);
    const result = computeCorrelation(
      [ambiguousX, ambiguousX2, ambiguousY, validX, validY],
      'soil',
      'dendro',
      { pooled: true, minSamples: 1 },
    );

    expect(result.groups).toEqual([
      expect.objectContaining({ groupId: 'zone:1', suppressed: true, suppressionReason: 'ambiguous' }),
      expect.objectContaining({ groupId: 'zone:2', n: 2, suppressed: false }),
    ]);
    expect(result.pooled).toEqual(expect.objectContaining({ groupId: 'pooled', n: 2, suppressed: false }));
  });

  it('reports r=1 for a perfectly linear zone with enough samples', () => {
    const n = MIN_CORRELATION_SAMPLES;
    const x = series(1, 'soil', ramp(n, (i) => i));
    const y = series(1, 'dendro', ramp(n, (i) => 2 * i + 3));
    const result = computeCorrelation([x, y], 'soil', 'dendro');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].n).toBe(n);
    expect(result.groups[0].r).toBeCloseTo(1, 6);
    expect(result.groups[0].suppressed).toBe(false);
  });

  it('suppresses zones below the minimum sample count', () => {
    const x = series(2, 'soil', ramp(5, (i) => i));
    const y = series(2, 'dendro', ramp(5, (i) => i));
    const result = computeCorrelation([x, y], 'soil', 'dendro');
    expect(result.groups[0].suppressed).toBe(true);
    expect(result.groups[0].r).toBeNull();
    expect(result.groups[0].n).toBe(5);
  });

  it('pairwise-deletes buckets where either channel is null', () => {
    const x = series(3, 'soil', [1, 2, null, 4]);
    const y = series(3, 'dendro', [1, null, 3, 4]);
    const result = computeCorrelation([x, y], 'soil', 'dendro', { minSamples: 1 });
    expect(result.groups[0].n).toBe(2); // buckets 0 and 3
    expect(result.groups[0].droppedPairs).toBe(2);
  });

  it('computes a pooled group only when requested', () => {
    const n = MIN_CORRELATION_SAMPLES;
    const series1x = series(1, 'soil', ramp(n, (i) => i));
    const series1y = series(1, 'dendro', ramp(n, (i) => i));
    const noPool = computeCorrelation([series1x, series1y], 'soil', 'dendro');
    expect(noPool.pooled).toBeNull();
    const pooled = computeCorrelation([series1x, series1y], 'soil', 'dendro', { pooled: true });
    expect(pooled.pooled?.zoneId).toBeNull();
    expect(pooled.pooled?.n).toBe(n);
  });

  it('treats legacy aliases and canonical channel keys as the same series family', () => {
    const n = MIN_CORRELATION_SAMPLES;
    const x = series(1, 'ambient_temperature', ramp(n, (i) => i));
    const y = series(1, 'dendro', ramp(n, (i) => 2 * i));
    const result = computeCorrelation([x, y], 'temperature', 'dendro');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].r).toBeCloseTo(1, 6);
  });
});
