#!/usr/bin/env node
'use strict';
// Parity check: the database after a Node-RED boot (the T1 oracle,
// edge/harness/oracle-node-red.js on the release-smoke runtime) against the
// database after edge/boot/run-sync-init.js, both started from copies of the
// same input. Workstation only; synthetic databases only.
//
//   node edge/boot/parity.js --out <dir> [--oracle-runs 2] name=/abs/input.db ...
//
// Per source: the oracle boots two copies (A, B) and the runner one (R).
// A-vs-B is the nondeterminism floor (randomblob() UUIDs, 'now' timestamps
// written during boot). R may differ from A only in cells where A and B also
// differ; anything else is a residual difference. Runs under Node >= 22.5
// (node:sqlite); the oracle and the runner run on the pinned Node 20.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { snapshot, diff, rootpageDiff, effects } = require('./db-compare');

const ROOT = path.resolve(__dirname, '../..');
const EUI = '0016C001F1000001'; // example value; the release-smoke runtime sets the same
const pinnedNode = () => {
  const v = /OSI_SMOKE_NODE_VERSION:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, '.github/workflows/release-smoke.yml'), 'utf8'))[1];
  const bin = process.env.OSI_ORACLE_NODE || path.join(process.env.HOME || '', `.local/node-v${v}-linux-x64/bin/node`);
  const got = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  if (got.status !== 0 || got.stdout.trim() !== v) throw new Error(`needs Node ${v} at ${bin} (set OSI_ORACLE_NODE)`);
  return bin;
};

function get(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: data ? 'POST' : 'GET', headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(t || 'null')) : reject(new Error(p + ' ' + res.statusCode + ' ' + t))));
    });
    req.setTimeout(120000, () => req.destroy(new Error('timeout ' + p)));
    req.on('error', reject); req.end(data);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Copy an input database into a run directory as one consistent file.
function place(input, dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.copyFileSync(input, dbFile);
  const r = spawnSync('sqlite3', [dbFile, 'PRAGMA wal_checkpoint(TRUNCATE);'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('checkpoint of placed copy failed: ' + r.stderr);
  for (const s of ['-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });
}

async function oracleBoot(node, input, run) {
  fs.mkdirSync(run, { recursive: true });
  const dbFile = path.join(run, 'data/db/farming.db');
  place(input, dbFile);
  const ready = path.join(run, 'oracle-ready.json');
  const out = fs.openSync(path.join(run, 'oracle.log'), 'w');
  const t0 = Date.now();
  const child = spawn(node, ['--max-old-space-size=1536', path.join(ROOT, 'edge/harness/oracle-node-red.js')], {
    cwd: ROOT, stdio: ['ignore', out, out],
    env: { PATH: process.env.PATH, HOME: run, LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: run, UV_THREADPOOL_SIZE: '4',
      OSI_SMOKE_RUNTIME: 'image', OSI_SMOKE_RUN: run, OSI_ORACLE_READY_FILE: ready, OSI_ORACLE_SCOPED: '0', OSI_HARNESS_CLOUD: '0' },
  });
  let info;
  for (const end = Date.now() + 120000; !info; await sleep(100)) {
    if (fs.existsSync(ready)) info = JSON.parse(fs.readFileSync(ready, 'utf8'));
    else if (child.exitCode !== null) throw new Error('oracle exited ' + child.exitCode + ', see ' + path.join(run, 'oracle.log'));
    else if (Date.now() > end) throw new Error('oracle not ready');
  }
  // Wait for the boot node's own end line, then for the flows to settle.
  let logs = [];
  for (const end = Date.now() + 120000; ; await sleep(100)) {
    logs = await get(info.control, '/logs');
    if (logs.some((l) => l.id === 'sync-init-fn' && (l.msg === 'sync-init: schema init complete' || /^Sync init failed/.test(l.msg)))) break;
    if (Date.now() > end) throw new Error('oracle: sync-init-fn did not finish');
  }
  await get(info.control, '/settle', {});
  logs = await get(info.control, '/logs');
  await get(info.control, '/stop', {}).catch(() => {});
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
  fs.writeFileSync(path.join(run, 'logs.json'), JSON.stringify(logs, null, 1));
  return { db: dbFile, info, seconds: (Date.now() - t0) / 1000, syncInit: logs.filter((l) => l.id === 'sync-init-fn'), otherLogs: logs.filter((l) => l.id !== 'sync-init-fn' && (l.level === 'error' || l.level === 'warn')) };
}

function runnerBoot(node, input, run, userDir) {
  fs.mkdirSync(run, { recursive: true });
  const dbFile = path.join(run, 'farming.db');
  place(input, dbFile);
  const report = path.join(run, 'report.json');
  const r = spawnSync(node, [path.join(__dirname, 'run-sync-init.js')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: run, LANG: 'C.UTF-8', TZ: 'UTC', DEVICE_EUI: EUI, OSI_BOOT_DB: dbFile,
      OSI_BOOT_NODE_RED_DIR: userDir, OSI_BOOT_SQLITE_NODE_DIR: path.join(ROOT, 'scripts/fixtures/release-smoke/node_modules/node-red-node-sqlite'),
      OSI_BOOT_REPORT: report },
  });
  fs.writeFileSync(path.join(run, 'runner.log'), r.stdout + r.stderr);
  return { db: dbFile, status: r.status, log: r.stdout + r.stderr, report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null };
}

// A Node-RED user directory for the runner: osi-db-helper copied from the
// canonical profile, as the release-smoke runtime copies it for the oracle.
function makeUserDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper'), path.join(dir, 'osi-db-helper'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'osi-db-helper'), path.join(dir, 'node_modules/osi-db-helper'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'osi-db-helper': 'file:osi-db-helper' } }));
  return dir;
}

async function paritySource(name, input, out, { node, userDir, oracleRuns = 2 }) {
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const oracles = [];
  for (let i = 0; i < oracleRuns; i++) oracles.push(await oracleBoot(node, input, path.join(dir, 'oracle-' + 'AB'[i])));
  const runner = runnerBoot(node, input, path.join(dir, 'runner'), userDir);
  const inputSnap = snapshot(input);
  const snaps = oracles.map((o) => snapshot(o.db));
  const rSnap = snapshot(runner.db);
  const floor = new Set();
  for (let i = 1; i < snaps.length; i++) for (const d of diff(snaps[0], snaps[i])) floor.add(d.key);
  const raw = diff(snaps[0], rSnap);
  const residual = raw.filter((d) => !floor.has(d.key));
  // Inside the floor the runner's value must still have the oracle's shape:
  // same storage class and length (a 32-hex UUID, an ISO timestamp).
  const shape = (v) => (typeof v === 'string' ? v.slice(0, v.indexOf(':')) + '/' + v.length : String(v));
  const shapeMismatch = raw.filter((d) => floor.has(d.key) && d.key.startsWith('cell|') && shape(d.a) !== shape(d.b));
  const result = {
    name, input,
    oracle_seconds: oracles.map((o) => o.seconds),
    oracle_sync_init_logs: oracles.map((o) => o.syncInit.map((l) => l.level + ': ' + l.msg)),
    oracle_other_errors_warnings: oracles.map((o) => o.otherLogs.map((l) => `${l.level} ${l.type}:${l.id} ${l.msg}`.slice(0, 300))),
    oracle_engine: oracles.map((o) => ({ node: o.info.nodeVersion, sqlite: o.info.sqliteVersion })),
    runner: { exit: runner.status, sqlite: runner.report && runner.report.sqlite_version, node: runner.report && runner.report.node_version,
      wall_ms: runner.report && runner.report.wall_ms, max_rss_kib: runner.report && runner.report.max_rss_kib,
      statements: runner.report && runner.report.statements, failed_by_class: runner.report && runner.report.failed_by_class,
      devices_rebuild: runner.report && runner.report.devices_rebuild, fk_self_heal: runner.report && runner.report.fk_self_heal,
      reasons: runner.report && runner.report.reasons,
      warnings: runner.report ? runner.report.events.filter((e) => e.level === 'warn' || e.level === 'error').map((e) => e.level + ': ' + e.text) : [] },
    oracle_reported_error: oracles.some((o) => o.syncInit.some((l) => l.level === 'error')),
    floor_A_vs_B: floor.size,
    raw_R_vs_A: raw.length,
    residual: residual.length,
    floor_shape_mismatch: shapeMismatch.length,
    residual_detail: residual.slice(0, 50),
    floor_detail: [...floor].slice(0, 50),
    rootpage_R_vs_A: rootpageDiff(snaps[0], rSnap),
    pragmas: { oracle: snaps.map((s) => s.pragmas), runner: rSnap.pragmas },
    effects_input_to_runner: effects(inputSnap, rSnap),
  };
  // The runner's verdict must match what the oracle's node logged: exit 0
  // exactly when sync-init-fn logged no error under Node-RED.
  result.exit_matches_oracle = (runner.status === 0) === !result.oracle_reported_error;
  // Same engine: the oracle's mapped addon and SQLite version equal the runner's.
  const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };
  const rAddons = ((runner.report && runner.report.sqlite_addons) || []).map(real);
  result.same_engine = oracles.every((o) => {
    const native = ((o.info.metadata && o.info.metadata.nativePaths) || []).map(real);
    return native.length === 1 && rAddons.length === 1 && native[0] === rAddons[0] && o.info.sqliteVersion === (runner.report && runner.report.sqlite_version);
  });
  result.pass = result.residual === 0 && result.floor_shape_mismatch === 0 && result.exit_matches_oracle && result.same_engine;
  fs.writeFileSync(path.join(dir, 'parity.json'), JSON.stringify(result, null, 1) + '\n');
  return result;
}

async function main(argv) {
  const outIdx = argv.indexOf('--out');
  if (outIdx < 0) throw new Error('--out <dir> is required');
  const out = path.resolve(argv[outIdx + 1]);
  const runsIdx = argv.indexOf('--oracle-runs');
  const oracleRuns = runsIdx >= 0 ? Number(argv[runsIdx + 1]) : 2;
  const sources = argv.filter((a, i) => /^[\w.-]+=\//.test(a) && i !== outIdx + 1).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; });
  if (!sources.length) throw new Error('no name=/abs/path sources given');
  const node = pinnedNode();
  fs.mkdirSync(out, { recursive: true });
  const userDir = makeUserDir(path.join(out, 'userdir'));
  const results = [];
  for (const [name, input] of sources) {
    const r = await paritySource(name, input, out, { node, userDir, oracleRuns });
    results.push(r);
    console.log(`${name}: ${r.pass ? 'PASS' : 'FAIL'} runner exit=${r.runner.exit} oracle_error=${r.oracle_reported_error} floor(A-B)=${r.floor_A_vs_B} raw(R-A)=${r.raw_R_vs_A} residual=${r.residual} engine=${r.same_engine} shape=${r.floor_shape_mismatch} rootpage=${r.rootpage_R_vs_A.length} rebuild=${r.runner.devices_rebuild} fk=${r.runner.fk_self_heal} failed=${JSON.stringify(r.runner.failed_by_class)} runner_ms=${r.runner.wall_ms}`);
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results.map((r) => ({ name: r.name, pass: r.pass, runner_exit: r.runner.exit, oracle_reported_error: r.oracle_reported_error, floor: r.floor_A_vs_B, raw: r.raw_R_vs_A, residual: r.residual, same_engine: r.same_engine, floor_shape_mismatch: r.floor_shape_mismatch, rootpage: r.rootpage_R_vs_A.length, devices_rebuild: r.runner.devices_rebuild, fk_self_heal: r.runner.fk_self_heal, failed_by_class: r.runner.failed_by_class, runner_wall_ms: r.runner.wall_ms, runner_max_rss_kib: r.runner.max_rss_kib })), null, 1) + '\n');
  return results.every((r) => r.pass) ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error('parity: ' + (e && e.stack || e)); process.exitCode = 2; });
}
module.exports = { paritySource, makeUserDir, oracleBoot, runnerBoot, pinnedNode, main };
