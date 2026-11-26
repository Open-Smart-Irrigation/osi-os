import assert from 'node:assert/strict';
import test from 'node:test';
import {START_TILE} from '../../src/core/map';
import {PLANS_PATH} from '../../src/core/osi/farm-builder';
import {createRun} from '../../src/core/replay';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS, MINUTE_MS} from '../../src/core/time';
import {Tutorial} from '../../src/core/tutorial';
import {tutorialHint} from '../../src/ui/hints';
import {atHour, buildAdapter, write} from './osi-fixture';
import {advanceUntil, evening, house, queueWalk} from './run-replay-session';

/** A T3 tutorial observing the simulator to day 5 at 08:00, with a weekly plan written on day `planDay` at 20:00. */
function planPracticed(planDay: number | null): boolean {
  const {adapter, header} = buildAdapter(3);
  const tutorial = new Tutorial(header.start, true, header.tier);
  const advance = (to: number) => {
    while (adapter.now < to) {
      adapter.advance(Math.min(to, adapter.now + 30 * MINUTE_MS));
      tutorial.observe(adapter);
    }
  };
  if (planDay !== null) {
    advance(atHour(planDay, 20));
    write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'WEEKLY', weekdays_mask: 127, start_time: '07:00',
      duration_minutes: 45});
  }
  advance(atHour(5, 8));
  return tutorial.state().practiced.includes('plan');
}

test('a weekly plan the player wrote on the phone ends the day-5 plan hint', () => {
  assert.equal(planPracticed(null), false);
  assert.equal(planPracticed(4), true);
});

// Council r1, Sol S3: the hint stayed until the next soil uplink, which after 23:30 falls on day 6.
test('a weekly plan saved on day 5 at 23:40 ends the plan hint at once', () => {
  const run = createRun({...defaultHeader('test', TUTORIAL_SCENARIO, 3), pace: 300, pauseWhilePhoneOpen: false});
  queueWalk(run, START_TILE, house);
  for (let day = 0; day < 4; day++) {
    advanceUntil(run, evening + day * DAY_MS);
    run.apply({kind: 'sleep'});
    run.step(0);
  }
  advanceUntil(run, atHour(5, 23) + 40 * MINUTE_MS);
  run.apply({kind: 'phoneOpen'});
  run.step(0);
  assert.equal(run.viewModel().sky.day, 5);
  const hint = () => tutorialHint(run.viewModel(), run.feedback(), undefined);
  assert.equal(hint(), 'Set a weekly plan for 07:00 on the phone. Visit the shared well while the plan waters bed A.');
  const response = run.request('POST', PLANS_PATH + '/schedules', {kind: 'WEEKLY', weekdays_mask: 127,
    start_time: '07:00', duration_minutes: 45});
  assert.ok(response.status < 300, JSON.stringify(response));
  assert.ok(run.feedback().tutorial.practiced.includes('plan'));
  assert.equal(hint(), undefined);
});
