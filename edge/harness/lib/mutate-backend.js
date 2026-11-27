'use strict';
// Backend runs for the mutation pass. Reuses lib/backend.js (startNodeRed,
// startCommand) and lib/run.js (runScenario, one step per call so the pass
// keeps the scenario's captured variables itself).
//
// startOracleFrom() is startNodeRed() with one difference: it boots the
// shipped flows on a given database snapshot instead of a fresh seed. Keep
// its environment in step with lib/backend.js.
const fs = require('node:fs'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { startNodeRed, startCommand, request } = require('./backend');
const { runScenario } = require('./run');
const { fileSnapshot, fileDiff, effectsOf } = require('./mutate-effects');
const ROOT = path.resolve(__dirname, '../../..');
const TIMERS = require('../timers.json');

const ctl = async (port, p, body) => {
  const r = await request(port, body === undefined ? 'GET' : 'POST', p, body, {}, 60000);
  const j = JSON.parse(r.raw.toString() || 'null');
  if (r.status !== 200) throw new Error('control ' + p + ': ' + JSON.stringify(j));
  return j;
};

function oracleNode() {
  const pinned = /OSI_SMOKE_NODE_VERSION:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, '.github/workflows/release-smoke.yml'), 'utf8'))[1];
  const bin = process.env.OSI_ORACLE_NODE || path.join(process.env.HOME || '', '.local/node-v' + pinned + '-linux-x64/bin/node');
  const actual = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== pinned) throw new Error('oracle needs Node ' + pinned + ' at ' + bin);
  return bin;
}

async function startOracleFrom({ run, snapshot, scoped = false, cloud = false }) {
  if (!snapshot) return startNodeRed({ run, scoped, cloud });
  fs.mkdirSync(path.join(run, 'data/db'), { recursive: true });
  fs.copyFileSync(snapshot, path.join(run, 'data/db/farming.db'));
  const ready = path.join(run, 'oracle-ready.json');
  const out = fs.openSync(path.join(run, 'oracle.log'), 'w');
  const child = spawn(oracleNode(), ['--max-old-space-size=1536', path.join(__dirname, '../oracle-node-red.js')], {
    cwd: ROOT, stdio: ['ignore', out, out],
    env: { PATH: process.env.PATH, HOME: run, LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: run, UV_THREADPOOL_SIZE: '4',
      OSI_SMOKE_RUNTIME: 'image', OSI_SMOKE_RUN: run, OSI_ORACLE_READY_FILE: ready, OSI_ORACLE_SCOPED: scoped ? '1' : '0',
      OSI_HARNESS_CLOUD: cloud ? '1' : '0', OSI_HARNESS_PODMAN_HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR },
  });
  const end = Date.now() + 120000;
  while (!fs.existsSync(ready)) {
    if (child.exitCode !== null) throw new Error('node-red oracle exited ' + child.exitCode + '; see ' + path.join(run, 'oracle.log'));
    if (Date.now() > end) { child.kill('SIGKILL'); throw new Error('node-red oracle not ready'); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const info = JSON.parse(fs.readFileSync(ready, 'utf8'));
  return {
    name: 'node-red', http: info.http, mqtt: info.mqtt, db: info.db, info, child,
    control: {
      radio: () => ctl(info.control, '/radio'), mqtt: () => ctl(info.control, '/mqtt'),
      cloud: cloud ? (action) => ctl(info.control, '/cloud', action && { action }) : undefined,
      settle: () => ctl(info.control, '/settle', {}),
      timer: (name) => { const id = TIMERS[name] && TIMERS[name]['node-red']; if (!id) throw new Error('unknown timer ' + name); return ctl(info.control, '/inject', { id }); },
      backup: (to) => ctl(info.control, '/backup', { to }),
      logs: () => ctl(info.control, '/logs'),
    },
    async stop() {
      try { await ctl(info.control, '/stop', {}); } catch { child.kill('SIGKILL'); } finally {
        await new Promise((r) => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
      }
    },
  };
}

const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function resolveAuth(step, vars) {
  const a = step.http && step.http.auth;
  if (!a || a === 'none' || a.startsWith('Bearer ')) return step;
  return { ...step, http: { ...step.http, auth: 'Bearer ' + (vars[a] ?? 'missing-' + a) } };
}

// Both stand-ins read TMPDIR/radio-fault.json (TMPDIR is the run dir).
function armRadioFault(run, step) {
  const file = path.join(run, 'radio-fault.json');
  if (Array.isArray(step.radioFault) && step.radioFault.length) {
    fs.writeFileSync(file + '.next', JSON.stringify({ id: step.id, faults: step.radioFault }), { mode: 0o600 });
    fs.renameSync(file + '.next', file);
  } else fs.rmSync(file, { force: true });
}

// Runs steps one at a time; returns the raw records and the updated vars.
async function runSteps(backend, run, scenarioName, steps, vars, state) {
  const records = [];
  for (const step of steps) {
    armRadioFault(run, step);
    // One anchor for a whole run (state.anchorMs): the date tokens of the
    // oracle side and the backend side expand to the same text.
    const r = await runScenario(backend, { name: scenarioName, steps: [resolveAuth(step, vars)] },
      { cloudSeen: state.cloudSeen, ...(state.anchorMs !== undefined && { anchorMs: state.anchorMs }) });
    state.cloudSeen = r.cloudSeen;
    const rec = r.steps[0];
    for (const [name, p] of Object.entries(step.capture || {})) vars[name] = pick({ json: rec.response ? rec.response.json : undefined }, p);
    records.push(rec);
  }
  armRadioFault(run, {});
  return records;
}

// A round is quiet when it has no effect after normalisation: a timestamp
// restamped in the same form (a tick's own "last run at") is not an effect.
const hasEffect = (rec) => effectsOf([rec]).length > 0;

// Quiescence: tick rounds until a round produces no effect, at most `rounds`.
async function runTicks(backend, run, ticks, rounds, state) {
  const records = [];
  for (let round = 1; round <= rounds; round++) {
    const recs = await runSteps(backend, run, 'tick', ticks.map((t) => ({ id: 'tick' + round + ':' + t, timer: t })), {}, state);
    records.push(...recs);
    if (!recs.some(hasEffect)) break;
  }
  return records;
}

// One side of one mutant: boot on the snapshot, run steps and ticks, stop.
async function runSide({ side, goCmd, goEnv = {}, snapshot, steps, vars, ticks, rounds = 3, scoped, cloud, run, scenarioName, keep, anchorMs }) {
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  const t0 = Date.now();
  const res = { side, records: [], files: [], errors: [], timeouts: [], unregistered: [], tickErrors: [], sqlRejected: [], bootMs: 0, ms: 0 };
  let backend;
  try {
    backend = side === 'oracle' ? await startOracleFrom({ run, snapshot, scoped, cloud })
      : await startCommand({ run, command: goCmd, fixtureDb: snapshot, scoped, cloud, extraEnv: goEnv });
    if (backend.name === 'node-red') await backend.control.settle();
    if (cloud) await backend.control.cloud('connected');
    res.bootMs = Date.now() - t0;
    const before = fileSnapshot(run);
    const state = { cloudSeen: backend.control.cloud ? (await backend.control.cloud()).length : 0, anchorMs };
    const v = { ...vars };
    res.records.push(...await runSteps(backend, run, scenarioName, steps, v, state));
    res.records.push(...await runTicks(backend, run, ticks, rounds, state));
    res.files = fileDiff(before, fileSnapshot(run));
  } catch (e) {
    res.errors.push('harness: ' + String(e && e.message || e).slice(0, 400));
  } finally {
    if (backend) { try { await backend.stop(); } catch (e) { res.errors.push('stop: ' + String(e && e.message || e).slice(0, 200)); } }
  }
  for (const rec of res.records) {
    if (!rec.error) continue;
    if (rec.kind === 'timer') {
      if (/unknown timer/.test(rec.error) && side === 'go') res.unregistered.push(rec.request.timer);
      else if (/panic/.test(rec.error) || side === 'oracle') res.errors.push(rec.id + ': ' + rec.error);
      else res.tickErrors.push(rec.id + ': ' + rec.error);
    } else if (rec.kind === 'sql') res.sqlRejected.push(rec.id + ': ' + rec.error);
    else if (/timeout/.test(rec.error)) res.timeouts.push(rec.id);
    else res.errors.push(rec.id + ': ' + rec.error);
  }
  res.unregistered = [...new Set(res.unregistered)];
  res.ms = Date.now() - t0;
  if (!keep && !res.errors.length) fs.rmSync(run, { recursive: true, force: true });
  return res;
}

// Oracle prefix pass: one fresh boot runs the whole scenario; before each
// wanted step it saves a database snapshot and the captured variables.
async function prefixPass({ scenario, wanted, dir, scoped, cloud, keep }) {
  const run = path.join(dir, 'prefix-run');
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  const t0 = Date.now();
  const backend = await startNodeRed({ run, scoped, cloud });
  const snaps = {}, records = [];
  try {
    await backend.control.settle();
    if (cloud) await backend.control.cloud('connected');
    const vars = {}, state = { cloudSeen: 0 };
    for (let i = 0; i < scenario.steps.length; i++) {
      if (wanted.has(i)) {
        const to = path.join(dir, 'snap-' + String(i).padStart(3, '0') + '.db');
        fs.rmSync(to, { force: true });
        await backend.control.settle();
        await backend.control.backup(to);
        snaps[i] = { db: to, vars: { ...vars } };
      }
      records.push(...await runSteps(backend, run, scenario.name, [scenario.steps[i]], vars, state));
      if (i >= Math.max(...wanted)) break;
    }
  } finally { await backend.stop(); }
  if (!keep) fs.rmSync(run, { recursive: true, force: true });
  return { snaps, records, ms: Date.now() - t0 };
}

module.exports = { startOracleFrom, runSide, prefixPass, runSteps, runTicks, resolveAuth };
