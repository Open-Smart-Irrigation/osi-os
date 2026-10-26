import { describe, expect, it } from 'vitest';

import { presentSwtCatalog, presentSwtSeries } from '../swtPresentation';
import type { AnalysisCatalogEntry, AnalysisSeries } from '../types';

const catalog = (channelKey: string, unit: string | null, cardType = 'soil'): AnalysisCatalogEntry => ({
  seriesId: `${channelKey}-id`, hubEui: 'EDGE-1', zoneId: 7, zoneName: 'North', cardType,
  sourceKey: 'root-zone', channelKey, displayName: channelKey, unit, availability: 'available',
  deviceName: 'Tensiomark pair', depthCm: null, sourceKind: 'device',
});

const series = (channelKey: string, unit: string | null, value: number | null, cardType = 'soil'): AnalysisSeries => ({
  seriesId: `${channelKey}-id`,
  resolved: { hubEui: 'EDGE-1', zoneId: 7, cardType, sourceKey: 'root-zone', channelKey },
  label: channelKey, unit, coveragePct: null,
  points: [{ t: '2026-10-16T08:00:00Z', value, count: value == null ? 0 : 1, quality: value == null ? 'gap' : 'ok' }],
  truncated: false, cadence: 'hourly', timezone: null,
});

describe('SWT presentation', () => {
  it('projects canonical and legacy soil SWT kPa entries to pF without changing IDs, depths, or unrelated metrics', () => {
    const entries = [catalog('swt_1', 'kPa'), catalog('swt_wm2', 'kPa'), catalog('soil_temp_1', 'C'), catalog('pipe_pressure_kpa', 'kPa', 'irrigation')];
    const presented = presentSwtCatalog(entries, 'pF');

    expect(presented.map(({ seriesId, channelKey, unit, depthCm }) => ({ seriesId, channelKey, unit, depthCm }))).toEqual([
      { seriesId: 'swt_1-id', channelKey: 'swt_1', unit: 'pF', depthCm: null },
      { seriesId: 'swt_wm2-id', channelKey: 'swt_wm2', unit: 'pF', depthCm: null },
      { seriesId: 'soil_temp_1-id', channelKey: 'soil_temp_1', unit: 'C', depthCm: null },
      { seriesId: 'pipe_pressure_kpa-id', channelKey: 'pipe_pressure_kpa', unit: 'kPa', depthCm: null },
    ]);
    expect(entries[0].unit).toBe('kPa');
  });

  it('projects only finite canonical SWT readings, retaining zero pF and missing gaps with full point precision', () => {
    const source = [series('swt_1', 'kPa', 1.97), series('swt_wm2', 'kPa', 0.1), series('swt_3', 'kPa', Number.NaN), series('soil_temp_1', 'C', 13.96)];
    const presented = presentSwtSeries(source, 'pF');

    expect(presented.map((item) => [item.unit, item.points[0].value])).toEqual([
      ['pF', 1.294466226161593],
      ['pF', 0],
      ['pF', null],
      ['C', 13.96],
    ]);
    expect(source[0].points[0].value).toBe(1.97);
  });
});
