import type { AnalysisCatalogEntry, AnalysisSeries } from '../../types';
import type { RainHistory, RainHistoryDay } from '../../../utils/rain';

export const A12_DST_DAYS = [
  {
    day: '2026-03-29',
    period_start: '2026-03-28T23:00:00.000Z',
    period_end: '2026-03-29T22:00:00.000Z',
    total_mm: 0.5,
    samples: 1,
    quality: 'received_only',
    so_far: false,
  },
  {
    day: '2026-10-25',
    period_start: '2026-10-24T22:00:00.000Z',
    period_end: '2026-10-25T23:00:00.000Z',
    total_mm: 1,
    samples: 2,
    quality: 'received_only',
    so_far: false,
  },
] satisfies RainHistoryDay[];

export function a12History(day: RainHistoryDay): RainHistory {
  return {
    timezone: 'Europe/Zurich',
    timezoneBasis: 'zone',
    periodStart: day.period_start,
    periodEnd: day.period_end,
    days: [day],
  };
}

export const A12_DST_EXPORT: AnalysisSeries = {
  seriesId: 'rain-dst',
  resolved: { hubEui: 'HUB-1', zoneId: 12, cardType: 'environment', sourceKey: 'rain-acceptance', channelKey: 'rain_mm_delta' },
  label: 'Rainfall amount', unit: 'mm', coveragePct: null,
  points: A12_DST_DAYS.map((day) => ({ t: day.period_start!, value: day.total_mm, count: day.samples, expected: null, quality: day.quality })),
  truncated: false, cadence: 'daily', timezone: 'Europe/Zurich',
};

export const A19_HISTORY: RainHistory = {
  timezone: 'Europe/Zurich',
  timezoneBasis: 'zone',
  periodStart: '2026-10-21T22:00:00.000Z',
  periodEnd: '2026-10-25T23:00:00.000Z',
  days: [
    { day: '2026-10-22', period_start: '2026-10-21T22:00:00.000Z', period_end: '2026-10-22T22:00:00.000Z', total_mm: null, samples: 0, quality: 'received_only', reasons: [], so_far: false },
    { day: '2026-10-23', period_start: '2026-10-22T22:00:00.000Z', period_end: '2026-10-23T22:00:00.000Z', total_mm: 0.5, samples: 1, quality: 'received_only', reasons: [], so_far: false },
    { day: '2026-10-24', period_start: '2026-10-23T22:00:00.000Z', period_end: '2026-10-24T22:00:00.000Z', total_mm: 1, samples: 2, quality: 'partial', reasons: ['instrument says "coverage, incomplete"'], so_far: false },
    { day: '2026-10-25', period_start: '2026-10-24T22:00:00.000Z', period_end: '2026-10-25T23:00:00.000Z', total_mm: 0, samples: 3, quality: 'complete', reasons: ['all samples received'], so_far: false },
  ],
};

export const A19_EXPORT: AnalysisSeries = {
  seriesId: 'rain-a19',
  resolved: { hubEui: 'HUB-1', zoneId: 12, cardType: 'environment', sourceKey: 'rain-acceptance', channelKey: 'rain_mm_delta' },
  label: 'Rainfall amount', unit: 'mm', coveragePct: null,
  points: A19_HISTORY.days.map((day) => ({ t: day.period_start!, value: day.total_mm, count: day.samples, expected: null, quality: null })),
  truncated: false, cadence: 'daily', timezone: A19_HISTORY.timezone,
};

export const RAIN_ACCEPTANCE_CATALOG = new Map<string, AnalysisCatalogEntry>([
  ['rain-dst', {
    seriesId: 'rain-dst', hubEui: 'HUB-1', zoneId: 12, zoneName: 'Rain zone', cardType: 'environment', sourceKey: 'rain-acceptance',
    channelKey: 'rain_mm_delta', displayName: 'Rainfall amount', unit: 'mm', availability: 'available', deviceName: 'Rain gauge',
    depthCm: null, depthReference: null, sourceKind: 'device', deviceSourceId: 'rain-device', configurationState: 'current', legacy: false,
  }],
  ['rain-a19', {
    seriesId: 'rain-a19', hubEui: 'HUB-1', zoneId: 12, zoneName: 'Rain zone', cardType: 'environment', sourceKey: 'rain-acceptance',
    channelKey: 'rain_mm_delta', displayName: 'Rainfall amount', unit: 'mm', availability: 'available', deviceName: 'Rain gauge',
    depthCm: null, depthReference: null, sourceKind: 'device', deviceSourceId: 'rain-device', configurationState: 'current', legacy: false,
  }],
]);
