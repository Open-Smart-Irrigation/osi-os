import assert from 'node:assert/strict';
import test from 'node:test';
import {SCENARIOS, TUTORIAL_SCENARIO, defaultHeader, verdictTapMinutes} from '../../src/core/scenario';
import {DAY_MS, HOUR_MS, SLICE_END, SLICE_START, localDate, localDateStart, localDayStart, localHour} from '../../src/core/time';
import {hundredths} from '../../src/core/units';
import {Weather, rainBetween, rainInDay} from '../../src/core/weather';

test('2,000 January runs match table A rain, wet days and mean Tmax', () => {
  const january = localDateStart('2027-01-01');
  let rain = 0;
  let wet = 0;
  let tMax = 0;
  for (let seed = 1; seed <= 2_000; seed++) {
    const weather = new Weather(seed, january - 31 * DAY_MS);
    for (let index = 0; index < 31; index++) {
      const day = weather.actual(january + index * DAY_MS);
      rain += day.rainMm;
      wet += Number(day.wet);
      tMax += day.tMaxC;
      const hourlySum = day.hourlyRainMm.reduce((sum, value) => sum + hundredths(value), 0);
      assert.equal(hourlySum, hundredths(day.rainMm));
      if (day.burst) {
        assert.ok(localHour(day.burst.startsAt) >= 1 && localHour(day.burst.startsAt) <= 19);
        assert.ok(localHour(day.burst.endsAt) <= 22);
        assert.ok(rainInDay(day, day.burst.startsAt, day.burst.endsAt) > 0);
      }
    }
  }
  assert.ok(Math.abs(rain / 2_000 - 40) < 2, 'mean January rainfall: ' + rain / 2_000);
  assert.ok(Math.abs(wet / 2_000 - 5) < .25, 'mean wet days: ' + wet / 2_000);
  assert.ok(Math.abs(tMax / 62_000 - (29.3 - 2 * 5 / 31)) < .1, 'mean Tmax: ' + tMax / 62_000);
});

test('forecast flip frequency grows with lead and false-positive days carry rain', () => {
  const date = '2027-01-11';
  const target = localDateStart(date);
  const flips = [0, 0, 0, 0];
  let falsePositives = 0;
  for (let seed = 1; seed <= 2_000; seed++) {
    const weather = new Weather(seed, target - 3 * DAY_MS);
    const actual = weather.actual(target);
    for (const [lead] of flips.entries()) {
      const forecast = weather.asOf(date, target - lead * DAY_MS);
      assert.ok(forecast);
      flips[lead] += Number(forecast.wet !== actual.wet);
      if (forecast.wet && !actual.wet) {
        falsePositives++;
        assert.ok(forecast.rainMm > 0);
        assert.ok(forecast.burst && localHour(forecast.burst.endsAt) <= 22);
      }
    }
  }
  assert.ok(falsePositives > 100);
  for (const [lead, count] of flips.entries()) {
    assert.ok(Math.abs(count / 2_000 - (.1 + .1 * lead)) < .03, 'flip count: ' + count);
    if (lead) assert.ok(count > flips[lead - 1]);
  }
});

test('as-of weather is keyed by dates and serves the actual record after midnight', () => {
  const at = SLICE_START;
  const date = localDate(at);
  const past = localDate(at - DAY_MS);
  const first = new Weather(4);
  const second = new Weather(4);
  const forecast = first.asOf(date, at - DAY_MS);
  first.asOf(date, at);
  first.actual(at + 50 * DAY_MS);
  assert.deepEqual(second.asOf(date, at - DAY_MS), forecast);
  assert.equal(first.asOf(date, at - DAY_MS + HOUR_MS), forecast);
  assert.equal(first.asOf(past, at), first.actual(at - DAY_MS));
  assert.equal(first.asOf('2026-10-10', at), null);
  assert.equal(first.asOf(localDate(at + 4 * DAY_MS), at), null);
});

test('frozen scenarios cover the tutorial, a seven-day dry streak and a storm without pre-registration rain', () => {
  const traits = new Map<string, {longest: number; maxRain: number}>();
  for (const scenario of SCENARIOS) {
    assert.equal(scenario.start, SLICE_START);
    assert.ok(Object.isFrozen(scenario.initial.bedA.depletion));
    assert.deepEqual(scenario.tiers, [0, 1, 2, 3, 4]);
    assert.equal(scenario.reference.tiers.length, 5);
    const weather = new Weather(scenario.seed);
    assert.equal(rainBetween(weather, localDayStart(SLICE_START), SLICE_START), 0);
    let dry = 0;
    let longest = 0;
    let maxRain = 0;
    for (let day = localDayStart(SLICE_START); day < localDayStart(SLICE_END); day += DAY_MS) {
      const record = weather.actual(day);
      dry = record.wet ? 0 : dry + 1;
      longest = Math.max(longest, dry);
      maxRain = Math.max(maxRain, record.rainMm);
    }
    traits.set(scenario.id, {longest, maxRain});
  }
  assert.ok(traits.get('dry-spell')!.longest >= 7);
  assert.ok(traits.get('storm')!.maxRain >= 15);
  assert.equal(TUTORIAL_SCENARIO.tutorial, true);
  assert.equal(defaultHeader('unit').scenario, 'baseline');
  const t2 = TUTORIAL_SCENARIO.reference.tiers.find(policy => policy.kind === 'verdict-tap')!;
  assert.equal(verdictTapMinutes(t2, 'irrigate_today', -3), 27);
  assert.equal(verdictTapMinutes(t2, 'irrigate_today', -20), 90);
  assert.equal(verdictTapMinutes(t2, 'delay_irrigation', -3), 0);
});
