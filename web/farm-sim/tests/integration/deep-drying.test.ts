import assert from 'node:assert/strict';
import test from 'node:test';
import {LABOUR} from '../../src/core/labour';
import {BED_A_AREA_M2, BED_A_TOP_LEFT, FARM_SITES, START_TILE} from '../../src/core/map';
import {VALVE_PATH, ZONE_PATH} from '../../src/core/osi/farm-builder';
import {createRun} from '../../src/core/replay';
import {defaultHeader, scenarioById} from '../../src/core/scenario';
import {DAY_MS, HOUR_MS, MINUTE_MS, localDayStart} from '../../src/core/time';
import {Tutorial} from '../../src/core/tutorial';
import {World} from '../../src/core/world';
import {tutorialHint} from '../../src/ui/hints';
import {buildAdapter, write} from './osi-fixture';
import {advanceUntil, house, queueWalk} from './run-replay-session';

const bedATiles = Array.from({length: BED_A_AREA_M2}, (_, i) => ({
  x: BED_A_TOP_LEFT.x + i % 8, y: BED_A_TOP_LEFT.y + Math.floor(i / 8),
}));

/**
 * The T4 reference run (morning supply step, the preset trigger, picking at 17:00) through day 10, with the
 * game's sensor noise and a T4 tutorial observing after every uplink. `minutes` replaces the preset duration.
 * `manualMinutes` turns the trigger off and opens the valve from the phone for that long at 07:30 each day.
 */
function deepDryingBeat(scenarioId: string, minutes?: number, manualMinutes?: number) {
  const scenario = scenarioById(scenarioId);
  const {adapter, header} = buildAdapter(4, {scenario, sensorNoise: true});
  const preset = scenario.reference.tiers.find(policy => policy.kind === 'swt-trigger');
  assert.ok(preset);
  if (minutes !== undefined || manualMinutes !== undefined) {
    write(adapter, 'PUT', ZONE_PATH + '/schedule', {trigger_metric: preset.sensor, threshold_kpa: preset.kPa,
      duration_minutes: minutes ?? preset.minutes, enabled: manualMinutes === undefined});
  }
  const tutorial = new Tutorial(header.start, true, 4);
  const advance = (to: number) => {
    while (adapter.now < to) {
      adapter.advance(Math.min(to, adapter.now + 30 * MINUTE_MS));
      tutorial.observe(adapter);
    }
  };
  const world = adapter.world;
  const {supply} = scenario.reference;
  const [hour, minute] = supply.at.split(':').map(Number);
  const dayOne = localDayStart(scenario.start);
  for (let day = 1; day <= 10; day++) {
    const midnight = dayOne + (day - 1) * DAY_MS;
    advance(midnight + hour * HOUR_MS + minute * MINUTE_MS);
    while (world.tankLitersAt(adapter.now) < supply.pumpToLiters) {
      const end = world.pump(adapter.now);
      if (end === null) break;
      advance(end);
    }
    while (world.tankLitersAt(adapter.now) < supply.carryToLiters
      && world.snapshot().player.energy >= supply.carryMinEnergy) {
      const end = world.carryFromSharedWell(adapter.now);
      if (end === null) break;
      advance(end);
    }
    if (manualMinutes !== undefined) {
      advance(Math.max(adapter.now, midnight + 7.5 * HOUR_MS));
      write(adapter, 'POST', VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: manualMinutes * 60});
    }
    advance(midnight + 17 * HOUR_MS);
    for (const tile of bedATiles) world.harvest(adapter.now, tile);
    adapter.drainNow();
    tutorial.observe(adapter);
  }
  advance(dayOne + 10 * DAY_MS);
  return tutorial.state().deepDrying;
}

const sevenAm = (day: number) => localDayStart(scenarioById('baseline').start) + (day - 1) * DAY_MS + 7 * HOUR_MS;

test('under the T4 preset (25 kPa) the deep-drying beat fires on day 9 in baseline and dry-spell and on day 8 in storm', () => {
  assert.deepEqual(deepDryingBeat('baseline'), {day: 9, sampledAt: sevenAm(9), thresholdKpa: 25, shallowKpa: 24.76,
    deepBeforeKpa: 54.6, deepKpa: 66.09, riseKpa: 11.49});
  assert.deepEqual(deepDryingBeat('dry-spell'), {day: 9, sampledAt: sevenAm(9), thresholdKpa: 25, shallowKpa: 22.59,
    deepBeforeKpa: 48.2, deepKpa: 59.34, riseKpa: 11.14});
  assert.deepEqual(deepDryingBeat('storm'), {day: 8, sampledAt: sevenAm(8), thresholdKpa: 25, shallowKpa: 24.11,
    deepBeforeKpa: 81.59, deepKpa: 106.34, riseKpa: 24.75});
});

test('with 90-minute runs the 40 cm reading in baseline and dry-spell stays moist and the beat stays silent', () => {
  assert.equal(deepDryingBeat('baseline', 90), null);
  assert.equal(deepDryingBeat('dry-spell', 90), null);
  // Storm's 40 cm reading still climbs from 73 to 101 kPa by day 9 under 90-minute runs.
  assert.equal(deepDryingBeat('storm', 90)?.day, 9);
});

test('with the trigger off and 15-minute phone opens the beat stays silent in every scenario', () => {
  assert.equal(deepDryingBeat('baseline', undefined, 15), null);
  assert.equal(deepDryingBeat('dry-spell', undefined, 15), null);
  assert.equal(deepDryingBeat('storm', undefined, 15), null);
});

test('the deep-drying hint is a concept hint: unprompted decisions in a run never skip it', () => {
  const scenario = scenarioById('baseline');
  const header = defaultHeader('deep-drying', scenario, 4);
  const run = createRun(header);
  const dayOne = localDayStart(header.start);
  advanceUntil(run, dayOne + 18 * HOUR_MS);
  queueWalk(run, START_TILE, house);
  run.apply({kind: 'sleep'});
  run.step(0);
  queueWalk(run, house, {x: FARM_SITES.pump.x, y: FARM_SITES.pump.y - 1});
  for (let stroke = 0; stroke < 3; stroke++) {
    run.apply({kind: 'interact', tile: FARM_SITES.pump});
    run.step(0);
    assert.equal(run.feedback().notice, 'Pumping water into the tank.');
    advanceUntil(run, run.now + LABOUR.pumpMs);
  }
  assert.equal(run.viewModel().sky.day, 2);
  const {tutorial} = run.feedback();
  assert.ok(tutorial.practiced.includes('pump'));

  const at = dayOne + 8 * DAY_MS + 8 * HOUR_MS;
  const world = new World(header, scenario);
  world.stepTo(at);
  const dayNine = world.viewModel(at);
  const deepDrying = {day: 9, sampledAt: sevenAm(9), thresholdKpa: 25, shallowKpa: 24.76, deepBeforeKpa: 54.6,
    deepKpa: 66.09, riseKpa: 11.49};
  const feedback = {...run.feedback(), tutorial: {...tutorial, deepDrying}};
  assert.match(tutorialHint(dayNine, feedback, undefined) ?? '', /^The 40 cm reading went from 55 to 66 kPa/);
});
