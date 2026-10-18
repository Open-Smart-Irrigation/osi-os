import { describe, expect, it } from 'vitest';
import { exportRangeForOpen, exportSourceContextForCard } from '../HistoryCardDetailPage';
import type { HistoryCardSummary } from '../../history/types';

function soilCard(metadata: Record<string, unknown>): HistoryCardSummary {
  return {
    cardId: 'zone-1:soil:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil',
    subtitle: '',
    defaultView: 'soil-profile',
    views: ['soil-profile'],
    supportedRanges: ['24h'],
    defaultRange: '24h',
    sourceDevices: [{ name: 'Watermark', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'watermark' }],
    metadata: { coverageConfidence: 'unknown', ...metadata },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 0, recentRank: null, manualOrder: null, criticalAlert: false },
  };
}

describe('HistoryCardDetailPage export source context', () => {
  it('keeps non-Chameleon LSN50 exports on canonical SWT1/SWT2 channels', () => {
    expect(exportSourceContextForCard(soilCard({}), null)).toEqual({
      deviceType: 'DRAGINO_LSN50',
      chameleonEnabled: false,
    });
  });

  it('preserves Chameleon SWT3 export capability for LSN50 cards', () => {
    expect(exportSourceContextForCard(soilCard({ chameleonEnabled: true }), null)).toEqual({
      deviceType: 'DRAGINO_LSN50',
      chameleonEnabled: true,
    });
  });
});

describe('HistoryCardDetailPage export range for the mobile uPlot chart', () => {
  const legacyRange = { from: '2026-10-01', to: '2026-10-18' };

  it('opens export on the dates of the interval the uPlot chart shows', () => {
    const range = exportRangeForOpen({
      uplotActive: true,
      readVisibleInterval: () => ({ from: Date.parse('2026-08-03T00:00:00.000Z'), to: Date.parse('2026-08-10T00:00:00.000Z') }),
      legacyRange,
    });
    // The interval end is exclusive: a window ending exactly at midnight does
    // not add the following day.
    expect(range).toEqual({ from: '2026-08-03', to: '2026-08-09' });
  });

  it('includes the day that contains a mid-day interval end', () => {
    expect(exportRangeForOpen({
      uplotActive: true,
      readVisibleInterval: () => ({ from: Date.parse('2026-08-03T06:30:00.000Z'), to: Date.parse('2026-08-04T06:30:00.000Z') }),
      legacyRange,
    })).toEqual({ from: '2026-08-03', to: '2026-08-04' });
  });

  it('keeps the legacy page range when the uPlot chart is not active', () => {
    const readVisibleInterval = () => ({ from: Date.parse('2026-08-03T00:00:00.000Z'), to: Date.parse('2026-08-10T00:00:00.000Z') });
    expect(exportRangeForOpen({ uplotActive: false, readVisibleInterval, legacyRange })).toEqual(legacyRange);
  });

  it('keeps the legacy page range when the chart has not mounted its viewport yet', () => {
    expect(exportRangeForOpen({ uplotActive: true, readVisibleInterval: null, legacyRange })).toEqual(legacyRange);
  });

  it('keeps the legacy page range instead of inventing dates from an invalid interval', () => {
    expect(exportRangeForOpen({
      uplotActive: true,
      readVisibleInterval: () => ({ from: Number.NaN, to: Date.parse('2026-08-10T00:00:00.000Z') }),
      legacyRange,
    })).toEqual(legacyRange);
    expect(exportRangeForOpen({
      uplotActive: true,
      readVisibleInterval: () => ({ from: Date.parse('2026-08-10T00:00:00.000Z'), to: Date.parse('2026-08-10T00:00:00.000Z') }),
      legacyRange,
    })).toEqual(legacyRange);
  });
});
