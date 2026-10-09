import type { AnalysisCatalogEntry, AnalysisSeries } from '../../types';

// A Data view export of three kinds of series: a soil device (zone name with a comma), a
// daily agronomy series and a LoRain rain amount over the 25-hour autumn day in a zone on
// Europe/Zurich. The v1 snapshot of these is pinned in csv.test.ts.

export const soil: AnalysisSeries = {
  seriesId: 'soil',
  resolved: { hubEui: 'HUB-1', zoneId: 12, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', deviceSourceId: 'device-soil' },
  label: 'Chameleon 1 - Soil tension 1', unit: 'kPa', coveragePct: null,
  points: [
    { t: '2026-10-24T22:00:00.000Z', value: 41.2, count: 96, quality: 'derived' },
    { t: '2026-10-25T23:00:00.000Z', value: null, count: 0, quality: 'unknown' },
  ],
  truncated: false, cadence: 'hourly', timezone: 'Europe/Zurich',
};

export const et0: AnalysisSeries = {
  seriesId: 'et0',
  resolved: { hubEui: 'HUB-1', zoneId: 12, cardType: 'environment', sourceKey: 'agronomy-src-zone', channelKey: 'et0_mm' },
  label: 'North daily agronomy - Reference ET (ET0)', unit: 'mm/d', coveragePct: null,
  points: [{ t: '2026-10-24T22:00:00.000Z', value: 0.9, count: 1, expected: null, quality: null }],
  truncated: false, cadence: 'daily', timezone: 'Europe/Zurich',
};

export const rain: AnalysisSeries = {
  seriesId: 'rain',
  resolved: { hubEui: 'HUB-1', zoneId: 12, cardType: 'environment', sourceKey: 'environment-src-1', channelKey: 'rain_mm_delta', deviceSourceId: 'device-rain' },
  label: 'Gauge - Rainfall amount', unit: 'mm', coveragePct: null,
  points: [
    { t: '2026-10-24T22:00:00.000Z', value: 1.5, count: 2, expected: null, quality: 'unknown' },
    { t: '2026-10-25T23:00:00.000Z', value: null, count: 0, expected: null, quality: 'unknown' },
  ],
  truncated: false, cadence: 'hourly', timezone: 'Europe/Zurich',
};

const deviceEntry = (seriesId: string, extra: Partial<AnalysisCatalogEntry>): AnalysisCatalogEntry => ({
  seriesId, hubEui: 'HUB-1', zoneId: 12, zoneName: 'North, Plot A', cardType: 'environment', sourceKey: 'environment-src-1',
  channelKey: 'rain_mm_delta', displayName: '', unit: 'mm', availability: 'available', deviceName: null, depthCm: null,
  depthReference: null, sourceKind: 'device', configurationState: 'current', legacy: false, ...extra,
});

export const catalogById = new Map<string, AnalysisCatalogEntry>([
  ['soil', deviceEntry('soil', { cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1', displayName: 'Chameleon 1 - Soil tension 1', unit: 'kPa', deviceName: 'Chameleon 1', depthCm: 5, depthReference: 'current_layout' })],
  ['rain', deviceEntry('rain', { displayName: 'Gauge - Rainfall amount', deviceName: 'Gauge' })],
]);

export const seriesList = [soil, et0, rain];
