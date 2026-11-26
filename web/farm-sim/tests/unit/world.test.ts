import assert from 'node:assert/strict';
import test from 'node:test';
import {BED_A_TOP_LEFT, BED_B_TOP_LEFT, DRIP_TILES, farmMap} from '../../src/core/map';
import {defaultHeader, scenarioById, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS, HOUR_MS, localDayStart, MINUTE_MS, nextLocalMidnight, sleepUntil, SOIL_STEP_MS} from '../../src/core/time';
import type {Scenario} from '../../src/core/types';
import {World} from '../../src/core/world';

const scenario = TUTORIAL_SCENARIO;
const start = scenario.start;
const newWorld = (tankLiters = scenario.initial.tankLiters) => new World(defaultHeader('unit'),
  {...scenario, initial: {...scenario.initial, tankLiters}});

test('off-grid calls and read-only views leave the stored canonical grid invariant', () => {
  const coarse = newWorld(600);
  const fine = newWorld(600);
  const openAt = start + SOIL_STEP_MS + 725;
  const closeAt = openAt + 45 * MINUTE_MS;
  const stop = start + 2 * HOUR_MS;
  for (const world of [coarse, fine]) world.setManualTap(openAt, true);
  for (let at = openAt + 75_111; at < closeAt; at += 75_111) {
    fine.stepTo(at);
    const before = fine.snapshot();
    fine.columnAt(BED_A_TOP_LEFT, at);
    fine.viewModel(at);
    assert.deepEqual(fine.snapshot(), before);
  }
  for (const world of [coarse, fine]) {
    world.setManualTap(closeAt, false);
    world.stepTo(stop);
  }
  assert.deepEqual(coarse.snapshot(), fine.snapshot());
  assert.equal(fine.manualTapLitersBetween(start, stop), 360);
  assert.equal(fine.settledTankLiters(), 240);
});

test('stepTo is idempotent and monotonic with no simulated devices', () => {
  const world = newWorld();
  world.stepTo(start + 321);
  assert.equal(world.committedAt, start);
  world.stepTo(start + SOIL_STEP_MS + 321);
  const snapshot = world.snapshot();
  assert.equal(world.committedAt, start + SOIL_STEP_MS);
  world.stepTo(start + SOIL_STEP_MS + 444);
  world.stepTo(start + SOIL_STEP_MS);
  world.stepTo(start);
  assert.deepEqual(world.snapshot(), snapshot);
  assert.ok(world.viewModel(start + SOIL_STEP_MS + 444).plants.every(plant => plant.dayInStage === 5));
});

test('a T0 sleep advances soil, tomato age, midnight records and the 05:00 well refill', () => {
  const world = newWorld();
  const startSoil = world.bedAColumn(start);
  const completion = world.pump(start);
  assert.equal(completion, start + MINUTE_MS);
  world.stepTo(completion!);
  world.applyDueTankEvents(completion!);
  const midnight = nextLocalMidnight(start);
  const bedtime = midnight - 3 * HOUR_MS;
  assert.equal(sleepUntil(bedtime - 5 * HOUR_MS), null);
  world.stepTo(bedtime);
  const evening = world.viewModel(bedtime);
  assert.equal(evening.player.energy, 99);
  assert.equal(evening.water.wellLiters, 460);
  assert.equal(evening.water.tankLiters, 320);
  assert.equal(evening.plants[0].dayInStage, 5);
  assert.equal(evening.daily.length, 0);
  const wake = sleepUntil(bedtime)!;
  assert.equal(wake, midnight + 5 * HOUR_MS + 50 * MINUTE_MS);
  world.stepTo(wake);
  const morning = world.viewModel(wake);
  assert.notDeepEqual(world.bedAColumn(wake), startSoil);
  assert.equal(world.committedAt, wake);
  assert.equal(morning.plants[0].dayInStage, 6);
  assert.equal(morning.water.wellLiters, 480);
  assert.equal(morning.water.tankLiters, 320);
  assert.equal(morning.player.energy, 100);
  assert.equal(morning.daily[0].at, midnight);
  assert.equal(morning.daily[0].date, '2027-01-11');
  assert.equal(morning.daily[0].waterMinutes, 1);
  assert.equal(morning.daily[0].waterEnergy, 1);
  assert.equal(morning.daily[0].pumpStrokes, 1);
  assert.equal(morning.daily[0].carryTrips, 0);
  // Bed A starts 45.9 mm below the 198 mm it holds at field capacity over its 1 m root zone (plan 6.6).
  assert.equal(morning.daily[0].soilWaterMm.start, 152.1);
  assert.ok(morning.daily[0].soilWaterMm.end < 152.1);
  assert.equal(morning.today.soilWaterMm.start, morning.daily[0].soilWaterMm.end);
  assert.equal(morning.today.pumpStrokes, 0);
  assert.equal(morning.sky.day, 2);
  assert.equal(morning.hud.canUsePhone, false);
  assert.equal(morning.valve, 'absent');
  assert.ok(morning.map.tiles.every(tile => tile.feature !== 'probe' && tile.feature !== 'gateway'));
});

test('a can wets only the selected tile and bed B can be tilled and transplanted', () => {
  const world = newWorld();
  const tile = BED_B_TOP_LEFT;
  const neighbour = {x: BED_B_TOP_LEFT.x + 1, y: BED_B_TOP_LEFT.y};
  const at = start + 70_005;
  world.stepTo(at);
  assert.equal(world.transplant(at, tile), false);
  assert.equal(world.till(at, tile), true);
  assert.equal(world.transplant(at, tile), true);
  assert.equal(world.fill(at, 'can'), 10);
  const end = world.waterTile(at, tile)!;
  world.stepTo(end);
  assert.ok(world.columnAt(tile, end)!.storage[0] > world.columnAt(neighbour, end)!.storage[0]);
  const view = world.viewModel(end);
  assert.equal(view.hud.canLiters, 8);
  assert.equal(view.player.energy, 95);
  assert.equal(view.today.irrigationLiters.can, 2);
  // Bed B starts below the 50% crust threshold, so the can loses nothing (soil.test pins the crust loss).
  assert.equal(view.today.runoffLiters, 0);
  assert.equal(view.today.waterMinutes, .2);
  assert.ok(Object.isFrozen(view.map.tiles));
  assert.equal(view.plants.length, 65);
  const transplanted = view.plants.find(plant => plant.at.x === tile.x && plant.at.y === tile.y);
  assert.equal(transplanted?.stage, 'transplant');
});

test('the soil probe stands on a bed A drip line', () => {
  const probe = farmMap(1).find(tile => tile.feature === 'probe');
  assert.ok(probe);
  assert.equal(probe.bed, 'A');
  assert.ok(DRIP_TILES.some(tile => tile.at.x === probe.at.x && tile.at.y === probe.at.y));
});

test('unwatered bed B transplants roll at midday on day 2 and recover by evening', () => {
  const tile = BED_B_TOP_LEFT;
  const dayOne = localDayStart(start);
  // The tutorial asks for the transplant between 08:00 and 14:00 on day 1 (plan 7.4).
  for (const hour of [8, 14]) {
    const world = newWorld();
    const transplantAt = dayOne + hour * HOUR_MS;
    world.stepTo(transplantAt);
    assert.ok(world.till(transplantAt, tile) && world.transplant(transplantAt, tile));
    const rolling: number[] = [];
    for (let at = transplantAt; at <= dayOne + DAY_MS + 18 * HOUR_MS; at += SOIL_STEP_MS) {
      world.stepTo(at);
      const stress = world.viewModel(at).plants.find(plant => plant.at.x === tile.x && plant.at.y === tile.y)?.stress;
      const dayTwo = at >= dayOne + DAY_MS;
      if (stress === 'rolling') rolling.push(at);
      assert.ok(stress === 'turgid' || (dayTwo && stress === 'rolling'), stress + ' at ' + new Date(at).toISOString());
    }
    assert.ok(rolling.length > 0, 'no rolling after a ' + hour + ':00 transplant');
    assert.ok(rolling.every(at => at >= dayOne + DAY_MS + 11 * HOUR_MS && at < dayOne + DAY_MS + 16 * HOUR_MS));
  }
});

// Council r1, Fable S1: the T4 report compares stress days with a reference run that has no bed B.
test('stress days and mean Ks come from bed A only, while bed B transplants dry out', () => {
  const header = defaultHeader('unit');
  const split: Scenario = {...scenario, initial: {...scenario.initial, energy: 100,
    bedA: {...scenario.initial.bedA, depletion: [0, 0, 0, 0, 0]},
    bedB: {...scenario.initial.bedB, depletion: [.95, .95, .95, .95, .95]}}};
  const planted = new World(header, split);
  const twin = new World(header, split);
  const bedB = farmMap(header.tier).filter(tile => tile.bed === 'B');
  assert.equal(bedB.length, 24);
  for (const {at} of bedB) assert.ok(planted.till(start, at) && planted.transplant(start, at));
  const end = localDayStart(start) + 3 * DAY_MS;
  planted.stepTo(end);
  twin.stepTo(end);
  const inBedB = new Set(bedB.map(({at}) => at.x + ',' + at.y));
  const transplants = planted.viewModel(end).plants.filter(plant => inBedB.has(plant.at.x + ',' + plant.at.y));
  assert.equal(transplants.length, 24);
  assert.ok(transplants.every(plant => plant.ks < .2), 'bed B transplants ks ' + transplants.map(plant => plant.ks));
  const records = planted.dailyRecords();
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.stressDay), [false, false, false]);
  assert.deepEqual(records.map(record => record.meanKs), twin.dailyRecords().map(record => record.meanKs));
});

test('the dry-spell well yields its own daily volume and the day record counts strokes and trips', () => {
  const dry = scenarioById('dry-spell');
  assert.equal(dry.initial.wellYieldLiters, 310);
  assert.ok(TUTORIAL_SCENARIO.initial.wellYieldLiters > dry.initial.wellYieldLiters);
  const world = new World(defaultHeader('unit', dry), dry);
  let at = dry.start;
  assert.deepEqual([world.viewModel(at).water.wellLiters, world.viewModel(at).water.wellDailyLiters], [310, 310]);
  let strokes = 0;
  for (let end = world.pump(at); end !== null; end = world.pump(at)) {
    world.stepTo(end);
    world.applyDueTankEvents(end);
    at = end;
    strokes++;
  }
  // Fifteen full strokes of 20 L and a last one that empties the well.
  assert.equal(strokes, 16);
  assert.equal(world.settledTankLiters(), dry.initial.tankLiters + 310);
  const trip = world.carryFromSharedWell(at)!;
  world.stepTo(trip);
  world.applyDueTankEvents(trip);
  assert.equal(world.collectFromSharedWell(trip, 'jerrycan'), 20);
  assert.equal(world.collectFromSharedWell(trip, 'jerrycan'), 0);
  const today = world.viewModel(trip).today;
  assert.deepEqual([today.pumpStrokes, today.carryTrips, today.waterEnergy], [16, 2, 16 + 6 + 6]);
  const wake = sleepUntil(localDayStart(trip) + 20 * HOUR_MS)!;
  world.stepTo(wake);
  const morning = world.viewModel(wake);
  assert.equal(morning.water.wellLiters, 310);
  assert.deepEqual([morning.daily[0].pumpStrokes, morning.daily[0].carryTrips], [16, 2]);
});
