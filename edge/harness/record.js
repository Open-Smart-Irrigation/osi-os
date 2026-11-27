#!/usr/bin/env node
'use strict';
// T1 recorder and replayer.
//   node edge/harness/record.js --out DIR [--scoped] SCENARIO.json...
//       boots the Node-RED oracle, snapshots fixture.db, runs the scenarios in
//       order, writes DIR/cassette.json and DIR/fixture.db.
//   node edge/harness/record.js --replay CASSETTE_DIR --out DIR [--backend-cmd "BIN ARGS"]
//       runs the same scenarios against a fresh Node-RED (default) or against
//       a command-line backend (BACKEND-CONTRACT.md) started on a copy of the
//       cassette's fixture.db, then compares. --init-env gives the command
//       backend the osi-edge init's environment (lib/backend.js initEnv).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { startNodeRed, startCommand } = require('./lib/backend');
const { runScenario } = require('./lib/run');
const { compare } = require('./lib/compare');
const { stagedFixture, discardStaged, commitRecording, checkReplayFixture } = require('./lib/fixture');
const ROOT = path.resolve(__dirname, '../..');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function args(argv) {
  const o = { scenarios: [], scoped: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--replay') o.replay = path.resolve(argv[++i]);
    else if (a === '--backend-cmd') o.cmd = argv[++i].split(/\s+/).filter(Boolean);
    else if (a === '--scoped') o.scoped = true;
    else if (a === '--init-env') o.initEnv = true;
    else if (a === '--ignore') o.ignore = argv[++i].split(',');
    else o.scenarios.push(path.resolve(a));
  }
  if (!o.out) throw new Error('--out is required');
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  fs.mkdirSync(o.out, { recursive: true });
  const run = path.join(o.out, 'run');
  fs.rmSync(run, { recursive: true, force: true }); fs.mkdirSync(run, { recursive: true });
  let scenarios, expected = null, fixtureDb = null;
  if (o.replay) {
    expected = JSON.parse(fs.readFileSync(path.join(o.replay, 'cassette.json'), 'utf8'));
    scenarios = expected.scenarios;
    o.scoped = expected.meta.scoped;
    fixtureDb = path.join(o.replay, 'fixture.db');
    const integrity = checkReplayFixture(o.replay, expected.meta);
    if (!integrity.ok) {
      console.error('REFUSED replay:', integrity.reason);
      process.exitCode = 2;
      return;
    }
    if (integrity.warning) console.warn('WARNING', integrity.warning);
  } else scenarios = o.scenarios.map((f) => ({ file: path.relative(ROOT, f), ...JSON.parse(fs.readFileSync(f, 'utf8')) }));
  const started = Date.now();
  // Anchor for scenario date tokens and date normalisation: the run's start
  // instant, or the faked day set for a day-independence replay.
  const anchorMs = process.env.OSI_T1_ANCHOR_DAY
    ? (Number.isFinite(Date.parse(process.env.OSI_T1_ANCHOR_DAY + 'T00:00:00Z'))
      ? Date.parse(process.env.OSI_T1_ANCHOR_DAY + 'T00:00:00Z')
      : (() => { throw new Error('bad OSI_T1_ANCHOR_DAY: ' + process.env.OSI_T1_ANCHOR_DAY); })())
    : started;
  const anchorDay = new Date(Math.floor(anchorMs / 86400000) * 86400000).toISOString().slice(0, 10);
  const cloud = scenarios.some((s) => s.cloud === true);
  const cloudConnect = scenarios.find((s) => s.cloudConnect)?.cloudConnect;
  if (cloudConnect && (!cloud || scenarios.length !== 1)) throw new Error('cloudConnect requires one cloud scenario');
  const backend = o.cmd ? await startCommand({ run, command: o.cmd, fixtureDb, scoped: o.scoped, cloud, cloudConnect, useInitEnv: o.initEnv })
    : await startNodeRed({ run, scoped: o.scoped, cloud, cloudConnect });
  const out = { meta: {}, scenarios, steps: [] };
  // The oracle's fixture is staged and only replaces fixture.db when the
  // cassette is written, so a refused recording keeps the old pair.
  const staged = backend.name === 'node-red' ? stagedFixture(o.out).staged : null;
  try {
    if (cloud) await backend.control.cloud('connected');
    if (staged) {
      await backend.control.settle();
      discardStaged(o.out);
      await backend.control.backup(staged);
    }
    let cloudSeen = 0;
    for (const sc of scenarios) {
      const steps = sc.steps.map((s) => ({ ...s, id: sc.name + '/' + s.id }));
      const onStep = armRadioFaults(run, steps);
      const r = await runScenario(backend, { ...sc, steps }, { cloudSeen, onStep, anchorMs });
      cloudSeen = r.cloudSeen;
      out.steps.push(...r.steps); out.finalSchema = r.finalSchema;
    }
    if (backend.control.logs) out.errors = (await backend.control.logs()).filter((l) => l.level === 'error');
  } finally { await backend.stop(); }
  const flows = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  out.meta = { backend: backend.name, recordedAt: new Date().toISOString(), anchorDay, anchorMs, seconds: (Date.now() - started) / 1000, scoped: o.scoped,
    gitHead: execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(), flowsSha256: sha(flows),
    fixtureSha256: staged && fs.existsSync(staged) ? sha(staged) : (fixtureDb ? sha(fixtureDb) : null),
    node: process.versions.node, nodeRed: backend.info ? backend.info.metadata.nodeRed : undefined,
    oracleNode: backend.info ? backend.info.nodeVersion : undefined, oracleSqlite: backend.info ? backend.info.sqliteVersion : undefined };
  // A setup SQL step that fails on the oracle tests nothing (both sides would
  // fail alike); refuse the recording unless the step says it expects that.
  const badSetup = expected ? [] : out.steps.filter((st, i) => st.kind === 'sql' && st.error
    && !scenarios.flatMap((sc) => sc.steps)[i]?.expectSqlError);
  if (badSetup.length) {
    for (const st of badSetup) console.error('REFUSED setup SQL failed:', st.id, st.error);
    discardStaged(o.out);
    process.exitCode = 2;
    return;
  }
  commitRecording(o.out, JSON.stringify(out, null, 1) + '\n');
  console.log('RECORDED', out.steps.length, 'steps in', out.meta.seconds.toFixed(1), 's ->', o.out);
  if (expected) {
    const c = compare(expected, out, { ignore: o.ignore || [] });
    fs.writeFileSync(path.join(o.out, 'compare.json'), JSON.stringify(c, null, 1) + '\n');
    for (const r of c.results) console.log(r.pass ? 'PASS' : 'FAIL', r.id, r.pass ? '' : JSON.stringify(r.failures).slice(0, 600));
    console.log(`T1 ${c.pass ? 'GREEN' : 'RED'} ${c.passed}/${c.total}`);
    process.exitCode = c.pass ? 0 : 1;
  }
}

// Both stand-ins receive the run directory as TMPDIR. Arm the next request
// only after the previous step has settled and its radio calls were captured.
function armRadioFaults(run, steps) {
  if (!steps.some((step) => step.radioFault)) return undefined;
  const file = path.join(run, 'radio-fault.json');
  let index = 0;
  function arm() {
    const step = steps[index];
    if (step?.radioFault) {
      if (!(step.http || step.timer || step.uplink) || !Array.isArray(step.radioFault) || !step.radioFault.length) {
        throw new Error('radioFault requires an HTTP, timer or uplink step and a nonempty fault array: ' + step.id);
      }
      fs.writeFileSync(file + '.next', JSON.stringify({ id: step.id, faults: step.radioFault }), { mode: 0o600 });
      fs.renameSync(file + '.next', file);
    } else {
      fs.rmSync(file, { force: true });
    }
  }
  arm();
  return (record) => {
    const calls = (record.radio || []).filter((call) => call.injectedFault);
    for (const fault of steps[index].radioFault || []) {
      const fn = fault.rpc === 'flushQueue' ? 'flush' : fault.rpc;
      const index = calls.findIndex((call) => call.fn === fn && call.eui === fault.eui);
      if (index === -1) {
        // Capture the missing RPC as a step difference during replay.
        record.error = 'expected radio fault was not consumed: ' + fault.rpc + ' ' + fault.eui;
      }
      else calls.splice(index, 1);
    }
    index++;
    arm();
  };
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 2; });
