'use strict';

// Issue S-1 (v0.8.2 review): a deploy killed during payload activation must
// leave the complete old payload or the complete new one, never a mix, and
// the retry and the rollback must both find a complete set.
//
// Each case runs flipTo() in a child process that exits right after its k-th
// filesystem change, for every k the activation makes, so no catch block or
// finally clause runs, as with a kill or a power cut. After each kill the
// test reads what the gateway would serve, runs deploy.sh's preflight and
// capture choice for a retry, completes the retry, and rolls it back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const swap = require('./deploy-payload-swap');

const SWAP_JS = path.join(__dirname, 'deploy-payload-swap.js');
const KILLED = 86;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeModule(dir, marker) {
  write(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), version: '1.0.0', main: 'index.js' }) + '\n');
  write(path.join(dir, 'index.js'), `exports.marker = ${JSON.stringify(marker)};\n`);
}

function stage(root, stamp, modules) {
  const src = path.join(root, `src-${stamp}`);
  write(path.join(src, 'flows.json'), JSON.stringify([{ id: 'x', marker: `flows@${stamp}` }]));
  write(path.join(src, 'gui', 'index.html'), `gui@${stamp}\n`);
  swap.stagePayload(root, stamp, path.join(src, 'flows.json'), path.join(src, 'gui'));
  for (const name of modules) writeModule(path.join(root, 'payloads', stamp, 'modules', name), `${name}@${stamp}`);
  swap.sealModules(root, stamp);
}

function baseRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-node-red-kill-'));
  fs.mkdirSync(path.join(root, 'payloads'));
  writeModule(path.join(root, 'osi-command-ledger'), 'ledger-live');
  fs.mkdirSync(path.join(root, 'osi-watermark-binding'));
  fs.mkdirSync(path.join(root, 'codecs'));
  write(path.join(root, 'edge-channels.json'), '{}\n');
  return { root, guiRoot: path.join(root, 'usr-lib', 'gui') };
}

// Each fixture is a gateway before the deploy of payload "new", which carries
// osi-a and osi-new; it returns the rollback payload deploy.sh would pass.
const FIXTURES = {
  // A gateway whose last deploy used this code: everything through payloads/active.
  'one active link': { windows: [], build: ({ root, guiRoot }) => {
    stage(root, 'old', ['osi-a', 'osi-gone']);
    swap.flipTo(root, 'old', guiRoot);
    stage(root, 'new', ['osi-a', 'osi-new']);
    swap.linkNewModules(root, 'new', 'old');
    return 'old';
  } },
  // A gateway converted by the first version of this layout, which named the
  // link payloads/.active.
  'one .active link (first version)': { windows: [], build: ({ root, guiRoot }) => {
    stage(root, 'old', ['osi-a', 'osi-gone']);
    swap.flipTo(root, 'old', guiRoot);
    const payloads = path.join(root, 'payloads');
    fs.renameSync(path.join(payloads, 'active'), path.join(payloads, '.active'));
    const relink = (at) => {
      const text = fs.readlinkSync(at).replace(/(^|\/)payloads\/active\//, '$1payloads/.active/');
      fs.rmSync(at);
      fs.symlinkSync(text, at);
    };
    for (const at of [path.join(root, 'flows.json'), guiRoot, path.join(root, 'osi-a'), path.join(root, 'osi-gone')]) relink(at);
    stage(root, 'new', ['osi-a', 'osi-new']);
    swap.linkNewModules(root, 'new', 'old');
    return 'old';
  } },
  // A v0.8.2 gateway (1bdd49d5 and earlier): one link per entry, straight
  // into payloads/old.
  'one link per entry (v0.8.2 layout)': { windows: [], build: ({ root, guiRoot }) => {
    stage(root, 'old', ['osi-a', 'osi-gone']);
    const link = (target, at) => {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(at), target), at);
    };
    link(path.join(root, 'payloads', 'old', 'flows.json'), path.join(root, 'flows.json'));
    link(path.join(root, 'payloads', 'old', 'gui'), guiRoot);
    for (const name of ['osi-a', 'osi-gone']) link(path.join(root, 'payloads', 'old', 'modules', name), path.join(root, name));
    stage(root, 'new', ['osi-a', 'osi-new']);
    swap.linkNewModules(root, 'new', 'old');
    return 'old';
  } },
  // A v0.8.1 gateway after a sysupgrade: regular flows, a regular GUI and
  // module directories, captured as payloads/old by deploy.sh's capture block.
  'regular files captured (v0.8.1 after sysupgrade)': { windows: ['gui', 'osi-a'], build: ({ root, guiRoot }) => {
    write(path.join(root, 'flows.json'), JSON.stringify([{ id: 'x', marker: 'flows@old' }]));
    write(path.join(guiRoot, 'index.html'), 'gui@old\n');
    writeModule(path.join(root, 'osi-a'), 'osi-a@old');
    writeModule(path.join(root, 'osi-gone'), 'osi-gone@old');
    stage(root, 'new', ['osi-a', 'osi-new']);
    swap.captureExisting(root, 'old', path.join(root, 'flows.json'), guiRoot);
    swap.captureModules(root, 'old', 'new');
    swap.linkNewModules(root, 'new', 'old');
    return 'old';
  } },
};

const MODULES = ['osi-a', 'osi-gone', 'osi-new'];

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return fallback; }
}

// What a Node-RED restarted at this instant would load.
function served({ root, guiRoot }) {
  const state = {};
  const flows = readOr(path.join(root, 'flows.json'), null);
  state.flows = flows === null ? 'absent' : JSON.parse(flows)[0].marker;
  state.gui = readOr(path.join(guiRoot, 'index.html'), 'absent').trim();
  for (const name of MODULES) {
    const source = readOr(path.join(root, name, 'index.js'), null);
    state[name] = source === null ? 'absent' : JSON.parse(source.match(/= (".*");/)[1]);
  }
  return state;
}

// The old payload does not carry osi-new. deploy.sh links a module new in
// this release before the stop, for npm install; the old flows never load it.
function sameOld(state, before) {
  const strip = ({ 'osi-new': _new, ...rest }) => JSON.stringify(rest);
  return strip(state) === strip(before);
}

// A directory cannot be replaced by a link in one rename(2) (EISDIR), so
// converting the image GUI or a pre-#603 module directory moves it aside
// first. A kill between the two renames leaves exactly that entry absent with
// its old content beside it, and everything else old. Returns the entry, or
// null for any other state.
function conversionWindow({ root, guiRoot }, state, before) {
  const missing = Object.keys(before).filter((key) => key !== 'osi-new' && state[key] === 'absent' && before[key] !== 'absent');
  if (missing.length !== 1) return null;
  const [key] = missing;
  if (!sameOld({ ...state, [key]: before[key] }, before)) return null;
  const link = key === 'gui' ? guiRoot : path.join(root, key);
  const aside = fs.readdirSync(path.dirname(link)).filter((name) => name.startsWith(`${path.basename(link)}.osi-old-`));
  if (aside.length !== 1) return null;
  const file = key === 'gui' ? 'index.html' : 'index.js';
  const content = fs.readFileSync(path.join(path.dirname(link), aside[0], file), 'utf8');
  return content.includes(before[key]) ? key : null;
}

// Runs flipTo() in a child that exits after its k-th filesystem change;
// k = 0 runs to the end and reports the number of changes.
function killedFlip(env, prev, k) {
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const swap = require(${JSON.stringify(SWAP_JS)});
    const limit = ${k};
    let count = 0;
    for (const name of ['renameSync', 'symlinkSync', 'unlinkSync', 'rmSync', 'writeFileSync',
      'copyFileSync', 'cpSync', 'mkdirSync', 'linkSync']) {
      const real = fs[name];
      fs[name] = function (...args) {
        const result = real.apply(this, args);
        count += 1;
        if (count === limit) process.exit(${KILLED});
        return result;
      };
    }
    swap.flipTo(${JSON.stringify(env.root)}, 'new', ${JSON.stringify(env.guiRoot)}, ${JSON.stringify(prev)});
    process.stdout.write(String(count));
  `], { encoding: 'utf8' });
  return child;
}

// deploy.sh's choice of rollback payload for the retry: the legacy capture
// preflight, then the capture block (scripts lines between "# legacy payload
// capture begin" and "end"), then the module capture.
function retryPrevious({ root, guiRoot }, stamp) {
  const flowsPath = path.join(root, 'flows.json');
  swap.resumeInterruptedSwitch(root, guiRoot);
  swap.legacyCapturePreflight(root, flowsPath, guiRoot);
  let prev = swap.currentStamp(root);
  if (prev && !fs.existsSync(guiRoot)) prev = null;
  if ((!prev || swap.guiStamp(root, guiRoot) !== prev) && fs.existsSync(flowsPath) && fs.existsSync(guiRoot)) {
    prev = swap.legacyCaptureStamp(root, flowsPath, guiRoot);
    if (!prev) {
      prev = `${stamp}-previous`;
      swap.captureExisting(root, prev, flowsPath, guiRoot);
    }
  }
  if (prev) {
    swap.captureGui(root, prev, guiRoot);
    swap.captureModules(root, prev, stamp);
  }
  swap.linkNewModules(root, stamp, prev || '');
  return prev || '';
}

for (const [name, { build, windows }] of Object.entries(FIXTURES)) {
  test(`a kill at every step of the activation leaves one complete payload: ${name}`, (t) => {
    const dry = baseRoot();
    t.after(() => fs.rmSync(dry.root, { recursive: true, force: true }));
    const dryPrev = build(dry);
    const before = served(dry);
    const run = killedFlip(dry, dryPrev, 0);
    assert.equal(run.status, 0, run.stderr);
    const steps = Number(run.stdout);
    const after = served(dry);
    assert.equal(after.flows, 'flows@new');
    assert.equal(after.gui, 'gui@new');
    assert.equal(after['osi-new'], 'osi-new@new');
    assert.ok(steps > 1, `the activation makes ${steps} filesystem changes`);

    const seen = [];
    for (let k = 1; k <= steps; k += 1) {
      const env = baseRoot();
      try {
        const prev = build(env);
        const killed = killedFlip(env, prev, k);
        assert.equal(killed.status, KILLED, `k=${k}: ${killed.stderr}`);
        const state = served(env);
        const window = conversionWindow(env, state, before);
        if (window) seen.push(window);
        const complete = sameOld(state, before) || window ? 'old'
          : JSON.stringify(state) === JSON.stringify(after) ? 'new' : null;
        assert.ok(complete, `kill after change ${k} of ${steps} leaves a mixed payload: ${JSON.stringify(state)}`);

        // The retry: deploy.sh stages a new attempt and picks its rollback payload.
        stage(env.root, 'retry', ['osi-a', 'osi-new']);
        const retryPrev = retryPrevious(env, 'retry');
        assert.notEqual(retryPrev, '', `k=${k}: the retry finds a rollback payload`);
        assert.equal(swap.verifyPair(env.root, retryPrev), true, `k=${k}: payloads/${retryPrev} is complete`);
        swap.flipTo(env.root, 'retry', env.guiRoot, retryPrev);
        assert.equal(swap.verifyPair(env.root, 'retry', env.guiRoot), true, `k=${k}: the retry activates completely`);
        assert.throws(() => fs.lstatSync(path.join(env.root, 'payloads', '.active')), /ENOENT/, `k=${k}: the first version's link is gone`);
        assert.equal(fs.readlinkSync(path.join(env.root, 'payloads', 'active')), 'retry');
        assert.deepEqual(served(env), { ...after, flows: 'flows@retry', gui: 'gui@retry', 'osi-a': 'osi-a@retry', 'osi-new': 'osi-new@retry' });

        // The rollback returns to the set the gateway served after the kill.
        swap.flipTo(env.root, retryPrev, env.guiRoot);
        assert.equal(swap.verifyPair(env.root, retryPrev, env.guiRoot), true, `k=${k}: the rollback activates completely`);
        const back = served(env);
        assert.ok(complete === 'old' ? sameOld(back, before) : JSON.stringify(back) === JSON.stringify(after),
          `k=${k}: the rollback serves the ${complete} payload: ${JSON.stringify(back)}`);
      } finally {
        fs.rmSync(env.root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(seen.sort(), windows, 'only a directory conversion leaves an entry absent, once each');
  });
}

test('a kill during a first activation leaves nothing active or the complete payload', (t) => {
  const dry = baseRoot();
  t.after(() => fs.rmSync(dry.root, { recursive: true, force: true }));
  stage(dry.root, 'new', ['osi-a', 'osi-new']);
  const run = killedFlip(dry, '', 0);
  assert.equal(run.status, 0, run.stderr);
  const steps = Number(run.stdout);
  const after = served(dry);
  const none = { flows: 'absent', gui: 'absent', 'osi-a': 'absent', 'osi-gone': 'absent', 'osi-new': 'absent' };
  for (let k = 1; k <= steps; k += 1) {
    const env = baseRoot();
    try {
      stage(env.root, 'new', ['osi-a', 'osi-new']);
      assert.equal(killedFlip(env, '', k).status, KILLED);
      const state = served(env);
      assert.ok([JSON.stringify(none), JSON.stringify(after)].includes(JSON.stringify(state)),
        `kill after change ${k} of ${steps} leaves a partial first payload: ${JSON.stringify(state)}`);
      swap.flipTo(env.root, 'new', env.guiRoot);
      assert.equal(swap.verifyPair(env.root, 'new', env.guiRoot), true);
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }
});
