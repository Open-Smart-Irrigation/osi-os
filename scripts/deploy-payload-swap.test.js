'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  stagePayload,
  flipTo,
  currentStamp,
  previousStamp,
  rollback,
  prunePayloads,
} = require('./deploy-payload-swap');

function fakeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'srv-node-red-'));
}

function fakeFlowsSrc(dir, marker) {
  const src = path.join(dir, 'flows-src.json');
  fs.writeFileSync(src, JSON.stringify([{ id: 'x', marker }]));
  return src;
}

test('stagePayload writes payloads/<stamp>/flows.json without touching the live symlink', () => {
  const root = fakeRoot();
  const src = fakeFlowsSrc(root, 'v1');
  const dir = stagePayload(root, '20260508T100000Z', src);

  assert.equal(dir, path.join(root, 'payloads', '20260508T100000Z'));
  assert.ok(fs.existsSync(path.join(dir, 'flows.json')));
  assert.equal(currentStamp(root), null, 'no flip yet - nothing live');
});

test('flipTo atomically points flows.json at the staged payload; currentStamp reads it back', () => {
  const root = fakeRoot();
  const src = fakeFlowsSrc(root, 'v1');
  stagePayload(root, 'stampA', src);

  const { target } = flipTo(root, 'stampA');
  const link = path.join(root, 'flows.json');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(link), fs.realpathSync(target));
  assert.equal(currentStamp(root), 'stampA');
  assert.match(fs.readFileSync(link, 'utf8'), /v1/);
});

test('flipTo over an existing symlink is atomic replacement', () => {
  const root = fakeRoot();
  stagePayload(root, 'stampA', fakeFlowsSrc(root, 'v1'));
  stagePayload(root, 'stampB', fakeFlowsSrc(root, 'v2'));

  flipTo(root, 'stampA');
  flipTo(root, 'stampB');

  assert.equal(currentStamp(root), 'stampB');
  assert.match(fs.readFileSync(path.join(root, 'flows.json'), 'utf8'), /v2/);
});

test('flipTo migrates an in-place regular flows.json file to the symlink layout', () => {
  const root = fakeRoot();
  fs.writeFileSync(path.join(root, 'flows.json'), JSON.stringify([{ id: 'legacy' }]));
  stagePayload(root, 'stampA', fakeFlowsSrc(root, 'v1'));

  flipTo(root, 'stampA');

  assert.ok(fs.lstatSync(path.join(root, 'flows.json')).isSymbolicLink(), 'regular file replaced by symlink');
  assert.equal(currentStamp(root), 'stampA');
});

test('previousStamp returns the newest retained non-current stamp', () => {
  const root = fakeRoot();
  stagePayload(root, '20260501T000000Z', fakeFlowsSrc(root, 'old'));
  stagePayload(root, '20260502T000000Z', fakeFlowsSrc(root, 'new'));
  flipTo(root, '20260501T000000Z');
  flipTo(root, '20260502T000000Z');

  assert.equal(previousStamp(root), '20260501T000000Z');
});

test('rollback flips back to the previous payload', () => {
  const root = fakeRoot();
  stagePayload(root, 'good', fakeFlowsSrc(root, 'GOOD'));
  stagePayload(root, 'bad', fakeFlowsSrc(root, 'BAD'));
  flipTo(root, 'good');
  flipTo(root, 'bad');

  const { flippedTo } = rollback(root);

  assert.equal(flippedTo, 'good');
  assert.equal(currentStamp(root), 'good');
  assert.match(fs.readFileSync(path.join(root, 'flows.json'), 'utf8'), /GOOD/);
});

test('rollback throws when there is no previous payload to fall back to', () => {
  const root = fakeRoot();
  stagePayload(root, 'only', fakeFlowsSrc(root, 'ONLY'));
  flipTo(root, 'only');

  assert.throws(() => rollback(root), /no previous payload/i);
});

test('prunePayloads keeps the newest N and never removes the current target', () => {
  const root = fakeRoot();
  for (const stamp of ['20260501', '20260502', '20260503', '20260504']) {
    stagePayload(root, stamp, fakeFlowsSrc(root, stamp));
  }
  flipTo(root, '20260501');

  const { removed } = prunePayloads(root, 2);
  const remaining = fs.readdirSync(path.join(root, 'payloads')).sort();

  assert.ok(remaining.includes('20260501'), 'current target is never pruned');
  assert.ok(remaining.includes('20260504'), 'newest is retained');
  assert.ok(remaining.length <= 3, `keepN=2 plus protected current: got ${remaining.join(',')}`);
  assert.ok(removed.length >= 1);
});
