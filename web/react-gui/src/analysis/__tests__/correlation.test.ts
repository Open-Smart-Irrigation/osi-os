import { describe, it, expect } from 'vitest';
import { computeCorrelation, zonePairs, MIN_CORRELATION_SAMPLES } from '../correlation';
import type { AnalysisSeries, AnalysisPoint } from '../types';

function series(zoneId: number, channelKey: string, values: (number | null)[]): AnalysisSeries {
  const points: AnalysisPoint[] = values.map((v, i) => ({
    t: `2026-06-18T${String(i).padStart(2, '0')}:00:00Z`,
    value: v, count: v === null ? 0 : 1, quality: v === null ? 'gap' : 'ok',
  }));
  return {
    seriesId: `${zoneId}-${channelKey}`,
    resolved: { hubEui: null, zoneId, cardType: 'soil', sourceKey: 'root-zone', channelKey },
    label: `Zone ${zoneId} ${channelKey}`, unit: 'x', coveragePct: 100, points, truncated: false,
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
    truncated: false,
  };
}

describe('zonePairs', () => {
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
});

describe('computeCorrelation', () => {
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
