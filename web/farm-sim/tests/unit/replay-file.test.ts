import assert from 'node:assert/strict';
import test from 'node:test';
import {createRun} from '../../src/core/replay';
import {defaultHeader} from '../../src/core/scenario';
import type {Save} from '../../src/core/types';
import {loadReplayFile} from '../../src/replay-file';

const save = createRun(defaultHeader('test')).save();

test('a replay file cannot load or report a read error after another run starts', async () => {
  let session = 1;
  const calls: unknown[] = [];
  const target = {
    build: 'test', session: () => session,
    load: (value: Save) => calls.push(value), fail: (message: string) => calls.push(message),
  };
  let complete!: (text: string) => void;
  let reject!: (error: Error) => void;
  const good = loadReplayFile({text: () => new Promise(resolve => { complete = resolve; })}, target);
  const bad = loadReplayFile({text: () => new Promise((_, fail) => { reject = fail; })}, target);
  session++;
  complete(JSON.stringify(save));
  reject(new Error('Reading failed'));
  await Promise.all([good, bad]);
  assert.deepEqual(calls, []);
});

test('a replay file loads or reports errors in the session that selected it', async () => {
  const calls: unknown[] = [];
  const target = {
    build: 'test', session: () => 1,
    load: (value: Save) => calls.push(value), fail: (message: string) => calls.push(message),
  };
  await loadReplayFile({text: async () => JSON.stringify(save)}, target);
  await loadReplayFile({text: async () => { throw new Error('Reading failed'); }}, target);
  const foreign = {...save, header: {...save.header, build: 'other'}};
  await loadReplayFile({text: async () => JSON.stringify(foreign)}, target);
  assert.deepEqual(calls, [save, 'Reading failed', 'This replay was made with a different game build.']);
});
