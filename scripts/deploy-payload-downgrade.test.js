'use strict';

// A downgrade by an older deploy.sh on a gateway that the current code
// converted to the payloads/active layout (v0.8.2 review, S-1 follow-up).
// The older deploy.sh cannot be changed, so the test runs the swap helper of
// the v0.8.1 and v0.8.2 tags, read from git, the way their deploy.sh calls it.
//
// Intended behaviour: the downgrade works. The older release ends active and
// complete; its prune keeps payloads/active, because that name sorts after
// every timestamp stamp; and the next deploy of the current code converts the
// gateway back and can roll back to the older release.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const swap = require('./deploy-payload-swap');

const REPO = path.resolve(__dirname, '..');

function historicalSwap(t, ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swap-${ref}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'deploy-payload-swap.js');
  fs.writeFileSync(file, execFileSync('git', ['-C', REPO, 'show', `${ref}:scripts/deploy-payload-swap.js`]));
  return require(file);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeModule(dir, marker) {
  write(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), version: '1.0.0', main: 'index.js' }) + '\n');
  write(path.join(dir, 'index.js'), `exports.marker = ${JSON.stringify(marker)};\n`);
}

function sources(root, stamp) {
  const src = path.join(root, `src-${stamp}`);
  write(path.join(src, 'flows.json'), JSON.stringify([{ marker: `flows@${stamp}` }]));
  write(path.join(src, 'gui', 'index.html'), `gui@${stamp}\n`);
  return { flows: path.join(src, 'flows.json'), gui: path.join(src, 'gui') };
}

function stageCurrent(root, stamp, modules) {
  const src = sources(root, stamp);
  swap.stagePayload(root, stamp, src.flows, src.gui);
  for (const name of modules) writeModule(path.join(root, 'payloads', stamp, 'modules', name), `${name}@${stamp}`);
  swap.sealModules(root, stamp);
}

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return fallback; }
}

function served(root, guiRoot, modules) {
  const out = { flows: JSON.parse(readOr(path.join(root, 'flows.json'), '[{"marker":"absent"}]'))[0].marker };
  out.gui = readOr(path.join(guiRoot, 'index.html'), 'absent').trim();
  for (const name of modules) {
    const source = readOr(path.join(root, name, 'index.js'), null);
    out[name] = source === null ? 'absent' : JSON.parse(source.match(/= (".*");/)[1]);
  }
  return out;
}

// A gateway on the current code: payload "current" active through
// payloads/active, plus four older payloads so the older prune has work.
function convertedGateway(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-node-red-downgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'payloads'));
  writeModule(path.join(root, 'osi-command-ledger'), 'ledger-live');
  fs.mkdirSync(path.join(root, 'osi-watermark-binding'));
  fs.mkdirSync(path.join(root, 'codecs'));
  write(path.join(root, 'edge-channels.json'), '{}\n');
  const guiRoot = path.join(root, 'usr-lib', 'gui');
  for (const stamp of ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z']) {
    stageCurrent(root, stamp, ['osi-a', 'osi-b']);
  }
  stageCurrent(root, '20261110T000000Z', ['osi-a', 'osi-b', 'osi-new']);
  swap.flipTo(root, '20261110T000000Z', guiRoot);
  swap.markHealthy(root, '20261110T000000Z');
  assert.equal(fs.readlinkSync(path.join(root, 'payloads', 'active')), '20261110T000000Z');
  return { root, guiRoot };
}

// The next deploy of the current code after the downgrade: its capture and
// module capture, the switch, then a rollback to the downgraded release.
function redeployCurrent(root, guiRoot, older, modules) {
  stageCurrent(root, '20261120T000000Z', ['osi-a', 'osi-b', 'osi-new']);
  assert.equal(swap.legacyCapturePreflight(root, path.join(root, 'flows.json'), guiRoot), null);
  const prev = swap.currentStamp(root);
  assert.equal(prev, older);
  assert.equal(swap.guiStamp(root, guiRoot), older);
  swap.captureGui(root, prev, guiRoot);
  swap.captureModules(root, prev, '20261120T000000Z');
  swap.linkNewModules(root, '20261120T000000Z', prev);
  const before = served(root, guiRoot, modules);
  swap.flipTo(root, '20261120T000000Z', guiRoot, prev);
  assert.equal(swap.verifyPair(root, '20261120T000000Z', guiRoot), true);
  assert.equal(fs.readlinkSync(path.join(root, 'payloads', 'active')), '20261120T000000Z');
  swap.flipTo(root, prev, guiRoot);
  assert.equal(swap.verifyPair(root, prev, guiRoot), true);
  const back = served(root, guiRoot, modules);
  for (const name of ['flows', 'gui', 'osi-a', 'osi-b']) assert.equal(back[name], before[name], `rollback restores ${name}`);
}

test('a v0.8.1 deploy.sh on a converted gateway ends on a complete v0.8.1 and keeps payloads/active', (t) => {
  const old = historicalSwap(t, 'v0.8.1');
  const { root, guiRoot } = convertedGateway(t);
  // v0.8.1 writes helper modules in place, before its migration and switch.
  // The writes go through the module links into the active payload.
  for (const name of ['osi-a', 'osi-b']) {
    fs.writeFileSync(path.join(root, name, 'index.js'), `exports.marker = ${JSON.stringify(`${name}@v0.8.1`)};\n`);
  }
  assert.match(readOr(path.join(root, 'payloads', '20261110T000000Z', 'modules', 'osi-a', 'index.js'), ''), /osi-a@v0\.8\.1/,
    'the in-place write lands in the payload that was active');
  assert.equal(swap.payloadTrusted(root, '20261110T000000Z'), false,
    'a payload an older deploy.sh wrote into is no longer the set that passed its health check');
  const src = sources(root, '20261115T000000Z');
  old.stagePayload(root, '20261115T000000Z', src.flows, src.gui);
  assert.equal(old.currentStamp(root), '20261110T000000Z');
  assert.equal(old.guiStamp(root, guiRoot), '20261110T000000Z', 'no legacy capture: flows and GUI are one payload');
  old.flipTo(root, '20261115T000000Z', guiRoot);
  assert.equal(old.verifyPair(root, '20261115T000000Z', guiRoot), true);
  old.prunePayloads(root, 5);

  assert.equal(fs.readlinkSync(path.join(root, 'payloads', 'active')), '20261110T000000Z', 'the older prune keeps payloads/active');
  assert.deepEqual(served(root, guiRoot, ['osi-a', 'osi-b']), {
    flows: 'flows@20261115T000000Z', gui: 'gui@20261115T000000Z', 'osi-a': 'osi-a@v0.8.1', 'osi-b': 'osi-b@v0.8.1',
  }, 'v0.8.1 flows and GUI run on the helper files v0.8.1 wrote');

  redeployCurrent(root, guiRoot, '20261115T000000Z', ['osi-a', 'osi-b']);
});

test('a v0.8.2 deploy.sh on a converted gateway ends on a complete v0.8.2 and keeps payloads/active', (t) => {
  const old = historicalSwap(t, 'v0.8.2');
  const { root, guiRoot } = convertedGateway(t);
  const stamp = '20261115T000000Z';
  const src = sources(root, stamp);
  old.stagePayload(root, stamp, src.flows, src.gui);
  for (const name of ['osi-a', 'osi-b']) writeModule(path.join(root, 'payloads', stamp, 'modules', name), `${name}@v0.8.2`);
  old.sealModules(root, stamp);
  old.captureModules(root, '20261110T000000Z', stamp);
  old.linkNewModules(root, stamp, '20261110T000000Z');
  old.flipTo(root, stamp, guiRoot);
  assert.equal(old.verifyPair(root, stamp, guiRoot), true);
  old.prunePayloads(root, 5);

  assert.ok(fs.lstatSync(path.join(root, 'payloads', 'active')).isSymbolicLink(), 'the older prune keeps payloads/active');
  assert.deepEqual(served(root, guiRoot, ['osi-a', 'osi-b', 'osi-new']), {
    flows: `flows@${stamp}`, gui: `gui@${stamp}`, 'osi-a': 'osi-a@v0.8.2', 'osi-b': 'osi-b@v0.8.2', 'osi-new': 'absent',
  });

  redeployCurrent(root, guiRoot, stamp, ['osi-a', 'osi-b']);
});
