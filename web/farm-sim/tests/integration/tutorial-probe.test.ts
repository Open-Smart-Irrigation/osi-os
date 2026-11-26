import assert from 'node:assert/strict';
import test from 'node:test';
import {START_TILE} from '../../src/core/map';
import {PLANS_PATH} from '../../src/core/osi/farm-builder';
import {createRun} from '../../src/core/replay';
import {defaultHeader, SCENARIOS, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS, MINUTE_MS, localDayStart} from '../../src/core/time';
import {Tutorial} from '../../src/core/tutorial';
import type {IrrigationEvent, Scenario} from '../../src/core/types';
import {round2} from '../../src/core/units';
import {buildAdapter, manualTap, probeAt, write} from './osi-fixture';
import golden from './reference-golden.json';
import {atClock, supplyStep} from './reference-run';
import {advanceUntil, evening, house, queueWalk} from './run-replay-session';

type Observed = ReturnType<Tutorial['state']>['observed'];
type Options = Readonly<{
  /** A second tap run on day 3, opened and closed on the half hour. */
  later?: Readonly<{at: string; minutes: number}>;
  /** Opens the tap at 06:00 and closes it at 06:15, on an empty tank before the morning supply step. */
  dryFirst?: boolean;
  until?: string;
}>;

/**
 * A T1 tutorial fed as the Run feeds it, through the goldens' scripted day-3 drip run and then one uplink every
 * 30 minutes. Returns what the tutorial holds after each uplink from the end of the run to `until` (11:00 unless
 * set), by local clock, and the litres the later run delivered.
 */
function dayThreeObservations(scenario: Scenario, options: Options = {}) {
  const {adapter, header} = buildAdapter(1, {scenario, tank: options.dryFirst ? 0 : undefined});
  const tutorial = new Tutorial(header.start, true, header.tier);
  const drip = scenario.reference.tutorialDrip;
  const midnight = localDayStart(scenario.start) + (drip.day - 1) * DAY_MS;
  // A tap command as the Run handles it: the world, then the tutorial, then one observation.
  const tap = (at: number, open: boolean) => {
    adapter.advance(at);
    assert.ok(adapter.world.setManualTap(at, open));
    adapter.drainNow();
    tutorial.action({text: '', decision: 'tap', tapOpen: open}, at);
    tutorial.observe(adapter);
  };
  if (options.dryFirst) {
    tap(atClock(midnight, '06:00'), true);
    assert.equal(adapter.world.tankLitersAt(adapter.now), 0);
    tap(atClock(midnight, '06:15'), false);
  }
  supplyStep(adapter, scenario, midnight);
  const start = atClock(midnight, drip.at);
  const end = start + drip.minutes * MINUTE_MS;
  manualTap(adapter, start, drip.minutes);
  tutorial.action({text: '', decision: 'tap', tapOpen: true}, start);
  tutorial.action({text: '', decision: 'tap', tapOpen: false}, end);
  const later = options.later && {
    start: atClock(midnight, options.later.at),
    end: atClock(midnight, options.later.at) + options.later.minutes * MINUTE_MS,
  };
  let laterLiters = 0;
  const seen = new Map<string, Observed>();
  for (let at = end; at <= atClock(midnight, options.until ?? '11:00'); at += 30 * MINUTE_MS) {
    if (later && at === later.start) tap(at, true);
    if (later && at === later.end) {
      tap(at, false);
      laterLiters = adapter.world.manualTapLitersBetween(later.start, later.end);
    }
    adapter.advance(at);
    tutorial.observe(adapter);
    const minutes = (at - midnight) / MINUTE_MS;
    seen.set(String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'),
      tutorial.state().observed);
  }
  return {seen, laterLiters};
}

const dayThree = (scenario: Scenario) => localDayStart(scenario.start) + 2 * DAY_MS;

// Council r1, Sol S2 and Fable S6: plan 7.4 reports the change two hours after the run ends, not at the next uplink.
for (const scenario of SCENARIOS) {
  test(scenario.id + ' day-3 hint waits two hours after the drip run and keeps the golden 10:00 change', () => {
    assert.deepEqual(scenario.reference.tutorialDrip, {day: 3, at: '07:00', minutes: 60});
    const {seen} = dayThreeObservations(scenario);
    for (const clock of ['08:00', '08:30', '09:00', '09:30']) assert.equal(seen.get(clock), null, clock);
    const reported = seen.get('10:00');
    assert.equal(reported?.changeKpa, golden[scenario.id as keyof typeof golden].dayThreeHintKpa);
    assert.equal(reported?.sampledAt, atClock(localDayStart(scenario.start) + 2 * DAY_MS, '10:00'));
    assert.deepEqual(seen.get('11:00'), reported, 'the hint keeps the change it reported');
  });
}

// Council r2, Sol S6: plan 7.4 keeps the reported change for the day; a later open does not clear or replace it.
for (const scenario of SCENARIOS) {
  test(scenario.id + ' day-3 hint keeps the 10:00 change through a second drip run at noon', () => {
    const {seen, laterLiters} = dayThreeObservations(scenario, {later: {at: '12:00', minutes: 30}, until: '16:00'});
    assert.ok(laterLiters > 0, 'the noon run delivered water');
    const reported = seen.get('10:00');
    assert.equal(reported?.changeKpa, golden[scenario.id as keyof typeof golden].dayThreeHintKpa);
    for (const [clock, observed] of seen) if (clock >= '10:00') assert.deepEqual(observed, reported, clock);
  });

  test(scenario.id + ' a day-3 open before the comparison restarts the wait and keeps the before reading', () => {
    const single = dayThreeObservations(scenario).seen.get('10:00');
    const {seen, laterLiters} = dayThreeObservations(scenario, {later: {at: '09:00', minutes: 30}, until: '12:00'});
    assert.ok(laterLiters > 0, 'the 09:00 run delivered water');
    for (const clock of ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00']) {
      assert.equal(seen.get(clock), null, clock);
    }
    const reported = seen.get('11:30');
    assert.equal(reported?.sampledAt, atClock(dayThree(scenario), '11:30'), 'two hours after the 09:30 close');
    assert.equal(reported?.beforeKpa, single?.beforeKpa, 'still the last uplink before the 07:00 run');
    assert.deepEqual(seen.get('12:00'), reported);
  });

  test(scenario.id + ' a day-3 open on an empty tank before the run does not hold the before reading', () => {
    const single = dayThreeObservations(scenario).seen.get('10:00');
    const {seen} = dayThreeObservations(scenario, {dryFirst: true});
    for (const clock of ['08:00', '08:30', '09:00', '09:30']) assert.equal(seen.get(clock), null, clock);
    const reported = seen.get('10:00');
    assert.equal(reported?.sampledAt, single?.sampledAt);
    assert.equal(reported?.beforeKpa, single?.beforeKpa, 'the last uplink before the 07:00 run, not before 06:00');
  });
}

// Council r2, Fable S14: a day-3 run on an empty tank ends the run but delivers nothing, so no figure ever follows.
test('a day-3 run on an empty tank ends the run as it opens and leaves no comparison by midnight', () => {
  const {adapter, header} = buildAdapter(1, {scenario: TUTORIAL_SCENARIO, tank: 0});
  const tutorial = new Tutorial(header.start, true, header.tier);
  const midnight = dayThree(TUTORIAL_SCENARIO);
  for (const [clock, open] of [['10:00', true], ['10:15', false]] as const) {
    const at = atClock(midnight, clock);
    adapter.advance(at);
    assert.ok(adapter.world.setManualTap(at, open));
    adapter.drainNow();
    tutorial.action({text: '', decision: 'tap', tapOpen: open}, at);
    tutorial.observe(adapter);
  }
  const last = atClock(midnight, '23:30');
  for (let at = atClock(midnight, '10:30'); at <= last; at += 30 * MINUTE_MS) {
    adapter.advance(at);
    tutorial.observe(adapter);
  }
  assert.equal(adapter.world.manualTapLitersBetween(atClock(midnight, '10:00'), atClock(midnight, '10:15')), 0);
  const state = tutorial.state();
  assert.equal(state.dripEnd, atClock(midnight, '10:00'), 'the empty tank ends the run as it opens');
  assert.equal(state.observed, null, 'no comparison by the last day-3 uplink');
  // The waiting text for this state (dripEnd set, nothing observed) is pinned in tests/unit/tutorial.test.ts,
  // which sits with src/ui/hints in the game layer; this file stays in the core layer.
});

const eventAt = (event: IrrigationEvent) => event.kind === 'cutoff' ? event.closedAt : event.at;

/** Run the two weekly plans with the same irrigation-then-observe order as Replay.collectEvents. */
function dayThreeWithWeeklyPlan(scenario: Scenario, reopen: string) {
  const {adapter, header} = buildAdapter(3, {scenario, tank: 1000});
  const tutorial = new Tutorial(header.start, true, header.tier);
  const time = (clock: string) => atClock(dayThree(scenario), clock);
  const opened: number[] = [];
  const collect = () => {
    for (const event of adapter.drain().sort((a, b) => eventAt(a) - eventAt(b))) {
      if (event.kind === 'opened') opened.push(event.at);
      tutorial.irrigation(event, adapter);
    }
    tutorial.observe(adapter);
  };
  const advance = (clock: string) => {
    adapter.advance(time(clock));
    collect();
    return tutorial.state().observed;
  };
  const plan = (at: string, minutes: number) => {
    write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'WEEKLY', weekdays_mask: 127, start_time: at,
      duration_minutes: minutes});
    collect();
  };
  advance('06:00');
  plan(scenario.reference.tutorialDrip.at, scenario.reference.tutorialDrip.minutes);
  advance('07:00');
  advance('08:00');
  plan(reopen, 45);
  assert.equal(advance('09:30'), null);
  return {adapter, time, opened, advance};
}

for (const scenario of SCENARIOS) {
  test(scenario.id + ' a weekly valve open at 10:00 keeps the comparison from the same uplink', () => {
    const {adapter, time, opened, advance} = dayThreeWithWeeklyPlan(scenario, '10:00');
    const reported = advance('10:00');
    const expected = golden[scenario.id as keyof typeof golden].dayThreeHintKpa;
    assert.deepEqual(opened, [time('07:00'), time('10:00')]);
    assert.equal(round2(probeAt(adapter, time('10:00')) - probeAt(adapter, time('07:00'))), expected);
    assert.equal(reported?.sampledAt, time('10:00'), 'the hint reports the 10:00 uplink');
    assert.equal(reported?.changeKpa, expected);
    assert.deepEqual(advance('14:00'), reported);
  });
}

test('a valve open after the comparison preserves the reported change', () => {
  const {time, opened, advance} = dayThreeWithWeeklyPlan(TUTORIAL_SCENARIO, '10:30');
  const reported = advance('10:00');
  assert.equal(reported?.sampledAt, time('10:00'));
  assert.deepEqual(advance('14:00'), reported);
  assert.deepEqual(opened, [time('07:00'), time('10:30')]);
});

test('an open in a batched advance can compare only uplinks through the instant it opened', () => {
  for (const reopen of ['09:59', '10:00']) {
    const {time, opened, advance} = dayThreeWithWeeklyPlan(TUTORIAL_SCENARIO, reopen);
    const reported = advance('10:30');
    assert.deepEqual(opened, [time('07:00'), time(reopen)]);
    if (reopen === '09:59') assert.equal(reported, null);
    else assert.equal(reported?.sampledAt, time('10:00'));
  }
});

function sleepThroughPlans(day: number, schedules: readonly (readonly [string, number])[]) {
  const run = createRun({...defaultHeader('tutorial-probe', TUTORIAL_SCENARIO, 3), pace: 300});
  queueWalk(run, START_TILE, house);
  const sleep = () => {
    run.apply({kind: 'sleep'});
    run.step(0);
  };
  advanceUntil(run, evening);
  for (let night = 1; night < day; night++) {
    sleep();
    advanceUntil(run, evening + night * DAY_MS);
  }
  run.apply({kind: 'phoneOpen'});
  for (const [start_time, duration_minutes] of schedules) {
    const response = run.request('POST', PLANS_PATH + '/schedules', {
      kind: 'WEEKLY', weekdays_mask: 127, start_time, duration_minutes,
    });
    assert.ok(response.status < 400, JSON.stringify(response));
  }
  run.apply({kind: 'phoneClose'});
  sleep();
  assert.equal(run.now, atClock(localDayStart(TUTORIAL_SCENARIO.start) + day * DAY_MS, '05:50'));
  return run;
}

test('sleep on day 2 keeps the first eligible uplink before the 04:00 reopen', () => {
  const run = sleepThroughPlans(2, [['00:30', 30], ['04:00', 5]]);
  const observed = run.feedback().tutorial.observed;
  assert.ok(observed);
  assert.equal(observed.sampledAt, atClock(dayThree(TUTORIAL_SCENARIO), '03:00'));
  assert.equal(observed.changeKpa, -2.38);
});

test('sleep past day 3 leaves the hint empty when the valve reopens at the 23:00 eligible uplink', () => {
  const run = sleepThroughPlans(3, [['20:30', 30], ['23:00', 5]]);
  const changes = run.eventsSince(0).flatMap(event => event.type === 'irrigation'
    && (event.payload.kind === 'opened' || event.payload.kind === 'closed') ? [[event.sim_time, event.payload.kind]] : []);
  const at = (clock: string) => atClock(dayThree(TUTORIAL_SCENARIO), clock);
  assert.deepEqual(changes, [
    [at('20:30'), 'opened'], [at('21:00'), 'closed'], [at('23:00'), 'opened'], [at('23:05'), 'closed'],
  ]);
  assert.equal(run.feedback().tutorial.observed, null);
});
