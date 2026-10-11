import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import type {AxiosAdapter, AxiosResponse} from 'axios';
import {api, sensorAPI, dendroAPI, dendroAnalyticsAPI, devicesAPI, s2120API, environmentAPI, lsn50API} from '../../src/services/api';
import {Simulator} from '../model';

const require = createRequire(import.meta.url);
const nativeDendro = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js') as {
  buildDendroDerivedMetrics(options: Record<string, unknown>): {
    dendroRatio: number | null; dendroValid: number | null; positionRawMm: number | null; positionMm: number | null;
    dendroSaturated: number; dendroSaturationSide: string | null;
  };
};

function bridge(sim: Simulator): void {
  const adapter: AxiosAdapter = async config => {
    const url = new URL(config.url ?? '', 'http://simulator.test');
    for (const [key, value] of Object.entries(config.params ?? {})) if (value != null) url.searchParams.set(key, String(value));
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    const data = sim.request(config.method ?? 'GET', `${url.pathname}${url.search}`, body);
    return {data, status: 200, statusText: 'OK', headers: {}, config} as AxiosResponse;
  };
  api.defaults.adapter = adapter;
}

test('RD02 serves versioned daily rain with measured dry days distinct from missing days', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const rain = (await import('../../src/services/api')).devicesAPI.getAll;
  const device = (await rain()).find(item => item.rain_gauge_enabled === 1)!;
  for (const days of [7, 30, 90]) {
    const history = await sensorAPI.getDailyRainHistory(device.deveui, days);
    assert.equal(history.timezoneBasis, 'zone');
    assert.equal(history.days.length, days);
    assert.ok(history.days.some(day => day.total_mm === 0 && day.samples > 0));
    assert.ok(history.days.some(day => day.total_mm === null && day.samples === 0), 'the reserved telemetry cohort remains missing rather than measured dry');
  }
  const added = await devicesAPI.add({deveui: '00000000000000C9', name: 'New rain history', type_id: 'DRAGINO_LSN50'});
  const addedHistory = await sensorAPI.getDailyRainHistory(added.deveui, 7);
  assert.equal(addedHistory.days.length, 7);
  assert.equal(addedHistory.timezone, 'UTC');
  assert.equal(addedHistory.timezoneBasis, 'unassigned_default');
  assert.ok(addedHistory.days.some(day => day.total_mm === 0));
});

test('RD01 and RD05 keep seeded device chart windows finite and timestamped', async () => {
  bridge(new Simulator({mode: 'public'}));
  const devices = await (await import('../../src/services/api')).devicesAPI.getAll();
  const soil = devices.find(device => device.type_id === 'KIWI_SENSOR')!;
  const dendro = devices.find(device => device.dendro_enabled === 1)!;
  const swt = await sensorAPI.getHistory(soil.deveui, 'swt_1', 12);
  const stem = await dendroAPI.getHistory(dendro.deveui, 12);
  assert.ok(swt.length > 0 && swt.every(point => point.value !== null));
  assert.ok(stem.length > 0 && stem.every(point => point.t.length > 0));
});

test('RD03 and RD04 intervals match retained rain and wind ledger series across every monitor window', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const devices = await (await import('../../src/services/api')).devicesAPI.getAll();
  const rain = devices.find(device => device.type_id === 'DRAGINO_LSN50')!;
  for (const hours of [12, 24]) {
    const gauge = await sensorAPI.getHistory(rain.deveui, 'rain_mm_delta', hours);
    const expected = sim.readings.aggregate(rain.deveui, 'rain_mm_delta', sim.now - hours * 3600000, sim.now);
    assert.equal(gauge.reduce((total, row) => total + row.value, 0), expected);
  }
  const station = devices.find(device => device.type_id === 'SENSECAP_S2120')!;
  for (const field of ['wind_speed_mps', 'wind_gust_mps', 'wind_direction_deg']) for (const hours of [12, 24, 168, 720, 2160]) {
    const rows = await sensorAPI.getHistory(station.deveui, field, hours);
    assert.ok(rows.length > 0 && rows.every(row => Number.isFinite(row.value)), `${field}/${hours}h`);
    if (field === 'wind_direction_deg') assert.ok(rows.every(row => row.value >= 0 && row.value < 360), `wrapped direction ${hours}h`);
  }
});

test('accepted LSN50 rain observations conserve the storm across actual 15-minute reports and local midnight', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const eui = '00000000000000E1';
  sim.advanceTo(Date.parse('2026-10-16T20:00:00.000Z'));
  await lsn50API.setUplinkInterval(eui, 15);
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(Date.parse('2026-10-16T21:30:00.000Z'));
  const device = (await devicesAPI.getAll()).find(row => row.deveui === eui)!;
  const rows = await sensorAPI.getHistory(eui, 'rain_mm_delta', 4);
  const stormRows = rows.filter(row => Date.parse(row.t) > Date.parse('2026-10-16T20:15:00.000Z')
    && Date.parse(row.t) <= Date.parse('2026-10-16T21:15:02.000Z'));
  assert.equal(Number(stormRows.reduce((total, row) => total + row.value, 0).toFixed(3)), 4,
    'the accepted deltas include the full shared four-millimeter storm');
  assert.equal(device.latest_data.sampled_at, '2026-10-16T21:15:02.000Z');
  assert.equal(device.latest_data.counter_interval_seconds, 900);
  const currentDayRows = rows.filter(row => new Intl.DateTimeFormat('en-CA', {timeZone: 'Africa/Kampala', year: 'numeric',
    month: '2-digit', day: '2-digit'}).format(new Date(row.t)) === '2026-10-17');
  assert.equal(device.latest_data.rain_mm_today, Number(currentDayRows.reduce((total, row) => total + row.value, 0).toFixed(3)),
    'the midnight-crossing total follows accepted sample-date attribution, including the current row once');
  assert.equal(device.latest_data.rain_day, '2026-10-17');
  assert.equal(device.latest_data.rain_day_timezone, 'Africa/Kampala');
});

test('S2120 keeps recent ten-minute intensity separate from accepted-interval rain amounts', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  sim.advanceTo(Date.parse('2026-10-16T21:29:50.000Z'));
  const station = (await devicesAPI.getAll()).find(device => device.type_id === 'SENSECAP_S2120')!;
  assert.equal(station.latest_data.sampled_at, '2026-10-16T21:29:50.000Z');
  assert.ok(Number(station.latest_data.rain_mm_delta) > 0, 'the accepted cumulative difference includes rain earlier in this interval');
  assert.equal(station.latest_data.rain_mm_per_hour, 0, 'S2120 intensity is the distinct previous-ten-minute hardware channel');
  assert.ok(Number(station.latest_data.rain_mm_per_10min) > 0,
    'normalized per-ten-minute amount reflects the accepted interval even when its last ten minutes were dry');
  assert.equal(station.latest_data.rain_mm_per_10min, Number((Number(station.latest_data.rain_mm_delta) * 600 /
    Number(station.latest_data.counter_interval_seconds)).toFixed(3)));
  const cumulative = await sensorAPI.getHistory(station.deveui, 'rain_gauge_cumulative_mm', 2);
  const current = cumulative.find(row => row.t === station.latest_data.sampled_at)!;
  const previous = cumulative.filter(row => row.t < current.t).at(-1)!;
  assert.equal(Number((current.value - previous.value).toFixed(3)), Number(station.latest_data.rain_mm_delta),
    'the retained native counter difference is stored to the source 0.001 mm precision');
});

test('RD06-RD08 derive daily tree indicators and zone recommendations from the retained ledger', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const {devicesAPI} = await import('../../src/services/api');
  const devices = await devicesAPI.getAll();
  const dendro = devices.find(device => device.dendro_enabled === 1)!;
  const days = await dendroAnalyticsAPI.getDailyIndicators(dendro.deveui, 7);
  assert.equal(days.length, 7);
  assert.ok(days.every(day => day.deveui === dendro.deveui && typeof day.date === 'string'));
  const raw = await dendroAnalyticsAPI.getRawReadings(dendro.deveui, '2026-10-09T00:00:00.000Z', '2026-10-10T03:00:00.000Z');
  assert.ok(raw.length > 0);
  assert.ok(raw.every(row => row.deveui === dendro.deveui && row.recorded_at >= '2026-10-09T00:00:00.000Z' && row.recorded_at <= '2026-10-10T03:00:00.000Z'));
  const input = raw[0]!;
  const derived = nativeDendro.buildDendroDerivedMetrics({effectiveMode: 3, adcCh0V: input.adc_ch0v, adcCh1V: input.adc_ch1v,
    strokeMm: dendro.dendro_stroke_mm, ratioAtRetracted: dendro.dendro_ratio_at_retracted,
    ratioAtExtended: dendro.dendro_ratio_at_extended});
  assert.equal(input.is_valid, derived.dendroValid);
  assert.equal(input.dendro_ratio, derived.dendroRatio);
  assert.equal(input.position_raw_um, derived.positionRawMm === null ? null : derived.positionRawMm * 1000);
  assert.equal(input.position_um, derived.positionMm === null ? null : derived.positionMm * 1000);
  assert.equal(input.dendro_saturated, derived.dendroSaturated);
  assert.equal(input.dendro_saturation_side, derived.dendroSaturationSide);
  assert.ok(raw.every(row => row.is_valid === 1 && row.position_raw_um === null && row.position_um === null &&
    typeof row.adc_ch0v === 'number' && typeof row.adc_ch1v === 'number' && typeof row.dendro_ratio === 'number'),
  'unconfigured seed exposes native-valid ratio inputs without inventing a displacement calibration');
  for (const window of [12, 24, 168, 720, 2160]) {
    const history = await dendroAPI.getHistory(dendro.deveui, window);
    assert.ok(history.length > 0 && history.every(row => row.t && row.position_mm === null && row.position_raw_mm === null),
      `dendrometer/${window}h is null until calibration is supplied`);
  }
  for (const count of [7, 30]) {
    const indicators = await dendroAnalyticsAPI.getDailyIndicators(dendro.deveui, count);
    assert.equal(indicators.length, count);
    assert.ok(indicators.every(row => row.deveui === dendro.deveui && typeof row.date === 'string' && Number.isFinite(row.valid_readings_count)));
    if (count === 30) {
      const dates = new Set(indicators.map(row => row.date));
      const ledgerSamples = sim.readings.forDevice(dendro.deveui).filter(sample => dates.has(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(sample.at))) &&
        typeof sample.values.dendro_position_mm === 'number' && Number(sample.values.dendro_valid ?? 1) !== 0);
      assert.equal(indicators.reduce((total, row) => total + row.valid_readings_count, 0), ledgerSamples.length);
    }
  }
  for (const count of [1, 7, 14, 30]) {
    const recommendations = await dendroAnalyticsAPI.getZoneRecommendations(dendro.irrigation_zone_id!, count);
    assert.equal(recommendations.length, count);
    assert.ok(recommendations.every(row => row.zone_id === dendro.irrigation_zone_id && row.action_reasoning.length > 0));
  }
});

test('DV26-DV27 weather assignment selects rain source and timezone; reference cohort and recommendations use the shared ledger', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const station = (await devicesAPI.getAll()).find(device => device.type_id === 'SENSECAP_S2120')!;
  const priorStationRows = await sensorAPI.getHistory(station.deveui, 'rain_mm_delta', 24);
  await s2120API.setZoneAssignments(station.deveui, [1, 2]);
  const history = await sensorAPI.getDailyRainHistory(station.deveui, 7);
  assert.equal(history.timezoneBasis, 'weather_station_zone');
  assert.equal(history.timezone, 'Africa/Kampala');
  const summary = await environmentAPI.getSummary(1);
  assert.equal(summary.water.daily.at(-1)?.rainMm, history.days.at(-1)?.total_mm);
  assert.equal(summary.water.rainTodayMm, sim.readings.aggregate(station.deveui, 'rain_mm_delta', sim.now - 24 * 60 * 60 * 1000, sim.now));
  assert.ok(typeof summary.water.rainTodayMm === 'number');
  assert.deepEqual(await sensorAPI.getHistory(station.deveui, 'rain_mm_delta', 24), priorStationRows, 'assignment leaves stored observations unchanged');

  const secondTree = await devicesAPI.add({deveui: '00000000000000C7', name: 'Second tree', type_id: 'DRAGINO_LSN50', zone_id: 2});
  await lsn50API.setMode(secondTree.deveui, 'MOD3');
  await lsn50API.setDendroEnabled(secondTree.deveui, true);
  await devicesAPI.controlValve('00000000000000D2', {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(sim.now + 62_000);
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  const recommendationBefore = await dendroAnalyticsAPI.getZoneRecommendations(2, 7);
  assert.equal(recommendationBefore.at(-1)?.usable_tree_count, 2);
  const zoneSummary = await environmentAPI.getSummary(2);
  assert.equal(recommendationBefore.at(-1)?.rainfall_mm, zoneSummary.water.daily.at(-1)?.rainMm);
  assert.equal(recommendationBefore.at(-1)?.water_delivered_liters, zoneSummary.water.daily.at(-1)?.irrigationLiters);
  await dendroAnalyticsAPI.setReferenceTree('00000000000000E3', true);
  const recommendationAfter = await dendroAnalyticsAPI.getZoneRecommendations(2, 7);
  assert.equal(recommendationAfter.at(-1)?.usable_tree_count, 1);
  assert.match(recommendationAfter.at(-1)?.action_reasoning ?? '', /reference-cohort/);
});
