import { describe, expect, it } from 'vitest';

import type { Device } from '../../types/farming';
import { SENSOR_FRESHNESS_WINDOW_MS, summarizeZoneSoil, zoneHasFlowMeter } from '../zoneSoil';

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();
const STALE = new Date(NOW - SENSOR_FRESHNESS_WINDOW_MS - 60 * 1000).toISOString();

function device(overrides: Partial<Device>): Device {
  return {
    deveui: 'A84041A75D5E0001',
    name: 'Sensor',
    type_id: 'KIWI_SENSOR',
    latest_data: {},
    ...overrides,
  } as Device;
}

describe('summarizeZoneSoil', () => {
  it('reports no sensor for a zone that has none configured', () => {
    const status = summarizeZoneSoil([], NOW);
    expect(status.hasSensor).toBe(false);
    expect(status.quantity).toBeNull();
    expect(status.mean).toBeNull();
  });

  it('does not count a valve or a rain gauge as a soil sensor', () => {
    const zone = [
      device({ type_id: 'STREGA_VALVE' }),
      device({ type_id: 'AQUASCOPE_LORAIN' }),
      device({ type_id: 'SENSECAP_S2120' }),
    ];
    expect(summarizeZoneSoil(zone, NOW).hasSensor).toBe(false);
  });

  it('does not count an LSN50 whose Chameleon array is switched off', () => {
    const zone = [device({ type_id: 'DRAGINO_LSN50', chameleon_enabled: 0, last_seen: FRESH })];
    expect(summarizeZoneSoil(zone, NOW).hasSensor).toBe(false);
  });

  it('counts an LSN50 with the Chameleon array enabled', () => {
    const zone = [device({
      type_id: 'DRAGINO_LSN50',
      chameleon_enabled: 1,
      last_seen: FRESH,
      latest_data: { swt_1: 42, swt_2: 48 },
    })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.hasSensor).toBe(true);
    expect(status.quantity).toBe('tension');
    expect(status.mean).toBe(45);
    expect(status.stale).toBe(false);
    expect(status.invalid).toBe(false);
    expect(status.observedAt).toBe(FRESH);
  });

  it('averages canonical and legacy SWT channels and keeps a measured zero', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_wm1: 0, swt_2: 20 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.mean).toBe(10);
    expect(status.invalid).toBe(false);
  });

  it('marks a configured sensor stale once its uplink is older than the window', () => {
    const zone = [device({ last_seen: STALE, latest_data: { swt_1: 60 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.hasSensor).toBe(true);
    expect(status.stale).toBe(true);
    // The last valid value survives so the card can still show it with its timestamp.
    expect(status.mean).toBe(60);
    expect(status.observedAt).toBe(STALE);
  });

  it('treats a sensor that has never reported as stale with no value', () => {
    const zone = [device({ last_seen: null, latest_data: {} })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.hasSensor).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.invalid).toBe(false);
    expect(status.mean).toBeNull();
    expect(status.observedAt).toBeNull();
  });

  it('flags an out-of-range tension as invalid rather than plotting it', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_1: 900 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.invalid).toBe(true);
    expect(status.mean).toBeNull();
    expect(status.observedAt).toBe(FRESH);
  });

  it('flags a non-finite tension as invalid', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_1: Number.NaN } })];
    expect(summarizeZoneSoil(zone, NOW).invalid).toBe(true);
  });

  it('reports SDI-12 probes as volumetric water content', () => {
    const zone = [device({
      type_id: 'DRAGINO_SDI12',
      last_seen: FRESH,
      latest_data: { vwc_1: 28, vwc_2: 32 },
    })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.quantity).toBe('volumetric');
    expect(status.mean).toBe(30);
  });

  it('prefers tension when a zone carries both kinds', () => {
    const zone = [
      device({ type_id: 'DRAGINO_SDI12', last_seen: FRESH, latest_data: { vwc_1: 28 } }),
      device({ type_id: 'KIWI_SENSOR', last_seen: FRESH, latest_data: { swt_1: 55 } }),
    ];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.quantity).toBe('tension');
    expect(status.mean).toBe(55);
  });

  it('timestamps the value from the device that supplied it', () => {
    const zone = [
      device({ deveui: 'A1', last_seen: STALE, latest_data: {} }),
      device({ deveui: 'A2', last_seen: FRESH, latest_data: { swt_1: 33 } }),
    ];
    expect(summarizeZoneSoil(zone, NOW).observedAt).toBe(FRESH);
  });
});

describe('zoneHasFlowMeter', () => {
  it('is false without an LSN50 flow-meter input', () => {
    expect(zoneHasFlowMeter([device({ type_id: 'STREGA_VALVE' })])).toBe(false);
    expect(zoneHasFlowMeter([device({ type_id: 'DRAGINO_LSN50', flow_meter_enabled: 0 })])).toBe(false);
  });

  it('is true once one device has the flow meter enabled', () => {
    expect(zoneHasFlowMeter([
      device({ type_id: 'STREGA_VALVE' }),
      device({ type_id: 'DRAGINO_LSN50', flow_meter_enabled: 1 }),
    ])).toBe(true);
  });
});
