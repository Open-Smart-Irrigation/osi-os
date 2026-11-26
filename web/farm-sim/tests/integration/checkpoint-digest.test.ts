import assert from 'node:assert/strict';
import test from 'node:test';
import {PLANS_PATH, VALVE_PATH} from '../../src/core/osi/farm-builder';
import {createRun, loadRun, TICK_MS} from '../../src/core/replay';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {MINUTE_MS} from '../../src/core/time';
import {atHour, buildAdapter, iso, write} from './osi-fixture';

/**
 * The digest's bytes are fixed by plan 4.8 and Chromium must reproduce Node's checkpoints (replay-parity.spec.ts), so
 * a faster serialisation must not change one byte. These values were recorded before the checkpoint path stopped
 * copying the simulator state; a change to what is hashed or how it is written fails here first.
 */
const PINNED = {
  pending: '7CkBRV6X1kYWlMFKcWZa+NFw8R0GRCN96EUfiWt0ob0=',
  planned: 'FXCL7sM27Biv+r58ofY9kXY4LgJeWD772YUyAawAHP8=',
  checkpoints: [
    'JzmN6opWqtoDZK8jO6kcMl/5VSo+fE+wL4E78Q0iiLA=',
    '4X9tJ0UVst3zvjhOmwgaF0aDUe4B82UWL1Djpc6VbLM=',
    '5q71XoBXSA/QW5sSEoBqKHa6LyW/YTvPdlJuM5B5CQw=',
  ],
  terminal: 'i7tsGjViaEB9qrqnNs3EFUnrTImQw9D6/I2EIM34z6A=',
};

/** T3 tutorial: a timed open and a one-time plan written through the raised phone, then 1,801 ticks (3 checkpoints). */
function scriptedRun(sliced = false) {
  const run = createRun(defaultHeader('checkpoint-pin', TUTORIAL_SCENARIO, 3));
  const post = (path: string, body: object) => {
    const response = run.request('POST', path, body);
    assert.ok(response.status < 400, JSON.stringify(response));
  };
  run.apply({kind: 'phoneOpen'});
  post(VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: 120});
  const pending = run.hash();
  post(PLANS_PATH + '/schedules', {kind: 'ONCE', fire_at: iso(run.now + 90 * MINUTE_MS), duration_minutes: 5});
  const planned = run.hash();
  run.apply({kind: 'phoneClose'});
  let hashSlices = 0;
  for (let i = 0; i < 226; i++) {
    run.step(i === 225 ? TICK_MS : 400, sliced);
    while (run.pendingWork) {
      if (run.pendingWork === 'checkpoint hash') hashSlices++;
      run.resumeStep();
    }
  }
  if (sliced) assert.ok(hashSlices > 3 * PINNED.checkpoints.length);
  const save = run.save();
  assert.equal(save.cursor.tick, 1801);
  return {save, hashes: {pending, planned, checkpoints: save.checkpoints, terminal: run.hash()}};
}

test('checkpoint hashes of a short scripted run stay byte-identical', () => {
  const {save, hashes} = scriptedRun();
  assert.deepEqual(hashes, PINNED);
  const sliced = scriptedRun(true);
  assert.deepEqual(sliced.hashes, PINNED);
  assert.equal(JSON.stringify(sliced.save), JSON.stringify(save));
  assert.deepEqual(loadRun(JSON.parse(JSON.stringify(save))).save().checkpoints, PINNED.checkpoints);
});

test('hashing the initial farm before play leaves its state and first checkpoint intact', () => {
  const header = defaultHeader('boot');
  const warmed = createRun(header);
  const cold = createRun(header);
  warmed.hash();
  assert.deepEqual(warmed.save(), cold.save());
  assert.deepEqual(warmed.eventsSince(0), cold.eventsSince(0));
  for (let i = 0; i < 75; i++) {
    warmed.step(400);
    cold.step(400);
  }
  assert.equal(warmed.save().checkpoints.length, 1);
  assert.deepEqual(warmed.save(), cold.save());
  assert.equal(warmed.hash(), cold.hash());
});

/** Fails on any value whose JSON could differ from the JSON of its structured clone: only plain data passes. */
function assertPlainData(value: unknown, path: string): void {
  if (value === null) return;
  if (typeof value !== 'object') {
    assert.ok(['string', 'number', 'boolean', 'undefined'].includes(typeof value), path + ' is ' + typeof value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  assert.ok(Array.isArray(value) ? proto === Array.prototype : proto === Object.prototype || proto === null,
    path + ' is not a plain object or array');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (Array.isArray(value) && key === 'length') continue;
    assert.ok(typeof key === 'string' && descriptor.enumerable && 'value' in descriptor && key !== 'toJSON',
      path + '.' + String(key) + ' is not a plain enumerable data property');
    assertPlainData(descriptor.value, path + '.' + String(key));
  }
}

test('the checkpoint digest writes the simulator\'s live state as the bytes of its detached snapshot', () => {
  const {adapter} = buildAdapter(4);
  const filled = new Set<string>();
  const check = (label: string) => {
    const live = adapter.simulatorDigestInputs();
    assertPlainData(live, label);
    const snapshot = JSON.stringify(adapter.simulatorSnapshot());
    assert.equal(JSON.stringify(live), snapshot, label);
    assert.equal([...adapter.digestJson()].join(''), snapshot, label);
    for (const [key, part] of Object.entries(live)) if (part.length > 0) filled.add(key);
  };
  check('built');
  write(adapter, 'POST', VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: 300});
  check('timed open pending its ACK');
  write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'ONCE', fire_at: iso(adapter.now + 60 * MINUTE_MS), duration_minutes: 5});
  check('one-time plan written');
  adapter.advance(adapter.now + 2 * MINUTE_MS);
  check('valve open');
  adapter.advance(atHour(2, 7));
  check('day 2 after the 06:00 trigger');
  // Every container the digest covers held data at least once, so no check above passed on empty state alone.
  assert.deepEqual([...filled].sort(), ['activeCommands', 'clockIds', 'devices', 'environmentRecords', 'outcomes',
    'readings', 'schedules', 'triggerEvaluations', 'valveSettings', 'zones']);
});

test('a save during a partial checkpoint finishes the original frame before dispatching queued input', () => {
  const header = defaultHeader('mid-checkpoint');
  const whole = createRun(header);
  const sliced = createRun(header);
  for (const run of [whole, sliced]) {
    for (let i = 0; i < 74; i++) run.step(400);
    run.step(100); // The eight-tick frame below has two ticks left after checkpoint 600.
  }
  whole.step(400);
  assert.equal(sliced.step(400, true), false);
  assert.equal(sliced.pendingWork, 'checkpoint hash');
  sliced.resumeStep();
  for (const run of [whole, sliced]) run.apply({kind: 'move', dx: 1, dy: 0});
  assert.equal(JSON.stringify(sliced.save()), JSON.stringify(whole.save()));
  assert.equal(sliced.pendingWork, undefined);
  assert.equal(sliced.hash(), whole.hash());
  assert.equal(JSON.stringify(sliced.eventsSince(0)), JSON.stringify(whole.eventsSince(0)));
});
