import { expect, test } from 'vitest';
import { normalizeMobileAnalysisResponse, toMobileAnalysisWindow } from '../src/mobile/mobileTensionPolicy';
import type { HistoryWindowRequest, MobileAnalysisResponseDto } from '../src/shared/types';

test('invalid-average count survives normalization and accepted-response projection', () => {
  const request: HistoryWindowRequest = { from: 0, to: 3600000, rangeLabel: '24h', aggregation: 'hourly', readPolicy: 'edge-hourly' };
  const dto: MobileAnalysisResponseDto = {
    readPolicy: 'edge-hourly', coverage: { from: 0, to: 3600000 }, appliedAggregation: 'hourly', truncated: false,
    dropped: [], grid: { platform: 'edge', from: 0, to: 3600000 },
    series: [{ seriesId: 'invalid', label: 'Invalid', unit: 'kPa', truncated: false, points: [{ at: 0, value: 1000001, count: 1, quality: 'ok' }] }],
  };
  const normalized = normalizeMobileAnalysisResponse(dto, request, ['invalid']);
  expect(normalized.window.invalidHourlyAverageCount).toBe(1);
  expect(toMobileAnalysisWindow(normalized.response, ['invalid']).invalidHourlyAverageCount).toBe(1);
  expect(toMobileAnalysisWindow(normalized.response, []).invalidHourlyAverageCount).toBe(0);
});
