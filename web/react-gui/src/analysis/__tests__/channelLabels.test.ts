import { describe, it, expect } from 'vitest';
import { prettyUnit, axisLabel, channelMetaFromCatalog } from '../channelLabels';
import type { AnalysisCatalogEntry } from '../types';

const meta = channelMetaFromCatalog([
  {
    seriesId: 's1',
    hubEui: null,
    zoneId: 1,
    zoneName: 'Z',
    cardType: 'soil',
    sourceKey: 'root-zone',
    channelKey: 'swt_1',
    displayName: 'Soil water tension 1',
    unit: 'kPa',
    availability: 'available',
    deviceName: null,
    depthCm: null,
  } as AnalysisCatalogEntry,
  {
    seriesId: 's2',
    hubEui: null,
    zoneId: 1,
    zoneName: 'Z',
    cardType: 'environment',
    sourceKey: 'microclimate',
    channelKey: 'ambient_temperature',
    displayName: 'Air temperature',
    unit: 'C',
    availability: 'available',
    deviceName: null,
    depthCm: null,
  } as AnalysisCatalogEntry,
]);

describe('channelLabels', () => {
  it('prettifies unit glyphs', () => {
    expect(prettyUnit('C')).toBe('°C');
    expect(prettyUnit('um')).toBe('µm');
    expect(prettyUnit('kPa')).toBe('kPa');
    expect(prettyUnit(null)).toBe('');
  });

  it('builds "Name (unit)" axis labels from catalog meta', () => {
    expect(axisLabel('swt_1', meta)).toBe('Soil water tension 1 (kPa)');
    expect(axisLabel('ambient_temperature', meta)).toBe('Air temperature (°C)');
  });

  it('falls back to the raw channelKey when unknown', () => {
    expect(axisLabel('mystery', meta)).toBe('mystery');
  });
});

import { axisQuantityLabel } from '../channelLabels';

describe('axisQuantityLabel', () => {
  it('uses registry displayName with stripped per-sensor suffix + pretty unit', () => {
    expect(axisQuantityLabel('swt_1', 'kPa')).toBe('Soil water tension (kPa)');
    expect(axisQuantityLabel('ambient_temperature', 'C')).toBe('Ambient temperature (°C)');
    expect(axisQuantityLabel('dendro_stem_change_um', 'um')).toBe('Stem diameter change (µm)');
  });
  it('omits parens when unit is null', () => {
    expect(axisQuantityLabel('uv_index', null)).toBe('UV index');
  });
});
