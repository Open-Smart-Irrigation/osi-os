import { describe, expect, it } from 'vitest';
import { normaliseHistoryCardDataResponse, normaliseHistoryCardSummary } from '../api';

describe('history card source normalization', () => {
  it('preserves per-source Chameleon flags from camel and snake case payloads', () => {
    const card = normaliseHistoryCardSummary({
      cardType: 'soil',
      sourceDevices: [
        { name: 'Watermark', typeId: 'DRAGINO_LSN50', role: 'soil', chameleon_enabled: 0 },
        { name: 'Chameleon', type_id: 'DRAGINO_LSN50', role: 'soil', chameleonEnabled: true },
      ],
    });

    expect(card.sourceDevices?.map((source) => source.chameleonEnabled)).toEqual([false, true]);
  });

  it('normalizes real unavailable recovery metadata and source descriptors', () => {
    const response = normaliseHistoryCardDataResponse({
      seriesIdentityVersion: 2,
      availability: { available: false, reasons: ['raw_read_limit_exceeded', 'select_fewer_sources_or_shorter_interval'] },
      limits: { maxPointsPerSeries: 2000, maxPointsTotal: 30000, truncated: false },
      series: [
        { sourceKey: 'soil-src-a', deviceSourceId: 'device-a', sourceLabel: 'Soil sensor', label: 'SWT 1', points: [] },
        { sourceKey: 'soil-src-a', deviceSourceId: 'device-a', sourceLabel: 'Soil sensor', label: 'SWT 2', points: [] },
        { sourceKey: 'soil-src-b', deviceSourceId: 'device-b', sourceLabel: 'Soil sensor', label: 'SWT 1', points: [] },
      ],
    });

    expect(response.availability).toEqual({ available: false, reasons: ['raw_read_limit_exceeded', 'select_fewer_sources_or_shorter_interval'] });
    expect(response.limits.reason).toBe('raw_read_limit_exceeded');
    expect(response.limits.availableSources).toEqual([
      { sourceKey: 'soil-src-a', label: 'Soil sensor · il-src-a', deviceSourceId: 'device-a' },
      { sourceKey: 'soil-src-b', label: 'Soil sensor · il-src-b', deviceSourceId: 'device-b' },
    ]);
    expect(normaliseHistoryCardDataResponse({ availability: { available: false, reasons: ['no_data'] }, limits: {}, series: [] }).limits.reason).toBeNull();
  });
});
