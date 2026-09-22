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
  currentPair,
  captureGui,
  captureExisting,
  legacyCaptureStamp,
  clearLegacyCapture,
  verifyPair,
  writeCompatibility,
  compatibilityExists,
  verifyCompatibility,
  deactivate,
  discardPayload,
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

function fakeGuiSrc(dir, marker) {
  const gui = path.join(dir, `gui-${marker}`);
  fs.mkdirSync(gui);
  fs.writeFileSync(path.join(gui, 'index.html'), `<title>${marker}</title>\n`);
  return gui;
}

test('stagePayload writes payloads/<stamp>/flows.json without touching the live symlink', () => {
  const root = fakeRoot();
  const src = fakeFlowsSrc(root, 'v1');
  const dir = stagePayload(root, '20260508T100000Z', src);

  assert.equal(dir, path.join(root, 'payloads', '20260508T100000Z'));
  assert.ok(fs.existsSync(path.join(dir, 'flows.json')));
  assert.equal(currentStamp(root), null, 'no flip yet - nothing live');
});

test('stagePayload stages flows and GUI as one versioned payload before activation', () => {
  const root = fakeRoot();
  const flows = fakeFlowsSrc(root, 'v1');
  const gui = fakeGuiSrc(root, 'v1');
  const dir = stagePayload(root, 'pairA', flows, gui);

  assert.ok(fs.existsSync(path.join(dir, 'flows.json')));
  assert.ok(fs.existsSync(path.join(dir, 'gui', 'index.html')));
  assert.equal(currentPair(root, path.join(root, 'gui')), null, 'staging must not activate either half');
});

test('flipTo activates a flows and GUI version pair together', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  const flows = fakeFlowsSrc(root, 'v1');
  const gui = fakeGuiSrc(root, 'v1');
  stagePayload(root, 'pairA', flows, gui);

  flipTo(root, 'pairA', guiRoot);

  assert.deepEqual(currentPair(root, guiRoot), { flows: 'pairA', gui: 'pairA', compatible: true });
  assert.equal(verifyPair(root, 'pairA', guiRoot), true);
  assert.match(fs.readFileSync(path.join(guiRoot, 'index.html'), 'utf8'), /v1/);
});

test('captureGui preserves an existing regular GUI beside its current flows payload', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  const flows = fakeFlowsSrc(root, 'old');
  const oldGui = fakeGuiSrc(root, 'old');
  stagePayload(root, 'old', flows);
  flipTo(root, 'old');
  fs.mkdirSync(guiRoot);
  fs.copyFileSync(path.join(oldGui, 'index.html'), path.join(guiRoot, 'index.html'));

  captureGui(root, 'old', guiRoot);
  assert.equal(verifyPair(root, 'old'), true, 'captured GUI must complete the retained payload');
});

test('captureExisting turns an existing regular flows+GUI install into a rollback pair', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  const flows = path.join(root, 'flows.json');
  fs.writeFileSync(flows, JSON.stringify([{ marker: 'legacy' }]));
  fs.mkdirSync(guiRoot);
  fs.writeFileSync(path.join(guiRoot, 'index.html'), '<title>legacy</title>\n');

  captureExisting(root, 'legacy', flows, guiRoot);
  flipTo(root, 'legacy', guiRoot);
  assert.deepEqual(currentPair(root, guiRoot), { flows: 'legacy', gui: 'legacy', compatible: true });
});

test('legacy capture evidence is reused and refuses changed regular files', () => {
  const root = fakeRoot();
  const flowsPath = path.join(root, 'flows.json');
  const guiRoot = path.join(root, 'gui');
  fs.writeFileSync(flowsPath, JSON.stringify([{ id: 'legacy' }]) + '\n');
  fs.mkdirSync(guiRoot);
  fs.writeFileSync(path.join(guiRoot, 'index.html'), '<title>legacy</title>\n');

  captureExisting(root, 'legacy-first', flowsPath, guiRoot);
  assert.equal(legacyCaptureStamp(root, flowsPath, guiRoot), 'legacy-first');
  assert.equal(captureExisting(root, 'legacy-retry', flowsPath, guiRoot), path.join(root, 'payloads', 'legacy-first'));
  clearLegacyCapture(root);
  assert.equal(legacyCaptureStamp(root, flowsPath, guiRoot), null);
  captureExisting(root, 'legacy-second', flowsPath, guiRoot);
  fs.appendFileSync(flowsPath, 'changed\n');
  assert.throws(() => legacyCaptureStamp(root, flowsPath, guiRoot), /refusing to recapture changed legacy files/);
});

test('failed first activation explicitly removes both live links and the staged payload', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  stagePayload(root, 'first', fakeFlowsSrc(root, 'first'), fakeGuiSrc(root, 'first'));
  flipTo(root, 'first', guiRoot);
  deactivate(root, 'first', guiRoot);
  discardPayload(root, 'first');

  assert.equal(currentStamp(root), null);
  assert.equal(currentPair(root, guiRoot), null);
  assert.equal(fs.existsSync(path.join(root, 'payloads', 'first')), false);
});

test('forced activation failure before the flip leaves the prior pair untouched', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  stagePayload(root, 'old', fakeFlowsSrc(root, 'old'), fakeGuiSrc(root, 'old'));
  flipTo(root, 'old', guiRoot);

  assert.throws(() => flipTo(root, 'new', guiRoot), /staged payload missing/i);
  assert.deepEqual(currentPair(root, guiRoot), { flows: 'old', gui: 'old', compatible: true });
});

test('forced activation failure after the flow flip restores the prior flow pair', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'blocked', 'gui');
  fs.writeFileSync(path.join(root, 'blocked'), 'not a directory');
  stagePayload(root, 'new', fakeFlowsSrc(root, 'new'), fakeGuiSrc(root, 'new'));

  assert.throws(() => flipTo(root, 'new', guiRoot), /GUI flip|ENOTDIR|EEXIST|not a directory/i);
  assert.equal(currentStamp(root), null, 'a failed first activation must not leave the flow half active');
  assert.equal(fs.existsSync(guiRoot), false, 'a failed first activation must not create a GUI half');
});

test('GUI activation failure preserves existing regular flows and GUI files', () => {
  const root = fakeRoot();
  const flowsPath = path.join(root, 'flows.json');
  const guiRoot = path.join(root, 'gui');
  fs.writeFileSync(flowsPath, JSON.stringify([{ marker: 'legacy' }]) + '\n');
  fs.mkdirSync(guiRoot);
  fs.writeFileSync(path.join(guiRoot, 'index.html'), '<title>legacy</title>\n');
  stagePayload(root, 'new', fakeFlowsSrc(root, 'new'), fakeGuiSrc(root, 'new'));

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === guiRoot && String(from).includes('.gui.flip-')) {
      throw new Error('forced GUI replacement failure');
    }
    return realRename(from, to);
  };
  try {
    assert.throws(() => flipTo(root, 'new', guiRoot), /GUI flip|forced GUI replacement failure/i);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.lstatSync(flowsPath).isSymbolicLink(), false);
  assert.match(fs.readFileSync(flowsPath, 'utf8'), /legacy/);
  assert.match(fs.readFileSync(path.join(guiRoot, 'index.html'), 'utf8'), /legacy/);
});

test('rollback fixture restores a compatible flows and GUI pair', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  stagePayload(root, 'good', fakeFlowsSrc(root, 'good'), fakeGuiSrc(root, 'good'));
  stagePayload(root, 'bad', fakeFlowsSrc(root, 'bad'), fakeGuiSrc(root, 'bad'));
  flipTo(root, 'good', guiRoot);
  flipTo(root, 'bad', guiRoot);
  flipTo(root, 'good', guiRoot);

  assert.deepEqual(currentPair(root, guiRoot), { flows: 'good', gui: 'good', compatible: true });
  assert.equal(verifyPair(root, 'good', guiRoot), true);
});

test('retained payload compatibility requires the exact migrated schema head and ledger', () => {
  const root = fakeRoot();
  stagePayload(root, 'old', fakeFlowsSrc(root, 'old'), fakeGuiSrc(root, 'old'));
  writeCompatibility(root, 'old', '12', '1:a,2:b,12:c');

  assert.equal(verifyCompatibility(root, 'old', '12', '1:a,2:b,12:c'), true);
  assert.equal(verifyCompatibility(root, 'old', '13', '1:a,2:b,12:c,13:d'), false,
    'a retained payload recorded before migration must be refused after the DB head changes');
  assert.equal(verifyCompatibility(root, 'old', '12', '1:a,2:changed,12:c'), false,
    'a retained payload must be refused when the ledger checksum set differs');
});

test('compatibility metadata is immutable across a retry after a committed migration', () => {
  const root = fakeRoot();
  stagePayload(root, 'old', fakeFlowsSrc(root, 'old'), fakeGuiSrc(root, 'old'));
  writeCompatibility(root, 'old', '12', '1:a,2:b,12:c');

  assert.equal(compatibilityExists(root, 'old'), true);
  assert.throws(
    () => writeCompatibility(root, 'old', '13', '1:a,2:b,12:c,13:d'),
    /refusing to overwrite existing metadata/
  );
  assert.equal(verifyCompatibility(root, 'old', '12', '1:a,2:b,12:c'), true);
  assert.equal(verifyCompatibility(root, 'old', '13', '1:a,2:b,12:c,13:d'), false);
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
