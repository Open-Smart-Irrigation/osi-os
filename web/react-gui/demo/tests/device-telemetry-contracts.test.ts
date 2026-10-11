import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import type {AxiosAdapter, AxiosResponse} from 'axios';
import {api, devicesAPI, irrigationZonesAPI, lsn50API, sensorAPI, s2120API} from '../../src/services/api';
import {Simulator} from '../model';
import {rainfallMmBetween} from '../model/forcing';

const require = createRequire(import.meta.url);
const nativeDendro = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js') as {
  buildDendroDerivedMetrics(options: Record<string, unknown>): {
    dendroModeUsed: string; dendroRatio: number | null; dendroValid: number | null;
    positionRawMm: number | null; positionMm: number | null; dendroSaturated: number; dendroSaturationSide: string | null;
  };
};

function bridge(sim: Simulator): void {
  api.defaults.adapter = (async config => {
    const url = new URL(config.url ?? '', 'http://simulator.test');
    for (const [key, value] of Object.entries(config.params ?? {})) if (value != null) url.searchParams.set(key, String(value));
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    const data = sim.request(config.method ?? 'GET', `${url.pathname}${url.search}`, body);
    return {data, status: 200, statusText: 'OK', headers: {}, config} as AxiosResponse;
  }) as AxiosAdapter;
}

async function advanceInChunks(sim: Simulator, to: number, chunkMs = 3 * 60 * 60_000): Promise<void> {
  while (sim.now < to) sim.advanceTo(Math.min(to, sim.now + chunkMs));
}

test('nonperiodic close publishes one joint counter row and the next rain report conserves both totals', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  await advanceInChunks(sim, Date.parse('2026-10-16T20:29:50.000Z'));
  const prior = (await devicesAPI.getAll()).find(device => device.deveui === '00000000000000E1')!;
  assert.equal(prior.latest_data.sampled_at, '2026-10-16T20:29:50.000Z');
  assert.equal(typeof prior.latest_data.rain_mm_delta, 'number');
  assert.equal(typeof prior.latest_data.bat_v, 'number');

  await devicesAPI.controlValve('00000000000000D1', {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  const closeAt = Date.parse('2026-10-16T20:30:52.000Z');
  await advanceInChunks(sim, closeAt);
  const atClose = (await devicesAPI.getAll()).find(device => device.deveui === prior.deveui)!;
  assert.equal(atClose.latest_data.sampled_at, new Date(closeAt).toISOString());
  assert.equal(typeof atClose.latest_data.flow_liters_delta, 'number');
  assert.equal(typeof atClose.latest_data.rain_mm_delta, 'number', 'nonperiodic flow flush is a joint rain/flow counter observation');
  assert.equal(typeof atClose.latest_data.bat_v, 'number', 'joint flow report retains native battery channel');
  assert.equal(atClose.latest_data.counter_interval_seconds, (closeAt - Date.parse(prior.latest_data.sampled_at)) / 1000);
  assert.equal(atClose.latest_data.flow_liters_per_10min,
    Number((Number(atClose.latest_data.flow_liters_delta) * 600 / Number(atClose.latest_data.counter_interval_seconds)).toFixed(2)));

  const rainReportAt = Date.parse('2026-10-16T20:59:50.000Z');
  await advanceInChunks(sim, rainReportAt);
  const current = (await devicesAPI.getAll()).find(device => device.deveui === prior.deveui)!;
  assert.equal(current.latest_data.counter_interval_seconds, (rainReportAt - closeAt) / 1000);
  assert.equal(current.latest_data.rain_mm_delta,
    Number(rainfallMmBetween(closeAt, rainReportAt).toFixed(3)), 'the next report covers only the not-yet-reported rain interval');
  assert.equal(current.latest_data.rain_mm_per_10min,
    Number((Number(current.latest_data.rain_mm_delta) * 600 / Number(current.latest_data.counter_interval_seconds)).toFixed(3)));
  const history = await sensorAPI.getHistory(prior.deveui, 'rain_mm_delta', 2);
  const acceptedRain = history.filter(row => row.t > prior.latest_data.sampled_at && row.t <= current.latest_data.sampled_at);
  assert.equal(acceptedRain.filter(row => row.t === atClose.latest_data.sampled_at).length, 1);
  assert.equal(acceptedRain.reduce((sum, row) => sum + (row.value ?? 0), 0),
    Number(rainfallMmBetween(Date.parse(prior.latest_data.sampled_at), rainReportAt).toFixed(3)));
  const flowHistory = await sensorAPI.getHistory(prior.deveui, 'flow_liters_delta', 2);
  assert.equal(flowHistory.filter(row => row.t >= atClose.latest_data.sampled_at && row.t <= current.latest_data.sampled_at)
    .reduce((sum, row) => sum + (row.value ?? 0), 0), 6);
});

test('same-time closes from two valves publish one coherent shared meter observation', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const priorAt = Date.parse('2026-10-11T22:29:50.000Z');
  const closeAt = Date.parse('2026-10-11T22:59:50.000Z');
  const dayStart = Date.parse('2026-10-11T21:00:00.000Z');
  const meterEui = '00000000000000E1';
  await advanceInChunks(sim, priorAt);
  const prior = (await devicesAPI.getAll()).find(device => device.deveui === meterEui)!;
  assert.equal(prior.latest_data.sampled_at, new Date(priorAt).toISOString());

  await irrigationZonesAPI.removeDevice(2, '00000000000000D2');
  await irrigationZonesAPI.assignDevice(1, '00000000000000D2');
  await advanceInChunks(sim, closeAt - 62_000);
  await devicesAPI.controlValve('00000000000000D1', {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  await devicesAPI.controlValve('00000000000000D2', {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  await advanceInChunks(sim, closeAt);

  const current = (await devicesAPI.getAll()).find(device => device.deveui === meterEui)!;
  assert.equal(current.latest_data.sampled_at, new Date(closeAt).toISOString());
  assert.equal(current.latest_data.counter_interval_seconds, 1800, 'the cohort uses the report before both closes as its common baseline');
  assert.equal(current.latest_data.rain_mm_delta, 1.989);
  assert.equal(current.latest_data.flow_liters_delta, 12);
  assert.equal(current.latest_data.rain_mm_per_10min, 0.663);
  assert.equal(current.latest_data.flow_liters_per_10min, 4);

  const rainHistory = await sensorAPI.getHistory(meterEui, 'rain_mm_delta', 4);
  const flowHistory = await sensorAPI.getHistory(meterEui, 'flow_liters_delta', 4);
  const rainAtClose = rainHistory.filter(row => row.t === current.latest_data.sampled_at);
  const flowAtClose = flowHistory.filter(row => row.t === current.latest_data.sampled_at);
  assert.equal(rainAtClose.length, 1, 'all same-time valve contributions form one native row');
  assert.equal(flowAtClose.length, 1);
  assert.equal(rainAtClose[0]?.value, 1.989);
  assert.equal(flowAtClose[0]?.value, 12);
  assert.equal(current.latest_data.rain_mm_today,
    Number(rainHistory.filter(row => Date.parse(row.t) >= dayStart).reduce((sum, row) => sum + (row.value ?? 0), 0).toFixed(3)));
  assert.equal(current.latest_data.flow_liters_today,
    Number(flowHistory.filter(row => Date.parse(row.t) >= dayStart).reduce((sum, row) => sum + (row.value ?? 0), 0).toFixed(2)));

  const nextReportAt = Date.parse('2026-10-11T23:29:50.000Z');
  await advanceInChunks(sim, nextReportAt);
  const next = (await devicesAPI.getAll()).find(device => device.deveui === meterEui)!;
  assert.equal(next.latest_data.flow_liters_delta, 0);
  assert.equal(next.latest_data.flow_liters_today, 12);
  const flowAfterClose = await sensorAPI.getHistory(meterEui, 'flow_liters_delta', 4);
  assert.equal(flowAfterClose.filter(row => Date.parse(row.t) >= closeAt && Date.parse(row.t) <= nextReportAt)
    .reduce((sum, row) => sum + (row.value ?? 0), 0), 12, 'the periodic report does not publish either valve contribution again');
});

test('one-minute native meter reports conserve the received rain counter amount', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const meterEui = '00000000000000E1';
  const configureAt = Date.parse('2026-10-16T20:28:48.000Z');
  const intervalStart = Date.parse('2026-10-16T20:29:50.000Z');
  const intervalEnd = Date.parse('2026-10-16T20:59:50.000Z');
  await advanceInChunks(sim, configureAt);
  await lsn50API.setUplinkInterval(meterEui, 1);
  await advanceInChunks(sim, configureAt + 2_000);
  await advanceInChunks(sim, intervalStart);
  const baseline = (await devicesAPI.getAll()).find(device => device.deveui === meterEui)!;
  assert.equal(baseline.latest_data.sampled_at, new Date(intervalStart).toISOString());
  await advanceInChunks(sim, intervalEnd);

  const history = await sensorAPI.getHistory(meterEui, 'rain_mm_delta', 2);
  const reports = history.filter(row => Date.parse(row.t) > intervalStart && Date.parse(row.t) <= intervalEnd);
  assert.equal(reports.length, 30, 'the 30-minute physical rain event is reported in thirty one-minute intervals');
  assert.ok(reports.every(row => typeof row.value === 'number'));
  assert.equal(Number(reports.reduce((sum, row) => sum + (row.value ?? 0), 0).toFixed(3)), 2,
    'report partitions preserve the source interval’s 2.000 mm received amount');
});

test('S2120 Add and history use the same assigned timezone and preserve received millimetre precision', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  await advanceInChunks(sim, Date.parse('2026-10-16T21:29:50.000Z'));
  // Distinct fixture timezones make the stale device-zone vs weather-assignment owner observable.
  sim.state.zones.find(zone => zone.id === 2)!.timezone = 'America/Los_Angeles';
  const station = await devicesAPI.add({deveui: '00000000000000C8', name: 'Assigned weather station', type_id: 'SENSECAP_S2120', zone_id: 2});
  await s2120API.setZoneAssignments(station.deveui, [1]);
  await advanceInChunks(sim, Date.parse('2026-10-16T21:59:50.000Z'));
  const current = (await devicesAPI.getAll()).find(device => device.deveui === station.deveui)!;
  const history = await sensorAPI.getDailyRainHistory(station.deveui, 7);
  assert.equal(current.latest_data.rain_day_timezone, history.timezone);
  assert.equal(current.latest_data.rain_day_timezone_basis, history.timezoneBasis);
  assert.equal(history.timezone, 'Africa/Kampala', 'first explicit weather assignment owns current and daily history');
  const receivedToday = history.days.at(-1)!;
  assert.equal(current.latest_data.rain_mm_today, receivedToday.total_mm, 'current total matches native daily history once');
  assert.equal(receivedToday.total_mm, 1.011, 'received S2120 observations retain their source precision');
  assert.equal(current.latest_data.rain_mm_per_10min,
    Number((Number(current.latest_data.rain_mm_delta) * 600 / Number(current.latest_data.counter_interval_seconds)).toFixed(3)));
});

test('a missing LSN50 rain cohort is unavailable in current data and the native daily history', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const missingAt = Date.parse('2026-10-14T02:59:50.000Z');
  await advanceInChunks(sim, missingAt);
  const device = (await devicesAPI.getAll()).find(row => row.deveui === '00000000000000E1')!;
  assert.equal(device.latest_data.sampled_at, new Date(missingAt).toISOString());
  for (const field of ['rain_mm_delta', 'rain_mm_today', 'rain_mm_per_10min', 'rain_mm_per_hour']) {
    assert.equal(device.latest_data[field], null, `${field} stays unavailable instead of looking like measured dry rain`);
  }
  assert.equal(device.latest_data.rain_delta_status, 'unknown');
  const currentHistory = await sensorAPI.getHistory(device.deveui, 'rain_mm_delta', 1);
  assert.ok(currentHistory.some(row => row.t === device.latest_data.sampled_at && row.value === null));
  const daily = await sensorAPI.getDailyRainHistory(device.deveui, 1);
  assert.equal(daily.days[0]?.total_mm, null);
  assert.equal(daily.days[0]?.samples, 0);
  assert.equal(daily.days[0]?.quality, 'unknown');
});

test('dendro projections follow native ratio and legacy helper semantics, including dendro-only electrical input', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const add = await devicesAPI.add({deveui: '00000000000000C6', name: 'Dendro only', type_id: 'DRAGINO_LSN50', zone_id: 1});
  await lsn50API.setMode(add.deveui, 'MOD3');
  await lsn50API.setDendroEnabled(add.deveui, true);
  await lsn50API.setDendroConfig(add.deveui, {dendroStrokeMm: 10, dendroRatioAtRetracted: 0.49, dendroRatioAtExtended: 0.48});
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60_000);
  let current = (await devicesAPI.getAll()).find(device => device.deveui === add.deveui)!;
  assert.equal(current.chameleon_enabled, 0);
  assert.equal(typeof current.latest_data.adc_ch0v, 'number', 'dendro-enabled native report exposes ADC0 without Chameleon');
  assert.equal(typeof current.latest_data.adc_ch1v, 'number', 'MOD3 native report exposes ADC1 without Chameleon');
  let expected = nativeDendro.buildDendroDerivedMetrics({effectiveMode: 3, adcCh0V: current.latest_data.adc_ch0v,
    adcCh1V: current.latest_data.adc_ch1v, strokeMm: 10, ratioAtRetracted: 0.49, ratioAtExtended: 0.48});
  assert.equal(current.latest_data.dendro_position_raw_mm, expected.positionRawMm);
  assert.equal(current.latest_data.dendro_position_mm, expected.positionMm);
  assert.equal(current.latest_data.dendro_saturated, expected.dendroSaturated);
  assert.equal(current.latest_data.dendro_saturation_side, expected.dendroSaturationSide);

  await lsn50API.setDendroConfig(add.deveui, {dendroForceLegacy: true});
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60_000);
  current = (await devicesAPI.getAll()).find(device => device.deveui === add.deveui)!;
  expected = nativeDendro.buildDendroDerivedMetrics({effectiveMode: 3, forceLegacy: 1, adcCh0V: current.latest_data.adc_ch0v,
    adcCh1V: current.latest_data.adc_ch1v, strokeMm: 10, ratioAtRetracted: 0.49, ratioAtExtended: 0.48});
  assert.equal(current.latest_data.dendro_mode_used, expected.dendroModeUsed);
  assert.equal(current.latest_data.dendro_position_raw_mm, expected.positionRawMm);
  assert.equal(current.latest_data.dendro_position_mm, expected.positionMm);
  assert.equal(current.latest_data.dendro_saturated, expected.dendroSaturated);
  assert.equal(current.latest_data.dendro_saturation_side, expected.dendroSaturationSide);
});

test('unassigned LoRain current and daily rain use the native UTC fallback across a local-day boundary', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  await advanceInChunks(sim, Date.parse('2026-10-16T21:30:00.000Z'));
  const station = await devicesAPI.add({deveui: '00000000000000C7', name: 'Unassigned LoRain', type_id: 'AQUASCOPE_LORAIN'});
  assert.equal(station.irrigation_zone_id, null);
  assert.equal(station.latest_data.rain_day_timezone, 'UTC');
  assert.equal(station.latest_data.rain_day_timezone_basis, 'unassigned_default');
  assert.equal(station.latest_data.rain_day, '2026-10-16', 'Kampala is already on Oct 17 at this instant');
  const history = await sensorAPI.getDailyRainHistory(station.deveui, 1);
  assert.equal(history.timezone, 'UTC');
  assert.equal(history.timezoneBasis, 'unassigned_default');
  assert.equal(history.days[0]?.day, '2026-10-16');
  assert.equal(history.days[0]?.total_mm, station.latest_data.rain_mm_today);
});

test('each missing MOD3 ratio endpoint remains null through native config and readback', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const device = await devicesAPI.add({deveui: '00000000000000C5', name: 'Partial calibration', type_id: 'DRAGINO_LSN50', zone_id: 1});
  await lsn50API.setMode(device.deveui, 'MOD3');
  await lsn50API.setDendroEnabled(device.deveui, true);
  await lsn50API.setDendroConfig(device.deveui, {dendroStrokeMm: 10, dendroRatioAtRetracted: 0.49, dendroRatioAtExtended: 0.48});
  const sampleWith = async (dendroRatioAtRetracted: number | null, dendroRatioAtExtended: number | null) => {
    await lsn50API.setDendroConfig(device.deveui, {dendroRatioAtRetracted, dendroRatioAtExtended});
    await advanceInChunks(sim, sim.now + 2_000);
    await advanceInChunks(sim, sim.now + 30 * 60_000);
    const current = (await devicesAPI.getAll()).find(row => row.deveui === device.deveui)!;
    const expected = nativeDendro.buildDendroDerivedMetrics({effectiveMode: 3, adcCh0V: current.latest_data.adc_ch0v,
      adcCh1V: current.latest_data.adc_ch1v, strokeMm: 10, ratioAtRetracted: dendroRatioAtRetracted,
      ratioAtExtended: dendroRatioAtExtended});
    assert.equal(current.latest_data.dendro_valid, expected.dendroValid);
    assert.equal(current.latest_data.dendro_ratio, expected.dendroRatio);
    assert.equal(current.latest_data.dendro_position_raw_mm, null);
    assert.equal(current.latest_data.dendro_position_mm, null);
    assert.equal(expected.positionRawMm, null);
    assert.equal(expected.positionMm, null);
  };
  await advanceInChunks(sim, sim.now + 2_000);
  await advanceInChunks(sim, sim.now + 30 * 60_000);
  await sampleWith(null, 0.48);
  await sampleWith(0.49, null);
});

test('an active run overlapping the rain report uses one interval for both native counter rates', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const priorReportAt = Date.parse('2026-10-11T22:29:50.000Z');
  const rainReportAt = Date.parse('2026-10-11T22:59:50.000Z');
  await advanceInChunks(sim, priorReportAt);
  const meter = (await devicesAPI.getAll()).find(device => device.deveui === '00000000000000E1')!;
  const valveEui = '00000000000000D1';
  await advanceInChunks(sim, Date.parse('2026-10-11T22:58:58.000Z'));
  await devicesAPI.controlValve(valveEui, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  await advanceInChunks(sim, rainReportAt);
  const current = (await devicesAPI.getAll()).find(device => device.deveui === meter.deveui)!;
  const rainValue = current.latest_data.rain_mm_delta;
  const rain = Number(rainValue);
  const rainPer10Min = Number(current.latest_data.rain_mm_per_10min);
  const flow = Number(current.latest_data.flow_liters_delta);
  const flowPer10Min = Number(current.latest_data.flow_liters_per_10min);
  const sharedInterval = Number(current.latest_data.counter_interval_seconds);
  assert.ok(typeof rainValue === 'number' && rain > 0 && flow > 0,
    `joint native report should have positive rain and flow: ${JSON.stringify({rainValue, rainPer10Min, flow, flowPer10Min, sharedInterval, sampledAt: current.latest_data.sampled_at})}`);
  assert.equal(sharedInterval, 1800);
  assert.equal(rainPer10Min, Number((rain * 600 / sharedInterval).toFixed(3)));
  assert.equal(flowPer10Min, Number((flow * 600 / sharedInterval).toFixed(2)));
  const history = await sensorAPI.getHistory(meter.deveui, 'rain_mm_delta', 2);
  assert.equal(history.filter(row => row.t === current.latest_data.sampled_at).length, 1, 'same-time rain and flow contributions coalesce into one native row');
});
