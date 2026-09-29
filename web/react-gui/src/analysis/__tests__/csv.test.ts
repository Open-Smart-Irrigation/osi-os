import { describe, it, expect } from 'vitest';
import { toTidyCsv } from '../csv';
import type { AnalysisSeries, AnalysisCatalogEntry } from '../types';

const series: AnalysisSeries = {
  seriesId: 'abc',
  resolved: { hubEui: 'HUB-1', zoneId: 12, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
  label: 'x', unit: 'kPa', coveragePct: 50,
  points: [
    { t: '2026-06-18T00:00:00Z', value: 41.2, count: 4, quality: 'ok' },
    { t: '2026-06-18T01:00:00Z', value: null, count: 0, quality: 'gap' },
  ],
  truncated: false, cadence: 'hourly', timezone: null,
};

const catalog = new Map<string, AnalysisCatalogEntry>([
  ['abc', {
    seriesId: 'abc', hubEui: 'HUB-1', zoneId: 12, zoneName: 'North, Plot A',
    cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1',
    displayName: 'Chameleon 1: SWT 5cm', unit: 'kPa', availability: 'available',
    deviceName: 'Chameleon 1', depthCm: 5, sourceKind: 'device',
  }],
]);

describe('toTidyCsv', () => {
  it('emits one row per bucket with header and null as empty', () => {
    const csv = toTidyCsv([series], catalog);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('timestamp,site,zone,series_label,card_type,source_key,channel_key,depth_cm,array_id,unit,value');
    // zoneName has a comma -> must be quoted
    expect(lines[1]).toBe('2026-06-18T00:00:00Z,HUB-1,"North, Plot A",Chameleon 1: SWT 5cm,soil,root-zone,swt_1,5,,kPa,41.2');
    expect(lines[2]).toBe('2026-06-18T01:00:00Z,HUB-1,"North, Plot A",Chameleon 1: SWT 5cm,soil,root-zone,swt_1,5,,kPa,');
  });

  it('falls back to zoneId when the catalog lacks the series', () => {
    const csv = toTidyCsv([series], new Map());
    expect(csv.split('\n')[1]).toContain(',12,x,soil,');
  });

  it('writes the zone-local date for a daily series and the instant for an hourly weather series', () => {
    const daily: AnalysisSeries = {
      seriesId: 'et0',
      resolved: { hubEui: 'HUB-1', zoneId: 1, cardType: 'environment', sourceKey: 'agronomy-src-zone', channelKey: 'et0_mm' },
      label: 'North daily agronomy - Reference ET (ET0)', unit: 'mm/d', coveragePct: null,
      points: [{ t: '2026-09-24T22:00:00.000Z', value: 3.1, count: 1, expected: null, quality: null }],
      truncated: false, cadence: 'daily', timezone: 'Europe/Zurich',
    };
    const provider: AnalysisSeries = {
      seriesId: 'rain',
      resolved: { hubEui: 'HUB-1', zoneId: 1, cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey: 'rain_mm_per_hour' },
      label: 'Open-Meteo 46.80°N 6.95°E - Rain rate', unit: 'mm/h', coveragePct: null,
      points: [{ t: '2026-09-24T22:00:00.000Z', value: 0.4, count: 1, expected: null, quality: null }],
      truncated: false, cadence: 'hourly', timezone: 'Europe/Zurich',
    };
    const lines = toTidyCsv([daily, provider], new Map()).split('\n');
    expect(lines[1]).toBe('2026-09-25,HUB-1,1,North daily agronomy - Reference ET (ET0),environment,agronomy-src-zone,et0_mm,,,mm/d,3.1');
    expect(lines[2]).toBe('2026-09-24T22:00:00.000Z,HUB-1,1,Open-Meteo 46.80°N 6.95°E - Rain rate,environment,weather-src-0123456789ab,rain_mm_per_hour,,,mm/h,0.4');
    const invalidZone = toTidyCsv([{ ...daily, timezone: 'Not/AZone' }], new Map()).split('\n');
    expect(invalidZone[1].startsWith('2026-09-24,')).toBe(true);
  });
});
