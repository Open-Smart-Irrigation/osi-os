import { describe, expect, it } from 'vitest';

import type { Device } from '../../types/farming';
import { SENSOR_FRESHNESS_WINDOW_MS, isSensorObservationFresh, summarizeZoneSoil, zoneHasFlowMeter } from '../zoneSoil';

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
    expect(status.value).toBeNull();
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
    // The shallowest channel, not the 45 kPa mean of two different depths.
    expect(status.value).toBe(42);
    expect(status.channel).toBe('swt_1');
    expect(status.stale).toBe(false);
    expect(status.invalid).toBe(false);
    expect(status.observedAt).toBe(FRESH);
  });

  it('reads a legacy SWT alias as its canonical channel and keeps a measured zero', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_wm1: 0, swt_2: 20 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.value).toBe(0);
    expect(status.channel).toBe('swt_1');
    expect(status.invalid).toBe(false);
  });

  it('marks a configured sensor stale once its uplink is older than the window', () => {
    const zone = [device({ last_seen: STALE, latest_data: { swt_1: 60 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.hasSensor).toBe(true);
    expect(status.stale).toBe(true);
    // The last valid value survives so the card can still show it with its timestamp.
    expect(status.value).toBe(60);
    expect(status.observedAt).toBe(STALE);
  });

  it('treats a sensor that has never reported as stale with no value', () => {
    const zone = [device({ last_seen: null, latest_data: {} })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.hasSensor).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.invalid).toBe(false);
    expect(status.value).toBeNull();
    expect(status.observedAt).toBeNull();
  });

  it('flags an out-of-range tension as invalid rather than plotting it', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_1: 900 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.invalid).toBe(true);
    expect(status.value).toBeNull();
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
    expect(status.value).toBe(30);
  });

  it('prefers tension when a zone carries both kinds', () => {
    const zone = [
      device({ type_id: 'DRAGINO_SDI12', last_seen: FRESH, latest_data: { vwc_1: 28 } }),
      device({ type_id: 'KIWI_SENSOR', last_seen: FRESH, latest_data: { swt_1: 55 } }),
    ];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.quantity).toBe('tension');
    expect(status.value).toBe(55);
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

describe('summarizeZoneSoil channel selection', () => {
  it('reports the shallowest configured channel, not a cross-depth mean', () => {
    // 55.0 and 57.9 kPa at different burial depths became "56.5 kPa" on the
    // captured screen. A 20 cm and a 60 cm tensiometer answer different
    // questions and their mean answers neither.
    const zone = [device({
      type_id: 'DRAGINO_LSN50',
      chameleon_enabled: 1,
      last_seen: FRESH,
      chameleon_swt1_depth_cm: 60,
      chameleon_swt2_depth_cm: 20,
      latest_data: { swt_1: 55, swt_2: 57.9 },
    })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.value).toBe(57.9);
    expect(status.channel).toBe('swt_2');
    expect(status.depthCm).toBe(20);
  });

  it('names the channel when no depth is configured', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_1: 42, swt_2: 48 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.value).toBe(42);
    expect(status.channel).toBe('swt_1');
    expect(status.depthCm).toBeNull();
  });

  it('follows the channel the zone scheduler compares', () => {
    const zone = [device({
      last_seen: FRESH,
      soilMoistureProbeDepths: { swt_1: 20, swt_2: 60 },
      latest_data: { swt_1: 30, swt_2: 70 },
    })];
    const status = summarizeZoneSoil(zone, NOW, 'swt_2');
    expect(status.value).toBe(70);
    expect(status.channel).toBe('swt_2');
    expect(status.depthCm).toBe(60);
  });

  it('pools every channel when the scheduler triggers on the mean', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_1: 40, swt_2: 60 } })];
    const status = summarizeZoneSoil(zone, NOW, 'mean');
    expect(status.value).toBe(50);
    expect(status.channel).toBe('mean');
    expect(status.depthCm).toBeNull();
  });

  it('averages one channel across every sensor in the zone, as the scheduler does', () => {
    const zone = [
      device({ deveui: 'A1', last_seen: FRESH, latest_data: { swt_1: 40 } }),
      device({ deveui: 'A2', last_seen: FRESH, latest_data: { swt_1: 60 } }),
    ];
    const status = summarizeZoneSoil(zone, NOW, 'swt_1');
    expect(status.value).toBe(50);
  });

  it('skips a channel with no usable reading rather than reporting nothing', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_1: 900, swt_2: 40 } })];
    const status = summarizeZoneSoil(zone, NOW);
    expect(status.value).toBe(40);
    expect(status.channel).toBe('swt_2');
    expect(status.invalid).toBe(false);
  });

  it('falls back to the requested channel being absent', () => {
    const zone = [device({ last_seen: FRESH, latest_data: { swt_1: 35 } })];
    const status = summarizeZoneSoil(zone, NOW, 'swt_3');
    expect(status.value).toBe(35);
    expect(status.channel).toBe('swt_1');
  });
});

it('treats an SDI-12 Tensiomark as tension before and after its first sample', () => {
  const waiting = summarizeZoneSoil([device({
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: null,
    latest_data: {},
  })], NOW);
  expect(waiting).toMatchObject({ hasSensor: true, quantity: 'tension', value: null, stale: true });

  const reporting = summarizeZoneSoil([device({
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: FRESH,
    latest_data: { swt_1: 30.2, soil_temp_1: 21.5 },
  })], NOW);
  expect(reporting).toMatchObject({ quantity: 'tension', value: 30.2, channel: 'swt_1', stale: false });
});

it('keeps a non-Tensiomark SDI-12 probe volumetric', () => {
  const status = summarizeZoneSoil([device({
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    last_seen: FRESH,
    latest_data: { vwc_1: 28, vwc_2: 32 },
  })], NOW);
  expect(status).toMatchObject({ quantity: 'volumetric', value: 30 });
});

it('excludes stale contributors when a current reading exists', () => {
  const status = summarizeZoneSoil([
    device({ deveui: 'CURRENT', last_seen: FRESH, latest_data: { swt_1: 30 } }),
    device({ deveui: 'STALE', last_seen: STALE, latest_data: { swt_1: 90 } }),
  ], NOW, 'swt_1');
  expect(status).toMatchObject({ value: 30, observedAt: FRESH, stale: false });
});

it('retains stale values only when no current contributor exists', () => {
  const older = new Date(Date.parse(STALE) - 60_000).toISOString();
  const status = summarizeZoneSoil([
    device({ deveui: 'OLD-1', last_seen: STALE, latest_data: { swt_1: 60 } }),
    device({ deveui: 'OLD-2', last_seen: older, latest_data: { swt_1: 80 } }),
  ], NOW, 'swt_1');
  expect(status).toMatchObject({ value: 70, observedAt: STALE, stale: true });
});

it.each([
  new Date(NOW + 5 * 60_000 + 1).toISOString(),
  new Date(NOW + 365 * 24 * 60 * 60_000).toISOString(),
  'not-a-date',
  null,
])('excludes rejected timestamps from last-valid historical values: %s', (lastSeen) => {
  const status = summarizeZoneSoil([
    device({ deveui: 'OLD', last_seen: STALE, latest_data: { swt_1: 10 } }),
    device({ deveui: 'UNTRUSTED', last_seen: lastSeen, latest_data: { swt_1: 90 } }),
  ], NOW, 'swt_1');
  expect(status).toMatchObject({ value: 10, observedAt: STALE, stale: true, invalid: false });
  const rejectedOnly = summarizeZoneSoil([
    device({ last_seen: lastSeen, latest_data: { swt_1: 90 } }),
  ], NOW);
  expect(rejectedOnly).toMatchObject({ value: null, stale: true });
});

it('does not establish a last-valid historical value with a non-finite clock', () => {
  expect(summarizeZoneSoil([
    device({ last_seen: STALE, latest_data: { swt_1: 10 } }),
  ], Number.NaN)).toMatchObject({ value: null, stale: true });
});

it('does not use a stale contributor to choose or label a current channel depth', () => {
  const status = summarizeZoneSoil([
    device({
      deveui: 'CURRENT',
      last_seen: FRESH,
      soilMoistureProbeDepths: { swt_1: 60, swt_2: 30 },
      latest_data: { swt_1: 60, swt_2: 30 },
    }),
    device({
      deveui: 'STALE',
      last_seen: STALE,
      soilMoistureProbeDepths: { swt_1: 10 },
      latest_data: { swt_1: 10 },
    }),
  ], NOW);
  expect(status).toMatchObject({ value: 30, channel: 'swt_2', depthCm: 30, stale: false });
});

it.each([
  { swt_1: null, chameleon_i2c_missing: 1 },
  { swt_1: null, chameleon_timeout: 1 },
  { swt_1: null, chameleon_ch1_open: 1 },
  { swt_2: null, chameleon_ch2_open: 1 },
  { swt_3: null, chameleon_ch3_open: 1 },
])('rejects a faulted LSN50 sample even when its SWT value is null: %o', (latestData) => {
  const status = summarizeZoneSoil([device({
    type_id: 'DRAGINO_LSN50',
    chameleon_enabled: 1,
    last_seen: FRESH,
    latest_data: latestData,
  })], NOW);
  expect(status).toMatchObject({ value: null, invalid: true });
});


it('accepts the three-hour age and five-minute skew boundaries only', () => {
  const oldestCurrent = new Date(NOW - SENSOR_FRESHNESS_WINDOW_MS).toISOString();
  const oneMsTooOld = new Date(NOW - SENSOR_FRESHNESS_WINDOW_MS - 1).toISOString();
  const furthestCurrent = new Date(NOW + 5 * 60_000).toISOString();
  const oneMsTooFarAhead = new Date(NOW + 5 * 60_000 + 1).toISOString();
  const farFuture = new Date(NOW + 24 * 60 * 60_000).toISOString();
  expect(isSensorObservationFresh(FRESH, NOW)).toBe(true);
  expect(isSensorObservationFresh(oldestCurrent, NOW)).toBe(true);
  expect(isSensorObservationFresh(oneMsTooOld, NOW)).toBe(false);
  expect(isSensorObservationFresh(furthestCurrent, NOW)).toBe(true);
  expect(isSensorObservationFresh(oneMsTooFarAhead, NOW)).toBe(false);
  expect(isSensorObservationFresh(farFuture, NOW)).toBe(false);
  expect(isSensorObservationFresh(null, NOW)).toBe(false);
  expect(isSensorObservationFresh('not-a-date', NOW)).toBe(false);
  expect(isSensorObservationFresh(FRESH, Number.NaN)).toBe(false);
  expect(isSensorObservationFresh(FRESH, Number.POSITIVE_INFINITY)).toBe(false);
});
