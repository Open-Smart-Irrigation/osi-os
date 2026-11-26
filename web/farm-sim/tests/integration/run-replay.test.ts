import assert from 'node:assert/strict';
import test from 'node:test';
import {START_TILE} from '../../src/core/map';
import {createRun, loadRun} from '../../src/core/replay';
import {SleepJump} from '../../src/sleep-jump';
import {PLANS_PATH, VALVE_PATH} from '../../src/core/osi/farm-builder';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS, HOUR_MS, localHour, SOIL_STEP_MS} from '../../src/core/time';
import {advanceUntil, evening, house, queueWalk, recordSession, start} from './run-replay-session';

test('a write drains a queued move or can fill first, fires a due plan immediately and respects the phone pause', () => {
  const {duringPause, nearEmpty, beforePlan, atWrite, stillPaused, long, longHash, short} = recordSession('none');
  assert.deepEqual(duringPause, {at: start, open: true, phase: 'pending'});
  assert.ok(nearEmpty > 10 && nearEmpty < 10.2);
  assert.ok(atWrite.tankLitres > 0 && atWrite.tankLitres < .2);
  assert.equal(atWrite.at, stillPaused);
  assert.equal(atWrite.at, beforePlan);
  assert.equal(atWrite.phase, 'pending');
  assert.equal(atWrite.commanded?.sim_time, beforePlan);
  assert.equal(atWrite.commanded?.type === 'irrigation' && atWrite.commanded.payload.kind, 'commanded');

  const commands = long.log;
  const firstWrite = commands.findIndex(row => row.cmd.kind === 'phoneRequest');
  const secondWrite = commands.findIndex((row, index) => index > firstWrite && row.cmd.kind === 'phoneRequest');
  assert.deepEqual(commands.slice(firstWrite - 2, firstWrite + 1).map(row => [row.tick, row.cmd.kind]),
    [[0, 'move'], [0, 'phoneOpen'], [0, 'phoneRequest']]);
  assert.deepEqual(commands.slice(secondWrite - 2, secondWrite + 1).map(row => [row.tick, row.cmd.kind]),
    [[commands[secondWrite].tick, 'phoneOpen'], [commands[secondWrite].tick, 'useTool'],
      [commands[secondWrite].tick, 'phoneRequest']]);
  assert.equal(Math.round(localHour(short.cursor.simNow) * 60), 350);
  assert.match(longHash, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(loadRun(long).hash(), longHash);
});

test('no polling, immediate polls and repeated polls yield identical checkpoints and terminal hashes', () => {
  const first = recordSession('none');
  for (const poll of ['after-write', 'frequent'] as const) {
    const candidate = recordSession(poll, true);
    assert.deepEqual(candidate.long, first.long);
    assert.equal(candidate.longHash, first.longHash);
    assert.equal(loadRun(candidate.long).hash(), first.longHash);
  }
  assert.ok(first.long.checkpoints.length >= 4);
});

test('the same last command can have two distinct idle tails at the replay cursor', () => {
  const {short, shortHash, long, longHash} = recordSession('none');
  assert.deepEqual(short.log, long.log);
  assert.notEqual(short.cursor.simNow, long.cursor.simNow);
  for (const [save, expected] of [[short, shortHash], [long, longHash]] as const) {
    const loaded = loadRun(JSON.parse(JSON.stringify(save)));
    assert.deepEqual(loaded.save(), save);
    assert.equal(loaded.hash(), expected);
  }
  const bad = {...short, cursor: {...short.cursor, simNow: short.cursor.simNow + 1}};
  assert.throws(() => loadRun(bad), /cursor/);
  const badCheckpoint = {...long, checkpoints: long.checkpoints.map(() => 'wrong')};
  assert.throws(() => loadRun(badCheckpoint), /checkpoints/);
});

test('sliced sleep preserves overnight events, wake hash, checkpoints and the replay save', () => {
  const oneShot = createRun(defaultHeader('sleep-parity', TUTORIAL_SCENARIO, 4));
  queueWalk(oneShot, START_TILE, house);
  advanceUntil(oneShot, evening + 3 * HOUR_MS);
  oneShot.apply({kind: 'phoneOpen'});
  const plan = oneShot.request('POST', PLANS_PATH + '/schedules', {
    kind: 'ONCE', fire_at: new Date(oneShot.now + HOUR_MS).toISOString(), duration_minutes: 45,
  });
  assert.ok(plan.status < 300);
  oneShot.apply({kind: 'phoneClose'});
  const split = loadRun(oneShot.save());
  const before = oneShot.eventsSince(0).length;
  const bedtime = oneShot.now;
  oneShot.apply({kind: 'sleep'});
  oneShot.step(0);

  const jump = new SleepJump(split);
  assert.equal(jump.advance(), false);
  assert.ok(split.now > bedtime && split.now < oneShot.now);
  let done = false;
  while (!done) {
    const previous = split.now;
    done = jump.advance();
    assert.ok(split.now - previous <= SOIL_STEP_MS, 'one task crossed multiple soil grid intervals');
  }
  assert.deepEqual(split.feedback(), oneShot.feedback());
  assert.deepEqual(split.viewModel(), oneShot.viewModel());
  const overnight = oneShot.eventsSince(before);
  assert.ok(overnight.some(event => event.type === 'irrigation'));
  assert.ok(overnight.some(event => event.type === 'world_daily'));
  assert.deepEqual(split.eventsSince(before), overnight);
  assert.equal(split.hash(), oneShot.hash());
  const save = split.save();
  assert.equal(JSON.stringify(save), JSON.stringify(oneShot.save()));
  assert.equal(save.log.filter(row => row.cmd.kind === 'sleep').length, 1);
  assert.equal(loadRun(save).hash(), split.hash());

  // Cross a new checkpoint after waking, so this also compares a digest made after the sliced sleep.
  for (let i = 0; i < 75; i++) {
    oneShot.step(400);
    split.step(400, true);
    while (split.pendingWork) split.resumeStep();
    assert.equal(split.now, oneShot.now);
  }
  assert.equal(JSON.stringify(split.eventsSince(before)), JSON.stringify(oneShot.eventsSince(before)));
  assert.equal(split.save().checkpoints.length, save.checkpoints.length + 1);
  assert.deepEqual(split.save(), oneShot.save());
});

test('refused bodies stay out of the log and a slow frame advances at most eight ticks', () => {
  const run = createRun(defaultHeader('test', TUTORIAL_SCENARIO, 3));
  run.apply({kind: 'phoneOpen'});
  const response = run.request('POST', '/auth/login?password=private-query', {password: 'private-body'});
  assert.equal(response.status, 403);
  assert.doesNotMatch(JSON.stringify(run.eventsSince(0)), /private-query|private-body/);
  assert.equal(run.save().log.length, 1);
  run.apply({kind: 'phoneClose'});
  const closed = run.request('POST', VALVE_PATH, {action: 'CLOSE'});
  assert.equal(closed.status, 503);
  const closedAt = run.phoneNow();
  run.step(1010);
  assert.equal(run.save().cursor.tick, 8);
  assert.equal(run.phoneNow(), closedAt);
  assert.deepEqual(run.eventsSince(0).find(event => event.type === 'slow_frame')?.payload, {dropped_ms: 600});
  run.step(40);
  assert.equal(run.save().cursor.tick, 9);
});

// Council r1, GLM S8: plan 4.6 logs every refused phone write, the ones after the slice ends included.
test('a phone write after the slice ends is refused and logged without its body', () => {
  const run = createRun({...defaultHeader('test', TUTORIAL_SCENARIO, 3), pace: 300, pauseWhilePhoneOpen: false});
  queueWalk(run, START_TILE, house);
  for (let day = 0; day < 14; day++) {
    advanceUntil(run, evening + day * DAY_MS);
    run.apply({kind: 'sleep'});
    run.step(0);
  }
  run.apply({kind: 'phoneOpen'});
  advanceUntil(run, start + 14 * DAY_MS);
  assert.ok(run.complete && run.isPhoneOpen());
  const before = run.eventsSince(0).length;
  const response = run.request('POST', VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: 600});
  assert.equal(response.status, 403);
  assert.deepEqual(response.data, {error: 'game_refused'});
  const logged = run.eventsSince(before);
  assert.deepEqual(logged.map(event => [event.type, event.sim_time, event.payload]), [['phone_refused', run.now,
    {method: 'POST', path: VALVE_PATH, code: 'game_refused', simNow: run.now}]]);
  assert.doesNotMatch(JSON.stringify(logged), /duration_seconds|OPEN_FOR_DURATION/);
});

test('a full 14-day run reaches the report and logs a single terminal event', () => {
  const run = createRun({...defaultHeader('test'), pace: 300});
  queueWalk(run, START_TILE, house);
  for (let day = 0; day < 14; day++) {
    advanceUntil(run, evening + day * DAY_MS);
    run.apply({kind: 'sleep'});
    run.step(0);
  }
  advanceUntil(run, start + 14 * DAY_MS);
  assert.ok(run.complete);
  assert.equal(run.viewModel().sky.day, 14);
  assert.equal(run.feedback().report?.days.length, 15);
  assert.equal(run.eventsSince(0).filter(event => event.type === 'report').length, 1);
  assert.equal(loadRun(run.save()).hash(), run.hash());
});
