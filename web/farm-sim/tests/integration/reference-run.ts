import assert from 'node:assert/strict';
import {BED_A_AREA_M2, BED_A_TOP_LEFT} from '../../src/core/map';
import {PLANS_PATH} from '../../src/core/osi/farm-builder';
import {SCENARIOS, verdictTapMinutes} from '../../src/core/scenario';
import {DAY_MS, HOUR_MS, MINUTE_MS, localDayStart} from '../../src/core/time';
import {DAY_THREE_HINT_DELAY_MS} from '../../src/core/tutorial';
import type {IrrigationEvent, Scenario, Tier} from '../../src/core/types';
import {buildAdapter, environment, manualTap, probeAt, write} from './osi-fixture';

const bedATiles = Array.from({length: BED_A_AREA_M2}, (_, i) => ({
  x: BED_A_TOP_LEFT.x + i % 8, y: BED_A_TOP_LEFT.y + Math.floor(i / 8),
}));

export function atClock(dayStart: number, hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map(Number);
  return dayStart + hour * HOUR_MS + minute * MINUTE_MS;
}

/** The morning supply step common to every scripted run: pump, then carry if the tank is still low. */
export function supplyStep(adapter: ReturnType<typeof buildAdapter>['adapter'], scenario: Scenario, midnight: number): void {
  const supply = scenario.reference.supply;
  const world = adapter.world;
  adapter.advance(atClock(midnight, supply.at));
  while (world.tankLitersAt(adapter.now) < supply.pumpToLiters) {
    const end = world.pump(adapter.now);
    if (end === null) break;
    adapter.advance(end);
  }
  while (world.tankLitersAt(adapter.now) < supply.carryToLiters
    && world.snapshot().player.energy >= supply.carryMinEnergy) {
    const end = world.carryFromSharedWell(adapter.now);
    if (end === null) break;
    adapter.advance(end);
  }
}

export function referenceRun(scenario: Scenario, tier: Tier) {
  const {adapter} = buildAdapter(tier, {scenario});
  const policy = scenario.reference.tiers.find(policy => policy.tier === tier);
  assert.ok(policy);
  if (policy.kind === 'weekly-plan') {
    write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'WEEKLY', weekdays_mask: policy.weekdays,
      start_time: policy.at, duration_minutes: policy.minutes});
  }
  const tapRuns = [];
  const world = adapter.world;
  const dayOne = localDayStart(scenario.start);
  for (let day = 1; day <= 14; day++) {
    const midnight = dayOne + (day - 1) * DAY_MS;
    supplyStep(adapter, scenario, midnight);
    if (policy.kind === 'even-day-tap' && day % 2 === 0) {
      tapRuns.push(manualTap(adapter, atClock(midnight, policy.at), policy.minutes));
    } else if (policy.kind === 'verdict-tap') {
      adapter.advance(atClock(midnight, policy.at));
      const {action, balanceTodayMm} = environment(adapter).water;
      const minutes = verdictTapMinutes(policy, action.code, balanceTodayMm);
      if (minutes > 0) tapRuns.push(manualTap(adapter, adapter.now, minutes));
    }
    adapter.advance(midnight + 17 * HOUR_MS);
    for (const tile of bedATiles) world.harvest(adapter.now, tile);
    adapter.drainNow();
  }
  adapter.advance(scenario.start + 14 * DAY_MS);
  const outcomes = adapter.simulatorSnapshot().outcomes.slice().reverse();
  const closed = outcomes.filter(row => row.observedCloseAt !== null);
  const runs = closed.map(row => {
    const to = Date.parse(row.observedCloseAt!);
    const from = row.observedOpenAt ? Date.parse(row.observedOpenAt) : to;
    const liters = adapter.litersBetween(1, from, to);
    assert.equal(liters.estimated, row.estimatedGrossLiters ?? 0, row.expectationId);
    return liters;
  });
  const days = adapter.viewModel().daily;
  assert.equal(days.length, 14);
  return {
    triggerDates: outcomes.filter(row => row.trigger === 'trigger_based').map(row => row.commandedAt?.slice(0, 10)),
    runLiters: [...tapRuns, ...runs.map(run => run.delivered)],
    cutoffs: adapter.drain().filter((e): e is Extract<IrrigationEvent, {kind: 'cutoff'}> => e.kind === 'cutoff')
      .map(event => ({at: new Date(event.at).toISOString(), ...event.liters, status: event.status})),
    harvestedKg: Math.round(days.reduce((kg, day) => kg + day.pickedKg, 0) * 1_000) / 1_000,
    // Labour and soil water over the 14 day records, which end at midnight before the 06:30 slice end.
    pumpStrokes: days.reduce((sum, day) => sum + day.pumpStrokes, 0),
    carryTrips: days.reduce((sum, day) => sum + day.carryTrips, 0),
    stressDays: days.filter(day => day.stressDay).length,
    soilWaterMm: {start: days[0].soilWaterMm.start, end: days[13].soilWaterMm.end},
  };
}

/**
 * Scripted T1 tutorial run: no irrigation before day 3, the morning supply step on day 3, then
 * the tutorial drip run. Returns the run start, the hint instant and the 20 cm reading at every
 * uplink from 06:30 to 11:00 on day 3.
 */
export function dayThreeRun(scenario: Scenario) {
  const {adapter} = buildAdapter(1, {scenario});
  const tutorial = scenario.reference.tutorialDrip;
  const midnight = localDayStart(scenario.start) + (tutorial.day - 1) * DAY_MS;
  supplyStep(adapter, scenario, midnight);
  const at = atClock(midnight, tutorial.at);
  const liters = manualTap(adapter, at, tutorial.minutes);
  // Uplinks fall on the hour and half hour; the hint reads the latest one at the hint instant.
  const uplinkMs = 30 * MINUTE_MS;
  const due = at + tutorial.minutes * MINUTE_MS + DAY_THREE_HINT_DELAY_MS;
  const readAt = midnight + Math.floor((due - midnight) / uplinkMs) * uplinkMs;
  adapter.advance(Math.max(readAt, atClock(midnight, '11:00')));
  const readings = new Map<number, number>();
  for (let uplink = atClock(midnight, '06:30'); uplink <= atClock(midnight, '11:00'); uplink += uplinkMs) {
    readings.set(uplink, probeAt(adapter, uplink));
  }
  return {at, readAt, liters, readings, kPa: (uplink: number) => probeAt(adapter, uplink)};
}

export function dayThreeHint(scenario: Scenario): number {
  const run = dayThreeRun(scenario);
  return Math.round((run.kPa(run.readAt) - run.kPa(run.at)) * 100) / 100;
}

export function generateGolden() {
  return Object.fromEntries(SCENARIOS.map(scenario => [scenario.id, {
    dayThreeHintKpa: dayThreeHint(scenario),
    tiers: Object.fromEntries(scenario.tiers.map(tier => [tier, referenceRun(scenario, tier)])),
  }]));
}
