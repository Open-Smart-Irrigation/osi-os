'use strict';

// Issue S-1 (v0.8.2 review): a deploy killed during payload activation must
// leave the complete old payload or the complete new one, never a mix, and
// the retry and the rollback must both find a complete set.
//
// Each case runs a swap call in a child process that exits right after its
// k-th filesystem change, for every k the call makes, so no catch block or
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
const MODULES = ['osi-a', 'osi-gone', 'osi-new'];

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

function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(at), target), at);
}

// The v0.8.2 layout: one link per entry, straight into payloads/<stamp>.
function linkDirect(root, guiRoot, stamp, modules) {
  link(path.join(root, 'payloads', stamp, 'flows.json'), path.join(root, 'flows.json'));
  link(path.join(root, 'payloads', stamp, 'gui'), guiRoot);
  for (const name of modules) link(path.join(root, 'payloads', stamp, 'modules', name), path.join(root, name));
}

// A sysupgrade keeps /srv (flows and module links) and replaces the GUI link
// with the image GUI directory.
function sysupgrade(guiRoot) {
  fs.rmSync(guiRoot, { recursive: true, force: true });
  write(path.join(guiRoot, 'index.html'), 'gui@image\n');
}

// deploy.sh's capture block and module staging for the deploy of "new" on a
// gateway whose live flows and GUI are not one payload.
function legacyCapture(root, guiRoot) {
  swap.captureExisting(root, 'new-previous', path.join(root, 'flows.json'), guiRoot);
  swap.captureGui(root, 'new-previous', guiRoot);
  swap.captureModules(root, 'new-previous', 'new');
  swap.linkNewModules(root, 'new', 'new-previous');
  return 'new-previous';
}

// Each fixture is a gateway before the deploy of payload "new", which carries
// osi-a and osi-new and drops osi-gone. build() returns the rollback payload
// deploy.sh passes. windows lists the entries whose directory-to-link
// conversion has a one-rename window; extraOld lists other states the old
// side may show (row S7 starts mixed and the switch completes it);
// rolledBack is what the rollback serves when the kill came before the
// switch (default: the state before the deploy).
const FIXTURES = {
  'one active link': { windows: [], build: ({ root, guiRoot }) => {
    stage(root, 'old', ['osi-a', 'osi-gone']);
    swap.flipTo(root, 'old', guiRoot);
    stage(root, 'new', ['osi-a', 'osi-new']);
    swap.captureModules(root, 'old', 'new');
    swap.linkNewModules(root, 'new', 'old');
    return 'old';
  } },
  'one link per entry (v0.8.2 layout)': { windows: [], build: ({ root, guiRoot }) => {
    stage(root, 'old', ['osi-a', 'osi-gone']);
    linkDirect(root, guiRoot, 'old', ['osi-a', 'osi-gone']);
    stage(root, 'new', ['osi-a', 'osi-new']);
    swap.captureModules(root, 'old', 'new');
    swap.linkNewModules(root, 'new', 'old');
    return 'old';
  } },
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
  // Council #636 round 1: a module the old payload links and the new one
  // drops must be in the capture and stay served until the switch.
  'v0.8.2 layout after a sysupgrade, module dropped': { windows: ['gui'], build: ({ root, guiRoot }) => {
    stage(root, 'old', ['osi-a', 'osi-gone']);
    linkDirect(root, guiRoot, 'old', ['osi-a', 'osi-gone']);
    sysupgrade(guiRoot);
    stage(root, 'new', ['osi-a', 'osi-new']);
    return legacyCapture(root, guiRoot);
  } },
  'active layout after a sysupgrade, module dropped': { windows: ['gui'], build: ({ root, guiRoot }) => {
    stage(root, 'old', ['osi-a', 'osi-gone']);
    swap.flipTo(root, 'old', guiRoot);
    sysupgrade(guiRoot);
    stage(root, 'new', ['osi-a', 'osi-new']);
    return legacyCapture(root, guiRoot);
  } },
  // State-table row S7: a v0.8.2 deploy into "cut" was killed during its
  // module renames. Flows, GUI and osi-a are in cut; osi-gone is still the
  // v0.8.1 directory. The switch completes cut, as v0.8.2 would have.
  'v0.8.2 switch cut during the module renames (row S7)': {
    windows: ['osi-gone'],
    extraOld: [{ 'osi-gone': 'osi-gone@cut' }],
    rolledBack: { 'osi-gone': 'osi-gone@cut' },
    build: ({ root, guiRoot }) => {
      writeModule(path.join(root, 'osi-gone'), 'osi-gone@old');
      stage(root, 'cut', ['osi-a', 'osi-gone']);
      link(path.join(root, 'payloads', 'cut', 'flows.json'), path.join(root, 'flows.json'));
      link(path.join(root, 'payloads', 'cut', 'gui'), guiRoot);
      link(path.join(root, 'payloads', 'cut', 'modules', 'osi-a'), path.join(root, 'osi-a'));
      stage(root, 'new', ['osi-a', 'osi-new']);
      swap.captureModules(root, 'cut', 'new');
      swap.linkNewModules(root, 'new', 'cut');
      assert.match(swap.switchPreflight(root, 'new', guiRoot, 'cut'), /module osi-gone was left behind by a switch into payloads\/cut/);
      return 'cut';
    },
  },
};

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

function oldSide(fixture, before) {
  return [before, ...(fixture.extraOld || []).map((change) => ({ ...before, ...change }))];
}

// A directory cannot be replaced by a link in one rename(2) (EISDIR), so
// converting the image GUI or a pre-#603 module directory moves it aside
// first. A kill between the two renames leaves exactly that entry absent with
// its old content beside it, and everything else on the old side. Returns
// the entry, or null for any other state.
function conversionWindow({ root, guiRoot }, state, olds) {
  for (const before of olds) {
    const missing = Object.keys(before).filter((key) => key !== 'osi-new' && state[key] === 'absent' && before[key] !== 'absent');
    if (missing.length !== 1) continue;
    const [key] = missing;
    if (!sameOld({ ...state, [key]: before[key] }, before)) continue;
    const at = key === 'gui' ? guiRoot : path.join(root, key);
    const aside = fs.readdirSync(path.dirname(at)).filter((name) => name.startsWith(`${path.basename(at)}.osi-old-`));
    if (aside.length !== 1) continue;
    const file = key === 'gui' ? 'index.html' : 'index.js';
    if (fs.readFileSync(path.join(path.dirname(at), aside[0], file), 'utf8').includes(before[key])) return key;
  }
  return null;
}

function classify(env, state, olds, after) {
  if (olds.some((old) => sameOld(state, old))) return 'old';
  if (after && JSON.stringify(state) === JSON.stringify(after)) return 'new';
  return conversionWindow(env, state, olds) ? 'window' : null;
}

// Runs one swap call in a child that exits after its k-th filesystem change;
// k = 0 runs to the end and reports the number of changes.
function killed(env, k, call, args) {
  return spawnSync(process.execPath, ['-e', `
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
    swap[${JSON.stringify(call)}](...${JSON.stringify([env.root, ...args])});
    process.stdout.write(String(count));
  `], { encoding: 'utf8' });
}

function countSteps(env, call, args) {
  const run = killed(env, 0, call, args);
  assert.equal(run.status, 0, run.stderr);
  return Number(run.stdout);
}

// deploy.sh's choice of rollback payload for the retry: the resume step, the
// legacy capture preflight, the capture block, the module capture and the
// switch preflight, in deploy.sh's order.
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
  swap.switchPreflight(root, stamp, guiRoot, prev || '');
  return prev || '';
}

function withEnv(fn) {
  const env = baseRoot();
  try {
    return fn(env);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
}

for (const [name, fixture] of Object.entries(FIXTURES)) {
  test(`a kill at every step of the activation leaves one complete payload: ${name}`, () => {
    const { before, after, steps } = withEnv((dry) => {
      const prev = fixture.build(dry);
      const state = served(dry);
      const n = countSteps(dry, 'flipTo', ['new', dry.guiRoot, prev]);
      return { before: state, after: served(dry), steps: n };
    });
    assert.equal(after.flows, 'flows@new');
    assert.equal(after.gui, 'gui@new');
    assert.equal(after['osi-new'], 'osi-new@new');
    const olds = oldSide(fixture, before);
    const rolledBack = { ...before, ...(fixture.rolledBack || {}) };

    const seen = [];
    for (let k = 1; k <= steps; k += 1) {
      withEnv((env) => {
        const prev = fixture.build(env);
        const run = killed(env, k, 'flipTo', ['new', env.guiRoot, prev]);
        assert.equal(run.status, KILLED, `k=${k}: ${run.stderr}`);
        const state = served(env);
        const kind = classify(env, state, olds, after);
        assert.ok(kind, `kill after change ${k} of ${steps} leaves a mixed payload: ${JSON.stringify(state)}`);
        if (kind === 'window') seen.push(conversionWindow(env, state, olds));

        // The retry: the resume step moves a set-aside directory back first.
        stage(env.root, 'retry', ['osi-a', 'osi-new']);
        const retryPrev = retryPrevious(env, 'retry');
        if (kind === 'window') assert.ok(olds.some((old) => sameOld(served(env), old)), `k=${k}: the resume step restores the old side`);
        assert.notEqual(retryPrev, '', `k=${k}: the retry finds a rollback payload`);
        assert.equal(swap.verifyPair(env.root, retryPrev), true, `k=${k}: payloads/${retryPrev} is complete`);
        swap.flipTo(env.root, 'retry', env.guiRoot, retryPrev);
        assert.equal(swap.verifyPair(env.root, 'retry', env.guiRoot), true, `k=${k}: the retry activates completely`);
        const left = [env.root, path.dirname(env.guiRoot), path.join(env.root, 'payloads')]
          .flatMap((dir) => fs.readdirSync(dir).filter((entry) => /\.(flip|osi-old)-/.test(entry)));
        assert.deepEqual(left, [], `k=${k}: the retry leaves nothing a killed switch left behind`);
        assert.deepEqual(served(env), { ...after, flows: 'flows@retry', gui: 'gui@retry', 'osi-a': 'osi-a@retry', 'osi-new': 'osi-new@retry' });

        // The rollback returns to a complete set: the old payload when the
        // kill came before the switch, the new one after it.
        swap.flipTo(env.root, retryPrev, env.guiRoot);
        assert.equal(swap.verifyPair(env.root, retryPrev, env.guiRoot), true, `k=${k}: the rollback activates completely`);
        const back = served(env);
        assert.ok(kind === 'new' ? JSON.stringify(back) === JSON.stringify(after) : sameOld(back, rolledBack),
          `k=${k}: the rollback serves the ${kind === 'new' ? 'new' : 'old'} payload: ${JSON.stringify(back)}`);
      });
    }
    assert.deepEqual(seen.sort(), fixture.windows, 'only a directory conversion leaves an entry absent, once each');
  });

  test(`a kill at every step of the rollback after a completed switch leaves one complete payload: ${name}`, () => {
    const { before, after, steps } = withEnv((dry) => {
      const prev = fixture.build(dry);
      const state = served(dry);
      swap.flipTo(dry.root, 'new', dry.guiRoot, prev);
      const done = served(dry);
      return { before: state, after: done, steps: countSteps(dry, 'flipTo', [prev, dry.guiRoot]) };
    });
    const rolledBack = { ...before, ...(fixture.rolledBack || {}) };
    for (let k = 1; k <= steps; k += 1) {
      withEnv((env) => {
        const prev = fixture.build(env);
        swap.flipTo(env.root, 'new', env.guiRoot, prev);
        assert.equal(killed(env, k, 'flipTo', [prev, env.guiRoot]).status, KILLED);
        const state = served(env);
        assert.ok(JSON.stringify(state) === JSON.stringify(after) || sameOld(state, rolledBack),
          `rollback killed after change ${k} of ${steps}: ${JSON.stringify(state)}`);
        swap.flipTo(env.root, prev, env.guiRoot);
        assert.ok(sameOld(served(env), rolledBack));
      });
    }
  });

  test(`a kill at every step of a rollback before the switch began keeps the old payload served: ${name}`, () => {
    // deploy.sh's exit handler after a failure between the Node-RED stop and
    // the forward switch: flipTo(PREV, GUI) with nothing switched yet.
    const { before, steps } = withEnv((dry) => {
      const prev = fixture.build(dry);
      const state = served(dry);
      return { before: state, steps: countSteps(dry, 'flipTo', [prev, dry.guiRoot]) };
    });
    const olds = oldSide(fixture, before);
    for (let k = 1; k <= steps; k += 1) {
      withEnv((env) => {
        const prev = fixture.build(env);
        assert.equal(killed(env, k, 'flipTo', [prev, env.guiRoot]).status, KILLED);
        const state = served(env);
        // The old payload stays served; converting a real directory to a link
        // has its one-rename window here as on the forward switch.
        assert.ok(classify(env, state, olds, null), `rollback before the switch killed after change ${k} of ${steps}: ${JSON.stringify(state)}`);
        swap.resumeInterruptedSwitch(env.root, env.guiRoot);
        swap.flipTo(env.root, prev, env.guiRoot);
        assert.equal(swap.verifyPair(env.root, prev, env.guiRoot), true);
        assert.ok(sameOld(served(env), { ...before, ...(fixture.rolledBack || {}) }));
      });
    }
  });
}

test('a kill at every step of the resume step leaves the window or the old payload', () => {
  const fixture = FIXTURES['regular files captured (v0.8.1 after sysupgrade)'];
  const before = withEnv((dry) => { fixture.build(dry); return served(dry); });
  const steps = withEnv((dry) => {
    const prev = fixture.build(dry);
    return countSteps(dry, 'flipTo', ['new', dry.guiRoot, prev]);
  });
  const windows = [];
  for (let k = 1; k <= steps; k += 1) {
    withEnv((env) => {
      killed(env, k, 'flipTo', ['new', env.guiRoot, fixture.build(env)]);
      if (conversionWindow(env, served(env), [before])) windows.push(k);
    });
  }
  assert.equal(windows.length, fixture.windows.length);
  for (const at of windows) {
    const resumeSteps = withEnv((env) => {
      killed(env, at, 'flipTo', ['new', env.guiRoot, fixture.build(env)]);
      return countSteps(env, 'resumeInterruptedSwitch', [env.guiRoot]);
    });
    assert.ok(resumeSteps >= 1);
    for (let k = 1; k <= resumeSteps; k += 1) {
      withEnv((env) => {
        killed(env, at, 'flipTo', ['new', env.guiRoot, fixture.build(env)]);
        assert.equal(killed(env, k, 'resumeInterruptedSwitch', [env.guiRoot]).status, KILLED);
        const state = served(env);
        assert.ok(sameOld(state, before) || conversionWindow(env, state, [before]),
          `resume killed after change ${k} of ${resumeSteps} (window at ${at}): ${JSON.stringify(state)}`);
        swap.resumeInterruptedSwitch(env.root, env.guiRoot);
        assert.ok(sameOld(served(env), before));
      });
    }
  }
});

test('a kill during a first activation leaves no flows running or the complete payload', () => {
  const build = ({ root }) => {
    stage(root, 'new', ['osi-a', 'osi-new']);
    // deploy.sh links every module before the stop, for npm install.
    swap.linkNewModules(root, 'new', '');
  };
  const { after, steps } = withEnv((dry) => {
    build(dry);
    const n = countSteps(dry, 'flipTo', ['new', dry.guiRoot, '']);
    return { after: served(dry), steps: n };
  });
  for (let k = 1; k <= steps; k += 1) {
    withEnv((env) => {
      build(env);
      assert.equal(killed(env, k, 'flipTo', ['new', env.guiRoot, '']).status, KILLED);
      const state = served(env);
      assert.ok(JSON.stringify(state) === JSON.stringify(after) || (state.flows === 'absent' && state.gui === 'absent'),
        `kill after change ${k} of ${steps} leaves a partial first payload: ${JSON.stringify(state)}`);
      stage(env.root, 'retry', ['osi-a', 'osi-new']);
      const prev = retryPrevious(env, 'retry');
      swap.flipTo(env.root, 'retry', env.guiRoot, prev);
      assert.equal(swap.verifyPair(env.root, 'retry', env.guiRoot), true);
    });
  }
});
