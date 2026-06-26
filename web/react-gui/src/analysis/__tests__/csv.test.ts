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
  truncated: false,
};

const catalog = new Map<string, AnalysisCatalogEntry>([
  ['abc', {
    seriesId: 'abc', hubEui: 'HUB-1', zoneId: 12, zoneName: 'North, Plot A',
    cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1',
    displayName: 'Chameleon 1: SWT 5cm', unit: 'kPa', availability: 'available',
    deviceName: 'Chameleon 1', depthCm: 5,
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
});
