'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every fixture directory this file makes is removed when the run ends, so
// repeated runs do not fill the temporary directory.
const madeFixtureDirs = [];
const realMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (...args) {
  const dir = realMkdtempSync.apply(this, args);
  madeFixtureDirs.push(dir);
  return dir;
};
process.on('exit', () => {
  for (const dir of madeFixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const {
  stagePayload,
  flipTo,
  currentStamp,
  currentPair,
  captureGui,
  captureExisting,
  legacyCaptureStamp,
  legacyCapturePreflight,
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

// A regular flows file and GUI directory, as on a gateway the payload layout
// has not reached yet or after a sysupgrade reset the GUI link.
function legacyRoot(t) {
  const root = fakeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const flowsPath = path.join(root, 'flows.json');
  const guiRoot = path.join(root, 'gui');
  fs.writeFileSync(flowsPath, JSON.stringify([{ id: 'legacy' }]) + '\n');
  fs.mkdirSync(guiRoot);
  fs.writeFileSync(path.join(guiRoot, 'index.html'), '<title>legacy</title>\n');
  const marker = path.join(root, 'payloads', '.legacy-capture.json');
  return { root, flowsPath, guiRoot, marker };
}

test('legacyCapturePreflight moves a marker whose capture is gone aside, and the capture starts fresh', (t) => {
  for (const changedSince of [false, true]) {
    const { root, flowsPath, guiRoot, marker } = legacyRoot(t);
    captureExisting(root, 'pruned-previous', flowsPath, guiRoot);
    fs.rmSync(path.join(root, 'payloads', 'pruned-previous'), { recursive: true, force: true });
    if (changedSince) fs.appendFileSync(flowsPath, 'deployed later\n');
    assert.throws(() => legacyCaptureStamp(root, flowsPath, guiRoot), /refusing to recapture changed legacy files/,
      'the capture block alone still refuses a stale marker');

    const report = legacyCapturePreflight(root, flowsPath, guiRoot);
    assert.match(report, /^WARN: stale legacy-capture marker \(payload pruned-previous gone\); moved to payloads\/\.legacy-capture\.json\.stale-\d+-\d+; recapturing$/);
    assert.equal(fs.existsSync(marker), false);
    const aside = fs.readdirSync(path.join(root, 'payloads')).filter((entry) => entry.startsWith('.legacy-capture.json.stale-'));
    assert.equal(aside.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'payloads', aside[0]), 'utf8')).stamp, 'pruned-previous');

    assert.equal(legacyCaptureStamp(root, flowsPath, guiRoot), null);
    captureExisting(root, 'new-previous', flowsPath, guiRoot);
    assert.equal(legacyCaptureStamp(root, flowsPath, guiRoot), 'new-previous');
    assert.equal(fs.readFileSync(path.join(root, 'payloads', 'new-previous', 'flows.json'), 'utf8'),
      fs.readFileSync(flowsPath, 'utf8'), 'the fresh capture holds the live flows');
    assert.deepEqual(prunePayloads(root, 5), { removed: [] }, 'the moved marker is not a payload');
  }
});

test('legacyCapturePreflight reuses an existing capture and refuses when the live files changed', (t) => {
  const { root, flowsPath, guiRoot, marker } = legacyRoot(t);
  captureExisting(root, 'kept-previous', flowsPath, guiRoot);
  assert.equal(legacyCapturePreflight(root, flowsPath, guiRoot), null);
  assert.equal(legacyCaptureStamp(root, flowsPath, guiRoot), 'kept-previous');
  fs.appendFileSync(flowsPath, 'changed\n');
  assert.throws(() => legacyCapturePreflight(root, flowsPath, guiRoot), /refusing to recapture changed legacy files/);
  assert.equal(fs.existsSync(marker), true, 'a refusal leaves the marker in place');
});

test('legacyCapturePreflight refuses a stale marker while flows point into the payload of the attempt that wrote it', (t) => {
  const { root, flowsPath, guiRoot, marker } = legacyRoot(t);
  captureExisting(root, 'cut-previous', flowsPath, guiRoot);
  stagePayload(root, 'cut', fakeFlowsSrc(root, 'cut'), fakeGuiSrc(root, 'cut'));
  // Power lost inside flipTo('cut'): flows switched, the GUI not yet.
  fs.rmSync(flowsPath);
  fs.symlinkSync(path.join('payloads', 'cut', 'flows.json'), flowsPath);
  fs.rmSync(path.join(root, 'payloads', 'cut-previous'), { recursive: true, force: true });
  const before = fs.readFileSync(marker, 'utf8');

  assert.throws(() => legacyCapturePreflight(root, flowsPath, guiRoot),
    /live flows point into payloads\/cut from the deploy that wrote it; refusing to capture a half-switched state/);
  assert.equal(fs.readFileSync(marker, 'utf8'), before, 'the marker stays for the operator');
});

test('legacyCapturePreflight refuses a stale marker it cannot attribute and a malformed one', (t) => {
  const { root, flowsPath, guiRoot, marker } = legacyRoot(t);
  captureExisting(root, 'handmade', flowsPath, guiRoot);
  fs.rmSync(path.join(root, 'payloads', 'handmade'), { recursive: true, force: true });
  assert.throws(() => legacyCapturePreflight(root, flowsPath, guiRoot), /no deploy attempt can be read from it/);
  assert.equal(fs.existsSync(marker), true);

  const evidence = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, JSON.stringify({ ...evidence, stamp: '../outside-previous' }) + '\n');
  assert.throws(() => legacyCapturePreflight(root, flowsPath, guiRoot), /refusing to recapture changed legacy files/);
  fs.writeFileSync(marker, 'not json\n');
  assert.throws(() => legacyCapturePreflight(root, flowsPath, guiRoot), /legacy evidence is unreadable/);
  assert.equal(fs.existsSync(marker), true);
});

test('legacyCapturePreflight leaves the marker alone when the capture block would not read it', (t) => {
  const { root, flowsPath, guiRoot, marker } = legacyRoot(t);
  assert.equal(legacyCapturePreflight(root, flowsPath, guiRoot), null, 'no marker');

  captureExisting(root, 'gone-previous', flowsPath, guiRoot);
  fs.rmSync(path.join(root, 'payloads', 'gone-previous'), { recursive: true, force: true });
  const before = fs.readFileSync(marker, 'utf8');
  // Flows and GUI already one payload: deploy.sh never consults the marker.
  stagePayload(root, 'live', fakeFlowsSrc(root, 'live'), fakeGuiSrc(root, 'live'));
  flipTo(root, 'live', guiRoot);
  assert.equal(legacyCapturePreflight(root, flowsPath, guiRoot), null, 'paired payload');
  assert.equal(fs.readFileSync(marker, 'utf8'), before);
  // No GUI directory: deploy.sh skips the retained-pair capture.
  fs.rmSync(guiRoot);
  assert.equal(legacyCapturePreflight(root, flowsPath, guiRoot), null, 'GUI missing');
  assert.equal(fs.readFileSync(marker, 'utf8'), before);
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
  const remaining = fs.readdirSync(path.join(root, 'payloads')).filter((entry) => !entry.startsWith('.') && entry !== 'active').sort();

  assert.ok(remaining.includes('20260501'), 'current target is never pruned');
  assert.ok(remaining.includes('20260504'), 'newest is retained');
  assert.ok(remaining.length <= 3, `keepN=2 plus protected current: got ${remaining.join(',')}`);
  assert.ok(removed.length >= 1);
});

// Helper modules (issue #603). deploy.sh fetches each osi-* module into
// payloads/<stamp>/modules/<module>/ and /srv/node-red/<module> is a link into
// the active payload, switched by flipTo() together with flows and GUI.
const swap = require('./deploy-payload-swap');
const { spawnSync } = require('node:child_process');

function moduleRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-node-red-modules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'payloads'));
  // The command-ledger pair stays a live directory outside every payload.
  writeModule(path.join(root, 'osi-command-ledger'), 'ledger-live', "exports.binding = require('../osi-watermark-binding/canonicalization');\n");
  fs.mkdirSync(path.join(root, 'osi-watermark-binding'));
  fs.writeFileSync(path.join(root, 'osi-watermark-binding', 'canonicalization.js'), "module.exports = 'binding-live';\n");
  // Runtime files deploy.sh still writes in place.
  fs.mkdirSync(path.join(root, 'codecs'));
  fs.writeFileSync(path.join(root, 'codecs', 'decoder.js'), '// live codec\n');
  fs.writeFileSync(path.join(root, 'edge-channels.json'), '{"channels":"live"}\n');
  return root;
}

function writeModule(dir, marker, extra = '') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), version: '1.0.0', main: 'index.js' }) + '\n');
  fs.writeFileSync(path.join(dir, 'index.js'), `exports.marker = ${JSON.stringify(marker)};\n${extra}`);
}

// Stages flows, GUI and the named modules the way deploy.sh does, then seals.
function stageWithModules(root, stamp, modules) {
  stagePayload(root, stamp, fakeFlowsSrcAt(root, stamp), fakeGuiSrcAt(root, stamp));
  for (const [name, extra] of Object.entries(modules)) {
    writeModule(path.join(root, 'payloads', stamp, 'modules', name), `${name}@${stamp}`, extra || '');
  }
  return swap.sealModules(root, stamp);
}

function fakeFlowsSrcAt(root, marker) {
  const src = path.join(root, `flows-src-${marker}.json`);
  fs.writeFileSync(src, JSON.stringify([{ id: 'x', marker }]));
  return src;
}

function fakeGuiSrcAt(root, marker) {
  const gui = path.join(root, `gui-src-${marker}`);
  fs.mkdirSync(gui);
  fs.writeFileSync(path.join(gui, 'index.html'), `<title>${marker}</title>\n`);
  return gui;
}

// Loads modules in a fresh process, the way Node-RED does after a restart:
// osi-lib through /srv/node-red/<module>, libs through node_modules/<module>.
function loadMarkers(root, names, via = '') {
  const result = spawnSync(process.execPath, ['-e', `
    const path = require('path');
    const out = {};
    for (const name of JSON.parse(process.argv[2])) {
      try { out[name] = require(path.join(process.argv[1], process.argv[3], name)).marker; }
      catch (error) { out[name] = 'ERROR ' + error.code; }
    }
    process.stdout.write(JSON.stringify(out));
  `, root, JSON.stringify(names), via], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function linkTarget(root, name) {
  return path.relative(root, fs.realpathSync(path.join(root, name)));
}

test('sealModules records the staged module set and links the live command-ledger pair', (t) => {
  const root = moduleRoot(t);
  const sealed = stageWithModules(root, 'new', { 'osi-b': '', 'osi-a': '' });

  assert.deepEqual(sealed, ['osi-a', 'osi-b']);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'payloads', 'new', 'modules.json'), 'utf8'));
  assert.deepEqual(manifest, { format: 1, modules: ['osi-a', 'osi-b'], captured: {} });
  assert.deepEqual([...swap.LIVE_ENTRIES].sort(), ['codecs', 'edge-channels.json', 'osi-command-ledger', 'osi-watermark-binding']);
  for (const name of swap.LIVE_ENTRIES) {
    const link = path.join(root, 'payloads', 'new', 'modules', name);
    assert.equal(fs.readlinkSync(link), path.join('..', '..', '..', name));
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(root, name)));
  }
  assert.throws(() => swap.sealModules(root, 'new'), /already sealed/);
});

test('sealModules refuses a module without package.json and a staged command-ledger copy', (t) => {
  const root = moduleRoot(t);
  stagePayload(root, 'partial', fakeFlowsSrcAt(root, 'partial'));
  fs.mkdirSync(path.join(root, 'payloads', 'partial', 'modules', 'osi-a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'payloads', 'partial', 'modules', 'osi-a', 'index.js'), '');
  assert.throws(() => swap.sealModules(root, 'partial'), /osi-a.*package\.json/);

  stagePayload(root, 'ledger', fakeFlowsSrcAt(root, 'ledger'));
  writeModule(path.join(root, 'payloads', 'ledger', 'modules', 'osi-command-ledger'), 'staged');
  assert.throws(() => swap.sealModules(root, 'ledger'), /osi-command-ledger.*outside the payload/);
  assert.equal(fs.existsSync(path.join(root, 'payloads', 'ledger', 'modules.json')), false);

  stagePayload(root, 'codecs', fakeFlowsSrcAt(root, 'codecs'));
  writeModule(path.join(root, 'payloads', 'codecs', 'modules', 'osi-a'), 'a');
  fs.mkdirSync(path.join(root, 'payloads', 'codecs', 'modules', 'codecs'));
  assert.throws(() => swap.sealModules(root, 'codecs'), /codecs.*outside the payload/);
});

test('flipTo switches helper modules with flows and GUI, and rollback restores them', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, 'old', { 'osi-a': '', 'osi-gone': '' });
  stageWithModules(root, 'new', { 'osi-a': '', 'osi-new': '' });

  flipTo(root, 'old', guiRoot);
  assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-gone']), { 'osi-a': 'osi-a@old', 'osi-gone': 'osi-gone@old' });

  flipTo(root, 'new', guiRoot);
  assert.equal(verifyPair(root, 'new', guiRoot), true);
  assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-new', 'osi-gone']),
    { 'osi-a': 'osi-a@new', 'osi-new': 'osi-new@new', 'osi-gone': 'ERROR MODULE_NOT_FOUND' },
    'a module the target payload does not carry is removed with the flip');

  flipTo(root, 'old', guiRoot);
  assert.deepEqual(currentPair(root, guiRoot), { flows: 'old', gui: 'old', compatible: true });
  assert.equal(verifyPair(root, 'old', guiRoot), true);
  assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-gone', 'osi-new']),
    { 'osi-a': 'osi-a@old', 'osi-gone': 'osi-gone@old', 'osi-new': 'ERROR MODULE_NOT_FOUND' });
});

test('node_modules links and relative requires follow the active payload', (t) => {
  const root = moduleRoot(t);
  stageWithModules(root, 'old', {
    'osi-a': "exports.sibling = require('../osi-b').marker;\nexports.ledger = require('../osi-command-ledger');\n",
    'osi-b': '',
  });
  stageWithModules(root, 'new', {
    'osi-a': "exports.sibling = require('../osi-b').marker;\n" +
      "exports.channels = require('../edge-channels.json').channels;\n" +
      "exports.codec = require('fs').readFileSync(require('path').resolve(__dirname, '../codecs/decoder.js'), 'utf8');\n",
    'osi-b': '',
  });
  // npm creates node_modules/<module> -> ../<module> for each file: dependency.
  fs.mkdirSync(path.join(root, 'node_modules'));
  for (const name of ['osi-a', 'osi-b']) fs.symlinkSync(path.join('..', name), path.join(root, 'node_modules', name));

  flipTo(root, 'old', path.join(root, 'gui'));
  const probe = (expression) => spawnSync(process.execPath, ['-e', `
    const path = require('path'); const root = process.argv[1];
    process.stdout.write(JSON.stringify(${expression}));
  `, root], { encoding: 'utf8' });
  let out = probe("[require(path.join(root, 'node_modules', 'osi-a')).sibling, require(path.join(root, 'osi-a')).ledger.binding, require(path.join(root, 'node_modules', 'osi-a')).ledger === require(path.join(root, 'osi-command-ledger'))]");
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), ['osi-b@old', 'binding-live', true],
    'a staged module reaches its own siblings and the single live command-ledger instance');

  flipTo(root, 'new', path.join(root, 'gui'));
  out = probe("(({ sibling, channels, codec }) => [sibling, channels, codec])(require(path.join(root, 'node_modules', 'osi-a')))");
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), ['osi-b@new', 'live', '// live codec\n'],
    'edge-channels.json and the codecs stay in place and are reached from the payload');
});

test('a failed payload switch leaves flows, GUI and every module on the old payload', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, 'old', { 'osi-a': '', 'osi-b': '' });
  stageWithModules(root, 'new', { 'osi-a': '', 'osi-b': '' });
  flipTo(root, 'old', guiRoot);

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(root, 'payloads', 'active')) throw new Error('forced switch failure');
    return realRename(from, to);
  };
  try {
    assert.throws(() => flipTo(root, 'new', guiRoot), /payload switch to new.*forced switch failure/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(currentPair(root, guiRoot), { flows: 'old', gui: 'old', compatible: true });
  assert.equal(verifyPair(root, 'old', guiRoot), true);
  assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-b']), { 'osi-a': 'osi-a@old', 'osi-b': 'osi-b@old' });
});

test('flipTo refuses an unsealed module set and a module-less payload while modules are linked', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, 'sealed', { 'osi-a': '' });
  stagePayload(root, 'unsealed', fakeFlowsSrcAt(root, 'unsealed'), fakeGuiSrcAt(root, 'unsealed'));
  writeModule(path.join(root, 'payloads', 'unsealed', 'modules', 'osi-a'), 'half');
  stagePayload(root, 'legacy', fakeFlowsSrcAt(root, 'legacy'), fakeGuiSrcAt(root, 'legacy'));
  flipTo(root, 'sealed', guiRoot);

  assert.throws(() => flipTo(root, 'unsealed', guiRoot), /unsealed modules directory/);
  assert.equal(verifyPair(root, 'unsealed'), false);
  assert.throws(() => flipTo(root, 'legacy', guiRoot), /carries no helper modules.*osi-a/);
  assert.equal(verifyPair(root, 'legacy', guiRoot), false);
  assert.deepEqual(currentPair(root, guiRoot), { flows: 'sealed', gui: 'sealed', compatible: true });
  assert.equal(verifyPair(root, 'sealed', guiRoot), true);
});

test('verifyPair rejects a payload whose module links point elsewhere or whose module is missing', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, 'a', { 'osi-a': '' });
  stageWithModules(root, 'b', { 'osi-a': '' });
  flipTo(root, 'a', guiRoot);
  fs.rmSync(path.join(root, 'osi-a'));
  fs.symlinkSync(path.join('payloads', 'b', 'modules', 'osi-a'), path.join(root, 'osi-a'));
  assert.equal(verifyPair(root, 'a', guiRoot), false, 'flows on a, module on b is not a verified pair');

  fs.rmSync(path.join(root, 'payloads', 'b', 'modules', 'osi-a'), { recursive: true });
  assert.equal(verifyPair(root, 'b'), false, 'a sealed module that is gone makes the payload incomplete');
});

test('captureModules copies live module directories into the previous payload with evidence', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  // A v0.8.1 gateway: flows+GUI already a payload, helper modules real directories.
  stagePayload(root, 'prev', fakeFlowsSrcAt(root, 'prev'), fakeGuiSrcAt(root, 'prev'));
  flipTo(root, 'prev', guiRoot);
  writeModule(path.join(root, 'osi-a'), 'osi-a@live');
  fs.mkdirSync(path.join(root, 'osi-a', 'lib'));
  fs.writeFileSync(path.join(root, 'osi-a', 'lib', 'part.js'), 'module.exports = 1;\n');
  writeModule(path.join(root, 'osi-unmanaged'), 'unmanaged@live');
  stageWithModules(root, 'new', { 'osi-a': '', 'osi-new': '' });

  const report = swap.captureModules(root, 'prev', 'new');
  assert.match(report, /captured osi-a into payloads\/prev\/modules/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'payloads', 'prev', 'modules.json'), 'utf8'));
  assert.deepEqual(manifest.modules, ['osi-a']);
  assert.match(manifest.captured['osi-a'], /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(path.join(root, 'payloads', 'prev', 'modules', 'osi-a', 'lib', 'part.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.lstatSync(path.join(root, 'osi-a')).isDirectory(), true, 'capture never touches the live directory');
  assert.equal(verifyPair(root, 'prev'), true);

  assert.equal(swap.captureModules(root, 'prev', 'new'), '', 'a second capture with unchanged live files is a no-op');

  flipTo(root, 'new', guiRoot);
  assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-new', 'osi-unmanaged']),
    { 'osi-a': 'osi-a@new', 'osi-new': 'osi-new@new', 'osi-unmanaged': 'unmanaged@live' });
  flipTo(root, 'prev', guiRoot);
  assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-new', 'osi-unmanaged']),
    { 'osi-a': 'osi-a@live', 'osi-new': 'ERROR MODULE_NOT_FOUND', 'osi-unmanaged': 'unmanaged@live' },
    'rollback restores the captured module, removes the new one and leaves unmanaged directories alone');
  assert.equal(linkTarget(root, 'osi-a'), path.join('payloads', 'prev', 'modules', 'osi-a'));
});

test('captureModules refuses a live module that changed after it was captured', (t) => {
  const root = moduleRoot(t);
  stagePayload(root, 'prev', fakeFlowsSrcAt(root, 'prev'), fakeGuiSrcAt(root, 'prev'));
  writeModule(path.join(root, 'osi-a'), 'osi-a@live');
  stageWithModules(root, 'first', { 'osi-a': '' });
  swap.captureModules(root, 'prev', 'first');

  fs.appendFileSync(path.join(root, 'osi-a', 'index.js'), '// changed in place\n');
  stageWithModules(root, 'second', { 'osi-a': '' });
  assert.throws(() => swap.captureModules(root, 'prev', 'second'), /refusing to recapture changed live module osi-a/);
});

test('captureModules keeps a payload-staged copy over a real directory and warns', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, 'prev', { 'osi-a': '' });
  flipTo(root, 'prev', guiRoot);
  // An image seed that predates the payload layout replaces the link with its own copy.
  fs.rmSync(path.join(root, 'osi-a'));
  writeModule(path.join(root, 'osi-a'), 'osi-a@image');
  stageWithModules(root, 'new', { 'osi-a': '' });

  assert.match(swap.captureModules(root, 'prev', 'new'), /WARN: osi-a .*differs from payloads\/prev\/modules\/osi-a/);
  flipTo(root, 'new', guiRoot);
  flipTo(root, 'prev', guiRoot);
  assert.deepEqual(loadMarkers(root, ['osi-a']), { 'osi-a': 'osi-a@prev' });
});

test('captureModules copies linked modules when the previous payload has no module set', (t) => {
  for (const kind of ['sysupgrade', 'older deploy.sh']) {
    const root = moduleRoot(t);
    const guiRoot = path.join(root, 'gui');
    stageWithModules(root, 'deployed', { 'osi-a': '', 'osi-b': '' });
    flipTo(root, 'deployed', guiRoot);
    let prevStamp;
    if (kind === 'sysupgrade') {
      // A sysupgrade keeps /srv, so flows.json and the module links, but not
      // the GUI link under /usr/lib. deploy.sh then captures the flows and the
      // image GUI as a new <stamp>-previous payload.
      fs.rmSync(guiRoot);
      writeModule(guiRoot, 'image-gui');
      prevStamp = 'new-previous';
      captureExisting(root, prevStamp, path.join(root, 'flows.json'), guiRoot);
    } else {
      // An older deploy.sh writes the modules through the links and switches
      // only flows and GUI to a payload without modules.
      fs.writeFileSync(path.join(root, 'osi-a', 'index.js'), 'exports.marker = "osi-a@older";\n');
      prevStamp = 'older';
      stagePayload(root, prevStamp, fakeFlowsSrcAt(root, prevStamp), fakeGuiSrcAt(root, prevStamp));
      for (const link of [path.join(root, 'flows.json'), guiRoot]) fs.rmSync(link);
      fs.symlinkSync(path.join('payloads', prevStamp, 'flows.json'), path.join(root, 'flows.json'));
      fs.symlinkSync(path.join('payloads', prevStamp, 'gui'), guiRoot);
    }
    const running = loadMarkers(root, ['osi-a', 'osi-b']);
    stageWithModules(root, 'new', { 'osi-a': '', 'osi-b': '', 'osi-c': '' });

    const report = swap.captureModules(root, prevStamp, 'new');
    assert.match(report, /captured osi-a/, kind);
    assert.match(report, /captured osi-b/, kind);
    assert.equal(swap.captureModules(root, prevStamp, 'new'), '', `${kind}: a retry is a no-op`);
    const liveA = path.join(root, 'osi-a', 'index.js');
    const bytesA = fs.readFileSync(liveA);
    fs.writeFileSync(liveA, 'exports.marker = "osi-a@written-between-attempts";\n');
    assert.throws(() => swap.captureModules(root, prevStamp, 'new'), /refusing to recapture changed live module osi-a/,
      `${kind}: a retry refuses a linked module that changed after its capture`);
    fs.writeFileSync(liveA, bytesA);
    assert.match(swap.linkNewModules(root, 'new', prevStamp), /^OK: linked osi-c [^\n]*$/, `${kind}: only the absent module is linked`);
    assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-b']), running, `${kind}: the running flows keep their modules until the flip`);

    flipTo(root, 'new', guiRoot);
    flipTo(root, prevStamp, guiRoot);
    assert.equal(verifyPair(root, prevStamp, guiRoot), true, kind);
    assert.deepEqual(loadMarkers(root, ['osi-a', 'osi-b', 'osi-c']), { ...running, 'osi-c': 'ERROR MODULE_NOT_FOUND' },
      `${kind}: a switch back restores the modules the previous flows ran`);
  }
});

test('linkNewModules links absent modules into the staged payload and repairs stale pre-links', (t) => {
  const root = moduleRoot(t);
  stageWithModules(root, 'prev', { 'osi-a': '' });
  flipTo(root, 'prev', path.join(root, 'gui'));
  stageWithModules(root, 'killed', { 'osi-a': '', 'osi-new': '' });
  // A deploy that exited before its exit handler leaves its pre-link behind.
  fs.symlinkSync(path.join('payloads', 'killed', 'modules', 'osi-new'), path.join(root, 'osi-new'));
  writeModule(path.join(root, 'osi-real'), 'osi-real@live');
  stageWithModules(root, 'new', { 'osi-a': '', 'osi-new': '', 'osi-newer': '', 'osi-real': '' });

  const report = swap.linkNewModules(root, 'new', 'prev');
  assert.match(report, /linked osi-newer/);
  assert.match(report, /relinked osi-new/);
  assert.equal(linkTarget(root, 'osi-a'), path.join('payloads', 'prev', 'modules', 'osi-a'), 'live modules stay on the previous payload');
  assert.equal(linkTarget(root, 'osi-new'), path.join('payloads', 'new', 'modules', 'osi-new'));
  assert.equal(linkTarget(root, 'osi-newer'), path.join('payloads', 'new', 'modules', 'osi-newer'));
  assert.equal(fs.lstatSync(path.join(root, 'osi-real')).isDirectory(), true);
  assert.equal(swap.linkNewModules(root, 'new', 'prev'), '', 'a second run is a no-op');
});

test('discardPayload and deactivate remove module links into the payload; prune keeps linked payloads', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, '20260501', { 'osi-a': '' });
  flipTo(root, '20260501', guiRoot);
  stageWithModules(root, '20260502', { 'osi-a': '', 'osi-new': '' });
  swap.linkNewModules(root, '20260502', '20260501');

  discardPayload(root, '20260502');
  assert.equal(fs.existsSync(path.join(root, 'payloads', '20260502')), false);
  assert.throws(() => fs.lstatSync(path.join(root, 'osi-new')), /ENOENT/, 'a pre-link into a discarded payload is removed');
  assert.equal(linkTarget(root, 'osi-a'), path.join('payloads', '20260501', 'modules', 'osi-a'));

  for (const stamp of ['20260503', '20260504', '20260505']) stageWithModules(root, stamp, { 'osi-a': '' });
  // Flows on the newest payload, one module link still on the oldest one.
  flipTo(root, '20260505', guiRoot);
  fs.rmSync(path.join(root, 'osi-a'));
  fs.symlinkSync(path.join('payloads', '20260501', 'modules', 'osi-a'), path.join(root, 'osi-a'));
  prunePayloads(root, 1);
  assert.equal(fs.existsSync(path.join(root, 'payloads', '20260501')), true, 'a payload a module link points into is never pruned');

  deactivate(root, '20260501', guiRoot);
  assert.throws(() => fs.lstatSync(path.join(root, 'osi-a')), /ENOENT/);
});

// Issue #466, PR #618 review: before a fresh capture the live flows, GUI and
// helper modules must be one set, whichever deploy attempt switched them.
// coherentRoot() is a gateway after a committed deploy with module payloads.
function coherentRoot(t, stamp) {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, stamp, { 'osi-a': '', 'osi-b': '' });
  flipTo(root, stamp, guiRoot);
  return { root, guiRoot, flowsPath: path.join(root, 'flows.json'), marker: path.join(root, 'payloads', '.legacy-capture.json') };
}

// A sysupgrade keeps /srv but replaces the GUI link with the image GUI.
function imageGui(guiRoot) {
  fs.rmSync(guiRoot, { recursive: true, force: true });
  writeModule(guiRoot, 'image-gui');
}

function relink(root, name, target) {
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
  fs.symlinkSync(target, path.join(root, name));
}

function staleMarker(marker, stamp) {
  fs.writeFileSync(marker, JSON.stringify({ format: 1, stamp, flows_path: 'x', gui_path: 'y', flows_sha256: '0', gui_sha256: '0' }) + '\n');
}

test('legacyCapturePreflight accepts a sysupgrade beside a committed payload, a pre-#603 payload and regular flows', (t) => {
  const committed = coherentRoot(t, 'deployed');
  imageGui(committed.guiRoot);
  assert.equal(legacyCapturePreflight(committed.root, committed.flowsPath, committed.guiRoot), null, 'sysupgrade, no marker');
  staleMarker(committed.marker, 'gone-previous');
  assert.match(legacyCapturePreflight(committed.root, committed.flowsPath, committed.guiRoot),
    /^WARN: stale legacy-capture marker \(payload gone-previous gone\)/, 'sysupgrade, stale marker');

  const older = moduleRoot(t);
  const olderGui = path.join(older, 'gui');
  stagePayload(older, 'older', fakeFlowsSrcAt(older, 'older'), fakeGuiSrcAt(older, 'older'));
  fs.symlinkSync(path.join('payloads', 'older', 'flows.json'), path.join(older, 'flows.json'));
  writeModule(olderGui, 'image-gui');
  writeModule(path.join(older, 'osi-a'), 'osi-a@older');
  assert.equal(legacyCapturePreflight(older, path.join(older, 'flows.json'), olderGui), null,
    'a payload without modules.json runs the live module directories');

  // Regular flows: no switch is under way, whatever the GUI links to.
  const edited = coherentRoot(t, 'deployed');
  fs.rmSync(edited.flowsPath);
  fs.writeFileSync(edited.flowsPath, JSON.stringify([{ id: 'edited' }]) + '\n');
  assert.equal(legacyCapturePreflight(edited.root, edited.flowsPath, edited.guiRoot), null, 'regular flows file');
});

test('legacyCapturePreflight refuses flows and GUI linked into different payloads', (t) => {
  for (const marker of ['none', 'stale']) {
    const live = coherentRoot(t, 'old');
    stageWithModules(live.root, 'cut', { 'osi-a': '', 'osi-b': '' });
    // Power lost inside flipTo('cut'): flows switched, the GUI and modules not.
    relink(live.root, 'flows.json', path.join('payloads', 'cut', 'flows.json'));
    if (marker === 'stale') staleMarker(live.marker, 'gone-previous');
    const before = marker === 'stale' ? fs.readFileSync(live.marker, 'utf8') : null;

    assert.throws(() => legacyCapturePreflight(live.root, live.flowsPath, live.guiRoot),
      /the live flows point into payloads\/cut but the GUI into payloads\/old; refusing to capture a half-switched state/, marker);
    if (marker === 'stale') assert.equal(fs.readFileSync(live.marker, 'utf8'), before, 'the stale marker stays for the operator');
    else assert.equal(fs.existsSync(live.marker), false, 'no marker is written');
  }
});

test('legacyCapturePreflight refuses linked flows whose payload modules are not linked into it', (t) => {
  const cases = {
    'modules still in the older payload': () => {},
    'a module is a real directory': (root) => {
      for (const name of ['osi-a', 'osi-b']) relink(root, name, path.join('payloads', 'cut', 'modules', name));
      fs.rmSync(path.join(root, 'osi-a'));
      writeModule(path.join(root, 'osi-a'), 'osi-a@real');
    },
    'a module link dangles': (root) => {
      for (const name of ['osi-a', 'osi-b']) relink(root, name, path.join('payloads', 'cut', 'modules', name));
      fs.rmSync(path.join(root, 'payloads', 'cut', 'modules', 'osi-a'), { recursive: true, force: true });
    },
  };
  const stray = { 'modules still in the older payload': 'osi-a, osi-b', 'a module is a real directory': 'osi-a', 'a module link dangles': 'osi-a' };
  for (const [label, damage] of Object.entries(cases)) {
    for (const marker of ['none', 'stale']) {
      const live = coherentRoot(t, 'old');
      stageWithModules(live.root, 'cut', { 'osi-a': '', 'osi-b': '', 'osi-c': '' });
      swap.linkNewModules(live.root, 'cut', 'old');
      imageGui(live.guiRoot);
      // Power lost inside flipTo('cut') after a sysupgrade: flows switched.
      relink(live.root, 'flows.json', path.join('payloads', 'cut', 'flows.json'));
      damage(live.root);
      if (marker === 'stale') staleMarker(live.marker, 'attempt-a-previous');

      assert.throws(() => legacyCapturePreflight(live.root, live.flowsPath, live.guiRoot),
        new RegExp(`the live flows point into payloads/cut, but its helper modules ${stray[label]} are not linked into it; refusing to capture a half-switched state`),
        `${label}, ${marker} marker`);
      assert.equal(fs.existsSync(live.marker), marker === 'stale', `${label}, ${marker} marker: nothing moved aside`);
      assert.equal(fs.readdirSync(path.join(live.root, 'payloads')).some((entry) => entry.startsWith('.legacy-capture.json.stale-')), false);
    }
  }
});

test('legacyCapturePreflight refuses a malformed module manifest in the payload the flows point into', (t) => {
  const live = coherentRoot(t, 'old');
  stageWithModules(live.root, 'cut', { 'osi-a': '', 'osi-b': '' });
  imageGui(live.guiRoot);
  relink(live.root, 'flows.json', path.join('payloads', 'cut', 'flows.json'));
  fs.writeFileSync(path.join(live.root, 'payloads', 'cut', 'modules.json'), 'not json\n');
  assert.throws(() => legacyCapturePreflight(live.root, live.flowsPath, live.guiRoot), /module manifest unreadable/);
});

test('legacyCapturePreflight lets a rerun capture after power loss between moving the marker aside and the capture', (t) => {
  const { root, flowsPath, guiRoot, marker } = legacyRoot(t);
  captureExisting(root, 'pruned-previous', flowsPath, guiRoot);
  fs.rmSync(path.join(root, 'payloads', 'pruned-previous'), { recursive: true, force: true });
  assert.match(legacyCapturePreflight(root, flowsPath, guiRoot), /^WARN: stale legacy-capture marker/);
  // Power lost here: the rerun finds no marker and the same live files.
  assert.equal(legacyCapturePreflight(root, flowsPath, guiRoot), null);
  assert.equal(fs.existsSync(marker), false);
  captureExisting(root, 'rerun-previous', flowsPath, guiRoot);
  assert.equal(legacyCaptureStamp(root, flowsPath, guiRoot), 'rerun-previous');
});

// Issue #466, PR #618 amendment 2: the state table of legacyCapturePreflight.
// One named case per row of the table in scripts/helpers/deploy-state-table.js,
// which the kill matrix shares. A change that flips any verdict fails the case
// named after its row. A row marked `resume` is checked after the resume step
// deploy.sh runs first.
const table = require('./helpers/deploy-state-table');
const { STATE_TABLE, liveSnapshot } = table;

function tableGateway(t) {
  const root = table.tableRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return table.tableGateway(root);
}

const WARN_STALE = /^WARN: stale legacy-capture marker \(payload \S+ gone\); moved to payloads\/\.legacy-capture\.json\.stale-\d+-\d+; recapturing$/;

// Verdicts: SKIP (the capture block does not run; unchanged since before
// #466), PAYLOAD (flows and GUI share a payload, which stays the rollback
// target), REUSE (the marker's capture stays the rollback target), RECAPTURE
// (the capture block copies the live set; a stale marker is moved aside
// first), REFUSE (deploy.sh exits before any live file is replaced).
function assertVerdict(g, verdict, pattern, label) {
  const payloads = path.join(g.root, 'payloads');
  const live = liveSnapshot(g);
  const entriesBefore = fs.readdirSync(payloads).sort();
  const markerBefore = fs.existsSync(g.marker) ? fs.readFileSync(g.marker, 'utf8') : null;
  let result;
  let error = null;
  try { result = legacyCapturePreflight(g.root, g.flowsPath, g.guiRoot); } catch (caught) { error = caught; }
  assert.deepEqual(liveSnapshot(g), live, `${label}: the preflight changes no live file`);
  const entriesAfter = fs.readdirSync(payloads).sort();
  if (verdict === 'REFUSE') {
    assert.ok(error, `${label}: expected a refusal, got ${JSON.stringify(result)}`);
    assert.match(error.message, pattern, label);
    assert.deepEqual(entriesAfter, entriesBefore, `${label}: a refusal moves nothing`);
    if (markerBefore !== null) assert.equal(fs.readFileSync(g.marker, 'utf8'), markerBefore, `${label}: marker bytes`);
    return;
  }
  if (error) throw new Error(`${label}: expected ${verdict}, got ${error.message}`);
  if (verdict === 'RECAPTURE' && markerBefore !== null) {
    assert.match(result, WARN_STALE, label);
    const aside = entriesAfter.filter((entry) => !entriesBefore.includes(entry));
    assert.equal(aside.length, 1, `${label}: one marker moved aside`);
    assert.equal(fs.readFileSync(path.join(payloads, aside[0]), 'utf8'), markerBefore, label);
    assert.deepEqual(entriesAfter.filter((entry) => entry !== aside[0]), entriesBefore.filter((entry) => entry !== '.legacy-capture.json'), label);
  } else {
    assert.equal(result, null, label);
    assert.deepEqual(entriesAfter, entriesBefore, `${label}: nothing moved`);
    if (markerBefore !== null) assert.equal(fs.readFileSync(g.marker, 'utf8'), markerBefore, `${label}: marker bytes`);
  }
  const flowsFile = isFileOrDir(g.flowsPath) === 'file';
  const guiDir = isFileOrDir(g.guiRoot) === 'dir';
  const flows = currentStamp(g.root);
  if (verdict === 'SKIP') assert.ok(!flowsFile || !guiDir, `${label}: the capture block does not run`);
  if (verdict === 'PAYLOAD') assert.ok(flows && flows === swap.guiStamp(g.root, g.guiRoot), `${label}: flows and GUI share a payload`);
  if (verdict === 'REUSE') assert.equal(legacyCaptureStamp(g.root, g.flowsPath, g.guiRoot), JSON.parse(markerBefore).stamp, label);
  if (verdict === 'RECAPTURE') {
    assert.ok(flowsFile && guiDir && !(flows && flows === swap.guiStamp(g.root, g.guiRoot)), `${label}: the capture block runs`);
    assert.equal(legacyCaptureStamp(g.root, g.flowsPath, g.guiRoot), null, `${label}: no marker is reused`);
  }
}

function isFileOrDir(target) {
  try {
    const stat = fs.statSync(target);
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other';
  } catch (_) {
    return 'absent';
  }
}

for (const { row, verdict, name, match, stale, resume, builds } of STATE_TABLE) {
  test(`state table ${row} -> ${verdict}: ${name}`, (t) => {
    builds.forEach((build, index) => {
      for (const marker of stale ? ['as built', 'with a stale marker'] : ['as built']) {
        const g = tableGateway(t);
        build(g);
        if (marker === 'with a stale marker') staleMarker(g.marker, 'gone-previous');
        if (resume) swap.resumeInterruptedSwitch(g.root, g.guiRoot);
        assertVerdict(g, verdict, match, `${row} variant ${index + 1}, ${marker}`);
      }
    });
  });
}

// Council #636 round 1: a conversion an older deploy.sh left interrupted,
// before payloads/.active existed, is undone too; leftovers are removed.
test('resumeInterruptedSwitch moves a set-aside entry back without payloads/.active and sweeps leftovers', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'usr-lib', 'gui');
  fs.mkdirSync(guiRoot, { recursive: true });
  fs.writeFileSync(path.join(guiRoot, 'index.html'), 'image\n');
  fs.writeFileSync(path.join(root, 'flows.json'), '[]\n');
  // A v0.8.2 flipTo() killed between moving the GUI aside and linking it.
  fs.renameSync(guiRoot, `${guiRoot}.osi-old-1-200`);
  fs.mkdirSync(`${guiRoot}.osi-old-1-100`);
  fs.symlinkSync('nowhere', path.join(root, 'usr-lib', '.gui.flip-1-300'));
  fs.symlinkSync('nowhere', path.join(root, 'payloads', '.active.flip-1-300'));
  writeModule(path.join(root, 'osi-a'), 'a');
  fs.mkdirSync(path.join(root, 'osi-a.osi-old-1-50'));
  assert.equal(fs.existsSync(path.join(root, 'payloads', '.active')), false);

  const report = swap.resumeInterruptedSwitch(root, guiRoot);
  assert.match(report, /left gui at gui\.osi-old-1-200; moved it back/);
  assert.equal(fs.readFileSync(path.join(guiRoot, 'index.html'), 'utf8'), 'image\n', 'the newest set-aside directory is back');
  for (const leftover of [`${guiRoot}.osi-old-1-100`, path.join(root, 'usr-lib', '.gui.flip-1-300'),
    path.join(root, 'payloads', '.active.flip-1-300'), path.join(root, 'osi-a.osi-old-1-50')]) {
    assert.throws(() => fs.lstatSync(leftover), /ENOENT/, leftover);
  }
  assert.equal(swap.resumeInterruptedSwitch(root, guiRoot), null, 'a second run finds nothing');
});

// v0.8.2 review, S-1 follow-up: health record and rollback target.
test('a payload is a rollback target once healthy and only while its recorded files are unchanged', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, 'a', { 'osi-a': '' });
  stageWithModules(root, 'b', { 'osi-a': '' });
  stageWithModules(root, 'c', { 'osi-a': '' });
  assert.equal(swap.payloadTrusted(root, 'a'), true, 'no record: from before the record, trusted');
  swap.markActivated(root, 'b');
  assert.equal(swap.payloadTrusted(root, 'b'), false, 'activated, never checked');
  swap.markHealthy(root, 'b');
  assert.equal(swap.payloadTrusted(root, 'b'), true);
  writeModule(path.join(root, 'payloads', 'b', 'modules', 'osi-extra'), 'captured later');
  assert.equal(swap.payloadTrusted(root, 'b'), true, 'a module captured into it later does not change the recorded set');
  fs.appendFileSync(path.join(root, 'payloads', 'b', 'modules', 'osi-a', 'index.js'), '// written in place\n');
  assert.equal(swap.payloadTrusted(root, 'b'), false, 'a recorded module that changed');
  fs.writeFileSync(path.join(root, 'payloads', 'b', 'health.json'), '{');
  assert.equal(swap.payloadTrusted(root, 'b'), false, 'an unreadable record');

  swap.markHealthy(root, 'a');
  swap.markActivated(root, 'c');
  flipTo(root, 'c', guiRoot);
  assert.equal(swap.rollbackTarget(root, 'c', 'next'), 'a', 'the newest complete, trusted payload');
  swap.markHealthy(root, 'c');
  assert.equal(swap.rollbackTarget(root, 'c', 'next'), 'c');
  swap.markActivated(root, 'c');
  swap.markActivated(root, 'a');
  assert.equal(swap.rollbackTarget(root, 'c', 'next'), 'c', 'nothing trusted is left: the served payload stays the target');
  assert.equal(swap.rollbackTarget(root, '', 'next'), '');
});

test('prune keeps the payload the next deploy would roll back to', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  for (const stamp of ['20261101', '20261102', '20261103', '20261104']) stageWithModules(root, stamp, { 'osi-a': '' });
  swap.markHealthy(root, '20261101');
  for (const stamp of ['20261102', '20261103', '20261104']) swap.markActivated(root, stamp);
  flipTo(root, '20261104', guiRoot);
  prunePayloads(root, 1);
  assert.ok(fs.existsSync(path.join(root, 'payloads', '20261101')), 'the healthy payload stays');
  assert.equal(fs.existsSync(path.join(root, 'payloads', '20261102')), false);
});

// Review of #636: a payload a deploy staged and never switched to (a cut
// during npm install) is no rollback target and no restore target; payloads
// from before the record stay trusted.
test('a staged payload is never a rollback or restore target; one from before the record still is', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, '20261101', { 'osi-a': '' });
  flipTo(root, '20261101', guiRoot);
  swap.writeCompatibility(root, '20261101', '70', '70:a');
  stageWithModules(root, '20261102', { 'osi-a': '' });
  swap.markStaged(root, '20261102');
  stageWithModules(root, '20261103', { 'osi-a': '' });
  swap.writeCompatibility(root, '20261103', '79', '70:a,79:b');
  swap.markActivated(root, '20261103');
  flipTo(root, '20261103', guiRoot);
  assert.equal(swap.payloadTrusted(root, '20261101'), true, 'no record: from before the record');
  assert.equal(swap.payloadTrusted(root, '20261102'), false, 'staged');
  assert.equal(swap.rollbackTarget(root, '20261103', 'next'), '20261101');
  assert.equal(swap.owedCheckPlan(root, '79', '70:a,79:b'), '20261103|1||20261101');
});

// Review of #636: the health record and the payload state are on storage
// before the switch that follows: the file is synced before its rename and
// the directory after it.
test('health records and the payload state are synced around their rename', (t) => {
  const root = moduleRoot(t);
  stageWithModules(root, 'p', { 'osi-a': '' });
  const calls = [];
  const real = { fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, openSync: fs.openSync };
  const kinds = new Map();
  fs.openSync = function (file, ...rest) {
    const fd = real.openSync.call(this, file, ...rest);
    kinds.set(fd, fs.statSync(file).isDirectory() ? 'dir' : 'file');
    return fd;
  };
  fs.fsyncSync = function (fd) { calls.push(`fsync ${kinds.get(fd)}`); return real.fsyncSync.call(this, fd); };
  fs.renameSync = function (...args) { calls.push('rename'); return real.renameSync.apply(this, args); };
  try {
    swap.markActivated(root, 'p');
    swap.writePayloadState(root, 'p', 'unverified', 'x');
  } finally {
    Object.assign(fs, real);
  }
  assert.deepEqual(calls, ['fsync file', 'rename', 'fsync dir', 'fsync file', 'rename', 'fsync dir']);
});

// Review of #636 (residual gap 1): the "staged" record is written before
// anything is copied into the payload, in the same call, so a cut while
// staging never leaves a payload without a record.
test('stagePayload records "staged" before it copies anything into the payload', (t) => {
  const root = moduleRoot(t);
  const seen = [];
  const realCopy = fs.copyFileSync;
  const realCp = fs.cpSync;
  const record = () => fs.existsSync(path.join(root, 'payloads', 'p', 'health.json'));
  fs.copyFileSync = function (...args) { seen.push(['copyFileSync', record()]); return realCopy.apply(this, args); };
  fs.cpSync = function (...args) { seen.push(['cpSync', record()]); return realCp.apply(this, args); };
  try {
    stagePayload(root, 'p', fakeFlowsSrcAt(root, 'p'), fakeGuiSrcAt(root, 'p'), 'staged');
  } finally {
    fs.copyFileSync = realCopy;
    fs.cpSync = realCp;
  }
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(([, present]) => present), JSON.stringify(seen));
  assert.equal(swap.payloadTrusted(root, 'p'), false);
  stagePayload(root, 'capture', fakeFlowsSrcAt(root, 'capture'), fakeGuiSrcAt(root, 'capture'));
  assert.equal(swap.payloadTrusted(root, 'capture'), true, 'the legacy capture stays trusted');
});

// Ledger item 4 (residual gap 1): a kill at each step of stagePayload leaves
// either no complete payload or one recorded "staged", never a complete,
// unrecorded payload that would read as "from before the record".
test('a kill at each step of staging leaves nothing usable or a staged payload', (t) => {
  const root = moduleRoot(t);
  const flows = fakeFlowsSrcAt(root, 'k');
  const gui = fakeGuiSrcAt(root, 'k');
  const child = (killAt) => spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    let n = 0;
    for (const name of ['mkdirSync', 'writeFileSync', 'openSync', 'writeSync', 'fsyncSync', 'renameSync', 'copyFileSync', 'cpSync', 'symlinkSync']) {
      const real = fs[name];
      fs[name] = function (...args) {
        n += 1;
        if (n === ${killAt}) process.kill(process.pid, 'SIGKILL');
        return real.apply(this, args);
      };
    }
    require(${JSON.stringify(path.join(__dirname, 'deploy-payload-swap.js'))})
      .stagePayload(${JSON.stringify(root)}, 'k', ${JSON.stringify(flows)}, ${JSON.stringify(gui)}, 'staged');
  `], { encoding: 'utf8' });
  let killAt = 1;
  for (; killAt < 500; killAt += 1) {
    fs.rmSync(path.join(root, 'payloads', 'k'), { recursive: true, force: true });
    const run = child(killAt);
    const complete = swap.verifyPair(root, 'k');
    const record = swap.readHealth(root, 'k');
    assert.ok(!complete || (record && record.state === 'staged'),
      `kill at step ${killAt}: complete=${complete} record=${JSON.stringify(record)}`);
    if (run.signal !== 'SIGKILL') break;
  }
  assert.ok(killAt > 2 && killAt < 500, `the staging ran to completion after ${killAt} steps`);
  assert.equal(swap.payloadTrusted(root, 'k'), false);
});

// Ledger item 4: on a gateway whose helper modules link into payloads, a
// payload without modules.json (flows and GUI only, as a cut before module
// staging left it) is never a rollback, restore or fallback target.
test('a payload without its modules is never a target on a gateway whose helpers are linked', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, '20261101', { 'osi-a': '' });
  flipTo(root, '20261101', guiRoot);
  swap.writeCompatibility(root, '20261101', '70', '70:a');
  // Newer, complete flows and GUI, no record, no modules.
  stagePayload(root, '20261102', fakeFlowsSrcAt(root, '20261102'), fakeGuiSrcAt(root, '20261102'));
  swap.writeCompatibility(root, '20261102', '70', '70:a');
  stageWithModules(root, '20261103', { 'osi-a': '' });
  swap.markActivated(root, '20261103');
  flipTo(root, '20261103', guiRoot);
  assert.equal(swap.verifyPair(root, '20261102'), true);
  assert.equal(swap.payloadTrusted(root, '20261102'), true, 'no record reads as from before the record');
  assert.equal(swap.rollbackTarget(root, '20261103', 'next'), '20261101');
  assert.equal(swap.owedCheckPlan(root, '70', '70:a'), '20261103|0|20261101|20261101');
});

// Ledger item 5: a power cut while a switch removes the image layer's GUI
// directory, file by file. The marker beside it is now synced before the
// first file goes; a GUI left partly removed is finished whether its marker
// is present, empty (written by a head before the sync) or absent. Each state
// is repaired by the boot (resumeInterruptedSwitch), passes the next deploy's
// legacy-capture preflight, and takes the next switch.
for (const marker of ['present', 'empty', 'absent']) {
  test(`a GUI partly removed by a cut switch, marker ${marker}: the boot, the next deploy and the next switch repair it`, (t) => {
    const root = moduleRoot(t);
    const guiRoot = path.join(root, 'web', 'gui');
    const romGui = path.join(root, 'rom', path.resolve(guiRoot));
    const saved = { paths: process.env.OSI_SWAP_IMAGE_LAYER_PATHS, rom: process.env.OSI_SWAP_ROM_ROOT };
    process.env.OSI_SWAP_IMAGE_LAYER_PATHS = path.resolve(guiRoot);
    process.env.OSI_SWAP_ROM_ROOT = path.join(root, 'rom');
    t.after(() => {
      for (const [name, value] of [['OSI_SWAP_IMAGE_LAYER_PATHS', saved.paths], ['OSI_SWAP_ROM_ROOT', saved.rom]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    // The image's GUI, and the payload that holds the same GUI.
    for (const dir of [romGui]) {
      fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), '<title>image</title>\n');
      fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'a\n');
      fs.writeFileSync(path.join(dir, 'assets', 'b.js'), 'b\n');
    }
    stageWithModules(root, '20261101', { 'osi-a': '' });
    flipTo(root, '20261101', guiRoot);
    // The cut: the GUI path is the image's directory again, partly removed.
    fs.rmSync(guiRoot, { force: true });
    fs.mkdirSync(path.join(guiRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(guiRoot, 'assets', 'b.js'), 'b\n');
    const markerPath = `${guiRoot}.osi-removing`;
    if (marker === 'present') fs.writeFileSync(markerPath, `${path.join(root, 'payloads', 'active', 'gui')}\n`);
    if (marker === 'empty') fs.writeFileSync(markerPath, '');

    const report = swap.resumeInterruptedSwitch(root, guiRoot);
    assert.match(report || '', /gui/);
    assert.ok(fs.lstatSync(guiRoot).isSymbolicLink(), 'the GUI is a link again');
    assert.equal(fs.readFileSync(path.join(guiRoot, 'index.html'), 'utf8'), '<title>20261101</title>\n');
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(swap.verifyPair(root, '20261101', guiRoot), true);
    assert.doesNotThrow(() => swap.legacyCapturePreflight(root, path.join(root, 'flows.json'), guiRoot));

    stageWithModules(root, '20261102', { 'osi-a': '' });
    flipTo(root, '20261102', guiRoot);
    assert.equal(swap.verifyPair(root, '20261102', guiRoot), true);
  });
}

test('the removal marker is on storage before the first file of the GUI is removed', () => {
  const source = fs.readFileSync(path.join(__dirname, 'deploy-payload-swap.js'), 'utf8');
  const at = source.indexOf("removing = `${link}.osi-removing`;");
  const block = source.slice(at, source.indexOf('fs.rmSync(link, { recursive: true, force: true });', at));
  assert.match(block, /writeDurable\(removing,/);
});

// R3, item 4: a retry that stopped before its switch left one more staged
// payload each time. The next deploy removes exactly those: recorded
// "staged", never switched to; never the active or served payload, one a
// helper module links into, one a pending switch names, or one from before
// the health record.
test('stale stages: only payloads staged and never switched to are removed', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, '20261101', { 'osi-a': '' });          // from before the record
  flipTo(root, '20261101', guiRoot);
  for (const stamp of ['20261102', '20261103', '20261104', '20261105']) {
    stageWithModules(root, stamp, { 'osi-a': '' });
    swap.markStaged(root, stamp);
  }
  swap.writePendingSwitch(root, '20261104', '80', 'a,b', '70', 'a'); // a pending switch names it
  swap.markActivated(root, '20261105');                             // was switched to once
  assert.deepEqual(swap.staleStages(root, 'next'), ['20261102', '20261103']);
  assert.match(swap.staleStageSizes(root, 'next'), /^20261102 \d+\n20261103 \d+$/);
  const report = swap.clearStaleStages(root, 'next');
  assert.match(report, /removed payloads\/20261102, staged by an earlier deploy that never switched to it/);
  for (const gone of ['20261102', '20261103']) assert.equal(fs.existsSync(path.join(root, 'payloads', gone)), false);
  for (const kept of ['20261101', '20261104', '20261105']) assert.ok(fs.existsSync(path.join(root, 'payloads', kept)), kept);
  assert.equal(swap.verifyPair(root, '20261101', guiRoot), true);
  // The deploy's own stage is never among them.
  stageWithModules(root, 'next', { 'osi-a': '' });
  swap.markStaged(root, 'next');
  assert.deepEqual(swap.staleStages(root, 'next'), []);
});
