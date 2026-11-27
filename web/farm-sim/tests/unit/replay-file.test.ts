import assert from 'node:assert/strict';
import test from 'node:test';
import {createRun} from '../../src/core/replay';
import {defaultHeader} from '../../src/core/scenario';
import type {Save} from '../../src/core/types';
import {createReplayFileLoader} from '../../src/replay-file';

const save = createRun(defaultHeader('test')).save();

test('a replay file cannot load or report a read error after another run starts', async () => {
  let session = 1;
  const calls: unknown[] = [];
  const load = createReplayFileLoader({
    build: 'test', session: () => session,
    load: (value: Save) => calls.push(value), fail: (message: string) => calls.push(message),
  });
  for (const value of [JSON.stringify(save), new Error('Reading failed')]) {
    let finish!: () => void;
    const pending = load({text: () => new Promise((resolve, reject) => {
      finish = () => typeof value === 'string' ? resolve(value) : reject(value);
    })});
    session++;
    finish();
    await pending;
  }
  assert.deepEqual(calls, []);
});

test('a replay file loads or reports errors in the session that selected it', async () => {
  const calls: unknown[] = [];
  const load = createReplayFileLoader({
    build: 'test', session: () => 1,
    load: (value: Save) => calls.push(value), fail: (message: string) => calls.push(message),
  });
  await load({text: async () => JSON.stringify(save)});
  await load({text: async () => { throw new Error('Reading failed'); }});
  const foreign = {...save, header: {...save.header, build: 'other'}};
  await load({text: async () => JSON.stringify(foreign)});
  assert.deepEqual(calls, [save, 'Reading failed', 'This replay was made with a different game build.']);
});

test('only the latest replay selection can replace the run or report an error', async () => {
  let session = 1;
  const calls: unknown[] = [];
  const load = createReplayFileLoader({
    build: 'test', session: () => session,
    load: value => { calls.push(value); session++; }, fail: message => calls.push(message),
  });
  let completeOlder!: (text: string) => void;
  let rejectOlder!: (error: Error) => void;
  let completeLatest!: (text: string) => void;
  const older = load({text: () => new Promise(resolve => { completeOlder = resolve; })});
  const failing = load({text: () => new Promise((_, reject) => { rejectOlder = reject; })});
  const latest = load({text: () => new Promise(resolve => { completeLatest = resolve; })});
  completeOlder(JSON.stringify(save));
  rejectOlder(new Error('Stale read failed'));
  await Promise.all([older, failing]);
  assert.deepEqual(calls, []);
  const newestSave = createRun({...defaultHeader('test'), tier: 4}).save();
  completeLatest(JSON.stringify(newestSave));
  await latest;
  assert.deepEqual(calls, [newestSave]);
});
