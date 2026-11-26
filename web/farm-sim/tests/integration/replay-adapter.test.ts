import assert from 'node:assert/strict';
import test from 'node:test';
import type {Command} from '../../src/core/commands';
import {TANK_TILE} from '../../src/core/map';
import {PLANS_PATH, VALVE_PATH} from '../../src/core/osi/farm-builder';
import {DAY_MS, MINUTE_MS, sleepUntil} from '../../src/core/time';
import type {Save} from '../../src/core/types';
import {atHour, buildAdapter, hash, iso, START, SUMMARY, write} from './osi-fixture';

const FRAME = 50;

function session() {
  const {adapter, header, setDispatcher} = buildAdapter(3, {tank: 10.15, open: false});
  const queue: Command[] = [];
  const log: Save['log'] = [];
  const checkpoints: string[] = [];
  let tick = 0;
  let seq = 0;
  const digest = () => hash([adapter.now, adapter.isPhoneOpen(), adapter.world.snapshot(),
    adapter.waterSnapshot(), adapter.simulatorSnapshot()]);
  function dispatch(cmd: Command) {
    let response;
    switch (cmd.kind) {
      case 'phoneOpen': adapter.setPhoneOpen(true); break;
      case 'phoneClose': adapter.setPhoneOpen(false); break;
      case 'useTool': adapter.world.fill(adapter.now, 'can'); break;
      case 'move': adapter.world.move(adapter.now, cmd.dx, cmd.dy); break;
      case 'sleep': {
        const wake = sleepUntil(adapter.now);
        assert.ok(wake !== null);
        adapter.advance(wake);
        break;
      }
      case 'phoneRequest':
        cmd = {...cmd, simNow: adapter.now, seq: seq + 1};
        response = adapter.executePhoneWrite(cmd);
        break;
      default: throw new Error('Unexpected fixture command');
    }
    log.push({tick, seq: ++seq, cmd});
    adapter.drainNow();
    return response;
  }
  const queued = () => { while (queue.length) dispatch(queue.shift()!); };
  setDispatcher(queued, cmd => {
    queue.push({...cmd, simNow: 0, seq: 0});
    const answer = dispatch(queue.shift()!);
    assert.ok(answer);
    return answer;
  });
  function advanceTick() {
    assert.equal(adapter.isPhoneOpen(), false);
    adapter.advance(adapter.now + FRAME * header.pace);
    tick++;
    if (tick % 600 === 0) checkpoints.push(digest());
  }
  return {
    adapter, queue, digest, get tick() { return tick; },
    step() { queued(); if (!adapter.isPhoneOpen()) advanceTick(); },
    save(): Save { return structuredClone({header, log, checkpoints, cursor: {tick, seq, simNow: adapter.now}}); },
    restore(save: Save) {
      for (const row of save.log) {
        if (row.seq > save.cursor.seq) break;
        while (tick < row.tick) advanceTick();
        dispatch(row.cmd);
      }
      while (tick < save.cursor.tick) advanceTick();
      assert.equal(seq, save.cursor.seq);
      assert.equal(adapter.now, save.cursor.simNow);
    },
  };
}

function play(poll: 'none' | 'after-write' | 'frequent') {
  const run = session();
  const {adapter, queue} = run;
  const read = () => {
    const before = run.digest();
    for (const path of [SUMMARY, '/api/devices', '/api/valves', '/api/irrigation/recent-actuations',
      PLANS_PATH + '/schedules', '/api/system/settings']) write(adapter, 'GET', path);
    assert.equal(run.digest(), before);
  };

  queue.push({kind: 'phoneOpen'}, {kind: 'useTool', tool: 'can', tile: TANK_TILE});
  write(adapter, 'POST', VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: 600});
  assert.equal(adapter.world.settledTankLiters(), .15);
  assert.equal(adapter.viewModel().valve, 'pending');
  if (poll !== 'none') read();
  run.step();
  assert.equal(adapter.now, START);
  queue.push({kind: 'phoneClose'});
  for (let i = 0; i < 120; i++) run.step();

  queue.push({kind: 'phoneOpen'}, {kind: 'move', dx: -1, dy: 0});
  const due = adapter.now;
  write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'ONCE', fire_at: iso(due - MINUTE_MS), duration_minutes: 10});
  const dispatched = adapter.simulatorSnapshot();
  assert.equal(dispatched.schedules[0][1][0].dispatch_created_at, iso(due));
  assert.equal(dispatched.outcomes[0].commandedAt, iso(due));
  if (poll !== 'none') read();
  for (let i = 0; i < 3; i++) run.step();
  assert.equal(adapter.now, due);
  queue.push({kind: 'phoneClose'});
  while (adapter.now < atHour(1, 18)) {
    run.step();
    if (run.tick % 311 === 0) {
      queue.push({kind: 'phoneOpen'});
      run.step();
      if (poll === 'frequent') read();
      queue.push({kind: 'phoneClose'});
    }
  }
  queue.push({kind: 'sleep'});
  run.step();
  const short = run.save();
  const shortHash = run.digest();
  for (let i = 0; i < 37; i++) run.step();
  return {short, shortHash, long: run.save(), longHash: run.digest()};
}

test('queued player actions precede phone writes, and three polling patterns replay through a pause and sleep', () => {
  const first = play('none');
  const afterWrite = play('after-write');
  const frequent = play('frequent');
  for (const candidate of [afterWrite, frequent]) {
    assert.deepEqual(candidate.long.log, first.long.log);
    assert.deepEqual(candidate.long.checkpoints, first.long.checkpoints);
    assert.equal(candidate.longHash, first.longHash);
  }
  assert.deepEqual(first.long.log.slice(0, 4).map(row => [row.tick, row.seq, row.cmd.kind]),
    [[0, 1, 'phoneOpen'], [0, 2, 'useTool'], [0, 3, 'phoneRequest'], [0, 4, 'phoneClose']]);
  assert.ok(first.long.checkpoints.length > 0);
  for (const run of [first, afterWrite, frequent]) {
    const replay = session();
    replay.restore(run.long);
    assert.deepEqual(replay.save().checkpoints, run.long.checkpoints);
    assert.equal(replay.digest(), run.longHash);
  }
});

test('replay preserves distinct idle tails after the same final command', () => {
  const {short, shortHash, long, longHash} = play('none');
  assert.deepEqual(short.log, long.log);
  assert.notEqual(short.cursor.simNow, long.cursor.simNow);
  for (const [save, expected] of [[short, shortHash], [long, longHash]] as const) {
    const replay = session();
    replay.restore(save);
    assert.deepEqual(replay.save().cursor, save.cursor);
    assert.equal(replay.digest(), expected);
  }
});

test('different host advance grids preserve the full digest across midnight and trigger runs', () => {
  const run = (minutes: number) => {
    const {adapter} = buildAdapter(4, {tank: 100});
    const end = START + 3 * DAY_MS;
    while (adapter.now < end) adapter.advance(Math.min(end, adapter.now + minutes * MINUTE_MS));
    return hash([adapter.world.snapshot(), adapter.waterSnapshot(), adapter.simulatorSnapshot()]);
  };
  assert.equal(run(61), run(97));
});
