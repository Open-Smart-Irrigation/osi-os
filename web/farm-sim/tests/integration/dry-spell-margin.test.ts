import assert from 'node:assert/strict';
import test from 'node:test';
import {BED_A_AREA_M2, BED_A_TOP_LEFT} from '../../src/core/map';
import {PLANS_PATH} from '../../src/core/osi/farm-builder';
import {scenarioById} from '../../src/core/scenario';
import {DAY_MS, HOUR_MS, MINUTE_MS, localDayStart} from '../../src/core/time';
import {round2} from '../../src/core/units';
import {Weather} from '../../src/core/weather';
import {buildAdapter, write} from './osi-fixture';
import golden from './reference-golden.json';

const DRY_SPELL = scenarioById('dry-spell');
const {supply} = DRY_SPELL.reference;

/**
 * Litres above the carry threshold (`supply.carryToLiters`) in the tank after the morning pumping, on the
 * T4 reference's tightest morning. That is day 5: the trigger has run 360 L at 06:00 local on days 2 to 5,
 * and every morning so far has emptied the hand-dug well into the tank. One litre less daily yield takes
 * 5 L off that morning, so 10 L of tank is 2 L a day of yield: at 308 L the tank holds exactly 400 L and
 * nobody carries; at 307 L the player carries on day 5.
 */
const T4_TANK_MARGIN_L = 10;

/** Noise seeds for the sweep; 4 is the scenario's own seed, the game's default draw. */
const NOISE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const bedATiles = Array.from({length: BED_A_AREA_M2}, (_, i) => ({
  x: BED_A_TOP_LEFT.x + i % 8, y: BED_A_TOP_LEFT.y + Math.floor(i / 8),
}));

/**
 * The closed-loop reference run of `reference-run.ts` for the dry-spell T3 and T4 policies, recording the
 * tank between each morning's pumping and carrying. Without `noiseSeed` the sensor noise is off, as in the
 * goldens. With it, the noise is on and drawn from that seed, while the weather keeps the scenario's seed:
 * the header seed feeds only the weather and the sensor-noise stream, so only the noise changes.
 */
function drySpellRun(tier: 3 | 4, noiseSeed?: number) {
  const scenario = noiseSeed === undefined ? DRY_SPELL : {...DRY_SPELL, seed: noiseSeed};
  const {adapter} = buildAdapter(tier, {scenario, weather: new Weather(DRY_SPELL.seed),
    sensorNoise: noiseSeed !== undefined});
  const policy = DRY_SPELL.reference.tiers.find(candidate => candidate.tier === tier);
  assert.ok(policy);
  if (policy.kind === 'weekly-plan') {
    write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'WEEKLY', weekdays_mask: policy.weekdays,
      start_time: policy.at, duration_minutes: policy.minutes});
  }
  const world = adapter.world;
  const [hour, minute] = supply.at.split(':').map(Number);
  const dayOne = localDayStart(DRY_SPELL.start);
  const mornings: {day: number; tankLiters: number; trips: number}[] = [];
  for (let day = 1; day <= 14; day++) {
    const midnight = dayOne + (day - 1) * DAY_MS;
    adapter.advance(midnight + hour * HOUR_MS + minute * MINUTE_MS);
    while (world.tankLitersAt(adapter.now) < supply.pumpToLiters) {
      const end = world.pump(adapter.now);
      if (end === null) break;
      adapter.advance(end);
    }
    const tankLiters = world.tankLitersAt(adapter.now);
    let trips = 0;
    while (world.tankLitersAt(adapter.now) < supply.carryToLiters
      && world.snapshot().player.energy >= supply.carryMinEnergy) {
      const end = world.carryFromSharedWell(adapter.now);
      if (end === null) break;
      trips++;
      adapter.advance(end);
    }
    mornings.push({day, tankLiters, trips});
    adapter.advance(midnight + 17 * HOUR_MS);
    for (const tile of bedATiles) world.harvest(adapter.now, tile);
    adapter.drainNow();
  }
  adapter.advance(DRY_SPELL.start + 14 * DAY_MS);
  const days = adapter.viewModel().daily;
  const tightest = mornings.reduce((low, morning) => morning.tankLiters < low.tankLiters ? morning : low);
  return {
    mornings, tightest, spareLiters: round2(tightest.tankLiters - supply.carryToLiters),
    triggerDates: adapter.simulatorSnapshot().outcomes.slice().reverse()
      .filter(row => row.trigger === 'trigger_based').map(row => row.commandedAt?.slice(0, 10)),
    harvestedKg: Math.round(days.reduce((kg, day) => kg + day.pickedKg, 0) * 1_000) / 1_000,
    pumpStrokes: days.reduce((sum, day) => sum + day.pumpStrokes, 0),
    carryTrips: days.reduce((sum, day) => sum + day.carryTrips, 0),
  };
}

function once<T>(run: () => T): () => T {
  let result: {value: T} | undefined;
  return () => (result ??= {value: run()}).value;
}
const t4Reference = once(() => drySpellRun(4));
const t3Reference = once(() => drySpellRun(3));

function marginMessage(run: ReturnType<typeof drySpellRun>, label: string): string {
  return label + ': day ' + run.tightest.day + ' holds ' + run.tightest.tankLiters + ' L after pumping, '
    + run.spareLiters + ' L above the ' + supply.carryToLiters + ' L carry threshold; T4_TANK_MARGIN_L is '
    + T4_TANK_MARGIN_L + ' L';
}

test('dry-spell T4 reference never carries and keeps T4_TANK_MARGIN_L in the tank on its tightest morning', () => {
  const run = t4Reference();
  assert.ok(run.spareLiters >= T4_TANK_MARGIN_L, marginMessage(run, 'T4 reference'));
  assert.equal(run.carryTrips, 0);
  assert.deepEqual(run.mornings.filter(morning => morning.trips > 0), []);
});

test('dry-spell T3 reference carries from day 6', () => {
  const run = t3Reference();
  assert.equal(run.mornings.find(morning => morning.trips > 0)?.day, 6);
});

test('the dry-spell runs here reproduce the stored T3 and T4 references', () => {
  for (const [tier, run] of [['3', t3Reference()], ['4', t4Reference()]] as const) {
    const stored = golden['dry-spell'].tiers[tier];
    assert.deepEqual({triggerDates: run.triggerDates, harvestedKg: run.harvestedKg, pumpStrokes: run.pumpStrokes,
      carryTrips: run.carryTrips}, {triggerDates: stored.triggerDates, harvestedKg: stored.harvestedKg,
      pumpStrokes: stored.pumpStrokes, carryTrips: stored.carryTrips}, 'T' + tier);
  }
});

test('sensor noise leaves the dry-spell T4 margin in place for every seed of the sweep', () => {
  const runs = NOISE_SEEDS.map(seed => drySpellRun(4, seed));
  runs.forEach((run, i) => {
    assert.ok(run.spareLiters >= T4_TANK_MARGIN_L, marginMessage(run, 'noise seed ' + NOISE_SEEDS[i]));
    assert.equal(run.carryTrips, 0, 'noise seed ' + NOISE_SEEDS[i]);
  });
  // The sweep is not vacuous: the seeds draw different noise, which moves some trigger dates.
  assert.ok(new Set(runs.map(run => run.triggerDates.join())).size > 1);
});
