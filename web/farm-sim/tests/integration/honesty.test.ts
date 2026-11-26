import assert from 'node:assert/strict';
import test from 'node:test';
import {METER_EUI, PLANS_PATH, PROBE_EUI, VALVE_EUI} from '../../src/core/osi/farm-builder';
import {TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {layerKpa} from '../../src/core/soil';
import {FARM_SITE, HOUR_MS, MINUTE_MS, localDayStart} from '../../src/core/time';
import {atHour, buildAdapter, edgeTomatoKc, environment, fao56, fixtureWeather, hash, iso, meter, openFor, START, SUMMARY, write} from './osi-fixture';

test('creation uplinks and fixed half-hour samples carry only the world inputs', () => {
  const {adapter} = buildAdapter(3);
  const snapshot = adapter.simulatorSnapshot();
  assert.deepEqual(snapshot.devices.map(device => device.deveui), [PROBE_EUI, METER_EUI, VALVE_EUI]);
  const column = adapter.world.bedAColumn();
  assert.deepEqual(snapshot.readings[0][1][0].values, {swt_1: layerKpa(column, 1), swt_2: layerKpa(column, 2), bat_pct: 90});
  assert.deepEqual(snapshot.readings[2][1][0].values, {valve_state: 0, bat_pct: 90});
  const latest = meter(adapter);
  assert.equal(latest.sampled_at, iso(START));
  assert.equal(latest.rain_mm_delta, 0);
  assert.equal(latest.flow_liters_delta, 0);
  assert.equal(latest.flow_liters_today, 0);
  adapter.advance(atHour(1, 7));
  for (const [, samples] of adapter.simulatorSnapshot().readings) {
    assert.deepEqual(samples.map(sample => sample.at), [START, atHour(1, 7)]);
  }
});

test('an off-grid KIWI uplink reads projected soil at the sample timestamp', () => {
  const scenario = {...TUTORIAL_SCENARIO, start: START + 5 * MINUTE_MS};
  const {adapter} = buildAdapter(1, {scenario, weather: fixtureWeather({et0: 30})});
  const at = scenario.start + 30 * MINUTE_MS;
  adapter.advance(at);
  const committed = adapter.world.bedAColumn();
  const projected = adapter.world.bedAColumn(at);
  const sample = adapter.latestProbeSample();
  assert.ok(sample);
  assert.equal(sample.at, at);
  assert.notEqual(layerKpa(projected, 1), layerKpa(committed, 1));
  assert.equal(sample.values.swt_1, layerKpa(projected, 1));
  assert.equal(sample.values.swt_2, layerKpa(projected, 2));
});

test('FAO-56 and edge Kc use the as-of day while T1 has no ET0', () => {
  const weather = fixtureWeather({leadZeroTemperatureDelta: 4});
  const {adapter} = buildAdapter(2, {weather});
  const now = atHour(2, 12);
  adapter.advance(now);
  const summary = environment(adapter).water;
  for (const row of summary.daily) {
    const asOf = weather.asOf(row.date, now);
    assert.ok(asOf);
    assert.equal(row.et0Mm, fao56(asOf));
    assert.equal(row.kc, edgeTomatoKc(row.date));
  }
  assert.notEqual(weather.actual(now).et0Mm, summary.daily.find(day => day.date === summary.todayDate)?.et0Mm);
  const t1 = buildAdapter(1, {weather}).adapter;
  t1.advance(now);
  assert.ok(environment(t1).water.daily.every(day => day.et0Mm === null && day.demandMm === null));
  const otherTiers = ([0, 3, 4] as const).map(tier => buildAdapter(tier, {weather}).adapter);
  for (const farm of [adapter, t1, ...otherTiers]) {
    farm.advance(now);
    const records = farm.simulatorSnapshot().environmentRecords;
    assert.equal(records.length, 93);
    for (const [, row] of records) {
      assert.equal(row.timezone, FARM_SITE.timezone);
      const expectedCoords = [FARM_SITE.latDeg, FARM_SITE.lonDeg].map(value => value.toFixed(2)).join(':');
      assert.equal(row.values.location_key, row.provider ? row.provider + ':' + expectedCoords : null);
    }
  }
});

test('past-day weather and provenance are identical across capture times and later reads', () => {
  const weather = fixtureWeather({
    leadZeroTemperatureDelta: 4,
    forecastRain: () => [2, ...Array<number>(23).fill(0)],
  });
  const a = buildAdapter(2, {weather}).adapter;
  const b = buildAdapter(2, {weather}).adapter;
  const priorDate = '2027-01-11';
  const midnight = atHour(2, 0);
  const record = (adapter: typeof a) => {
    const value = adapter.simulatorSnapshot().environmentRecords.find(([, row]) => row.date === priorDate);
    assert.ok(value);
    return value[1];
  };
  assert.ok(!a.simulatorSnapshot().environmentRecords.some(([, row]) => row.date === priorDate));
  const leadZero = environment(a).water.daily.find(day => day.date === priorDate)?.et0Mm;
  a.advance(midnight + HOUR_MS);
  b.advance(midnight + 6 * HOUR_MS);
  b.resetEnvironmentRecords();
  const first = record(a);
  const second = record(b);
  assert.notEqual(first.values.et0_mm, leadZero);
  assert.equal(first.values.forecast_rain_mm, 0);
  assert.equal(first.values.et0_source, 'fao56_daily_game_weather');
  assert.equal(first.values.et0_tier, 'fao56_daily');
  assert.equal(first.provenance.stage, 'mid_season');
  assert.equal(first.provenance.kc, 1.15);
  const sameAgronomy = (row: typeof first) => ({
    ...row, values: {...row.values, source_captured_at: null}, provenance: {...row.provenance, capturedAt: null},
  });
  assert.deepEqual(sameAgronomy(first), sameAgronomy(second));
  for (const [adapter, at, prior] of [[a, midnight, first], [b, b.now, second]] as const) {
    assert.equal(prior.values.source_captured_at, iso(at));
    assert.equal(prior.provenance.capturedAt, iso(at));
    const digest = hash(adapter.simulatorSnapshot());
    environment(adapter);
    environment(adapter);
    assert.equal(hash(adapter.simulatorSnapshot()), digest);
    assert.deepEqual(record(adapter), prior);
  }
});

test('weather source declines missing dates and memoizes the date and issue pair', async () => {
  const {createWeatherSource} = await import('../../src/core/osi/weather-source');
  const base = fixtureWeather();
  const issued: string[] = [];
  const source = createWeatherSource({
    actual: base.actual,
    asOf(date, now) { issued.push(date); return base.asOf(date, now); },
    forecastIssueAt: localDayStart,
  });
  const zone = buildAdapter(2).adapter.simulatorSnapshot().zones[0];
  assert.equal(source('2026-10-10', zone, START), null);
  assert.equal(source('2027-01-15', zone, START), null);
  assert.equal(source('2027-02-30', zone, START), null);
  assert.equal(source('2027-1-1', zone, START), null);
  const first = source('2027-01-11', zone, START);
  assert.ok(first);
  assert.equal(source('2027-01-11', zone, START + MINUTE_MS), first);
  assert.equal(source('2027-01-11', zone, atHour(2, 0))?.rain, 0);
  assert.deepEqual(issued, ['2027-01-11', '2027-01-11']);
});

test('the phone reads an intraday forecast revision from an injected source', () => {
  const noon = atHour(1, 12);
  const tomorrow = atHour(2, 0);
  const weather = fixtureWeather({
    forecastRain: (day, now) => Array.from({length: 24}, (_, hour) =>
      day.startsAt === tomorrow && now >= noon && hour === 6 ? 7 : 0),
  });
  const {adapter} = buildAdapter(2, {weather});
  assert.equal(environment(adapter).water.next24hRainMm, 0);
  adapter.advance(noon);
  assert.equal(environment(adapter).water.next24hRainMm, 7);
});

// Tank-tap readings feed the same OSI flow fields as the valve's observed-flow estimates.
// The two current-weather blocks show daily values where a current observation would appear.
type Classification = 'world' | 'osi' | 'illustrative';
const fieldTable: Record<Classification, readonly string[]> = {
  world: [
    'devices[].active_valve_actuation.flow_rate_lpm',
    'devices[].flow_rate_lpm',
    'devices[].latest_data.bat_pct',
    'devices[].latest_data.rain_mm_delta',
    'devices[].latest_data.rain_mm_per_10min',
    'devices[].latest_data.swt_1',
    'devices[].latest_data.swt_2',
    'devices[].soil_moisture_probe_depths_json.swt_1',
    'devices[].soil_moisture_probe_depths_json.swt_2',
    'environment.forecast.rainFocus.daily[].rainMm',
    'environment.forecast.rainFocus.daily[].windSpeedMps',
    'environment.forecast.rainFocus.hourly[].rainMm',
    'environment.forecast.rainFocus.hourly[].windSpeedMps',
    'environment.location.latitude',
    'environment.location.longitude',
    'environment.water.areaM2',
    'environment.water.daily[].areaM2',
    'environment.water.daily[].irrigationEfficiencyPct',
    'environment.water.irrigationEfficiencyPct',
    'valves.valves[].active_actuation.flow_rate_lpm',
    'valves.valves[].flow_rate_lpm',
  ],
  osi: [
    'actuations.actuations[].commandedDurationSeconds',
    'actuations.actuations[].estimatedGrossLiters',
    'actuations.actuations[].flowRateLpm',
    'actuations.actuations[].zoneId',
    'devices[].active_valve_actuation.duration_seconds',
    'devices[].active_valve_actuation.generation',
    'devices[].active_valve_actuation.open_delay_ms',
    'devices[].active_valve_actuation.zone_id',
    'devices[].chameleon_enabled',
    'devices[].dendro_enabled',
    'devices[].flow_meter_enabled',
    'devices[].irrigation_zone_id',
    'devices[].latest_data.counter_interval_seconds',
    'devices[].latest_data.flow_liters_delta',
    'devices[].latest_data.flow_liters_per_10min',
    'devices[].latest_data.flow_liters_today',
    'devices[].latest_data.lsn50_mode_code',
    'devices[].latest_data.rain_mm_today',
    'devices[].latest_data.valve_state',
    'devices[].lsn50_mode_code',
    'devices[].rain_gauge_enabled',
    'devices[].temp_enabled',
    'devices[].temp_humidity_enabled',
    'devices[].valve_opening_percent',
    'environment.agronomic.current.cropCoefficientKc',
    'environment.agronomic.current.etcMmDay',
    'environment.agronomic.current.referenceEt0MmDay',
    'environment.forecast.rainFocus.daily[].et0MmDay',
    'environment.forecast.rainFocus.daily[].etcMmDay',
    'environment.forecast.rainFocus.maxHourlyRainMm',
    'environment.forecast.rainFocus.rainHoursNext24h',
    'environment.forecast.rainFocus.totalNext24hMm',
    'environment.forecast.rainFocus.totalNext72hMm',
    'environment.local.freshSensorCount',
    'environment.local.sensorCount',
    'environment.local.staleSensorCount',
    'environment.water.balanceTodayMm',
    'environment.water.daily[].coveragePct',
    'environment.water.daily[].demandMm',
    'environment.water.daily[].et0Mm',
    'environment.water.daily[].expectedHours',
    'environment.water.daily[].forecastRainMm',
    'environment.water.daily[].hoursPresent',
    'environment.water.daily[].irrigationLiters',
    'environment.water.daily[].irrigationNetMm',
    'environment.water.daily[].kc',
    'environment.water.daily[].measuredIrrigationLiters',
    'environment.water.daily[].measuredIrrigationNetMm',
    'environment.water.daily[].rainMm',
    'environment.water.daily[].totalWaterMm',
    'environment.water.irrigationTodayLiters',
    'environment.water.irrigationTodayMeasuredLiters',
    'environment.water.irrigationTodayNetMm',
    'environment.water.measuredIrrigationNetMm',
    'environment.water.next24hRainMm',
    'environment.water.rainTodayMm',
    'environment.water.sensorHealth.freshSensorCount',
    'environment.water.sensorHealth.sensorCount',
    'environment.water.sensorHealth.staleSensorCount',
    'environment.water.waterNeededTodayMm',
    'environment.zoneId',
    'valves.valves[].active_actuation.duration_seconds',
    'valves.valves[].active_actuation.generation',
    'valves.valves[].active_actuation.open_delay_ms',
    'valves.valves[].active_actuation.zone_id',
    'valves.valves[].default_open_minutes',
    'valves.valves[].next_run.minutes',
    'valves.valves[].push_state.acked',
    'valves.valves[].push_state.failed',
    'valves.valves[].push_state.queued',
    'valves.valves[].schedule_count',
    'valves.valves[].zone_id',
  ],
  illustrative: [
    'environment.agronomic.current.airTemperatureC',
    'environment.agronomic.current.dewPointC',
    'environment.agronomic.current.heatIndexC',
    'environment.agronomic.current.relativeHumidityPct',
    'environment.agronomic.current.thi',
    'environment.agronomic.current.vpdKpa',
    'environment.forecast.rainFocus.daily[].maxTempC',
    'environment.forecast.rainFocus.daily[].minTempC',
    'environment.forecast.rainFocus.daily[].rainProbabilityPct',
    'environment.forecast.rainFocus.hourly[].rainProbabilityPct',
    'environment.forecast.rainFocus.hourly[].tempC',
    'environment.online.current.airTemperatureC',
    'environment.online.current.precipitationProbabilityPct',
    'environment.online.current.rainMm',
    'environment.online.current.relativeHumidityPct',
    'environment.online.current.windSpeedMps',
  ],
};

function numericPaths(value: unknown, path: string, result: Set<string>): void {
  if (typeof value === 'number') result.add(path);
  else if (Array.isArray(value)) for (const item of value) numericPaths(item, path + '[]', result);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) numericPaths(child, path + '.' + key, result);
  }
}

test('every numeric field in the four phone response surfaces has a classification', () => {
  const paths = new Set<string>();
  const farm = buildAdapter(3, {tank: 600, weather: fixtureWeather({
    actualRain: () => Array.from({length: 24}, (_, hour) => hour === 7 ? 2 : 0),
    forecastRain: () => Array.from({length: 24}, (_, hour) => hour === 10 ? 3 : 0),
  })}).adapter;
  const collect = () => {
    for (const [name, path] of [['environment', SUMMARY], ['devices', '/api/devices'], ['valves', '/api/valves'],
      ['actuations', '/api/irrigation/recent-actuations']]) {
      numericPaths(write(farm, 'GET', path), name, paths);
    }
  };
  write(farm, 'POST', PLANS_PATH + '/schedules', {kind: 'WEEKLY', start_time: '17:00',
    weekdays_mask: 127, duration_minutes: 20});
  openFor(farm, atHour(2, 7), 45);
  collect();
  farm.advance(atHour(2, 7.5));
  collect();
  farm.advance(atHour(2, 8));
  collect();
  const expected = Object.values(fieldTable).flat().sort();
  assert.equal(new Set(expected).size, expected.length, 'field classifications must be unique');
  assert.deepEqual([...paths].sort(), expected);
});

test('two farms keep separate weather sources when phone reads interleave', () => {
  const aWeather = fixtureWeather({leadZeroTemperatureDelta: 4});
  const bWeather = fixtureWeather();
  const a = buildAdapter(2, {weather: aWeather}).adapter;
  const b = buildAdapter(2, {weather: bWeather}).adapter;
  const today = (farm: typeof a) => {
    const summary = environment(farm).water;
    return summary.daily.find(row => row.date === summary.todayDate)?.et0Mm;
  };
  assert.notEqual(today(a), today(b));
  for (const [farm, weather] of [[b, bWeather], [a, aWeather]] as const) {
    farm.advance(atHour(2, 7));
    const day = weather.asOf('2027-01-12', farm.now);
    assert.ok(day);
    assert.equal(today(farm), fao56(day));
  }
});
