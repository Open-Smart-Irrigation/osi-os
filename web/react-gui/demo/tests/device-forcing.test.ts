import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  atmosphereAt,
  netIrrigationMm,
  quantizeLoRainTips,
  rainCounterAt,
  rainfallMmBetween,
  soilTensionAt,
  type SoilResponseChannel,
  type WaterInput,
} from '../model/forcing';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SEED_EPOCH = Date.parse('2026-10-10T02:59:50.000Z');

test('Kampala daylight is zero at night, peaks around local noon, and repeats by timestamp', () => {
  const at = (localDay: string, hour: number, minute = 0) =>
    Date.parse(`${localDay}T00:00:00.000Z`) + (hour - 3) * HOUR + minute * 60_000;
  const night = atmosphereAt(at('2026-10-10', 2));
  const sunrise = atmosphereAt(at('2026-10-10', 6));
  const noon = atmosphereAt(at('2026-10-10', 12, 30));
  const nextNoon = atmosphereAt(at('2026-10-11', 12, 30));

  assert.equal(night.lightLux, 0);
  assert.equal(night.uvIndex, 0);
  assert.equal(sunrise.lightLux, 0);
  assert.ok(noon.lightLux > 10_000);
  assert.ok(noon.daylightFraction > sunrise.daylightFraction);
  assert.equal(nextNoon.daylightFraction, noon.daylightFraction);
  assert.deepEqual(atmosphereAt(at('2026-10-10', 12, 30)), noon);

  const hourly = Array.from({length: 24}, (_, hour) => atmosphereAt(at('2026-10-10', hour)).airTemperatureC);
  const maxHour = hourly.indexOf(Math.max(...hourly));
  assert.ok(maxHour >= 14 && maxHour <= 16, `air temperature peaked at local ${maxHour}:00`);
});

test('weather fields remain in range and humidity agrees with temperature and dew point', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const weather = atmosphereAt(SEED_EPOCH + hour * HOUR);
    assert.ok(weather.cloudFraction >= 0 && weather.cloudFraction <= 1);
    assert.ok(weather.airTemperatureC >= 15 && weather.airTemperatureC <= 36);
    assert.ok(weather.dewPointC < weather.airTemperatureC);
    assert.ok(weather.relativeHumidityPct >= 0 && weather.relativeHumidityPct <= 100);
    assert.ok(weather.windSpeedMps >= 0);
    assert.ok(weather.windGustMps >= weather.windSpeedMps);
    assert.ok(weather.windDirectionDeg >= 0 && weather.windDirectionDeg < 360);
    assert.ok(weather.stationPressureHpa >= 800 && weather.stationPressureHpa <= 1100);

    const saturation = (temperature: number) => Math.exp((17.625 * temperature) / (243.04 + temperature));
    const expectedRh = 100 * saturation(weather.dewPointC) / saturation(weather.airTemperatureC);
    assert.ok(Math.abs(weather.relativeHumidityPct - expectedRh) < 0.2);
  }
});

test('a shared rain event raises cloud and humidity in the same site forcing', () => {
  const rainy = atmosphereAt(Date.parse('2026-10-11T23:00:00.000Z'));
  const dry = atmosphereAt(Date.parse('2026-10-12T23:00:00.000Z'));

  assert.ok(rainy.cloudFraction > dry.cloudFraction);
  assert.ok(rainy.relativeHumidityPct > dry.relativeHumidityPct);
  assert.equal(rainy.lightLux, 0);
});

test('day variation changes at Kampala midnight, not three hours early, before and after the rain origin', () => {
  const circularDifference = (first: number, second: number) => {
    const difference = Math.abs(first - second);
    return Math.min(difference, 360 - difference);
  };
  for (const date of ['2026-10-10', '2026-10-03']) {
    const beforeEarlyBoundary = atmosphereAt(Date.parse(`${date}T17:59:59.999Z`));
    const afterEarlyBoundary = atmosphereAt(Date.parse(`${date}T18:00:00.000Z`));
    const beforeKampalaMidnight = atmosphereAt(Date.parse(`${date}T20:59:59.999Z`));
    const afterKampalaMidnight = atmosphereAt(Date.parse(`${date}T21:00:00.000Z`));

    assert.ok(Math.abs(afterEarlyBoundary.cloudFraction - beforeEarlyBoundary.cloudFraction) < 0.001);
    assert.ok(circularDifference(afterEarlyBoundary.windDirectionDeg, beforeEarlyBoundary.windDirectionDeg) < 2);
    assert.ok(circularDifference(afterKampalaMidnight.windDirectionDeg, beforeKampalaMidnight.windDirectionDeg) >= 15);
    assert.ok(circularDifference(afterKampalaMidnight.windDirectionDeg, beforeKampalaMidnight.windDirectionDeg) <= 19);
  }
});

test('physical rain integrates exact interval overlap across pre-epoch local midnight', () => {
  // The fictional Oct 3 event runs 23:15–00:15 Kampala time: 4 mm in one hour.
  const start = Date.parse('2026-10-03T20:15:00.000Z');
  const midnight = Date.parse('2026-10-03T21:00:00.000Z');
  const end = Date.parse('2026-10-03T21:15:00.000Z');

  assert.equal(rainfallMmBetween(start, end), 4);
  assert.equal(rainfallMmBetween(start, midnight), 3);
  assert.equal(rainfallMmBetween(midnight, end), 1);
  assert.equal(rainfallMmBetween(start, end),
    rainfallMmBetween(start, start + 17 * 60_000) +
    rainfallMmBetween(start + 17 * 60_000, midnight) +
    rainfallMmBetween(midnight, end));
  assert.equal(rainfallMmBetween(end, start), 0);

  // Oct 12's separate 6 mm event lasts 90 minutes, so this half-hour holds 2 mm.
  assert.equal(rainfallMmBetween(Date.parse('2026-10-11T22:45:00.000Z'), Date.parse('2026-10-11T23:15:00.000Z')), 2);
});

test('a cumulative rain counter adds physical rain to its explicit nonnegative baseline', () => {
  const baselineAt = Date.parse('2026-10-03T20:15:00.000Z');
  assert.equal(rainCounterAt(baselineAt + HOUR, baselineAt, 12.4), 16.4);
  assert.equal(rainCounterAt(baselineAt - HOUR, baselineAt, 12.4), 12.4);
  assert.throws(() => rainCounterAt(baselineAt, baselineAt, -0.1), RangeError);
});

test('LoRain converts received rain to half-millimetre tips and carries residual between reports', () => {
  const first = quantizeLoRainTips(0.3);
  const second = quantizeLoRainTips(0.25, first.residualMm);
  const third = quantizeLoRainTips(0.45, second.residualMm);

  assert.deepEqual(first, {tips: 0, rainMm: 0, residualMm: 0.3});
  assert.deepEqual(second, {tips: 1, rainMm: 0.5, residualMm: 0.05});
  assert.deepEqual(third, {tips: 1, rainMm: 0.5, residualMm: 0});
  assert.equal(first.rainMm + second.rainMm + third.rainMm, 1);
  assert.equal(first.residualMm + 0.25 + 0.45, 1);
});

test('irrigation net depth follows litres per square metre and captured efficiency', () => {
  assert.equal(netIrrigationMm(6, 100, 0.85), 0.051);
  assert.equal(netIrrigationMm(6, 200, 0.85), 0.0255);
  assert.equal(netIrrigationMm(6, 100, 0.5), 0.03);
  assert.equal(netIrrigationMm(6, null, 0.85), null);
  assert.equal(netIrrigationMm(6, 100, null), null);
  assert.equal(netIrrigationMm(0, null, null), 0);
});

test('shallow water response starts after ten minutes, before the deep response', () => {
  const start = Date.parse('2026-10-10T00:00:00.000Z');
  const shallow: SoilResponseChannel = {
    zoneId: 'tomato', installationId: 'tomato-bed', depthClass: 'shallow', baselineAtMs: start, baselineKpa: 80,
  };
  const deep: SoilResponseChannel = {...shallow, depthClass: 'deep'};
  const input: WaterInput = {
    eventId: 'observed-open-1', zoneId: 'tomato', installationId: 'tomato-bed', atMs: start,
    rainMm: 0, deliveredLiters: 600, areaM2: 100, efficiency: 0.85,
  };
  const noWater = (channel: SoilResponseChannel, atMs: number) => soilTensionAt(channel, atMs, []);
  const withWater = (channel: SoilResponseChannel, atMs: number) => soilTensionAt(channel, atMs, [input]);

  assert.equal(withWater(shallow, start), 80);
  assert.equal(withWater(shallow, start + 9 * 60_000), noWater(shallow, start + 9 * 60_000));
  assert.ok(withWater(shallow, start + 15 * 60_000)! < noWater(shallow, start + 15 * 60_000)!);
  assert.equal(withWater(deep, start + HOUR), noWater(deep, start + HOUR));
  assert.ok(withWater(shallow, start + 2 * HOUR) < noWater(shallow, start + 2 * HOUR));
  assert.ok(withWater(deep, start + 5 * HOUR) < noWater(deep, start + 5 * HOUR));
});

test('water-induced shallow deficit recovers after its peak and exceeds the deep response', () => {
  const start = Date.parse('2026-10-10T00:00:00.000Z');
  const shallow: SoilResponseChannel = {
    zoneId: 'tomato', installationId: 'tomato-bed', depthClass: 'shallow', baselineAtMs: start, baselineKpa: 80,
  };
  const deep: SoilResponseChannel = {...shallow, depthClass: 'deep'};
  const input: WaterInput = {
    eventId: 'observed-open-large-dose', zoneId: 'tomato', installationId: 'tomato-bed', atMs: start,
    rainMm: 0, deliveredLiters: 600, areaM2: 100, efficiency: 0.85,
  };
  const deficit = (channel: SoilResponseChannel, atMs: number) =>
    soilTensionAt(channel, atMs, [])! - soilTensionAt(channel, atMs, [input])!;
  const assertUnclamped = (channel: SoilResponseChannel, atMs: number) => {
    for (const tension of [soilTensionAt(channel, atMs, []), soilTensionAt(channel, atMs, [input])]) {
      assert.ok(tension! > 0 && tension! < 239);
    }
  };
  const postPeak = start + 8 * HOUR;
  const recovered = start + 5 * DAY;

  const shallowPostPeakDeficit = deficit(shallow, postPeak);
  const shallowRecoveredDeficit = deficit(shallow, recovered);
  assert.ok(shallowPostPeakDeficit > 0);
  assert.ok(shallowRecoveredDeficit > 0);
  assert.ok(shallowRecoveredDeficit < shallowPostPeakDeficit);
  assert.ok(deficit(deep, postPeak) > 0);
  assert.ok(deficit(deep, postPeak) < shallowPostPeakDeficit);

  assertUnclamped(shallow, postPeak);
  assertUnclamped(shallow, recovered);
  assertUnclamped(deep, postPeak);
});

test('water response is isolated by both zone and fixed installation identity', () => {
  const start = Date.parse('2026-10-10T00:00:00.000Z');
  const channel: SoilResponseChannel = {
    zoneId: 'tomato', installationId: 'tomato-bed', depthClass: 'shallow', baselineAtMs: start, baselineKpa: 70,
  };
  const unrelated: WaterInput = {
    eventId: 'other-bed-open', zoneId: 'bed', installationId: 'bed-installation', atMs: start,
    rainMm: 30, deliveredLiters: 1000, areaM2: 100, efficiency: 1,
  };
  const sameZoneOtherInstall: WaterInput = {...unrelated, zoneId: 'tomato'};
  const at = start + DAY;

  assert.equal(soilTensionAt(channel, at, [unrelated]), soilTensionAt(channel, at, []));
  assert.equal(soilTensionAt(channel, at, [sameZoneOtherInstall]), soilTensionAt(channel, at, []));
});

test('a timestamped input event is applied once when active/completed views overlap', () => {
  const start = Date.parse('2026-10-10T00:00:00.000Z');
  const channel: SoilResponseChannel = {
    zoneId: 'tomato', installationId: 'tomato-bed', depthClass: 'shallow', baselineAtMs: start, baselineKpa: 70,
  };
  const input: WaterInput = {
    eventId: 'same-observed-open', zoneId: 'tomato', installationId: 'tomato-bed', atMs: start,
    rainMm: 0, deliveredLiters: 600, areaM2: 100, efficiency: 0.85,
  };

  assert.equal(soilTensionAt(channel, start + 2 * HOUR, [input, input]),
    soilTensionAt(channel, start + 2 * HOUR, [input]));
});

test('unknown geometry leaves delivered-water response unavailable while preserving liters', () => {
  const start = Date.parse('2026-10-10T00:00:00.000Z');
  const channel: SoilResponseChannel = {
    zoneId: 'tomato', installationId: 'tomato-bed', depthClass: 'shallow', baselineAtMs: start, baselineKpa: 50,
  };
  const input: WaterInput = {
    eventId: 'observed-open-unknown-area', zoneId: 'tomato', installationId: 'tomato-bed', atMs: start,
    rainMm: 0, deliveredLiters: 6, areaM2: null, efficiency: 0.85,
  };

  assert.equal(input.deliveredLiters, 6);
  assert.equal(soilTensionAt(channel, start + DAY, [input]), null);
});

test('the pinned seed channels remain exact at their shared epoch', () => {
  const channel = (zoneId: string, installationId: string, baselineKpa: number): SoilResponseChannel => ({
    zoneId, installationId, depthClass: 'shallow', baselineAtMs: SEED_EPOCH, baselineKpa,
  });
  assert.equal(soilTensionAt(channel('tomato', 'tomato-bed', 45), SEED_EPOCH, []), 45);
  assert.equal(soilTensionAt(channel('tomato', 'tomato-bed', 50), SEED_EPOCH, []), 50);
  assert.equal(soilTensionAt(channel('tomato', 'tomato-bed', 55), SEED_EPOCH, []), 55);
  assert.equal(soilTensionAt(channel('bed', 'bed-installation', 10), SEED_EPOCH, []), 10);
  assert.equal(soilTensionAt(channel('bed', 'bed-installation', 12), SEED_EPOCH, []), 12);
  assert.equal(soilTensionAt(channel('bed', 'bed-installation', 14), SEED_EPOCH, []), 14);
});

test('same timestamped water timeline gives the same endpoint across clock partitions', () => {
  const start = Date.parse('2026-10-10T00:00:00.000Z');
  const endpoint = start + 3 * DAY;
  const channel: SoilResponseChannel = {
    zoneId: 'tomato', installationId: 'tomato-bed', depthClass: 'deep', baselineAtMs: start, baselineKpa: 65,
  };
  const inputs: WaterInput[] = [
    {eventId: 'rain-1', zoneId: 'tomato', installationId: 'tomato-bed', atMs: start + 2 * HOUR,
      rainMm: 8, deliveredLiters: 0, areaM2: null, efficiency: null},
    {eventId: 'irrigation-1', zoneId: 'tomato', installationId: 'tomato-bed', atMs: start + DAY,
      rainMm: 0, deliveredLiters: 120, areaM2: 100, efficiency: 0.85},
  ];
  const largeAdvance = soilTensionAt(channel, endpoint, inputs);
  const partitions = [start + HOUR, start + 2 * HOUR, start + DAY, start + 2 * DAY, endpoint];
  const partitionedEndpoint = partitions.reduce((_, atMs) => soilTensionAt(channel, atMs, inputs), null as number | null);

  assert.equal(partitionedEndpoint, largeAdvance);
});
