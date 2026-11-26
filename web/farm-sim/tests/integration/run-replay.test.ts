import assert from 'node:assert/strict';
import test from 'node:test';
import {START_TILE} from '../../src/core/map';
import {createRun, loadRun} from '../../src/core/replay';
import {VALVE_PATH} from '../../src/core/osi/farm-builder';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS, localHour} from '../../src/core/time';
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
    const candidate = recordSession(poll);
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
