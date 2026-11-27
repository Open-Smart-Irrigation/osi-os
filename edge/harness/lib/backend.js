'use strict';
// Starts a backend for T1 and returns one neutral handle:
//   { name, http, mqtt, db, control: {radio(), mqtt(), cloud?, settle(), timer(name)}, stop() }
// "node-red" is the oracle (release-smoke runtime, unmodified). Any other
// backend is a command line that honours BACKEND-CONTRACT.md in this folder.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const TIMERS = require('../timers.json');

// Synthetic identity shared by both backends (no real deployment values).
// The CHIRPSTACK_PROFILE_* ids mirror the stand-in's seeded device profiles
// (edge/harness/chirpstack-standin.js), the same values the oracle sets.
const SHARED_ENV = {
  AUTH_TOKEN_SECRET: 'synthetic-smoke-secret', TZ: 'UTC',
  CHIRPSTACK_APP_ACTUATORS: 'synthetic-actuators-app', CHIRPSTACK_APP_SENSORS: 'synthetic-sensors-app',
  CHIRPSTACK_API_KEY: 'synthetic', CHIRPSTACK_TENANT_ID: 'synthetic-tenant',
  DEVICE_EUI: '0016C001F1000001', LINK_GATEWAY_DEVICE_EUI: '0016C001F1000001',
  ...require('../chirpstack-standin').ENV,
  DEVICE_MQTT_PASSWORD: 'synthetic',
};

function request(port, method, p, body, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data !== undefined) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout ' + method + ' ' + p)); });
    req.on('error', reject); req.end(data);
  });
}
const ctl = async (port, p, body) => {
  const r = await request(port, body === undefined ? 'GET' : 'POST', p, body, {}, 60000);
  const j = JSON.parse(r.raw.toString() || 'null');
  if (r.status !== 200) throw new Error('control ' + p + ': ' + JSON.stringify(j));
  return j;
};
async function waitFile(file, child, label, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (child.exitCode !== null) throw new Error(label + ' exited ' + child.exitCode);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(label + ' not ready in ' + ms + ' ms');
}

// Opt-in V8 coverage of the oracle process (read by ../coverage-report.js):
// one directory per run, named after the recording's output directory.
function coverageEnv(run) {
  if (!process.env.OSI_ORACLE_COVERAGE_DIR) return {};
  const dir = path.join(path.resolve(process.env.OSI_ORACLE_COVERAGE_DIR), path.basename(path.dirname(run)));
  fs.mkdirSync(dir, { recursive: true });
  return { NODE_V8_COVERAGE: dir };
}

function oracleExecutable() {
  const pinned = /OSI_SMOKE_NODE_VERSION:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, '.github/workflows/release-smoke.yml'), 'utf8'))[1];
  return { pinned, oracleNode: process.env.OSI_ORACLE_NODE || path.join(process.env.HOME || '', '.local/node-v' + pinned + '-linux-x64/bin/node') };
}

const CLOUD_BROKER_ID = 'ec43625ea99685a6';
const connectEnv = ({ eui, password }) => ({ DEVICE_EUI: eui, DEVICE_MQTT_PASSWORD: password });

const { guiFixture } = require('./gui-fixture');

async function startNodeRed({ run, scoped = false, cloud = false, log, reuseDb = false, brokers, cloudConnect }) {
  fs.mkdirSync(path.join(run, 'data/db'), { recursive: true });
  if (reuseDb) fs.accessSync(path.join(run, 'data/db/farming.db'));
  else {
    const seed = spawnSync(process.execPath, ['scripts/build-seed-db.js', '--out', path.join(run, 'data/db/farming.db')], { cwd: ROOT, encoding: 'utf8' });
    fs.writeFileSync(path.join(run, 'seed.log'), seed.stdout + seed.stderr);
    if (seed.status !== 0) throw new Error('seed build failed: ' + seed.stderr);
  }
  const ready = path.join(run, 'oracle-ready.json');
  fs.rmSync(ready, { force: true });
  // The oracle must run the Node version the device and the release smoke run
  // (.github/workflows/release-smoke.yml OSI_SMOKE_NODE_VERSION). Under a newer
  // Node, node_sqlite3 binds to Node's own embedded SQLite and the oracle runs
  // a different engine from the device (found 23 Nov: 3.51.2 instead of 3.44.2).
  const { pinned, oracleNode } = oracleExecutable();
  const actual = spawnSync(oracleNode, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== pinned) throw new Error('oracle needs Node ' + pinned + ' at ' + oracleNode + ' (set OSI_ORACLE_NODE); got ' + (actual.stdout || actual.stderr || '').trim());
  const out = fs.openSync(log || path.join(run, 'oracle.log'), 'w');
  const child = spawn(oracleNode, ['--max-old-space-size=1536', path.join(__dirname, '../oracle-node-red.js')], {
    cwd: ROOT, stdio: ['ignore', out, out],
    env: { PATH: process.env.PATH, HOME: run, LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: run, UV_THREADPOOL_SIZE: '4',
      OSI_SMOKE_RUNTIME: 'image', OSI_SMOKE_RUN: run, OSI_EDGE_GUI_DIR: guiFixture(run), OSI_ORACLE_READY_FILE: ready, OSI_ORACLE_SCOPED: scoped ? '1' : '0',
      OSI_HARNESS_CLOUD: cloud ? '1' : '0', OSI_HARNESS_PODMAN_HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      ...(brokers && { OSI_HARNESS_LOCAL_PORT: String(brokers.local), OSI_HARNESS_CLOUD_URL: brokers.cloud }),
      ...(cloudConnect && { OSI_HARNESS_CLOUD_CONNECT: JSON.stringify(cloudConnect) }),
      ...coverageEnv(run) },
    });
  fs.closeSync(out);
  const info = await waitFile(ready, child, 'node-red oracle').catch((error) => {
    child.kill('SIGTERM');
    throw error;
  });
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
      try { await ctl(info.control, '/stop', {}); } finally {
        await new Promise((r) => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
      }
    },
  };
}

// --init-env: the backend gets exactly the environment the osi-edge init
// derives on a device (edge/package/test/init-env.sh) from a synthetic root:
// UCI carries the keys node-red.init reads from UCI; .chirpstack.env carries
// the keys Node-RED only gets through settings.js. Harness plumbing (database,
// ports, stand-in URLs, test hooks) is the only addition; SHARED_ENV is not
// used, so a variable the init forgets stays unset.
const STANDIN = require('../chirpstack-standin');
const PROCD_PROFILE_KEYS = { KIWI: 'kiwi', STREGA: 'strega', LSN50: 'lsn50', CLOVER: 'clover', S2120: 's2120', SDI12: 'sdi12', RAK10701: 'rak10701' };
function initEnv(run, { radio, scoped }) {
  const write = (rel, text, mode) => { const f = path.join(run, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, { mode }); };
  const uci = { device_eui: SHARED_ENV.DEVICE_EUI, link_gateway_device_eui: SHARED_ENV.LINK_GATEWAY_DEVICE_EUI, mqtt_password: 'synthetic',
    scoped_access_enabled: scoped ? '1' : '0', chirpstack_app_sensors: SHARED_ENV.CHIRPSTACK_APP_SENSORS, chirpstack_app_actuators: SHARED_ENV.CHIRPSTACK_APP_ACTUATORS };
  const fileEnv = { CHIRPSTACK_API_URL: radio, CHIRPSTACK_API_KEY: SHARED_ENV.CHIRPSTACK_API_KEY };
  for (const [name, value] of Object.entries(STANDIN.ENV)) {
    const key = PROCD_PROFILE_KEYS[name.replace('CHIRPSTACK_PROFILE_', '')];
    if (key) uci['chirpstack_profile_' + key] = value; else fileEnv[name] = value;
  }
  write('etc/osi-backend', 'edge\n');
  write('etc/TZ', (process.env.OSI_HARNESS_INIT_TZ || 'UTC') + '\n');
  write('uci', Object.entries(uci).map(([k, v]) => 'osi-server.cloud.' + k + '=' + v + '\n').join(''));
  write('srv/node-red/.chirpstack.env', Object.entries(fileEnv).map(([k, v]) => k + '=' + v + '\n').join(''), 0o600);
  write('data/db/osi_auth_token_secret', SHARED_ENV.AUTH_TOKEN_SECRET + '\n', 0o600);
  const init = process.env.OSI_HARNESS_EDGE_INIT || path.join(ROOT, 'edge/package/files/etc/init.d/osi-edge');
  const r = spawnSync('sh', [path.join(ROOT, 'edge/package/test/init-env.sh'), run, init], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  fs.writeFileSync(path.join(run, 'init-env.txt'), r.stdout + r.stderr);
  if (r.status !== 0) throw new Error('init-env.sh failed: ' + r.stderr);
  const env = {};
  for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1); }
  return env;
}

// The boot runner (edge/boot/run-sync-init.js) before every Go start, as the
// osi-edge init runs it on a device (edge/package/files/etc/init.d/osi-edge,
// run_boot_runner): the frozen Node-RED boot node "Sync Init Schema +
// Triggers" with its data repairs (zone and device gateway EUI backfills,
// irrigation event uuids), on the database Go is about to open, with the
// DEVICE_EUI Go gets. Like the init, exit 0 or 1 goes on and any other status
// refuses the start. OSI_HARNESS_NO_BOOT_RUNNER=1 (or bootRunner: false)
// starts Go on the database as it is.
const BOOT_DIR = path.join(ROOT, 'edge/boot');
const BOOT_SQLITE_NODE = path.join(ROOT, 'scripts/fixtures/release-smoke/node_modules/node-red-node-sqlite');
function bootNode() {
  const { pinned } = oracleExecutable();
  // Never a preload wrapper (OSI_ORACLE_NODE may name one): the runner gets
  // its DEVICE_EUI from this environment, like the init passes it.
  const bin = process.env.OSI_ORACLE_NODE_REAL || path.join(process.env.HOME || '', '.local/node-v' + pinned + '-linux-x64/bin/node');
  const got = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  if (got.status !== 0 || got.stdout.trim() !== pinned) throw new Error('boot runner needs Node ' + pinned + ' at ' + bin + ' (set OSI_ORACLE_NODE_REAL)');
  return bin;
}
function runBootRunner(run, db, deviceEui) {
  if (!fs.existsSync(path.join(BOOT_SQLITE_NODE, 'sqlite.js'))) throw new Error('boot runner needs `npm ci --prefix scripts/fixtures/release-smoke` (' + BOOT_SQLITE_NODE + ')');
  const node = bootNode();
  // The Node-RED user directory the runner imports osi-db-helper from.
  const userDir = require('../../boot/parity').makeUserDir(path.join(run, 'boot-userdir'));
  const env = { PATH: process.env.PATH, TZ: 'UTC', LANG: 'C.UTF-8', OSI_BOOT_DB: db, OSI_BOOT_NODE_RED_DIR: userDir, OSI_BOOT_SQLITE_NODE_DIR: BOOT_SQLITE_NODE };
  if (deviceEui !== undefined) env.DEVICE_EUI = deviceEui;
  const t0 = Date.now();
  const r = spawnSync(node, [path.join(BOOT_DIR, 'run-sync-init.js')], { encoding: 'utf8', env, timeout: 120000, killSignal: 'SIGKILL' });
  fs.writeFileSync(path.join(run, 'boot-runner.log'), (r.stdout || '') + (r.stderr || '') + 'exit=' + r.status + ' signal=' + r.signal + ' ms=' + (Date.now() - t0) + '\n');
  if (r.status !== 0 && r.status !== 1) throw new Error('boot runner exit ' + r.status + (r.signal ? ' (' + r.signal + ')' : '') + '; see ' + path.join(run, 'boot-runner.log'));
  return r.status;
}

async function startCommand({ run, command, fixtureDb, scoped = false, cloud = false, extraEnv = {}, useInitEnv = false, reuseDb = false, brokers, cloudConnect,
  bootRunner = process.env.OSI_HARNESS_NO_BOOT_RUNNER !== '1' }) {
  fs.mkdirSync(path.join(run, 'data/db'), { recursive: true });
  const db = path.join(run, 'data/db/farming.db');
  if (reuseDb) fs.accessSync(db);
  else fs.copyFileSync(fixtureDb, db);
  if (cloudConnect?.previous) {
    const { eui, password } = cloudConnect.previous;
    const dir = path.join(run, 'srv/node-red');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([{ id: CLOUD_BROKER_ID, clientid: 'device_' + eui }]));
    fs.writeFileSync(path.join(dir, 'flows_cred.json'), JSON.stringify({ [CLOUD_BROKER_ID]: { user: eui, password } }), { mode: 0o600 });
  }
  if (cloudConnect?.edgeStore) {
    fs.writeFileSync(path.join(run, 'data/db/osi-edge-cloud-connect.json'),
      JSON.stringify(cloudConnect.edgeStore), { mode: 0o600 });
  }
  if (cloudConnect) extraEnv = { ...extraEnv, ...connectEnv(cloudConnect) };
  const fr = path.join(run, 'fakes-ready.json');
  fs.rmSync(fr, { force: true });
  const fout = fs.openSync(path.join(run, 'fakes.log'), 'w');
  const fakes = spawn(process.execPath, [path.join(__dirname, '../fakes.js')], { cwd: ROOT, stdio: ['ignore', fout, fout],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      TMPDIR: run, OSI_HARNESS_CONNECT_DETAILS: cloudConnect ? '1' : '0', OSI_FAKES_READY_FILE: fr, OSI_HARNESS_CLOUD: cloud ? '1' : '0' } });
  fs.closeSync(fout);
  const f = await waitFile(fr, fakes, 'fakes');
  const mqtt = brokers?.local || f.mqtt;
  const cloudUrl = brokers?.cloud || f.cloud;
  // A port the kernel just handed out, not a random guess: a random port once
  // landed on another service whose catch-all route answered every request.
  const port = await new Promise((resolve, reject) => { const srv = require('node:net').createServer(); srv.once('error', reject); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });
  const nonce = require('node:crypto').randomUUID();
  const out = fs.openSync(path.join(run, 'backend.log'), 'w');
  const [cmd, ...args] = command;
  const gui = guiFixture(run);
  const env = useInitEnv ? { PATH: process.env.PATH, HOME: run, ...initEnv(run, { radio: f.radio, scoped }),
      OSI_EDGE_GUI_DIR: gui, OSI_EDGE_DB: db, OSI_EDGE_DATA_ROOT: run, OSI_EDGE_HTTP_ADDR: '127.0.0.1:' + port,
      OSI_EDGE_MQTT_URL: 'tcp://127.0.0.1:' + mqtt, OSI_EDGE_TEST_HOOKS: '1', OSI_EDGE_TEST_NONCE: nonce,
      // Never the init's real default broker: the cloud stand-in, or none.
      OSI_CLOUD_BROKER_URL: cloudUrl || '', ...extraEnv }
      : { PATH: process.env.PATH, HOME: run, ...SHARED_ENV, OSI_SCOPED_ACCESS: scoped ? '1' : '0',
      OSI_EDGE_GUI_DIR: gui, OSI_EDGE_DB: db, OSI_EDGE_DATA_ROOT: run, OSI_EDGE_HTTP_ADDR: '127.0.0.1:' + port,
      OSI_EDGE_MQTT_URL: 'tcp://127.0.0.1:' + mqtt, CHIRPSTACK_API_URL: f.radio, OSI_EDGE_TEST_HOOKS: '1', OSI_EDGE_TEST_NONCE: nonce,
      ...(cloudUrl && { OSI_CLOUD_BROKER_URL: cloudUrl }), ...extraEnv };
  if (bootRunner) {
    try { runBootRunner(run, db, env.DEVICE_EUI); }
    catch (error) {
      try { await ctl(f.control, '/stop'); } catch { fakes.kill('SIGKILL'); }
      fs.closeSync(out);
      throw error;
    }
  }
  const child = spawn(cmd, args, { cwd: run, stdio: ['ignore', out, out], env });
  fs.closeSync(out);
  async function stop() {
    child.kill('SIGTERM');
    await new Promise((r) => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    try { await ctl(f.control, '/stop'); } finally {
      await new Promise((r) => fakes.exitCode !== null || fakes.signalCode !== null ? r() : fakes.once('exit', r));
    }
  }
  try {
    const end = Date.now() + 30000;
    for (;;) {
      let foreign = false;
      try {
        const r = await request(port, 'GET', '/__test/ready', undefined, {}, 1000);
        let body = null; try { body = JSON.parse(r.raw.toString()); } catch { /* not JSON */ }
        // Only this run's backend echoes this run's nonce.
        if (r.status === 200 && body && body.ok === true && body.nonce === nonce) break;
        foreign = r.status === 200;
      } catch { /* starting */ }
      if (foreign) throw new Error('port ' + port + ' answered /__test/ready without this run\'s nonce: not our backend');
      if (child.exitCode !== null) throw new Error('backend exited ' + child.exitCode + '; see ' + path.join(run, 'backend.log'));
      if (Date.now() > end) throw new Error('backend not ready');
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  const hook = async (p) => { const r = await request(port, 'POST', p, {}, {}, 60000); if (r.status !== 200) throw new Error(p + ' -> ' + r.status + ' ' + r.raw); };
  return {
    name: command.join(' '), http: port, mqtt, db, child,
    control: {
      radio: () => ctl(f.control, '/radio'), mqtt: () => ctl(f.control, '/mqtt'),
      cloud: cloud ? (action) => ctl(f.control, '/cloud', action && { action }) : undefined,
      settle: () => hook('/__test/settle'), timer: (name) => hook('/__test/timer/' + encodeURIComponent(name)),
    },
    stop,
  };
}
module.exports = { startNodeRed, startCommand, request, SHARED_ENV, oracleExecutable, runBootRunner };
