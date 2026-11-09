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

test('a failed module switch restores flows, GUI and the modules already switched', (t) => {
  const root = moduleRoot(t);
  const guiRoot = path.join(root, 'gui');
  stageWithModules(root, 'old', { 'osi-a': '', 'osi-b': '' });
  stageWithModules(root, 'new', { 'osi-a': '', 'osi-b': '' });
  flipTo(root, 'old', guiRoot);

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(root, 'osi-b')) throw new Error('forced module replacement failure');
    return realRename(from, to);
  };
  try {
    assert.throws(() => flipTo(root, 'new', guiRoot), /module flip osi-b.*forced module replacement failure/);
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
