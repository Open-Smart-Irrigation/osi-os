import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {localCalendarDayStart, PUBLIC_EPOCH, Simulator, uncachedLocalCalendarDayStart, VALVE_EUI} from '../model';
import type {ReadingSource} from '../model/readings';
import {buildForecast, getWeatherSource, selectedWeatherProvider, setWeatherSource, type WeatherSource} from '../model/environment';

const require = createRequire(import.meta.url);
const nativeEnvironment = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js') as {
  sumRain: (hours: Array<{time: string; rainMm: number | null}>, nowMs: number, horizonHours: number,
    sourceBasis: {source: string; basis: 'start' | 'end'}) => {totalMm: number | null; coveredHours: number; expectedHours: number};
};

// --- default-scenario digest (begin) ---
// Only APIs present on the base commit: this block is copied verbatim into a runner on the base to record the constant.
function runDefaultScenario() {
  const sim = new Simulator({mode: 'public'});
  const start = sim.now;
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 600});
  sim.request('POST', `/api/valves/${VALVE_EUI}/schedules`, {kind: 'WEEKLY', weekdays_mask: 127,
    start_time: '07:00', duration_minutes: 10, label: 'Digest plan'});
  sim.request('PUT', '/api/irrigation-zones/1/schedule', {trigger_metric: 'SWT_1', threshold_kpa: 40, enabled: true, duration_minutes: 5});
  for (let hour = 1; hour <= 72; hour++) sim.advanceTo(start + hour * 3_600_000);
  const readings = Object.fromEntries(sim.devices.map(device => [device.deveui, sim.readings.forDevice(device.deveui)]));
  const environment = sim.request('GET', '/api/irrigation-zones/1/environment-summary') as {water: {todayDate: string | null}};
  // The summary keeps only the next 24 forecast hours; the full 72-hour forecast also pins the hourly rain amounts.
  const zone = sim.zones.find(row => row.id === 1)!;
  const forecast = buildForecast(zone, environment.water.todayDate!, sim.now, zone.timezone ?? sim.state.settings.gatewayTimezone,
    selectedWeatherProvider(zone), sim.state.environmentRecords);
  const payload = JSON.stringify({zones: sim.zones, devices: sim.devices, outcomes: sim.outcomes,
    triggerEvaluations: sim.state.triggerEvaluations, readings, environment, forecast});
  return {digest: createHash('sha256').update(payload).digest('base64'), sim, readings, environment, forecast};
}
// --- default-scenario digest (end) ---

// SHA-256 (base64) produced by running runDefaultScenario() above, copied verbatim into a runner, against the base
// commit 4682fb17b1 (web/react-gui extracted from that commit into a separate directory, node_modules linked, run with
// tsx; two runs agreed). On the base the scenario gave 5 completed runs, 3 trigger evaluations, 5 observed-flow
// samples on the meter and four 0.4 mm forecast rain hours.
const BASE_DEFAULT_DIGEST = 'g+alNkylWb7Swl3ebfxVSl2VmfPmzMWJ9oTN1rJvbCI=';

type Summary = {
  water: {next24hRainMm: number | null; todayDate: string | null; daily: Array<{date: string; et0Mm: number | null; et0Source: string | null; et0Tier: string | null}>};
  online: {current: {relativeHumidityPct: number | null; windSpeedMps: number | null} | null};
  forecast: {available: boolean; rainFocus: {daily: Array<{date: string; windSpeedMps: number | null; et0MmDay: number | null}>;
    hourly: Array<{time: string; rainMm: number | null}>; totalNext24hMm: number | null} | null};
};
const summaryOf = (sim: Simulator, zoneId = 1) => sim.request('GET', `/api/irrigation-zones/${zoneId}/environment-summary`) as Summary;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const deviceOf = (sim: Simulator, eui: string) => sim.devices.find(device => device.deveui === eui)!;
const latest = (sim: Simulator, eui: string) => deviceOf(sim, eui).latest_data as unknown as Record<string, unknown>;
const NEW_PROBE = '00000000000000B0';
const FLOW_METER = '00000000000000E1';
const addProbe = (sim: Simulator) => sim.request('POST', '/api/devices', {deveui: NEW_PROBE, name: 'Game soil probe', type_id: 'KIWI_SENSOR', zone_id: 1});
const swt1At = (at: number) => Number((31.5 + (at - PUBLIC_EPOCH) / HOUR).toFixed(2));
// A soil reading source whose values are recognisable and move with simulated time.
const soilSource: ReadingSource = (device, at, synthetic) => device.type_id === 'KIWI_SENSOR'
  ? {...synthetic(), swt_1: swt1At(at), swt_2: 41.5, swt_3: 51.5}
  : synthetic();
const publicToday = new Intl.DateTimeFormat('en-CA', {timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(PUBLIC_EPOCH));

test('defaults are unchanged: the fixed public scenario reproduces the base commit digest', () => {
  const first = runDefaultScenario();
  // The scenario must exercise what the hooks touch: runs, trigger evaluations, observed flow on the meter and forecast rain.
  assert.ok(first.sim.outcomes.length >= 2);
  assert.ok(first.sim.state.triggerEvaluations.length >= 1);
  assert.ok(first.readings[FLOW_METER]!.some(sample => sample.source === 'observed-flow'));
  assert.ok((first.forecast?.hourly ?? []).some(row => (row.rainMm ?? 0) > 0));
  assert.equal(first.digest, BASE_DEFAULT_DIGEST);
  assert.equal(runDefaultScenario().digest, first.digest);
});

test('a reading source reaches latest_data at device creation and on later uplinks; soil response adds nothing', () => {
  const sim = new Simulator({mode: 'public', readingSource: soilSource});
  const created = sim.now;
  addProbe(sim);
  assert.equal(latest(sim, NEW_PROBE).swt_1, swt1At(created));
  assert.equal(latest(sim, NEW_PROBE).swt_2, 41.5);
  assert.equal(latest(sim, NEW_PROBE).sampled_at, new Date(created).toISOString());
  const listed = (sim.request('GET', '/api/devices') as Array<{deveui: string; latest_data: Record<string, unknown>}>).find(row => row.deveui === NEW_PROBE)!;
  assert.equal(listed.latest_data.swt_1, swt1At(created));
  sim.advanceTo(created + 2 * HOUR + 1_000);
  const later = latest(sim, NEW_PROBE), sampledAt = Date.parse(String(later.sampled_at));
  assert.ok(sampledAt > created);
  assert.equal(later.swt_1, swt1At(sampledAt));
  // The fixture probes also report the source's values from their first scheduled uplink.
  assert.equal(latest(sim, '00000000000000A1').swt_2, 41.5);

  const samples = sim.readings.forDevice(NEW_PROBE).length;
  const before = structuredClone(latest(sim, NEW_PROBE));
  sim.readings.applySoilResponse(NEW_PROBE, sim.now, 500, deviceOf(sim, NEW_PROBE));
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, samples);
  assert.deepEqual(latest(sim, NEW_PROBE), before);

  // Without a source the same call still applies the synthetic soil response.
  const plain = new Simulator({mode: 'public'});
  addProbe(plain);
  const plainSamples = plain.readings.forDevice(NEW_PROBE).length;
  plain.readings.applySoilResponse(NEW_PROBE, plain.now + 60_000, 500, deviceOf(plain, NEW_PROBE));
  assert.equal(plain.readings.forDevice(NEW_PROBE).length, plainSamples + 1);
});

test('fictionalHistory false starts with no seed samples and gives a new device exactly one creation sample', () => {
  const empty = new Simulator({mode: 'public', fictionalHistory: false});
  for (const device of empty.devices) assert.equal(empty.readings.forDevice(device.deveui).length, 0, device.deveui);
  addProbe(empty);
  const plainSamples = empty.readings.forDevice(NEW_PROBE);
  assert.equal(plainSamples.length, 1);
  assert.equal(plainSamples[0]!.at, empty.now);

  const sourced = new Simulator({mode: 'public', fictionalHistory: false, readingSource: soilSource});
  for (const device of sourced.devices) assert.equal(sourced.readings.forDevice(device.deveui).length, 0, device.deveui);
  addProbe(sourced);
  const samples = sourced.readings.forDevice(NEW_PROBE);
  assert.equal(samples.length, 1);
  const expected = soilSource(deviceOf(sourced, NEW_PROBE), sourced.now, () => ({}));
  for (const [field, value] of Object.entries(expected)) assert.equal(samples[0]!.values[field], value, field);

  // The default keeps the 90-day fictional history for a new device.
  const seeded = new Simulator({mode: 'public'});
  addProbe(seeded);
  assert.equal(seeded.readings.forDevice(NEW_PROBE).length, 90 * 48 + 1);
});

// Rain in local hours 10 and 11 of every date: each local hour occurs once in any 24-hour window (Africa/Kampala has no DST).
const gameHourlyRain = Array.from({length: 24}, (_, hour) => hour === 10 || hour === 11 ? 0.5 : 0);
const gameWeather: WeatherSource = () => ({et0: 4.56, rain: 1, maxTemp: 30.5, meanRhPct: 71, windSpeedMps: 2.7,
  et0Source: 'fao56_daily_game_weather', et0Tier: 'fao56_daily', hourlyRainMm: gameHourlyRain});

test('a weather source drives ET0, humidity, wind, labels and hourly forecast rain; without one the summary keeps its fixture values', () => {
  const calls: Array<{date: string; zoneId: number; now: number}> = [];
  const sim = new Simulator({mode: 'public', weatherSource: (date, zone, now) => { calls.push({date, zoneId: zone.id, now}); return gameWeather(date, zone, now); }});
  sim.advanceTo(sim.now + 2 * HOUR);
  calls.length = 0;
  const summary = summaryOf(sim);
  assert.ok(calls.length > 0 && calls.every(call => call.zoneId === 1 && call.now === sim.now));
  assert.equal(summary.online.current?.relativeHumidityPct, 71);
  assert.equal(summary.online.current?.windSpeedMps, 2.7);
  const past = summary.water.daily.filter(day => day.date < summary.water.todayDate!);
  assert.equal(past.length, 6);
  for (const day of past) {
    // 'fao56_daily' is not a WaterDay tier, so the summary emits null; the record below keeps the source's own tier.
    assert.equal(day.et0Mm, 4.56); assert.equal(day.et0Source, 'fao56_daily_game_weather'); assert.equal(day.et0Tier, null);
  }
  assert.equal(summary.water.next24hRainMm, 1);
  assert.deepEqual(summary.forecast.rainFocus?.daily.map(day => day.windSpeedMps), [2.7, 2.7, 2.7]);
  assert.deepEqual(summary.forecast.rainFocus?.daily.map(day => day.et0MmDay), [4.56, 4.56, 4.56]);
  const record = [...sim.state.environmentRecords.values()].find(row => row.date < summary.water.todayDate!)!;
  assert.equal(record.values.relative_humidity_pct, 71);
  assert.equal(record.values.et0_source, 'fao56_daily_game_weather');
  assert.equal(record.values.et0_tier, 'fao56_daily');
  // A tier that WaterDay declares passes through unchanged.
  const stationSim = new Simulator({mode: 'public', weatherSource: (date, zone, now) => ({...gameWeather(date, zone, now)!, et0Tier: 'station_fao56'})});
  stationSim.advanceTo(stationSim.now + 2 * HOUR);
  const stationSummary = summaryOf(stationSim);
  assert.ok(stationSummary.water.daily.filter(day => day.date < stationSummary.water.todayDate!).every(day => day.et0Tier === 'station_fao56'));

  const plain = new Simulator({mode: 'public'});
  plain.advanceTo(plain.now + 2 * HOUR);
  const fixture = summaryOf(plain);
  assert.equal(fixture.online.current?.relativeHumidityPct, 62);
  assert.equal(fixture.online.current?.windSpeedMps, 1.1);
  assert.deepEqual(fixture.forecast.rainFocus?.daily.map(day => day.windSpeedMps), [1.1, 1.1, 1.1]);
  for (const day of fixture.water.daily.filter(row => row.date < fixture.water.todayDate!)) {
    assert.equal(day.et0Source, 'open_meteo_hourly_sum'); assert.equal(day.et0Tier, 'provider_hourly_sum');
  }
  assert.ok((fixture.forecast.rainFocus?.hourly ?? []).every(row => row.rainMm === 0 || row.rainMm === 0.4));
  const fixtureRecord = [...plain.state.environmentRecords.values()].find(row => row.date < fixture.water.todayDate!)!;
  assert.equal(fixtureRecord.values.relative_humidity_pct, 62);
  assert.equal(fixtureRecord.values.et0_tier, 'provider_hourly_sum');

  // A source without data for today and the forecast dates makes them unavailable instead of failing the route.
  const pastOnly = new Simulator({mode: 'public', weatherSource: (date, zone, now) => date < publicToday ? gameWeather(date, zone, now) : null});
  const partial = summaryOf(pastOnly);
  assert.equal(partial.forecast.available, false);
  assert.equal(partial.online.current, null);
  assert.equal(partial.water.daily.find(day => day.date < publicToday)?.et0Mm, 4.56);
});

test('memoised and uncached local midnight agree on every day of 2027 across DST transitions', () => {
  for (const timezone of ['Africa/Kampala', 'Etc/GMT-3', 'Europe/Zurich']) {
    for (let at = Date.UTC(2027, 0, 1); at < Date.UTC(2028, 0, 1); at += DAY) {
      const date = new Date(at).toISOString().slice(0, 10);
      const uncached = uncachedLocalCalendarDayStart(date, timezone);
      assert.equal(localCalendarDayStart(date, timezone), uncached, `${timezone} ${date}`);
      assert.equal(localCalendarDayStart(date, timezone), uncached, `${timezone} ${date} (hit)`);
    }
  }
  // Spot values, including both Zurich transition days and dates already evicted from the 1,024-entry cache.
  const midnight = (date: string, timezone: string) => new Date(localCalendarDayStart(date, timezone)).toISOString();
  assert.equal(midnight('2027-01-01', 'Africa/Kampala'), '2026-12-31T21:00:00.000Z');
  assert.equal(midnight('2027-01-01', 'Etc/GMT-3'), '2026-12-31T21:00:00.000Z');
  assert.equal(midnight('2027-03-28', 'Europe/Zurich'), '2027-03-27T23:00:00.000Z');
  assert.equal(midnight('2027-03-29', 'Europe/Zurich'), '2027-03-28T22:00:00.000Z');
  assert.equal(midnight('2027-10-31', 'Europe/Zurich'), '2027-10-30T22:00:00.000Z');
  assert.equal(midnight('2027-11-01', 'Europe/Zurich'), '2027-10-31T23:00:00.000Z');
});

// Covers runs with reading and weather sources, uplink sampling and environment summaries. The plan and history
// helpers in plans.ts and histories.ts keep their own formatters; they are outside the hook scope.
test('Intl.DateTimeFormat constructions stay bounded over 30 simulated days with sources', () => {
  const original = Intl.DateTimeFormat;
  let constructions = 0;
  const counting = new Proxy(original, {
    construct(target, args) { constructions++; return Reflect.construct(target, args); },
    apply(target, thisArg, args) { constructions++; return Reflect.apply(target, thisArg, args); },
  });
  const counts: number[] = [];
  Object.defineProperty(Intl, 'DateTimeFormat', {value: counting, configurable: true, writable: true});
  try {
    const sim = new Simulator({mode: 'public', fictionalHistory: false, readingSource: soilSource, weatherSource: gameWeather});
    const start = sim.now;
    for (let day = 1; day <= 30; day++) {
      for (let hour = 1; hour <= 24; hour++) sim.advanceTo(start + (day - 1) * DAY + hour * HOUR);
      summaryOf(sim);
      if (day === 15 || day === 30) counts.push(constructions);
    }
  } finally {
    Object.defineProperty(Intl, 'DateTimeFormat', {value: original, configurable: true, writable: true});
  }
  assert.ok(counts[1]! <= 20, `constructions after 30 days: ${counts[1]}`);
  assert.ok(counts[1]! - counts[0]! <= 2, `constructions between day 15 and day 30: ${counts[1]! - counts[0]!}`);
});

const weatherWith = (et0: number, label: string): WeatherSource => () => ({et0, rain: 0, maxTemp: 25, et0Source: label});
test('two live simulators with different weather sources each see only their own ET0', () => {
  const a = new Simulator({mode: 'public', weatherSource: weatherWith(1.11, 'source_a')});
  const b = new Simulator({mode: 'public', weatherSource: weatherWith(2.22, 'source_b')});
  const check = (sim: Simulator, et0: number, label: string) => {
    const summary = summaryOf(sim);
    for (const day of summary.water.daily) assert.equal(day.et0Mm, et0, `${label} ${day.date}`);
    for (const day of summary.water.daily.filter(row => row.date < summary.water.todayDate!)) assert.equal(day.et0Source, label);
    assert.deepEqual(summary.forecast.rainFocus?.daily.map(day => day.et0MmDay), [et0, et0, et0]);
  };
  check(a, 1.11, 'source_a');
  check(b, 2.22, 'source_b');
  // Each entry point runs right after the other simulator was active, and crosses local days where it advances.
  a.advanceTo(a.now + 2 * DAY);
  check(a, 1.11, 'source_a');
  b.advance(DAY);
  check(b, 2.22, 'source_b');
  check(a, 1.11, 'source_a');
  b.advanceTo(b.now + 3 * DAY);
  check(b, 2.22, 'source_b');
  a.jumpToNextEvent();
  check(a, 1.11, 'source_a');
  check(b, 2.22, 'source_b');
  check(a, 1.11, 'source_a');
  b.reset();
  check(b, 2.22, 'source_b');
  check(a, 1.11, 'source_a');
  const plain = new Simulator({mode: 'public'});
  check(a, 1.11, 'source_a');
  assert.equal(summaryOf(plain).water.daily[0]!.et0Source, 'open_meteo_hourly_sum');
});

function flowDeltasToday(sim: Simulator, eui: string, at: number): number {
  const timezone = sim.state.settings.gatewayTimezone;
  const date = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(at));
  const from = localCalendarDayStart(date, timezone);
  return Number(sim.readings.forDevice(eui).filter(sample => sample.at >= from && sample.at <= at)
    .reduce((sum, sample) => sum + (typeof sample.values.flow_liters_delta === 'number' ? sample.values.flow_liters_delta : 0), 0).toFixed(2));
}
function assertFlowTotalMatchesLedger(sim: Simulator, label: string) {
  const data = latest(sim, FLOW_METER);
  assert.equal(data.flow_liters_today, flowDeltasToday(sim, FLOW_METER, Date.parse(String(data.sampled_at))), label);
}

test('flow_liters_today counts the current uplink delta from a source; without one it is the stored aggregate, as on the base', () => {
  const meterSource: ReadingSource = (device, _at, synthetic) => device.deveui === FLOW_METER ? {...synthetic(), flow_liters_delta: 5} : synthetic();
  const sim = new Simulator({mode: 'public', fictionalHistory: false, readingSource: meterSource});
  const start = sim.now;
  sim.advanceTo(start + 31 * 60_000);
  assert.equal(latest(sim, FLOW_METER).flow_liters_delta, 5);
  assert.equal(latest(sim, FLOW_METER).flow_liters_today, 5);
  sim.advanceTo(start + 61 * 60_000);
  assert.equal(latest(sim, FLOW_METER).flow_liters_today, 10);
  // A valve run across uplinks: an observed-flow sample at the uplink instant keeps its own litres, so the total stays the ledger's sum.
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 3600});
  for (let minute = 62; minute <= 240; minute += 7) {
    sim.advanceTo(start + minute * 60_000);
    assertFlowTotalMatchesLedger(sim, `source, minute ${minute}`);
  }
  assert.ok(sim.readings.forDevice(FLOW_METER).some(sample => sample.source === 'observed-flow'));
  assert.ok(Number(latest(sim, FLOW_METER).flow_liters_today) > 10);

  // The synthetic default reports zero litres per uplink, so the total is exactly the ledger's sum, as on the base.
  const plain = new Simulator({mode: 'public', fictionalHistory: false});
  plain.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 3600});
  for (let minute = 31; minute <= 181; minute += 15) {
    plain.advanceTo(start + minute * 60_000);
    assertFlowTotalMatchesLedger(plain, `default, minute ${minute}`);
  }
  assert.ok(plain.readings.forDevice(FLOW_METER).filter(sample => sample.source !== 'observed-flow')
    .every(sample => sample.values.flow_liters_delta === 0));

  // Without a source the total is exactly the aggregate stored before the uplink is appended: the uplink's own litres
  // are not added, as on the base. The default reports 0 L, so the synthetic values are stubbed here to carry 5 L.
  const stubbed = new Simulator({mode: 'public', fictionalHistory: false});
  const synthetic = stubbed.readings.sampleValues.bind(stubbed.readings);
  stubbed.readings.sampleValues = (device, at) => device.deveui === FLOW_METER ? {...synthetic(device, at), flow_liters_delta: 5} : synthetic(device, at);
  for (const minute of [61, 91, 121]) {
    stubbed.advanceTo(start + minute * 60_000);
    const data = latest(stubbed, FLOW_METER), at = Date.parse(String(data.sampled_at));
    assert.equal(stubbed.readings.forDevice(FLOW_METER).find(sample => sample.at === at)?.values.flow_liters_delta, 5);
    assert.ok(Number(data.flow_liters_today) > 0, `stubbed, minute ${minute}`);
    assert.equal(data.flow_liters_today, Number((flowDeltasToday(stubbed, FLOW_METER, at) - 5).toFixed(2)), `stubbed, minute ${minute}`);
  }
});

const zoneTimezone = (sim: Simulator, zoneId = 1) => sim.zones.find(row => row.id === zoneId)!.timezone ?? sim.state.settings.gatewayTimezone;
const localDate = (at: number, timezone: string) => new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(at));
/** The full 72-hour forecast for zone 1 with an explicit source in effect for this call only. */
function forecastWith(source: WeatherSource | null, sim: Simulator, now = sim.now, timezone = zoneTimezone(sim)) {
  const zone = sim.zones.find(row => row.id === 1)!;
  const previous = getWeatherSource();
  setWeatherSource(source);
  try { return buildForecast(zone, localDate(now, timezone), now, timezone, selectedWeatherProvider(zone))!; }
  finally { setWeatherSource(previous); }
}

test('after any Simulator call returns, environment helpers called directly see no weather source', () => {
  // The reference is taken before any simulator with a source exists, with the same zone and instant.
  const plain = new Simulator({mode: 'public'});
  const zone = structuredClone(plain.zones.find(row => row.id === 1)!), timezone = zoneTimezone(plain), at = plain.now;
  const direct = () => buildForecast(zone, localDate(at, timezone), at, timezone, selectedWeatherProvider(zone));
  const reference = direct();
  assert.ok(reference && reference.hourly.every(row => row.windSpeedMps === 1.1 && (row.rainMm === 0 || row.rainMm === 0.4)));
  const afterCall = (label: string) => {
    assert.equal(getWeatherSource(), null, label);
    assert.deepEqual(direct(), reference, label);
  };
  const sim = new Simulator({mode: 'public', weatherSource: gameWeather});
  afterCall('constructor');
  // Inside a call the simulator's own source is in effect.
  assert.equal(summaryOf(sim).online.current?.windSpeedMps, 2.7);
  afterCall('request');
  sim.requestResponse('GET', '/api/irrigation-zones/1/environment-summary');
  afterCall('requestResponse');
  sim.advanceTo(sim.now + DAY + HOUR);
  afterCall('advanceTo');
  sim.advance(HOUR);
  afterCall('advance');
  sim.jumpToNextEvent();
  afterCall('jumpToNextEvent');
  sim.resetEnvironmentRecords();
  afterCall('resetEnvironmentRecords');
  sim.reset();
  afterCall('reset');
  // A source that throws inside a call still leaves no source behind.
  const failing = new Simulator({mode: 'public', weatherSource: (date, row, now) => {
    if (date >= publicToday) throw new Error('weather source failed');
    return gameWeather(date, row, now);
  }});
  afterCall('constructor with a failing source');
  assert.throws(() => failing.request('GET', '/api/irrigation-zones/1/environment-summary'));
  afterCall('throwing source');
});

test('nested scope: a simulator called from another simulator\'s reading source restores the caller\'s weather source', () => {
  const b = new Simulator({mode: 'public', weatherSource: weatherWith(2.22, 'source_b')});
  let nestedCalls = 0;
  // A few nested calls are enough: the completed-day refresh runs at the end of A's call, after every one of them.
  const a = new Simulator({mode: 'public', weatherSource: weatherWith(1.11, 'source_a'), readingSource: (_device, _at, synthetic) => {
    if (nestedCalls < 3) {
      const nested = b.requestResponse('GET', '/api/irrigation-zones/1/environment-summary').data as Summary;
      assert.equal(nested.water.daily[0]!.et0Mm, 2.22);
      nestedCalls++;
    }
    return synthetic();
  }});
  const start = a.now;
  // Crossing local midnight makes A seed completed-day records at the end of the same call, after B returned.
  a.advanceTo(start + 2 * DAY);
  assert.ok(nestedCalls > 0);
  const startDate = localDate(start, zoneTimezone(a));
  const completed = [...a.state.environmentRecords.values()].filter(record => record.date >= startDate);
  assert.ok(completed.length >= 2);
  for (const record of completed) {
    assert.equal(record.values.et0_mm, 1.11, record.date);
    assert.equal(record.values.et0_source, 'source_a', record.date);
  }
  for (const day of summaryOf(a).water.daily) assert.equal(day.et0Mm, 1.11, day.date);
  assert.equal(summaryOf(b).water.daily[0]!.et0Mm, 2.22);
});

test('hourly source rain follows the local wall-clock hour across a DST change', () => {
  // 2027-03-28 is the spring-forward day in Europe/Zurich: 02:00 CET becomes 03:00 CEST.
  const rainDate = '2027-03-28';
  const dstSource: WeatherSource = date => ({et0: 3, rain: date === rainDate ? 1.5 : 0, maxTemp: 18,
    hourlyRainMm: Array.from({length: 24}, (_, hour) => date === rainDate && hour === 14 ? 1.5 : 0)});
  const sim = new Simulator({mode: 'public'});
  const now = Date.parse('2027-03-27T23:30:00Z'); // 00:30 CET on the transition day
  const forecast = forecastWith(dstSource, sim, now, 'Europe/Zurich');
  const wet = forecast.hourly.filter(row => (row.rainMm ?? 0) > 0);
  // The end-stamped row at 15:00 CEST (13:00 UTC) carries local hour 14; elapsed time since midnight would put it at 16:00.
  assert.deepEqual(wet.map(row => row.time), ['2027-03-28T13:00:00.000Z']);
  assert.equal(new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23'}).format(new Date(wet[0]!.time)), '15');
  assert.equal(wet[0]!.rainMm, 1.5);
  assert.deepEqual(forecast.daily.map(row => [row.date, row.rainMm]), [['2027-03-28', 1.5], ['2027-03-29', 0], ['2027-03-30', 0]]);
  assert.equal(getWeatherSource(), null);
});

test('with a source the 24-hour rain total is end-stamped and equals the edge sumRain', () => {
  // PUBLIC_EPOCH is 05:59:50 in Africa/Kampala (UTC+3, no DST); D is 2026-10-10.
  const D = '2026-10-10', D1 = '2026-10-11';
  const rainAt: Record<string, Record<number, number>> = {
    [D]: {5: 0.7 /* ends at 06:00 D, not after now */, 6: 0.5 /* the first hour after now */},
    [D1]: {5: 1.25 /* ends at 06:00 D+1, now + 24 h on the hour */, 6: 0.9 /* ends at 07:00 D+1, beyond the window */},
  };
  const windowSource: WeatherSource = date => {
    const hours = Array.from({length: 24}, (_, hour) => rainAt[date]?.[hour] ?? 0);
    return {et0: 4, rain: hours.reduce((sum, value) => sum + value, 0), maxTemp: 28, hourlyRainMm: hours};
  };
  const sim = new Simulator({mode: 'public', fictionalHistory: false, weatherSource: windowSource});
  for (const now of [Date.parse('2026-10-10T03:00:00Z'), Date.parse('2026-10-10T03:30:00Z')]) {
    sim.advanceTo(now);
    const label = new Date(now).toISOString();
    const forecast = forecastWith(windowSource, sim);
    const edge = nativeEnvironment.sumRain(forecast.hourly, now, 24, {source: 'open_meteo', basis: 'end'});
    assert.equal(edge.totalMm, 1.75, label);
    assert.equal(forecast.totalNext24hMm, edge.totalMm, label);
    assert.equal(summaryOf(sim).water.next24hRainMm, edge.totalMm, label);
    assert.equal(forecast.nextRainEta, '2026-10-10T04:00:00.000Z', label);
    assert.equal(forecast.rainHoursNext24h, 2, label);
    assert.equal(forecast.hourly.find(row => row.time === '2026-10-11T03:00:00.000Z')?.rainMm, 1.25, label);
    // The 72-hour total takes the end-stamped (now, now + 72 h] and equals the edge sumRain: 0.5 + 1.25 + 0.9 mm. The
    // hour ending at 03:00Z has no row (rows start at the first whole hour after now), so its 0.7 mm is not counted.
    const edge72 = nativeEnvironment.sumRain(forecast.hourly, now, 72, {source: 'open_meteo', basis: 'end'});
    assert.equal(edge72.totalMm, 2.65, label);
    assert.equal(forecast.totalNext72hMm, edge72.totalMm, label);
    // The summary's chart rows use the same end-stamped window, so they sum to the total on and between hours.
    const rainFocus = summaryOf(sim).forecast.rainFocus!, rows = rainFocus.hourly;
    const rowSum = Number(rows.reduce((sum, row) => sum + (row.rainMm ?? 0), 0).toFixed(2));
    assert.equal(rows.length, 24, label);
    assert.ok(rows.every(row => Date.parse(row.time) > now && Date.parse(row.time) <= now + DAY), label);
    assert.equal(rowSum, rainFocus.totalNext24hMm, label);
    assert.equal(rowSum, edge.totalMm, label);
    assert.equal(nativeEnvironment.sumRain(rows, now, 24, {source: 'open_meteo', basis: 'end'}).totalMm, edge.totalMm, label);
    // The hour ending at 06:00 D+1 is in the rows; on the hour it ends exactly at now + 24 h and is the last row.
    assert.equal(rows.find(row => row.time === '2026-10-11T03:00:00.000Z')?.rainMm, 1.25, label);
    if (now % HOUR === 0) assert.equal(rows[rows.length - 1]!.time, new Date(now + DAY).toISOString(), label);
  }
  // Without a source the illustrative window is unchanged: [now, now + 24 h) over the fixture pattern.
  const plain = new Simulator({mode: 'public'});
  plain.advanceTo(Date.parse('2026-10-10T03:00:00Z'));
  const fixture = forecastWith(null, plain), start = plain.now;
  const expected = fixture.hourly.filter(row => Date.parse(row.time) >= start && Date.parse(row.time) < start + DAY)
    .reduce((sum, row) => sum + (row.rainMm ?? 0), 0);
  assert.equal(fixture.totalNext24hMm, Number(expected.toFixed(2)));
});

test('measured zero: with a reading source a 0 L uplink gives flow_liters_today 0', () => {
  const NEW_METER = '00000000000000B4';
  const created = Date.parse('2026-10-10T03:00:00Z');                // 06:00 local, so an uplink lands on local midnight
  const midnight = Date.parse('2026-10-10T21:00:00Z');               // 00:00 local on 2026-10-11
  const litres = (at: number) => at === created || at >= midnight ? 0 : 5;
  const meterSource: ReadingSource = (device, at, synthetic) => device.deveui === NEW_METER
    ? {rain_mm_delta: 0, flow_liters_delta: litres(at), lsn50_mode_label: 'MOD9', bat_pct: 88} : synthetic();
  const sim = new Simulator({mode: 'public', fictionalHistory: false, readingSource: meterSource});
  sim.advanceTo(created);
  sim.request('POST', '/api/devices', {deveui: NEW_METER, name: 'Game meter', type_id: 'DRAGINO_LSN50', zone_id: 1});
  assert.equal(latest(sim, NEW_METER).flow_liters_today, 0);
  sim.advanceTo(midnight - 1_000);
  assert.ok(Number(latest(sim, NEW_METER).flow_liters_today) > 0, 'litres before midnight');
  sim.advanceTo(midnight);
  assert.equal(latest(sim, NEW_METER).sampled_at, new Date(midnight).toISOString());
  assert.equal(latest(sim, NEW_METER).flow_liters_today, 0);

  // An uplink without flow_liters_delta keeps the default behaviour: no daily flow total is derived.
  const noFlow = new Simulator({mode: 'public', fictionalHistory: false,
    readingSource: (device, _at, synthetic) => device.deveui === NEW_METER ? {rain_mm_delta: 0, bat_pct: 88} : synthetic()});
  noFlow.advanceTo(created);
  noFlow.request('POST', '/api/devices', {deveui: NEW_METER, name: 'Game meter', type_id: 'DRAGINO_LSN50', zone_id: 1});
  assert.equal(latest(noFlow, NEW_METER).flow_liters_today, undefined);
  assert.ok(!('flow_liters_today' in noFlow.readings.forDevice(NEW_METER)[0]!.values));

  // An observed-flow sample at the uplink instant still wins over the source's 0 L.
  const zero: ReadingSource = (device, _at, synthetic) => device.deveui === FLOW_METER ? {...synthetic(), flow_liters_delta: 0} : synthetic();
  const run = new Simulator({mode: 'public', fictionalHistory: false, readingSource: zero});
  const start = run.now;
  run.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 3600});
  run.advanceTo(start + 31 * 60_000);
  const sampledAt = Date.parse(String(latest(run, FLOW_METER).sampled_at));
  assert.ok(run.readings.forDevice(FLOW_METER).some(sample => sample.at === sampledAt && sample.source === 'observed-flow'));
  assert.ok(Number(latest(run, FLOW_METER).flow_liters_today) > 0);
  assertFlowTotalMatchesLedger(run, 'observed flow at the uplink instant');
});

test('resetEnvironmentRecords rebuilds the retained records after a zone reconfiguration', () => {
  const sim = new Simulator({mode: 'public', weatherSource: gameWeather});
  const oldKey = (key: unknown) => String(key ?? '').includes(':0.35:') || String(key ?? '').startsWith('open_meteo:');
  sim.request('PUT', '/api/irrigation-zones/1/config', {timezone: 'Etc/GMT-3', weatherSource: 'meteoswiss'});
  sim.request('PUT', '/api/irrigation-zones/1/location', {latitude: -2, longitude: 0});
  sim.request('DELETE', '/api/irrigation-zones/2');
  // Without the reset, records from the earlier configuration and from the deleted zone stay retained.
  assert.ok([...sim.state.environmentRecords.values()].some(record => oldKey(record.values.location_key)));
  sim.resetEnvironmentRecords();
  const records = [...sim.state.environmentRecords.entries()];
  assert.equal(records.length, 92);
  for (const [key, record] of records) {
    assert.ok(key.startsWith('1|'), key);
    assert.equal(record.provider, 'meteoswiss', key);
    assert.equal(record.values.source_provider, 'meteoswiss', key);
    assert.equal(record.values.location_key, 'meteoswiss:-2.00:0.00', key);
    assert.equal(record.timezone, 'Etc/GMT-3', key);
    assert.equal(record.values.et0_mm, 4.56, key);
  }
  // The refresh key is current: neither a summary nor an entry point at the same instant adds or rewrites a record.
  const before = JSON.stringify([...sim.state.environmentRecords.entries()]);
  summaryOf(sim);
  sim.advanceTo(sim.now);
  assert.equal(JSON.stringify([...sim.state.environmentRecords.entries()]), before);

  // Same key: records cleared with no zone change leave the refresh key current, so an entry point later on the same
  // local day does not rebuild them; resetEnvironmentRecords clears the key as well and rebuilds them at once.
  sim.advanceTo(sim.now + HOUR);
  assert.equal(sim.state.environmentRecords.size, 92);
  sim.state.environmentRecords.clear();
  sim.advanceTo(sim.now);
  assert.equal(sim.state.environmentRecords.size, 0, 'the unchanged refresh key skips the rebuild');
  sim.resetEnvironmentRecords();
  const rebuilt = [...sim.state.environmentRecords.entries()];
  assert.equal(rebuilt.length, 92, 'rebuilt before any GET');
  for (const [key, record] of rebuilt) {
    assert.ok(key.startsWith('1|'), key);
    assert.equal(record.values.location_key, 'meteoswiss:-2.00:0.00', key);
    assert.equal(record.values.et0_mm, 4.56, key);
  }
});

test('a reading source that throws on the creation uplink registers no device; a retry succeeds and samples on schedule', () => {
  const failure = new Error('creation uplink failed');
  let failures = 1;
  const flakySource: ReadingSource = (device, at, synthetic) => {
    if (device.deveui === NEW_PROBE && failures > 0) { failures--; throw failure; }
    return soilSource(device, at, synthetic);
  };
  const sim = new Simulator({mode: 'public', fictionalHistory: false, readingSource: flakySource});
  const created = sim.now, interval = 30 * 60_000;
  // request() rethrows anything that is not a DemoError: the source's own error reaches the caller, with no status code.
  assert.throws(() => addProbe(sim), (error: unknown) => error === failure);
  const listed = sim.request('GET', '/api/devices') as Array<{deveui: string}>;
  assert.ok(!listed.some(row => row.deveui === NEW_PROBE), 'the failed creation left a registered device');
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 0, 'the failed creation stored a sample');

  // The retry is not refused as a duplicate (409) and takes the creation uplink from the source.
  assert.doesNotThrow(() => addProbe(sim), 'the retry was refused');
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 1, 'creation uplink');
  assert.equal(latest(sim, NEW_PROBE).sampled_at, new Date(created).toISOString(), 'creation uplink');
  assert.equal(latest(sim, NEW_PROBE).swt_1, swt1At(created), 'creation uplink');

  // The next uplink was scheduled by the retry and runs one interval later.
  sim.advanceTo(created + interval);
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 2, 'scheduled uplink');
  assert.equal(latest(sim, NEW_PROBE).sampled_at, new Date(created + interval).toISOString(), 'scheduled uplink');
  assert.equal(latest(sim, NEW_PROBE).swt_1, swt1At(created + interval), 'scheduled uplink');
});

test('with the default fictional history a throwing creation uplink stores nothing; a later retry stores one history and the creation sample', () => {
  const failure = new Error('creation uplink failed');
  let failures = 1;
  const flakySource: ReadingSource = (device, at, synthetic) => {
    if (device.deveui === NEW_PROBE && failures > 0) { failures--; throw failure; }
    return soilSource(device, at, synthetic);
  };
  const sim = new Simulator({mode: 'public', readingSource: flakySource});
  const interval = 30 * 60_000;
  assert.throws(() => addProbe(sim), (error: unknown) => error === failure);
  const listed = sim.request('GET', '/api/devices') as Array<{deveui: string}>;
  assert.ok(!listed.some(row => row.deveui === NEW_PROBE), 'the failed creation left a registered device');
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 0, 'the failed creation stored history or a sample');

  const retried = sim.now + interval;
  sim.advanceTo(retried);
  assert.doesNotThrow(() => addProbe(sim), 'the retry was refused');
  // seedNewDevice stores one fictional sample every 30 minutes from retried - 90 d up to, not including, retried:
  // 90 x 48 = 4,320. The creation uplink from the source adds 1: 4,321. History left by the failed attempt would
  // start 30 minutes earlier and add one more sample (4,322).
  const samples = sim.readings.forDevice(NEW_PROBE);
  assert.equal(samples.length, 4321, 'history plus creation uplink');
  assert.equal(samples.filter(sample => sample.source === 'fictional-history').length, 90 * 48, 'history');
  assert.equal(samples[0]!.at, retried - 90 * DAY, 'history start');
  assert.equal(samples[samples.length - 1]!.at, retried, 'creation uplink');
  assert.equal(latest(sim, NEW_PROBE).sampled_at, new Date(retried).toISOString(), 'creation uplink');
  assert.equal(latest(sim, NEW_PROBE).swt_1, swt1At(retried), 'creation uplink');

  // The next uplink was scheduled by the retry and runs one interval later.
  sim.advanceTo(retried + interval);
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 4322, 'scheduled uplink');
  assert.equal(latest(sim, NEW_PROBE).sampled_at, new Date(retried + interval).toISOString(), 'scheduled uplink');
  assert.equal(latest(sim, NEW_PROBE).swt_1, swt1At(retried + interval), 'scheduled uplink');
});

test('a weather source with no data for a past date gives that day no hours, 0 % coverage and the no_source reason', () => {
  const missing = '2026-10-07', present = '2026-10-08'; // past local days of the public epoch's 2026-10-10
  const sim = new Simulator({mode: 'public', weatherSource: (date, zone, now) => date === missing ? null : gameWeather(date, zone, now)});
  const recordOn = (date: string) => [...sim.state.environmentRecords.entries()].find(([key, row]) => key.startsWith('1|') && row.date === date)![1];
  const record = recordOn(missing);
  assert.equal(record.values.et0_mm, null);
  assert.equal(record.values.hours_present, 0);
  assert.equal(record.values.coverage_pct, 0);
  assert.equal(record.values.null_reason, 'no_source');
  // A day the source covers is unchanged: every hour present, 100 %, no reason.
  assert.equal(recordOn(present).values.et0_mm, 4.56);
  assert.equal(recordOn(present).values.coverage_pct, 100);
  assert.equal(recordOn(present).values.null_reason, null);
  // The app reads the same values from the summary's water days.
  const day = summaryOf(sim).water.daily.find(row => row.date === missing) as unknown as Record<string, unknown>;
  assert.equal(day.et0Mm, null);
  assert.equal(day.hoursPresent, 0);
  assert.equal(day.coveragePct, 0);
  assert.equal(day.nullReason, 'no_source');
});

test('a reading source that throws on a scheduled uplink does not end the device\'s sampling', () => {
  const failure = new Error('scheduled uplink failed');
  const interval = 30 * 60_000;
  let created = 0, failures = 1;
  const flakySource: ReadingSource = (device, at, synthetic) => {
    if (device.deveui === NEW_PROBE && at === created + interval && failures > 0) { failures--; throw failure; }
    return soilSource(device, at, synthetic);
  };
  const sim = new Simulator({mode: 'public', fictionalHistory: false, readingSource: flakySource});
  created = sim.now;
  addProbe(sim);
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 1, 'creation uplink');
  // The failed uplink's error reaches the caller and stores nothing.
  assert.throws(() => sim.advanceTo(created + interval), (error: unknown) => error === failure);
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 1, 'the failed uplink stored a sample');
  // The next uplink was still queued and samples from the source again.
  sim.advanceTo(created + 2 * interval);
  assert.equal(sim.readings.forDevice(NEW_PROBE).length, 2, 'sampling ended after the failed uplink');
  assert.equal(latest(sim, NEW_PROBE).sampled_at, new Date(created + 2 * interval).toISOString());
  assert.equal(latest(sim, NEW_PROBE).swt_1, swt1At(created + 2 * interval));
});
