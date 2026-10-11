import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AxiosAdapter, AxiosResponse} from 'axios';
import {api, devicesAPI, environmentAPI, irrigationOutcomesAPI, irrigationZonesAPI, lsn50API, s2120API, sensorAPI, valvesAPI} from '../../src/services/api';
import {createDemoAdapter} from '../adapter';
import {PUBLIC_EPOCH, Simulator} from '../model';

function bridge(simulator: Simulator): void {
  const adapter: AxiosAdapter = async config => {
    const url = new URL(config.url ?? '', 'http://simulator.test');
    const params = config.params as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    const data = simulator.request(config.method ?? 'GET', `${url.pathname}${url.search}`, body);
    return {data, status: 200, statusText: 'OK', headers: {}, config} as AxiosResponse;
  };
  api.defaults.adapter = adapter;
}

function nativeBridge(simulator: Simulator): void {
  api.defaults.adapter = createDemoAdapter(simulator);
}

test('known Chameleon calibration status reaches the native device consumer without changing current telemetry/history', async () => {
  const simulator = new Simulator({mode: 'public'});
  bridge(simulator);
  const knownEui = '00000000000000E3';
  const before = (await devicesAPI.getAll()).find(device => device.deveui === knownEui)!;
  const beforeLatest = structuredClone(before.latest_data);
  const beforeSample = simulator.readings.latestSample(knownEui);
  assert.equal(before.calibration_status ?? null, null);
  assert.ok(beforeLatest.chameleon_array_id, 'the public seed is the known fictional array fixture');

  assert.equal((await lsn50API.refreshChameleonCalibration(knownEui)).status, 'pending');
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === knownEui)?.calibration_status, 'pending');
  simulator.advanceTo(simulator.now + 5000);
  const calibrated = (await devicesAPI.getAll()).find(device => device.deveui === knownEui)!;
  assert.equal(calibrated.calibration_status, 'calibrated');
  assert.deepEqual(calibrated.latest_data, beforeLatest, 'calibration metadata does not rewrite the latest reading');
  assert.deepEqual(simulator.readings.latestSample(knownEui), beforeSample, 'calibration metadata retains current history');

  const unknownEui = '00000000000000E4';
  const unknownBefore = (await devicesAPI.getAll()).find(device => device.deveui === unknownEui)!;
  assert.equal(unknownBefore.calibration_status ?? null, null);
  assert.equal((await lsn50API.refreshChameleonCalibration(unknownEui)).status, 'unknown');
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === unknownEui)?.calibration_status ?? null, null,
    'an unknown fictional array remains uncalibrated');
});

test('the first valid dendrometer report establishes a raw-position baseline', async () => {
  const simulator = new Simulator({mode: 'public'});
  bridge(simulator);
  const eui = '00000000000000E3';

  await lsn50API.setDendroEnabled(eui, true);
  await lsn50API.setMode(eui, 'MOD3');
  await lsn50API.setDendroConfig(eui, {
    dendroForceLegacy: true,
    dendroStrokeMm: 12,
    dendroRatioAtRetracted: 0.4,
    dendroRatioAtExtended: 0.5,
  });
  simulator.advanceTo(PUBLIC_EPOCH + 2000);
  simulator.advanceTo(PUBLIC_EPOCH + 30 * 60_000);

  const initialSample = simulator.readings.latestSample(eui)!;
  const firstRawPosition = initialSample.values.dendro_position_raw_mm;
  const firstReadback = (await devicesAPI.getAll()).find(device => device.deveui === eui)! as DeviceWithDendroBaseline;
  assert.equal(typeof firstRawPosition, 'number', 'MOD3 supplies a finite raw dendrometer position');
  assert.equal(initialSample.values.dendro_mode_used, 'legacy_single_adc');
  assert.equal(initialSample.values.dendro_stem_change_um, 0,
    'the first calibrated raw position establishes the current device baseline');
  assert.equal(firstReadback.dendro_baseline_pending, 0);
  assert.equal(firstReadback.dendro_baseline_position_mm, firstRawPosition);
  assert.notEqual(firstRawPosition, initialSample.values.dendro_position_mm,
    'this fixture distinguishes the native raw position from its clamped/calibrated display position');
});

test('native dendrometer config clears explicit nulls immediately and resets only the current baseline', async () => {
  const simulator = new Simulator({mode: 'public'});
  nativeBridge(simulator);
  const eui = '00000000000000E3';
  const device = simulator.devices.find(row => row.deveui === eui)! as typeof simulator.devices[number] & Record<string, unknown>;
  Object.assign(device, {
    dendro_force_legacy: 0,
    dendro_stroke_mm: 12,
    dendro_ratio_at_retracted: 0.4,
    dendro_ratio_at_extended: 0.5,
    dendro_ratio_zero: 0.4,
    dendro_ratio_span: 0.5,
    dendro_invert_direction: 0,
    dendro_baseline_pending: 0,
    dendro_baseline_position_mm: 11.5,
    dendro_baseline_mode_used: 'legacy_single_adc',
    dendro_baseline_calibration_signature: '12|0.4|0.5',
    dendro_baseline_at: new Date(PUBLIC_EPOCH).toISOString(),
  });
  const oldHistory = simulator.readings.forDevice(eui);
  const oldTime = simulator.now;
  const oldPendingCount = simulator.state.sessions.pendingOutboxCount;

  await assert.doesNotReject(() => lsn50API.setDendroConfig(eui, {
    dendroForceLegacy: true,
    dendroStrokeMm: null,
    dendroRatioAtRetracted: null,
    dendroRatioAtExtended: null,
  }));

  const saved = (await devicesAPI.getAll()).find(row => row.deveui === eui)! as typeof device;
  assert.equal(saved.dendro_force_legacy, 1);
  assert.equal(saved.dendro_stroke_mm, null);
  assert.equal(saved.dendro_ratio_at_retracted, null);
  assert.equal(saved.dendro_ratio_at_extended, null);
  assert.equal(saved.dendro_ratio_zero, null, 'canonical clear also updates the legacy zero mirror');
  assert.equal(saved.dendro_ratio_span, null, 'canonical clear also updates the legacy span mirror');
  assert.equal(saved.dendro_invert_direction, 0);
  assert.equal(saved.dendro_baseline_pending, 1);
  assert.equal(saved.dendro_baseline_position_mm, null);
  assert.equal(saved.dendro_baseline_mode_used, null);
  assert.equal(saved.dendro_baseline_calibration_signature, null);
  assert.equal(simulator.now, oldTime, 'saving calibration does not require an uplink or simulated-time advance');
  assert.equal(simulator.state.sessions.pendingOutboxCount, oldPendingCount + 1,
    'one changed local config save creates exactly one pending mutation');
  assert.deepEqual(simulator.readings.forDevice(eui), oldHistory, 'configuration does not rewrite telemetry history');

  Object.assign(device, {
    dendro_baseline_pending: 0,
    dendro_baseline_position_mm: 9.75,
    dendro_baseline_mode_used: 'legacy_single_adc',
    dendro_baseline_calibration_signature: 'cleared-calibration',
  });
  const pendingBeforeUnchanged = simulator.state.sessions.pendingOutboxCount;
  await lsn50API.setDendroConfig(eui, {
    dendroForceLegacy: true,
    dendroStrokeMm: null,
    dendroRatioAtRetracted: null,
    dendroRatioAtExtended: null,
  });
  const unchanged = (await devicesAPI.getAll()).find(row => row.deveui === eui)! as typeof device;
  assert.equal(unchanged.dendro_baseline_pending, 0, 'an unchanged config save retains an established baseline');
  assert.equal(unchanged.dendro_baseline_position_mm, 9.75);
  assert.equal(simulator.state.sessions.pendingOutboxCount, pendingBeforeUnchanged,
    'an unchanged config save does not add another pending mutation');
});

test('native dendrometer config preserves omitted fields, legacy mirrors, and native validation', async () => {
  const simulator = new Simulator({mode: 'public'});
  nativeBridge(simulator);
  const eui = '00000000000000E3';
  const path = `/api/devices/${eui}/dendro-config`;

  const legacyWrite = simulator.requestResponse('PUT', path, {
    dendro_force_legacy: '1',
    dendro_stroke_mm: 150,
    dendro_ratio_zero: 0.35,
    dendro_ratio_span: 0.85,
    dendro_invert_direction: 1,
  });
  assert.equal(legacyWrite.status, 200);
  let saved = (await devicesAPI.getAll()).find(row => row.deveui === eui)! as typeof simulator.devices[number] & Record<string, unknown>;
  assert.equal(saved.dendro_force_legacy, 1);
  assert.equal(saved.dendro_stroke_mm, 150, 'native validation has no arbitrary 100 mm maximum');
  assert.equal(saved.dendro_ratio_at_retracted, 0.85);
  assert.equal(saved.dendro_ratio_at_extended, 0.35);
  assert.equal(saved.dendro_ratio_zero, 0.85);
  assert.equal(saved.dendro_ratio_span, 0.35);
  assert.equal(saved.dendro_invert_direction, 0, 'canonical mirrors normalize invert to zero');

  const canonicalWins = simulator.requestResponse('PUT', path, {
    dendro_ratio_at_retracted: -0.25,
    dendro_ratio_zero: 0.4,
    dendro_ratio_span: 0.8,
    dendro_invert_direction: 1,
  });
  assert.equal(canonicalWins.status, 200);
  let responseData = canonicalWins.data as Record<string, unknown>;
  assert.equal(responseData.dendro_ratio_at_retracted, -0.25, 'canonical endpoints take precedence over legacy aliases');
  assert.equal(responseData.dendro_ratio_at_extended, 0.4, 'a supplied legacy pair resolves its omitted canonical endpoint');
  assert.equal(responseData.dendro_ratio_zero, -0.25);
  assert.equal(responseData.dendro_ratio_span, 0.4);

  await lsn50API.setDendroConfig(eui, {dendroStrokeMm: 151});
  saved = (await devicesAPI.getAll()).find(row => row.deveui === eui)! as typeof saved;
  assert.equal(saved.dendro_stroke_mm, 151);
  assert.equal(saved.dendro_ratio_at_retracted, -0.25, 'omitted endpoint fields remain unchanged');
  assert.equal(saved.dendro_ratio_at_extended, 0.4, 'omitted endpoint fields remain unchanged');

  const pendingBeforeInvalid = simulator.state.sessions.pendingOutboxCount;
  const invalidStroke = await lsn50API.setDendroConfig(eui, {dendroStrokeMm: 0}).then(
    () => null,
    error => error as {response?: {status?: number}},
  );
  assert.equal(invalidStroke?.response?.status, 400, 'stroke must be finite and strictly positive');
  const equalEndpoints = await lsn50API.setDendroConfig(eui, {
    dendroRatioAtRetracted: 0.5,
    dendroRatioAtExtended: 0.5,
  }).then(() => null, error => error as {response?: {status?: number}});
  assert.equal(equalEndpoints?.response?.status, 400, 'equal nonnull endpoints are rejected');
  assert.equal(simulator.state.sessions.pendingOutboxCount, pendingBeforeInvalid,
    'rejected config writes do not create pending mutations');

  const clearResponse = simulator.requestResponse('PUT', path, {
    dendro_ratio_at_retracted: '',
    dendro_ratio_at_extended: null,
    dendro_force_legacy: null,
  });
  assert.equal(clearResponse.status, 200);
  saved = (await devicesAPI.getAll()).find(row => row.deveui === eui)! as typeof saved;
  assert.equal(saved.dendro_force_legacy, null);
  assert.equal(saved.dendro_ratio_at_retracted, null);
  assert.equal(saved.dendro_ratio_at_extended, null);
  assert.equal(saved.dendro_ratio_zero, null);
  assert.equal(saved.dendro_ratio_span, null);
  assert.equal(saved.dendro_stroke_mm, 151, 'clearing endpoints leaves the omitted stroke unchanged');

  const forceLegacyForms: Array<[unknown, number | null]> = [
    [true, 1], ['1', 1], [1, 1], [false, 0], ['0', 0], [0, 0], [null, null], ['', null],
  ];
  for (const [input, expected] of forceLegacyForms) {
    const response = simulator.requestResponse('PUT', path, {dendroForceLegacy: input});
    assert.equal(response.status, 200);
    responseData = response.data as Record<string, unknown>;
    assert.equal(responseData.dendro_force_legacy, expected, `native force-legacy input ${String(input)} is preserved`);
  }
  const snakeFieldWins = simulator.requestResponse('PUT', path, {dendro_force_legacy: 0, dendroForceLegacy: 1});
  assert.equal(snakeFieldWins.status, 200);
  assert.equal((snakeFieldWins.data as Record<string, unknown>).dendro_force_legacy, 0,
    'a supplied snake-case field takes precedence over its camel-case alias');
});

test('dendrometer reset waits for a valid raw-position uplink and preserves prior history', async () => {
  const simulator = new Simulator({mode: 'public'});
  bridge(simulator);
  const eui = '00000000000000E3';

  await lsn50API.setDendroEnabled(eui, true);
  await lsn50API.setMode(eui, 'MOD3');
  await lsn50API.setDendroConfig(eui, {
    dendroForceLegacy: true,
    dendroStrokeMm: 12,
    dendroRatioAtRetracted: 0.4,
    dendroRatioAtExtended: 0.5,
  });
  simulator.advanceTo(PUBLIC_EPOCH + 2000);
  simulator.advanceTo(PUBLIC_EPOCH + 30 * 60_000);

  const baselineDevice = simulator.devices.find(device => device.deveui === eui)! as DeviceWithDendroBaseline;
  Object.assign(baselineDevice, {
    dendro_baseline_pending: 0,
    dendro_baseline_position_mm: 11.5,
    dendro_baseline_mode_used: 'legacy_single_adc',
    dendro_baseline_calibration_signature: '12|0.4|0.5',
    dendro_baseline_at: new Date(simulator.now).toISOString(),
  });
  const beforeReset = (await devicesAPI.getAll()).find(device => device.deveui === eui)! as DeviceWithDendroBaseline;
  const establishedHistory = simulator.readings.forDevice(eui);
  assert.equal(typeof beforeReset.dendro_baseline_position_mm, 'number');

  await lsn50API.resetDendroBaseline(eui);
  const resetReadback = (await devicesAPI.getAll()).find(device => device.deveui === eui)! as DeviceWithDendroBaseline;
  assert.equal(resetReadback.dendro_baseline_pending, 1,
    'the local reset is observable before any radio event or uplink');
  assert.equal(resetReadback.dendro_baseline_position_mm, null);
  assert.equal(resetReadback.dendro_baseline_mode_used, null);
  assert.equal(resetReadback.dendro_baseline_calibration_signature, null);
  assert.deepEqual(simulator.readings.forDevice(eui), establishedHistory,
    'clearing the current baseline does not rewrite any previously recorded sample');

  await lsn50API.setMode(eui, 'MOD9');
  simulator.advanceTo(simulator.now + 2000);
  simulator.advanceTo(simulator.now + 30 * 60_000);
  const unavailableSample = simulator.readings.latestSample(eui)!;
  const waitingReadback = (await devicesAPI.getAll()).find(device => device.deveui === eui)! as DeviceWithDendroBaseline;
  assert.equal(unavailableSample.values.dendro_stem_change_um ?? null, null,
    'an uplink without dendrometer telemetry has no stem-change value');
  assert.equal(waitingReadback.dendro_baseline_pending, 1,
    'an unavailable report cannot consume the reset');
  assert.equal(waitingReadback.dendro_baseline_position_mm, null);

  await lsn50API.setMode(eui, 'MOD3');
  simulator.advanceTo(simulator.now + 2000);
  simulator.advanceTo(simulator.now + 30 * 60_000);
  const firstValidSample = simulator.readings.latestSample(eui)!;
  const firstValidRawPosition = firstValidSample.values.dendro_position_raw_mm;
  const establishedReadback = (await devicesAPI.getAll()).find(device => device.deveui === eui)! as DeviceWithDendroBaseline;
  assert.equal(typeof firstValidRawPosition, 'number');
  assert.equal(establishedReadback.dendro_baseline_pending, 0);
  assert.equal(establishedReadback.dendro_baseline_position_mm, firstValidRawPosition,
    'the first valid sample stores its raw position as the new baseline');
  assert.equal(firstValidSample.values.dendro_stem_change_um, 0);
  assert.equal(establishedReadback.dendro_baseline_mode_used, firstValidSample.values.dendro_mode_used);
  assert.equal(typeof establishedReadback.dendro_baseline_calibration_signature, 'string');

  simulator.advanceTo(simulator.now + 30 * 60_000);
  const laterSample = simulator.readings.latestSample(eui)!;
  assert.equal(laterSample.values.dendro_stem_change_um,
    Math.round((Number(laterSample.values.dendro_position_raw_mm) - Number(firstValidRawPosition)) * 1000),
    'later reports are measured from the newly established raw-position baseline in integer micrometers');
  assert.deepEqual(simulator.readings.forDevice(eui).slice(0, establishedHistory.length), establishedHistory,
    'later baseline establishment and reports leave all historical samples unchanged');
});

type DeviceWithDendroBaseline = Awaited<ReturnType<typeof devicesAPI.getAll>>[number] & {
  dendro_baseline_position_mm?: number | null;
  dendro_baseline_mode_used?: string | null;
  dendro_baseline_calibration_signature?: string | null;
  dendro_baseline_pending?: number | null;
};

test('S2120 assignment writes project zone IDs and names into the device collection consumed by its native card', async () => {
  const simulator = new Simulator({mode: 'public'});
  bridge(simulator);
  const stationEui = '00000000000000F2';
  const before = (await devicesAPI.getAll()).find(device => device.deveui === stationEui)!;
  const beforeLatest = structuredClone(before.latest_data);

  await s2120API.setZoneAssignments(stationEui, [1, 2]);
  assert.deepEqual(await s2120API.getZoneAssignments(stationEui), [
    {zone_id: 1, zone_name: 'Tomato plot'},
    {zone_id: 2, zone_name: 'Demonstration bed'},
  ]);
  const assigned = (await devicesAPI.getAll()).find(device => device.deveui === stationEui)!;
  assert.deepEqual(assigned.zone_ids, [1, 2]);
  assert.deepEqual(assigned.zone_names, ['Tomato plot', 'Demonstration bed']);
  assert.deepEqual(assigned.latest_data, beforeLatest, 'assignment metadata preserves weather readings');

  await assert.rejects(s2120API.setZoneAssignments(stationEui, [999]));
  assert.deepEqual((await devicesAPI.getAll()).find(device => device.deveui === stationEui)?.zone_ids, [1, 2],
    'rejected assignment preserves the prior native-card projection');
});

test('actuation started unassigned keeps null zone, flow, and soil ownership after valve assignment', async () => {
  const simulator = new Simulator({mode: 'public'});
  const reference = new Simulator({mode: 'public'});
  bridge(simulator);
  const valveEui = '00000000000000D1';
  const before = await devicesAPI.getAll();
  const beforeFlow = new Map(before.filter(device => ['00000000000000E1', '00000000000000E2'].includes(device.deveui))
    .map(device => [device.deveui, device.latest_data.flow_liters_today]));

  await irrigationZonesAPI.removeDevice(1, valveEui);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === valveEui)?.irrigation_zone_id, null);
  await devicesAPI.controlValve(valveEui, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  simulator.advanceTo(PUBLIC_EPOCH + 2000);
  await irrigationZonesAPI.assignDevice(2, valveEui);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === valveEui)?.irrigation_zone_id, 2);
  simulator.advanceTo(PUBLIC_EPOCH + 62_000);

  const outcome = (await irrigationOutcomesAPI.recentActuations()).actuations[0]!;
  assert.equal(outcome.zoneId, null, 'the completed client-visible actuation retains its unassigned zone snapshot');
  assert.equal(outcome.zoneName, null);
  assert.equal(outcome.estimatedGrossLiters, 6);
  const zones = await irrigationZonesAPI.getAll();
  assert.equal(zones.find(zone => zone.id === 1)?.daily_volume_liters ?? 0, 0);
  assert.equal(zones.find(zone => zone.id === 2)?.daily_volume_liters ?? 0, 0,
    'later assignment does not move observed water into the destination zone');
  const summary1 = await environmentAPI.getSummary(1);
  const summary2 = await environmentAPI.getSummary(2);
  assert.equal(summary1.water.irrigationTodayLiters ?? 0, 0);
  assert.equal(summary2.water.irrigationTodayLiters ?? 0, 0);
  const flowAfter = await devicesAPI.getAll();
  for (const device of flowAfter.filter(row => beforeFlow.has(row.deveui))) {
    assert.equal(device.latest_data.flow_liters_today, beforeFlow.get(device.deveui), `${device.name} does not inherit this command's flow`);
  }

  const finalTime = PUBLIC_EPOCH + 30 * 60_000;
  simulator.advanceTo(finalTime);
  reference.advanceTo(finalTime);
  bridge(reference);
  const referenceDevices = await devicesAPI.getAll();
  bridge(simulator);
  const afterDevices = await devicesAPI.getAll();
  for (const eui of ['00000000000000A1', '00000000000000A2']) {
    const after = afterDevices.find(device => device.deveui === eui)!.latest_data;
    const expected = referenceDevices.find(device => device.deveui === eui)!.latest_data;
    assert.deepEqual({swt_1: after.swt_1, swt_2: after.swt_2}, {swt_1: expected.swt_1, swt_2: expected.swt_2},
      `${eui} has no delayed watering response from an actuation with no zone`);
  }
});

test('actuation started in a zone keeps its original flow and soil ownership after valve reassignment', async () => {
  const simulator = new Simulator({mode: 'public'});
  const reference = new Simulator({mode: 'public'});
  bridge(simulator);
  const valveEui = '00000000000000D1';
  const before = await devicesAPI.getAll();
  const beforeFlow = new Map(before.filter(device => ['00000000000000E1', '00000000000000E2'].includes(device.deveui))
    .map(device => [device.deveui, device.latest_data.flow_liters_today]));

  await devicesAPI.controlValve(valveEui, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  simulator.advanceTo(PUBLIC_EPOCH + 2000);
  await irrigationZonesAPI.removeDevice(1, valveEui);
  await irrigationZonesAPI.assignDevice(2, valveEui);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === valveEui)?.irrigation_zone_id, 2);
  simulator.advanceTo(PUBLIC_EPOCH + 62_000);

  const outcome = (await irrigationOutcomesAPI.recentActuations()).actuations[0]!;
  assert.equal(outcome.zoneId, 1, 'the completed client-visible actuation retains its zone-at-start snapshot');
  assert.equal(outcome.zoneName, 'Tomato plot');
  assert.equal(outcome.estimatedGrossLiters, 6);
  const zones = await irrigationZonesAPI.getAll();
  assert.equal(zones.find(zone => zone.id === 1)?.daily_volume_liters, 6);
  assert.equal(zones.find(zone => zone.id === 2)?.daily_volume_liters ?? 0, 0);
  const summary1 = await environmentAPI.getSummary(1);
  const summary2 = await environmentAPI.getSummary(2);
  assert.equal(summary1.water.irrigationTodayLiters, 6);
  assert.equal(summary2.water.irrigationTodayLiters ?? 0, 0);
  const flowAfter = await devicesAPI.getAll();
  assert.equal(flowAfter.find(device => device.deveui === '00000000000000E1')?.latest_data.flow_liters_today,
    Number(beforeFlow.get('00000000000000E1')) + 6);
  assert.equal(flowAfter.find(device => device.deveui === '00000000000000E2')?.latest_data.flow_liters_today,
    beforeFlow.get('00000000000000E2'));

  const finalTime = PUBLIC_EPOCH + 30 * 60_000;
  simulator.advanceTo(finalTime);
  reference.advanceTo(finalTime);
  bridge(reference);
  const referenceDevices = await devicesAPI.getAll();
  bridge(simulator);
  const afterDevices = await devicesAPI.getAll();
  const tomatoAfter = afterDevices.find(device => device.deveui === '00000000000000A1')!.latest_data.swt_1;
  const tomatoReference = referenceDevices.find(device => device.deveui === '00000000000000A1')!.latest_data.swt_1;
  assert.ok(Number(tomatoAfter) < Number(tomatoReference),
    `the original zone soil receives the delayed watering response (actual ${tomatoAfter}; reference ${tomatoReference})`);
  const bedAfter = afterDevices.find(device => device.deveui === '00000000000000A2')!.latest_data;
  const bedReference = referenceDevices.find(device => device.deveui === '00000000000000A2')!.latest_data;
  assert.deepEqual({swt_1: bedAfter.swt_1, swt_2: bedAfter.swt_2}, {swt_1: bedReference.swt_1, swt_2: bedReference.swt_2},
    'the destination zone receives no delayed watering response');
});

test('active valve flow reaches meter history, daily totals, and outcome before closure without double counting', async () => {
  const simulator = new Simulator({mode: 'public'});
  bridge(simulator);
  const valveEui = '00000000000000D1';
  const flowEui = '00000000000000E1';
  await devicesAPI.controlValve(valveEui, {action: 'OPEN_FOR_DURATION', duration_seconds: 3600});
  simulator.advanceTo(PUBLIC_EPOCH + 2000);
  simulator.advanceTo(PUBLIC_EPOCH + 30 * 60_000 + 2000);

  const activeValve = (await valvesAPI.list()).find(valve => valve.deviceEui === valveEui)!;
  assert.equal(activeValve.currentState, 'OPEN');
  const activeOutcome = (await irrigationOutcomesAPI.recentActuations()).actuations[0]!;
  assert.equal(activeOutcome.status, 'RUNNING');
  assert.equal(activeOutcome.estimatedGrossLiters, 179.8);
  const activeZone = (await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)!;
  assert.equal(activeZone.daily_volume_liters, 179.8);
  const activeFlowDevice = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
  assert.equal(activeFlowDevice.latest_data.flow_liters_today, 179.8);
  assert.equal(activeFlowDevice.latest_data.flow_liters_per_10min, 59.93,
    'the 1800-second report interval normalizes the 179.8 L delta despite the 2-second open acknowledgement');
  assert.equal(activeFlowDevice.latest_data.counter_interval_seconds, 1800);
  const atThirtyMinutes = (await sensorAPI.getHistory(flowEui, 'flow_liters_delta', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.equal(activeFlowDevice.latest_data.flow_liters_delta, 179.8);
  assert.equal(atThirtyMinutes.reduce((sum, point) => sum + (point.value ?? 0), 0), 179.8);
  const activeRateHistory = (await sensorAPI.getHistory(flowEui, 'flow_liters_per_10min', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.equal(activeRateHistory.at(-1)?.value, 59.93,
    'the actual per-ten-minute value survives the routine sample merge in sensor history');

  simulator.advanceTo(PUBLIC_EPOCH + 60 * 60_000 + 2000);
  const closedValve = (await valvesAPI.list()).find(valve => valve.deviceEui === valveEui)!;
  assert.equal(closedValve.currentState, 'CLOSED');
  const completedOutcome = (await irrigationOutcomesAPI.recentActuations()).actuations[0]!;
  assert.equal(completedOutcome.status, 'COMPLETED');
  assert.equal(completedOutcome.estimatedGrossLiters, 360);
  const completedZone = (await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)!;
  assert.equal(completedZone.daily_volume_liters, 360);
  const completedFlowDevice = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
  assert.equal(completedFlowDevice.latest_data.flow_liters_today, 360);
  assert.equal(completedFlowDevice.latest_data.flow_liters_delta, 0.2,
    'the nonperiodic close publishes the final 2-second counter delta');
  assert.equal(completedFlowDevice.latest_data.counter_interval_seconds, 2);
  assert.equal(completedFlowDevice.latest_data.flow_liters_per_10min, 60);
  const closeRateHistory = (await sensorAPI.getHistory(flowEui, 'flow_liters_per_10min', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.equal(closeRateHistory.at(-1)?.value, 60,
    'the nonperiodic close contributes a final two-second counter report to sensor history');
  const flowHistory = (await sensorAPI.getHistory(flowEui, 'flow_liters_delta', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.equal(flowHistory.reduce((sum, point) => sum + (point.value ?? 0), 0), 360);
  assert.equal((await environmentAPI.getSummary(1)).water.irrigationTodayLiters, 360);
});

test('successive short valve runs normalize each flow report from the preceding observed report', async () => {
  const simulator = new Simulator({mode: 'public'});
  bridge(simulator);
  const valveEui = '00000000000000D1';
  const flowEui = '00000000000000E1';
  const expectedPerTenMinutes = 58.06;

  for (let run = 1; run <= 2; run += 1) {
    await devicesAPI.controlValve(valveEui, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
    simulator.advanceTo(simulator.now + 62_000);

    const flow = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
    assert.equal(flow.latest_data.flow_liters_delta, 6, `run ${run} publishes its observed 6 L delta`);
    assert.equal(flow.latest_data.counter_interval_seconds, 62,
      `run ${run} uses the preceding observed meter report as its interval boundary`);
    assert.equal(flow.latest_data.flow_liters_per_10min, expectedPerTenMinutes,
      `run ${run} reports the measured rate over the actual 62-second interval`);
    assert.equal(Date.parse(String(flow.latest_data.sampled_at)), simulator.readings.latestSample(flowEui)?.at,
      `run ${run} exposes the same timestamp as the latest native meter sample`);

    const outcome = (await irrigationOutcomesAPI.recentActuations()).actuations[0]!;
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.estimatedGrossLiters, 6, `run ${run} records its own observed 6 L outcome`);
    assert.equal((await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)?.daily_volume_liters, run * 6);
    assert.equal((await environmentAPI.getSummary(1)).water.irrigationTodayLiters, run * 6);
  }

  const flowDeltas = (await sensorAPI.getHistory(flowEui, 'flow_liters_delta', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.equal(flowDeltas.reduce((sum, point) => sum + (point.value ?? 0), 0), 12,
    `the two per-run meter deltas account for the 12 L total exactly once: ${JSON.stringify(flowDeltas)}`);
  const flowRates = (await sensorAPI.getHistory(flowEui, 'flow_liters_per_10min', 1))
    .filter(point => Date.parse(point.t) > PUBLIC_EPOCH);
  assert.deepEqual(flowRates.slice(-2).map(point => point.value), [expectedPerTenMinutes, expectedPerTenMinutes]);
});
