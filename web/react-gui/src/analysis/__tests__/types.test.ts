import { describe, it, expect } from 'vitest';
import '../types';
import type { AnalysisSeries, AnalysisSeriesResponse, AnalysisCatalogEntry } from '../types';

describe('analysis types', () => {
  it('models a bucket-aligned series response', () => {
    const entry: AnalysisCatalogEntry = {
      seriesId: 'abc', hubEui: 'HUB-1', zoneId: 12, zoneName: 'Zone A',
      cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1',
      displayName: 'SWT 1', unit: 'kPa', availability: 'available',
      deviceName: null, depthCm: null,
    };
    const series: AnalysisSeries = {
      seriesId: 'abc',
      resolved: { hubEui: 'HUB-1', zoneId: 12, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
      label: 'HUB-1 · Zone A · SWT 1', unit: 'kPa', coveragePct: 50,
      points: [
        { t: '2026-06-18T00:00:00Z', value: 41.2, count: 4, quality: 'ok' },
        { t: '2026-06-18T01:00:00Z', value: null, count: 0, quality: 'gap' },
      ],
      truncated: false,
    };
    const resp: AnalysisSeriesResponse = {
      generatedAt: '2026-06-18T10:00:00Z',
      range: { label: '24h', from: '...', to: '...', timezone: 'UTC' },
      aggregation: { requested: 'auto', applied: 'hourly', bucketSizeSeconds: 3600 },
      grid: { stepSeconds: 3600, from: '...', to: '...', bucketCount: 2 },
      series: [series], dropped: [],
    };
    expect(entry.unit).toBe('kPa');
    expect(entry.deviceName).toBeNull();
    expect(resp.series[0].points[1].quality).toBe('gap');
  });
});
