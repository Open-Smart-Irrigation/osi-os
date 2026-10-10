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
    expect(axisQuantityLabel('swt_1', 'kPa')).toBe('Soil tension 1 (kPa)');
    expect(axisQuantityLabel('ambient_temperature', 'C')).toBe('Ambient temperature (°C)');
    expect(axisQuantityLabel('dendro_stem_change_um', 'um')).toBe('Stem diameter change (µm)');
  });
  it('omits parens when unit is null', () => {
    expect(axisQuantityLabel('uv_index', null)).toBe('UV index');
  });

  it('names the ET0 axis from the manifest with the series period unit', () => {
    expect(axisQuantityLabel('et0_mm', 'mm/d')).toBe('Reference evapotranspiration (mm/d)');
    expect(axisQuantityLabel('global_radiation_wm2', 'W/m²')).toBe('Global radiation (W/m²)');
  });
});

import { rainfallLabel, presentRainfallName } from '../channelLabels';

describe('rainfallLabel', () => {
  it('raw samples are this interval, sums are an amount', () => {
    expect(rainfallLabel('rain_mm_delta', 'raw')).toBe('Rainfall this interval');
    expect(rainfallLabel('rain_mm_delta', '15m')).toBe('Rainfall amount');
    expect(rainfallLabel('rain_mm_delta', 'hourly')).toBe('Rainfall amount');
    expect(rainfallLabel('rain_mm_delta', 'daily')).toBe('Rainfall amount');
    expect(rainfallLabel('rain_mm_delta', 'weekly')).toBe('Rainfall amount');
    expect(rainfallLabel('swt_1', 'raw')).toBeNull();
    expect(rainfallLabel('rain_mm_per_hour', 'raw')).toBeNull();
  });

  it('names a device rain amount by the applied aggregation and leaves other names alone', () => {
    const rain = { channelKey: 'rain_mm_delta', deviceName: 'Gauge', displayName: 'Gauge - Rainfall amount', sourceKind: 'device' };
    expect(presentRainfallName(rain, 'raw')).toBe('Gauge - Rainfall this interval');
    expect(presentRainfallName(rain, 'daily')).toBe('Gauge - Rainfall amount');
    expect(presentRainfallName(rain, undefined)).toBe('Gauge - Rainfall amount');
    const soil = { channelKey: 'swt_1', deviceName: 'Kiwi', displayName: 'Kiwi - Soil tension 1', sourceKind: 'device' };
    expect(presentRainfallName(soil, 'raw')).toBe('Kiwi - Soil tension 1');
  });

  it('the axis of a rain amount follows the manifest name', () => {
    expect(axisQuantityLabel('rain_mm_delta', 'mm')).toBe('Rainfall amount (mm)');
  });
});

describe('axisQuantityLabel with an aggregation', () => {
  it('names a raw rain axis by the interval and leaves other axes alone', () => {
    expect(axisQuantityLabel('rain_mm_delta', 'mm', 'raw')).toBe('Rainfall this interval (mm)');
    expect(axisQuantityLabel('rain_mm_delta', 'mm', 'daily')).toBe('Rainfall amount (mm)');
    expect(axisQuantityLabel('swt_1', 'kPa', 'raw')).toBe('Soil tension 1 (kPa)');
  });
});
