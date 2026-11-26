import assert from 'node:assert/strict';
import test from 'node:test';
import {parseOpenMeteoForecast, resolveWaterAction, round as edgeRound, sumRain, toEffectiveIrrigationMm} from '@osi-edge/osi-zone-env/index.js';
import type {FarmOsiAdapter} from '../../src/core/osi/adapter';
import {METER_EUI} from '../../src/core/osi/farm-builder';
import {BED_A_AREA_M2} from '../../src/core/map';
import {HOUR_MS, MINUTE_MS, localDate, localDayStart} from '../../src/core/time';
import {round2} from '../../src/core/units';
import {WATER} from '../../src/core/water';
import type {WeatherDay} from '../../src/core/weather';
import {atHour, buildAdapter, edgeTomatoKc, environment, fao56, fixtureWeather, iso, manualTap, meter, START} from './osi-fixture';

function hours(entries: readonly (readonly [number, number])[]): number[] {
  const rain = Array<number>(24).fill(0);
  for (const [hour, mm] of entries) rain[hour] = mm;
  return rain;
}

const storm = (day: WeatherDay) => hours(day.date === '2027-01-13' ? [[14, 2], [15, 2], [16, 2]] : []);
function edgeForecast(adapter: FarmOsiAdapter) {
  const now = adapter.now;
  const first = Math.floor(now / HOUR_MS) * HOUR_MS;
  const endStamps = Array.from({length: 26}, (_, i) => first + i * HOUR_MS);
  const amounts = endStamps.map(end => {
    const starts = end - HOUR_MS;
    const weather = adapter.world.weather.asOf(localDate(starts), now);
    assert.ok(weather);
    return weather.hourlyRainMm[(starts - localDayStart(starts)) / HOUR_MS];
  });
  const parsed = parseOpenMeteoForecast({hourly: {time: endStamps.map(iso), precipitation: amounts}}, {observedAtMs: now});
  assert.ok(parsed);
  return sumRain(parsed.hours, now, 24, {source: parsed.source, basis: 'end'}).totalMm;
}

function checkParity(adapter: FarmOsiAdapter, tier: 1 | 2) {
  const now = adapter.now;
  const date = localDate(now);
  const midnight = localDayStart(now);
  const world = adapter.world;
  const available = tier === 2;
  const wx = world.weather.asOf(date, now);
  assert.ok(wx);
  const et0 = fao56(wx);
  const kc = edgeTomatoKc(date);
  const demand = available ? edgeRound(et0 * kc, 2) : null;
  const net = toEffectiveIrrigationMm(world.manualTapLitersBetween(midnight, now), BED_A_AREA_M2,
    WATER.dripEfficiency * 100);
  assert.notEqual(net, null);
  const from = Math.max(START, midnight);
  const rainKnown = available && now >= from;
  const latestGaugeAt = from + Math.floor((now - from) / (30 * MINUTE_MS)) * (30 * MINUTE_MS);
  const rain = world.rainMmBetween(from, latestGaugeAt);
  const balance = demand === null ? null : edgeRound(rain + net! - demand, 2);
  const forecast = available ? edgeForecast(adapter) : null;
  const edge = resolveWaterAction(date, null, balance, forecast, demand, rainKnown, net);
  const summary = environment(adapter);
  const {code, source, reasonCode} = summary.water.action;
  assert.deepEqual({code, source, reasonCode}, {code: edge.code, source: edge.source, reasonCode: edge.reasonCode});
  if (available) {
    // The edge and simulator round decimal halves differently. Compare their verdicts above
    // using each system's own demand and balance.
    assert.equal(summary.water.waterNeededTodayMm, Number((et0 * kc).toFixed(2)));
    assert.equal(summary.water.next24hRainMm, forecast);
    assert.equal(summary.water.daily.find(day => day.date === date)?.rainMm, rain);
  }
  return {code, reasonCode, forecast};
}

test('T1 and edge both have unknown demand without a weather service', () => {
  const {adapter} = buildAdapter(1, {weather: fixtureWeather()});
  adapter.advance(atHour(2, 12.5));
  assert.equal(checkParity(adapter, 1).reasonCode, 'demand_unknown');
});

for (const {name, time, tap, expected, rain} of [
  {name: 'dry day at 12:30', time: atHour(2, 12.5), tap: false, expected: 'irrigate_today', rain: 0},
  {name: 'after a 400 L manual tap run', time: atHour(2, 12.5), tap: true, expected: 'delay_irrigation', rain: 0},
  {name: 'storm inside 24 hours', time: atHour(2, 20.5), tap: false, expected: 'delay_irrigation', rain: 6},
  {name: 'first minutes after local midnight', time: atHour(3, 0) + 10 * MINUTE_MS, tap: false, expected: 'irrigate_today', rain: 6},
]) {
  test('edge verdict on world inputs for ' + name, () => {
    const {adapter} = buildAdapter(2, {tank: 600, weather: fixtureWeather({forecastRain: storm})});
    if (tap) {
      assert.equal(manualTap(adapter, atHour(2, 7), 50), 400);
      adapter.advance(atHour(2, 8));
      assert.equal(meter(adapter).flow_liters_today, 400);
      assert.equal(meter(adapter).flow_liters_per_10min, 53.33);
    }
    adapter.advance(time);
    const result = checkParity(adapter, 2);
    assert.equal(result.forecast, rain);
    assert.equal(result.code, expected);
    assert.equal(environment(adapter).water.daily.find(day => day.date === localDate(adapter.now))?.irrigationLiters, tap ? 400 : 0);
  });
}

test('measured rain reaches the edge-equivalent verdict through gauge uplinks', () => {
  const {adapter} = buildAdapter(2, {weather: fixtureWeather({
    actualRain: day => hours(day.date === '2027-01-12' ? [[7, 3], [8, 3]] : []),
  })});
  adapter.advance(atHour(2, 12.5));
  assert.equal(checkParity(adapter, 2).code, 'delay_irrigation');
  const samples = adapter.simulatorSnapshot().readings.find(([eui]) => eui === METER_EUI)?.[1] ?? [];
  assert.equal(samples.find(sample => sample.at === atHour(2, 0))?.values.rain_mm_today, 0);
  assert.deepEqual(samples.filter(sample => Number(sample.values.rain_mm_delta) > 0)
    .map(sample => sample.values.rain_mm_delta), [1.5, 1.5, 1.5, 1.5]);
  assert.equal(meter(adapter).rain_mm_today, 6);
});

test('lead-zero rain forecast and measured rain are independent inputs', () => {
  const {adapter} = buildAdapter(2, {weather: fixtureWeather({
    forecastRain: day => hours(day.date === '2027-01-12' ? [[15, 10]] : []),
  })});
  adapter.advance(atHour(2, 12.5));
  assert.equal(checkParity(adapter, 2).code, 'delay_irrigation');
  assert.equal(meter(adapter).rain_mm_today, 0);
});

for (const minute of [0, 30]) {
  test('end-stamped forecast window at 07:' + String(minute).padStart(2, '0'), () => {
    const {adapter} = buildAdapter(2, {weather: fixtureWeather({
      forecastRain: day => hours(day.date === '2027-01-12' ? [[7, 1.5], [6, .7]]
        : day.date === '2027-01-13' ? [[6, 2.5], [7, .9]] : []),
    })});
    adapter.advance(atHour(2, 7) + minute * MINUTE_MS);
    assert.equal(checkParity(adapter, 2).forecast, 4);
    const summary = environment(adapter);
    assert.equal(round2(summary.forecast.rainFocus.hourly.reduce((total, row) => total + row.rainMm, 0)), 4);
  });
}
