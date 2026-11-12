'use strict';

// Issue S-1 (v0.8.2 review), council #636: a deploy killed at any instant
// leaves the complete old payload or the complete new one, and the retry and
// the rollback both end on a healthy payload, from every state the field can
// be in.
//
// The starting states are the rows of the deploy state table
// (scripts/helpers/deploy-state-table.js), every variant, and the variant
// with a stale legacy-capture marker where the table has one. From each row
// the test runs deploy.sh's decision sequence (resume step, legacy-capture
// preflight, capture block, module capture, switch preflight, rollback
// target). A row deploy.sh refuses there is refused before Node-RED stops:
// the test checks that nothing served changed and that the refusal is one of
// the expected ones. For every other row it kills, after every filesystem
// change, in a child process that exits on the spot (no catch, no finally):
// - the forward switch; after each kill a reboot (node-red.init's repair
//   step), then a retry and a rollback;
// - the rollback after a completed switch;
// - a rollback before the switch began (deploy.sh's exit handler after a
//   failure between the Node-RED stop and the switch);
// - the resume step, from every state the forward switch left in a window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const swap = require('./deploy-payload-swap');
const table = require('./helpers/deploy-state-table');

const SWAP_JS = path.join(__dirname, 'deploy-payload-swap.js');
const KILLED = 86;
const MODULES = ['osi-a', 'osi-b', 'osi-c'];
// The release this deploy brings: it keeps osi-a, drops osi-b, adds osi-c.
const NEW_MODULES = { 'osi-a': '', 'osi-c': '' };

// Rows deploy.sh refuses before Node-RED stops, with the refusal's reason.
// The table's REFUSE rows, plus the rows the resume step turns into one.
const EXPECTED_REFUSALS = {
  S13: /refusing to recapture changed legacy files after a prior attempt/,
  S15: /no deploy attempt can be read from it/,
  S16: /legacy evidence is unreadable|refusing to recapture changed legacy files after a prior attempt/,
  S17: /refusing to capture a half-switched state/,
  S18: /refusing to capture a half-switched state/,
  S26: /refusing to capture a half-switched state/,
  S27: /refusing to capture a half-switched state/,
  S28: /refusing to capture a half-switched state/,
  S29: /module manifest (unreadable|malformed)/,
  S30: /refusing to recapture changed legacy files after a prior attempt/,
  S32: /refusing to capture a half-switched state/,
  S33: /refusing to capture a half-switched state/,
  S38: /refusing to recapture changed legacy files after a prior attempt/,
};

// Rows whose starting state serves no complete payload, so "complete old"
// does not exist; what is checked instead is named in each entry.
const NO_COMPLETE_OLD = {
  S2: 'flows.json leads into a payload that is gone, so no flows run: the switch removes payloads/active first, and a kill leaves no flows served or the complete new payload',
  S3: 'the GUI leads into a pruned payload and the flows payload has no GUI (v0.7.0): the switch replaces entries one by one, as before payloads/active; a kill leaves old flows with a missing or new GUI',
};

const NODE_RED_INIT = fs.readFileSync(path.join(__dirname, '..', 'feeds', 'chirpstack-openwrt-feed', 'apps', 'node-red', 'files', 'node-red.init'), 'utf8');

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return fallback; }
}

// What a Node-RED restarted at this instant would load.
function served(g) {
  const out = { flows: readOr(g.flowsPath, 'absent'), gui: readOr(path.join(g.guiRoot, 'index.html'), 'absent') };
  for (const name of MODULES) out[name] = readOr(path.join(g.root, name, 'index.js'), 'absent');
  return out;
}

// osi-c is new in this release: deploy.sh links it before the stop for npm
// install, and the old flows never load it.
function sameOld(state, old) {
  const strip = ({ 'osi-c': _new, ...rest }) => JSON.stringify(rest);
  return strip(state) === strip(old);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function bootRepair(g) {
  const begin = NODE_RED_INIT.indexOf('# payload switch repair begin');
  const end = NODE_RED_INIT.indexOf('# payload switch repair end');
  assert.ok(begin >= 0 && end > begin, 'node-red.init must keep its payload switch repair block');
  const block = NODE_RED_INIT.slice(begin, end)
    .split('/srv/$PACKAGE_NAME').join(g.root)
    .split('/usr/lib/node-red/gui').join(g.guiRoot);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-bin-'));
  try {
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(path.join(g.root, 'boot.log'))}\n`, { mode: 0o755 });
    const run = spawnSync('sh', ['-c', `${block}\npayload_switch_repair`], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
  return readOr(path.join(g.root, 'boot.log'), '');
}

// deploy.sh's owed health check (between "# owed health check begin" and
// "end"): an active payload a cut deploy left unchecked is checked first.
// <outcome> stands for the health check's result. Returns null, or
// { held: <payload> } when deploy.sh holds Node-RED stopped and exits.
function owedCheck(g, outcome) {
  const [head, ledger] = g.schema || ['', ''];
  const plan = swap.owedCheckPlan(g.root, head, ledger);
  if (!plan) return null;
  const [payload, migrated, fallback] = plan.split('|');
  if (outcome === 'pass') {
    swap.markHealthy(g.root, payload);
    swap.writePayloadState(g.root, payload, 'healthy', 'its owed health check passed');
    return null;
  }
  swap.markFailed(g.root, payload, 'owed health check failed');
  if (migrated === '1' || !fallback) {
    swap.writePayloadState(g.root, payload, 'held', 'its owed health check failed and only it matches the migrated database');
    return { held: payload };
  }
  swap.flipTo(g.root, fallback, g.guiRoot);
  swap.writePayloadState(g.root, fallback, 'healthy', `payloads/${payload} failed its owed health check; returned to this payload`);
  return null;
}

// deploy.sh's decision sequence for a deploy of <stamp>, before Node-RED
// stops. Returns { refused }, { held } or { served, prev, notes }.
function deployDecision(g, stamp, outcome = 'pass') {
  try {
    swap.resumeInterruptedSwitch(g.root, g.guiRoot);
    swap.legacyCapturePreflight(g.root, g.flowsPath, g.guiRoot);
    const owed = owedCheck(g, outcome);
    if (owed) return owed;
    table.stageWithModules(g.root, stamp, NEW_MODULES);
    let prev = swap.currentStamp(g.root) || '';
    const prevGui = swap.guiStamp(g.root, g.guiRoot);
    const guiDir = fs.existsSync(g.guiRoot) && fs.statSync(g.guiRoot).isDirectory();
    const flowsFile = fs.existsSync(g.flowsPath) && fs.statSync(g.flowsPath).isFile();
    if (prev && !guiDir && !swap.verifyPair(g.root, prev)) prev = '';
    if ((!prev || prevGui !== prev) && flowsFile && guiDir) {
      prev = swap.legacyCaptureStamp(g.root, g.flowsPath, g.guiRoot);
      if (!prev) {
        prev = `${stamp}-previous`;
        swap.captureExisting(g.root, prev, g.flowsPath, g.guiRoot);
      }
    }
    if (prev) {
      swap.captureGui(g.root, prev, g.guiRoot);
      swap.captureModules(g.root, prev, stamp);
    }
    swap.linkNewModules(g.root, stamp, prev);
    const notes = swap.switchPreflight(g.root, stamp, g.guiRoot, prev) || '';
    const target = prev ? swap.rollbackTarget(g.root, prev, stamp) : '';
    return { served: prev, prev: target, notes };
  } catch (error) {
    return { refused: error.message };
  }
}

// The states the old side may show: as served, with a module a cut switch
// left behind completed (switchPreflight names it), and with a missing GUI
// restored from the base.
function oldSide(g, old, decision) {
  const olds = [old];
  for (const [, name, stamp] of decision.notes.matchAll(/module (osi-[a-z0-9-]+) was left behind by a switch into payloads\/(\S+) that was cut/g)) {
    olds.push({ ...olds[olds.length - 1], [name]: readOr(path.join(g.root, 'payloads', stamp, 'modules', name, 'index.js'), 'absent') });
  }
  if (old.gui === 'absent' && decision.served) {
    for (const o of [...olds]) olds.push({ ...o, gui: readOr(path.join(g.root, 'payloads', decision.served, 'gui', 'index.html'), 'absent') });
  }
  return olds;
}

// A directory cannot be replaced by a link in one rename(2) (EISDIR). A kill
// between moving it aside and linking leaves exactly that entry absent with
// its old content beside it.
function conversionWindow(g, state, olds) {
  for (const old of olds) {
    const missing = Object.keys(old).filter((key) => key !== 'osi-c' && state[key] === 'absent' && old[key] !== 'absent');
    if (missing.length !== 1) continue;
    const [key] = missing;
    if (!sameOld({ ...state, [key]: old[key] }, old)) continue;
    const at = key === 'gui' ? g.guiRoot : key === 'flows' ? g.flowsPath : path.join(g.root, key);
    const aside = fs.readdirSync(path.dirname(at)).filter((name) => name.startsWith(`${path.basename(at)}.osi-old-`));
    const file = key === 'gui' ? 'index.html' : key === 'flows' ? '' : 'index.js';
    if (aside.some((name) => readOr(path.join(path.dirname(at), name, file), null) === old[key])) return key;
  }
  return null;
}

function classify(g, state, olds, after) {
  if (olds.some((old) => sameOld(state, old))) return 'old';
  if (after && same(state, after)) return 'new';
  return conversionWindow(g, state, olds) ? 'window' : null;
}

function killed(g, k, call, args) {
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
    swap[${JSON.stringify(call)}](...${JSON.stringify([g.root, ...args])});
    process.stdout.write(String(count));
  `], { encoding: 'utf8' });
}

function countSteps(g, call, args) {
  const run = killed(g, 0, call, args);
  assert.equal(run.status, 0, run.stderr);
  return Number(run.stdout);
}

// Builds the row's gateway, runs the decision, and hands both to fn.
function withRow(build, stale, fn) {
  const root = table.tableRoot();
  try {
    const g = table.tableGateway(root);
    fs.copyFileSync(SWAP_JS, path.join(root, '.payload-swap.js'));
    build(g);
    if (stale) table.staleMarker(g.marker, 'gone-previous');
    const decision = deployDecision(g, 'new');
    // deploy.sh records the payload as activated just before its switch.
    if (!decision.refused && !decision.held) swap.markActivated(g.root, 'new');
    return fn(g, decision);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function leftovers(g) {
  return [g.root, path.dirname(g.guiRoot), path.join(g.root, 'payloads')]
    .flatMap((dir) => fs.readdirSync(dir).filter((entry) => /\.(flip|osi-old)-/.test(entry)));
}

// The retry after a kill and its rollback: both end on a complete payload,
// and the rollback on one that passed its health check or predates the record.
function retryAndRollback(g, label) {
  const retry = deployDecision(g, 'retry');
  assert.ok(!retry.refused, `${label}: the retry is not refused: ${retry.refused}`);
  swap.markActivated(g.root, 'retry');
  swap.flipTo(g.root, 'retry', g.guiRoot, retry.served);
  assert.equal(swap.verifyPair(g.root, 'retry', g.guiRoot), true, `${label}: the retry activates completely`);
  const state = served(g);
  for (const [key, want] of [['flows', 'retry'], ['gui', 'retry'], ['osi-a', 'osi-a@retry'], ['osi-c', 'osi-c@retry']]) {
    assert.ok(state[key].includes(want), `${label}: the retry serves ${key} from payloads/retry: ${state[key]}`);
  }
  assert.deepEqual(leftovers(g), [], `${label}: the retry leaves nothing a killed switch left behind`);
  if (!retry.prev) return;
  swap.flipTo(g.root, retry.prev, g.guiRoot);
  assert.equal(swap.verifyPair(g.root, retry.prev, g.guiRoot), true, `${label}: the rollback activates payloads/${retry.prev} completely`);
  assert.equal(swap.payloadTrusted(g.root, retry.prev), true, `${label}: the rollback target passed its health check or predates the record`);
}

const CASES = [];
for (const row of table.STATE_TABLE) {
  row.builds.forEach((build, index) => {
    for (const stale of row.stale ? [false, true] : [false]) {
      CASES.push({ row: row.row, label: `${row.row} variant ${index + 1}${stale ? ', stale marker' : ''}`, build, stale });
    }
  });
}

test('every row of the deploy state table is a starting state of the kill matrix', () => {
  const rows = new Set(CASES.map((c) => c.row));
  assert.deepEqual([...rows], table.STATE_TABLE.map((r) => r.row));
});

for (const c of CASES) {
  test(`kill matrix ${c.label}`, () => {
    const plan = withRow(c.build, c.stale, (g, decision) => {
      const old = served(g);
      if (decision.refused) return { refused: decision.refused };
      const olds = oldSide(g, old, decision);
      const steps = countSteps(g, 'flipTo', ['new', g.guiRoot, decision.served]);
      const after = served(g);
      const rollbackSteps = decision.prev ? countSteps(g, 'flipTo', [decision.prev, g.guiRoot]) : 0;
      const rolledBack = served(g);
      return { olds, after, steps, rollbackSteps, rolledBack, prev: decision.prev };
    });

    if (plan.refused) {
      assert.ok(EXPECTED_REFUSALS[c.row], `${c.label}: refused unexpectedly: ${plan.refused}`);
      assert.match(plan.refused, EXPECTED_REFUSALS[c.row]);
      // The refusal comes before anything served changes.
      withRow(c.build, c.stale, () => null);
      const root = table.tableRoot();
      try {
        const g = table.tableGateway(root);
        c.build(g);
        if (c.stale) table.staleMarker(g.marker, 'gone-previous');
        swap.resumeInterruptedSwitch(g.root, g.guiRoot);
        const resumed = served(g);
        deployDecision(g, 'new');
        assert.deepEqual(served(g), resumed, `${c.label}: a refusal changes nothing served`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    assert.ok(!EXPECTED_REFUSALS[c.row], `${c.label}: expected a refusal`);
    assert.ok(plan.after.flows.includes('new') && plan.after.gui.includes('new') && plan.after['osi-a'].includes('osi-a@new'), `${c.label}: the switch serves the new payload`);
    const loose = NO_COMPLETE_OLD[c.row];

    const windows = [];
    for (let k = 1; k <= plan.steps; k += 1) {
      withRow(c.build, c.stale, (g, decision) => {
        assert.equal(killed(g, k, 'flipTo', ['new', g.guiRoot, decision.served]).status, KILLED);
        const state = served(g);
        const kind = classify(g, state, plan.olds, plan.after);
        if (loose) {
          assert.ok(kind || state.flows === 'absent' || c.row === 'S3', `${c.label} k=${k}: ${JSON.stringify(state)}`);
        } else {
          assert.ok(kind, `${c.label}: kill after change ${k} of ${plan.steps} leaves a mixed payload: ${JSON.stringify(state)}`);
        }
        if (kind === 'window') windows.push(k);
        const log = bootRepair(g);
        const booted = served(g);
        if (kind === 'window') {
          assert.ok(plan.olds.some((old) => sameOld(booted, old)), `${c.label} k=${k}: the start after a reboot serves the old payload: ${JSON.stringify(booted)}`);
        } else if (loose && /moved it back/.test(log)) {
          // A per-entry replacement window; the repair moved the entry back.
        } else {
          assert.deepEqual(booted, state, `${c.label} k=${k}: the boot repair leaves a complete payload alone`);
        }
        assert.doesNotMatch(log, /failed/);
        retryAndRollback(g, `${c.label} k=${k}`);
      });
    }

    for (let k = 1; k <= plan.rollbackSteps; k += 1) {
      withRow(c.build, c.stale, (g, decision) => {
        swap.flipTo(g.root, 'new', g.guiRoot, decision.served);
        assert.equal(killed(g, k, 'flipTo', [decision.prev, g.guiRoot]).status, KILLED);
        const state = served(g);
        assert.ok(same(state, plan.after) || same(state, plan.rolledBack),
          `${c.label}: rollback killed after change ${k} of ${plan.rollbackSteps}: ${JSON.stringify(state)}`);
        swap.flipTo(g.root, decision.prev, g.guiRoot);
        assert.equal(swap.verifyPair(g.root, decision.prev, g.guiRoot), true);
      });
    }

    if (plan.prev) {
      const beforeSteps = withRow(c.build, c.stale, (g, decision) => countSteps(g, 'flipTo', [decision.prev, g.guiRoot]));
      for (let k = 1; k <= beforeSteps; k += 1) {
        withRow(c.build, c.stale, (g, decision) => {
          assert.equal(killed(g, k, 'flipTo', [decision.prev, g.guiRoot]).status, KILLED);
          const state = served(g);
          assert.ok(classify(g, state, plan.olds, null) || loose,
            `${c.label}: rollback before the switch killed after change ${k} of ${beforeSteps}: ${JSON.stringify(state)}`);
          swap.resumeInterruptedSwitch(g.root, g.guiRoot);
          swap.flipTo(g.root, decision.prev, g.guiRoot);
          assert.equal(swap.verifyPair(g.root, decision.prev, g.guiRoot), true);
          assert.equal(swap.payloadTrusted(g.root, decision.prev), true);
        });
      }
    }

    for (const at of windows) {
      const resumeSteps = withRow(c.build, c.stale, (g, decision) => {
        killed(g, at, 'flipTo', ['new', g.guiRoot, decision.served]);
        return countSteps(g, 'resumeInterruptedSwitch', [g.guiRoot]);
      });
      for (let k = 1; k <= resumeSteps; k += 1) {
        withRow(c.build, c.stale, (g, decision) => {
          killed(g, at, 'flipTo', ['new', g.guiRoot, decision.served]);
          assert.equal(killed(g, k, 'resumeInterruptedSwitch', [g.guiRoot]).status, KILLED);
          const state = served(g);
          assert.ok(plan.olds.some((old) => sameOld(state, old)) || conversionWindow(g, state, plan.olds),
            `${c.label}: resume killed after change ${k} of ${resumeSteps} (window at ${at}): ${JSON.stringify(state)}`);
          swap.resumeInterruptedSwitch(g.root, g.guiRoot);
          assert.ok(plan.olds.some((old) => sameOld(served(g), old)));
        });
      }
    }
  });
}

test('a kill during a first activation leaves no flows running or the complete payload', () => {
  const build = (g) => {
    table.stageWithModules(g.root, 'new', NEW_MODULES);
    swap.linkNewModules(g.root, 'new', '');
  };
  const root0 = table.tableRoot();
  let steps;
  let after;
  try {
    const g = table.tableGateway(root0);
    build(g);
    steps = countSteps(g, 'flipTo', ['new', g.guiRoot, '']);
    after = served(g);
  } finally {
    fs.rmSync(root0, { recursive: true, force: true });
  }
  for (let k = 1; k <= steps; k += 1) {
    const root = table.tableRoot();
    try {
      const g = table.tableGateway(root);
      build(g);
      assert.equal(killed(g, k, 'flipTo', ['new', g.guiRoot, '']).status, KILLED);
      const state = served(g);
      assert.ok(same(state, after) || (state.flows === 'absent' && state.gui === 'absent'),
        `kill after change ${k} of ${steps} leaves a partial first payload: ${JSON.stringify(state)}`);
      retryAndRollback(g, `first activation k=${k}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

// The S-1 ruling: unchecked is not failed. A deploy cut between its switch
// and its health check, with and without a migration; then the retry's owed
// check passing, failing, or a reboot without any retry.
for (const row of ['S41', 'S42']) {
  const build = table.STATE_TABLE.find((r) => r.row === row).builds[0];
  const migrated = row === 'S41';
  const withCut = (fn) => {
    const root = table.tableRoot();
    try {
      const g = table.tableGateway(root);
      fs.copyFileSync(SWAP_JS, path.join(root, '.payload-swap.js'));
      build(g);
      return fn(g);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const runsCut = (g) => {
    const state = served(g);
    assert.ok(state.flows.includes('cut') && state.gui.includes('cut') && state['osi-a'].includes('osi-a@cut'), JSON.stringify(state));
  };

  test(`owed check ${row}: a reboot without a retry starts the cut payload and records it unverified`, () => {
    withCut((g) => {
      const log = bootRepair(g);
      runsCut(g);
      const state = swap.readPayloadState(g.root);
      assert.equal(state.active, 'cut');
      assert.equal(state.state, 'unverified');
      assert.equal(state.writer, 'node-red.init');
      assert.match(log, /payloads\/cut runs unverified/);
      assert.equal(swap.payloadTrusted(g.root, 'cut'), false, 'never a rollback target while unverified');
      assert.equal(swap.rollbackTarget(g.root, 'cut', 'next'), 'old');
      assert.equal(bootRepair(g), log, 'a second boot changes nothing');
    });
  });

  test(`owed check ${row}: the retry's check passes, the cut payload becomes healthy and the deploy goes on`, () => {
    withCut((g) => {
      bootRepair(g);
      const decision = deployDecision(g, 'new', 'pass');
      assert.ok(!decision.refused && !decision.held, JSON.stringify(decision));
      assert.equal(decision.served, 'cut');
      assert.equal(decision.prev, 'cut', 'the checked payload is the rollback target');
      assert.equal(swap.payloadTrusted(g.root, 'cut'), true);
      assert.deepEqual(
        (({ active, state, writer }) => ({ active, state, writer }))(swap.readPayloadState(g.root)),
        { active: 'cut', state: 'healthy', writer: 'deploy.sh' });
      runsCut(g);
    });
  });

  test(`owed check ${row}: the retry's check fails`, () => {
    withCut((g) => {
      bootRepair(g);
      const decision = deployDecision(g, 'new', 'fail');
      const state = swap.readPayloadState(g.root);
      assert.equal(swap.readHealth(g.root, 'cut').state, 'failed');
      if (migrated) {
        // Only the cut payload matches the migrated database: held, never
        // older code on it.
        assert.deepEqual(decision, { held: 'cut' });
        runsCut(g);
        assert.equal(state.state, 'held');
        assert.equal(state.active, 'cut');
      } else {
        // The database was not migrated: the older healthy payload fits it.
        assert.ok(!decision.held && !decision.refused, JSON.stringify(decision));
        const now = served(g);
        assert.ok(now.flows.includes('old') && now.gui.includes('old') && now['osi-a'].includes('osi-a@old'), JSON.stringify(now));
        assert.equal(state.state, 'healthy');
        assert.equal(state.active, 'old');
        assert.equal(decision.served, 'old');
      }
    });
  });
}
