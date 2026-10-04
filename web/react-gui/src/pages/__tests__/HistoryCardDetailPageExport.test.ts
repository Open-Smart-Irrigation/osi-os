import { describe, expect, it } from 'vitest';
import { exportSourceContextForCard } from '../HistoryCardDetailPage';
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
