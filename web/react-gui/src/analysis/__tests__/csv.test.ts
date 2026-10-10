import { describe, it, expect } from 'vitest';
import { CSV_V2_EXTRA_COLUMNS, toTidyCsv } from '../csv';
import { catalogById as fixtureCatalog, rain as fixtureRain, seriesList as fixtureSeries } from './fixtures/csvSeries';
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
    deviceName: 'Chameleon 1', depthCm: 5, depthReference: 'current_layout', sourceKind: 'device',
  }],
]);

describe('toTidyCsv', () => {
  it('labels unassigned null-zone samples explicitly even without catalogue metadata', () => {
    const unassigned: AnalysisSeries = {
      ...series,
      seriesId: 'unassigned-rain',
      resolved: { ...series.resolved, zoneId: null, deviceSourceId: 'device-rain-1', channelKey: 'rain_mm_delta' },
      label: 'Rain gauge - Rain',
      points: [{ ...series.points[0], value: 6 }],
    };
    expect(toTidyCsv([unassigned], new Map()).split('\n')[1]).toContain(',Unassigned devices,');
  });

  it('emits one row per bucket with header and null as empty', () => {
    const csv = toTidyCsv([series], catalog);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('timestamp,site,zone,series_label,card_type,source_key,channel_key,depth_cm,array_id,unit,value,depth_reference');
    // zoneName has a comma -> must be quoted
    expect(lines[1]).toBe('2026-06-18T00:00:00Z,HUB-1,"North, Plot A",Chameleon 1: SWT 5cm,soil,root-zone,swt_1,5,,kPa,41.2,current_layout');
    expect(lines[2]).toBe('2026-06-18T01:00:00Z,HUB-1,"North, Plot A",Chameleon 1: SWT 5cm,soil,root-zone,swt_1,5,,kPa,,current_layout');
  });

  it('qualifies current depth, labels legacy depth unspecified, and leaves null depth blank', () => {
    const legacy: AnalysisSeries = { ...series, seriesId: 'legacy', resolved: { ...series.resolved, channelKey: 'vwc_1' }, points: [series.points[0]] };
    const missing: AnalysisSeries = { ...series, seriesId: 'missing', resolved: { ...series.resolved, channelKey: 'vwc_2' }, points: [series.points[0]] };
    const rows = new Map<string, AnalysisCatalogEntry>([
      ['legacy', { ...catalog.get('abc')!, seriesId: 'legacy', depthCm: 10, depthReference: undefined }],
      ['missing', { ...catalog.get('abc')!, seriesId: 'missing', depthCm: null, depthReference: null }],
    ]);
    const lines = toTidyCsv([legacy, missing], rows).split('\n');
    expect(lines[1]).toContain(',vwc_1,10,,kPa,41.2,unspecified');
    expect(lines[2]).toContain(',vwc_2,,,kPa,41.2,');
  });

  it('keeps an observed zero distinct from a null point', () => {
    const zero: AnalysisSeries = { ...series, seriesId: 'zero', points: [{ ...series.points[0], value: 0 }] };
    const zeroCatalog = new Map([['zero', { ...catalog.get('abc')!, seriesId: 'zero', depthCm: null, depthReference: null }]]);
    expect(toTidyCsv([zero], zeroCatalog).split('\n')[1]).toContain(',swt_1,,,kPa,0,');
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
    expect(lines[1]).toBe('2026-09-25,HUB-1,1,North daily agronomy - Reference ET (ET0),environment,agronomy-src-zone,et0_mm,,,mm/d,3.1,');
    expect(lines[2]).toBe('2026-09-24T22:00:00.000Z,HUB-1,1,Open-Meteo 46.80°N 6.95°E - Rain rate,environment,weather-src-0123456789ab,rain_mm_per_hour,,,mm/h,0.4,');
    const invalidZone = toTidyCsv([{ ...daily, timezone: 'Not/AZone' }], new Map()).split('\n');
    expect(invalidZone[1].startsWith('2026-09-24,')).toBe(true);
  });
});

// Taken from origin/main's toTidyCsv (csv.ts unchanged there) before the version option
// existed: the default export must keep these bytes.
const V1_SNAPSHOT = [
  'timestamp,site,zone,series_label,card_type,source_key,channel_key,depth_cm,array_id,unit,value,depth_reference',
  '2026-10-24T22:00:00.000Z,HUB-1,"North, Plot A",Chameleon 1 - Soil tension 1,soil,root-zone,swt_1,5,,kPa,41.2,current_layout',
  '2026-10-25T23:00:00.000Z,HUB-1,"North, Plot A",Chameleon 1 - Soil tension 1,soil,root-zone,swt_1,5,,kPa,,current_layout',
  '2026-10-25,HUB-1,12,North daily agronomy - Reference ET (ET0),environment,agronomy-src-zone,et0_mm,,,mm/d,0.9,',
  '2026-10-24T22:00:00.000Z,HUB-1,"North, Plot A",Gauge - Rainfall amount,environment,environment-src-1,rain_mm_delta,,,mm,1.5,',
  '2026-10-25T23:00:00.000Z,HUB-1,"North, Plot A",Gauge - Rainfall amount,environment,environment-src-1,rain_mm_delta,,,mm,,',
].join('\n');

describe('toTidyCsv versions', () => {
  it('v1 stays byte-identical by default and when asked for explicitly', () => {
    expect(toTidyCsv(fixtureSeries, fixtureCatalog)).toBe(V1_SNAPSHOT);
    expect(toTidyCsv(fixtureSeries, fixtureCatalog, { version: 1 })).toBe(V1_SNAPSHOT);
    expect(toTidyCsv(fixtureSeries, fixtureCatalog, { version: 1, aggregation: 'daily', rangeEnd: '2026-10-26T23:00:00.000Z' })).toBe(V1_SNAPSHOT);
  });

  it('v2 announces itself and appends timezone, period bounds, quality, coverage and sample count', () => {
    expect(CSV_V2_EXTRA_COLUMNS).toEqual(['timezone', 'period_start', 'period_end', 'quality', 'coverage', 'sample_count']);
    const lines = toTidyCsv(fixtureSeries, fixtureCatalog, { version: 2, aggregation: 'daily', rangeEnd: '2026-10-26T23:00:00.000Z' }).split('\n');
    expect(lines[0]).toBe('# osi-csv-version: 2');
    expect(lines[1]).toBe(`${V1_SNAPSHOT.split('\n')[0]},timezone,period_start,period_end,quality,coverage,sample_count`);
    // Every v2 row starts with its v1 row.
    V1_SNAPSHOT.split('\n').slice(1).forEach((row, index) => expect(lines[index + 2].startsWith(`${row},`)).toBe(true));
    // A LoRain daily amount: the zone-local day of the 25-hour autumn change, received reports only.
    expect(lines[5]).toBe('2026-10-24T22:00:00.000Z,HUB-1,"North, Plot A",Gauge - Rainfall amount,environment,environment-src-1,rain_mm_delta,,,mm,1.5,'
      + ',Europe/Zurich,2026-10-24T22:00:00.000Z,2026-10-25T23:00:00.000Z,received_only,,2');
    // The last bucket ends at the range end; an empty rain bucket is still received-only, count 0.
    expect(lines[6].endsWith(',Europe/Zurich,2026-10-25T23:00:00.000Z,2026-10-26T23:00:00.000Z,received_only,,0')).toBe(true);
    // A non-rain device bucket carries no quality grade; a daily agronomy row spans its local day.
    expect(lines[2].endsWith(',Europe/Zurich,2026-10-24T22:00:00.000Z,2026-10-25T23:00:00.000Z,,,96')).toBe(true);
    expect(lines[4].endsWith(',Europe/Zurich,2026-10-24T22:00:00.000Z,2026-10-25T23:00:00.000Z,,,1')).toBe(true);
  });

  it('v2 names a raw rain report "this interval", ending at the report, start unknown', () => {
    const raw = { ...fixtureRain, points: [{ t: '2026-10-25T06:15:00.000Z', value: 0.5, count: 1, expected: null, quality: null }] };
    const lines = toTidyCsv([raw], fixtureCatalog, { version: 2, aggregation: 'raw', rangeEnd: '2026-10-26T00:00:00.000Z' }).split('\n');
    expect(lines[2]).toBe('2026-10-25T06:15:00.000Z,HUB-1,"North, Plot A",Gauge - Rainfall this interval,environment,environment-src-1,rain_mm_delta,,,mm,0.5,'
      + ',Europe/Zurich,,2026-10-25T06:15:00.000Z,received_only,,1');
  });

  it('v2 states the coverage of a partial weather sum as a fraction, never for rain reports', () => {
    const provider: AnalysisSeries = {
      seriesId: 'p', resolved: { hubEui: 'HUB-1', zoneId: 1, cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey: 'rain_mm_per_hour' },
      label: 'Open-Meteo - Rain rate', unit: 'mm/d', coveragePct: null,
      points: [{ t: '2026-10-24T22:00:00.000Z', value: 3.1, count: 18, expected: 24, quality: 'partial' }],
      truncated: false, cadence: 'daily', timezone: 'Europe/Zurich',
    };
    const lines = toTidyCsv([provider], new Map(), { version: 2, aggregation: 'daily', rangeEnd: '2026-10-25T23:00:00.000Z' }).split('\n');
    expect(lines[2].endsWith(',Europe/Zurich,2026-10-24T22:00:00.000Z,2026-10-25T23:00:00.000Z,partial,0.75,18')).toBe(true);
  });
});

