'use strict';
// F-7: the node file usr/share/node-red/nodes/osi-sqlite-serialize.js puts the
// flows' shared SQLite handle into serialized mode at every start of the flows.
//
// Part 1 runs the file against stand-in runtime objects: it serializes each
// used handle once, says so in one error line and raises the heartbeat's error
// count when a handle is missing or cannot be serialized, and never throws.
//
// Part 2 starts Node-RED for real (red.js) with the file in the user
// directory's nodes/ directory, in the three package layouts a gateway can
// have, the field's first:
//   field:       no firmware SQLite package; node-red-node-sqlite and one
//                sqlite3 in the user directory (a stock-OS gateway after npm);
//   factory:     the firmware package with its nested sqlite3, plus a real
//                sqlite3 copy in the user directory (the OSI OS image);
//   factory-npm: the factory layout after an npm install of
//                node-red-node-sqlite in the user directory.
// In each it checks that the handle is serialized after the start and again
// after a restart of the flows (a new handle), and that the process maps
// exactly one node_sqlite3.node: the file loads no sqlite3 of its own.
// Node-RED comes from scripts/fixtures/release-smoke/node_modules (the image's
// 3.1.15). OSI_NODE_RED_EXTRA_ROOTS (colon-separated node_modules directories
// holding node-red, node-red-node-sqlite and sqlite3, e.g. a 4.0.9 install)
// adds runtimes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const NODE_DIR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/nodes');
const NODE_FILE = path.join(NODE_DIR, 'osi-sqlite-serialize.js');
const MARK = Symbol.for('osi.flowsDbSerialized');

// ---------- part 1: stand-in runtime ----------
function standIn(configs) {
  const events = new EventEmitter();
  const logs = [];
  const global = new Map();
  const live = new Map();
  const all = [];
  for (const c of configs) {
    all.push(c.config);
    if (c.live) live.set(c.config.id, Object.assign(c.live, { context: () => ({ global: { get: (k) => global.get(k), set: (k, v) => global.set(k, v) } }) }));
  }
  const RED = {
    events,
    log: { error: (m) => logs.push(['error', m]), warn: (m) => logs.push(['warn', m]), info: (m) => logs.push(['info', m]) },
    nodes: { eachNode: (fn) => all.forEach(fn), getNode: (id) => live.get(id) || null },
  };
  require(NODE_FILE)(RED);
  return { RED, logs, global, start: () => events.emit('flows:started', { type: 'full' }) };
}
function fakeDb() {
  return { calls: 0, serialize() { this.calls += 1; } };
}

test('serializes each used handle once per handle, silently', () => {
  const db = fakeDb();
  const rt = standIn([
    { config: { id: 'cfg', type: 'sqlitedb' }, live: { db } },
    { config: { id: 'q', type: 'sqlite', mydb: 'cfg' }, live: {} },
  ]);
  rt.start();
  rt.start();
  assert.equal(db.calls, 1);
  assert.equal(db[MARK], true);
  assert.deepEqual(rt.logs, []);
  assert.equal(rt.global.get('error_counts'), undefined);
});

test('a used configuration node without a handle: one error line, counted, no throw', () => {
  const rt = standIn([
    { config: { id: 'cfg', type: 'sqlitedb' }, live: {} },
    { config: { id: 'q', type: 'sqlite', mydb: 'cfg' }, live: {} },
  ]);
  rt.global.set('error_counts', { total: 2 });
  assert.doesNotThrow(() => rt.start());
  assert.equal(rt.logs.length, 1);
  assert.equal(rt.logs[0][0], 'error');
  assert.match(rt.logs[0][1], /sqlitedb cfg: no database handle found; the flows' database connection is not serialized/);
  const counts = rt.global.get('error_counts');
  assert.equal(counts.total, 3);
  assert.equal(counts.last.src, 'osi-sqlite-serialize');
});

test('serialize() that throws: one error line, counted, no throw', () => {
  const db = { serialize() { throw new Error('renamed'); } };
  const rt = standIn([
    { config: { id: 'cfg', type: 'sqlitedb' }, live: { db } },
    { config: { id: 'q', type: 'sqlite', mydb: 'cfg' }, live: {} },
  ]);
  assert.doesNotThrow(() => rt.start());
  assert.equal(rt.logs.length, 1);
  assert.match(rt.logs[0][1], /serialize\(\) failed: renamed/);
  assert.equal(rt.global.get('error_counts').total, 1);
});

test('an unexpected throw while serializing: one error line, counted, no throw', () => {
  const rt = standIn([
    { config: { id: 'cfg', type: 'sqlitedb' }, live: { db: fakeDb() } },
    { config: { id: 'q', type: 'sqlite', mydb: 'cfg' }, live: {} },
  ]);
  const eachNode = rt.RED.nodes.eachNode;
  let calls = 0;
  rt.RED.nodes.eachNode = (fn) => { calls += 1; if (calls === 1) throw new Error('runtime changed'); return eachNode(fn); };
  assert.doesNotThrow(() => rt.start());
  assert.equal(rt.logs.length, 1);
  assert.match(rt.logs[0][1], /runtime changed; the flows' database connection may not be serialized/);
  assert.equal(rt.global.get('error_counts').total, 1);
});

test('an unused configuration node and a sqlite node on a disabled tab are left alone', () => {
  const rt = standIn([
    { config: { id: 'unused', type: 'sqlitedb' }, live: {} },
    { config: { id: 'off', type: 'sqlitedb' }, live: {} },
    { config: { id: 'q', type: 'sqlite', mydb: 'off' } },
  ]);
  rt.start();
  assert.deepEqual(rt.logs, []);
  assert.equal(rt.global.get('error_counts'), undefined);
});

// ---------- part 2: real starts in the three layouts ----------
const FIXTURE_MODULES = path.join(ROOT, 'scripts/fixtures/release-smoke/node_modules');
const roots = [FIXTURE_MODULES, ...String(process.env.OSI_NODE_RED_EXTRA_ROOTS || '').split(':').filter(Boolean)];
const SQLITE_PACKAGES = ['sqlite3', 'bindings', 'file-uri-to-path'];

// Hard links keep the copy cheap, but the sqlite3 packages must be real
// copies: glibc's dlopen treats a hard link of a loaded library as the same
// object, which would hide a second load.
function copyTree(from, to) {
  try { execFileSync('cp', ['-al', from, to], { stdio: 'ignore' }); } catch (_) { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true }); }
}
function realCopy(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

function buildLayout(mods, layout, work) {
  const fw = path.join(work, 'fw/node_modules');
  const user = path.join(work, 'userdir');
  fs.mkdirSync(path.dirname(fw), { recursive: true });
  copyTree(mods, fw);
  fs.mkdirSync(path.join(user, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(user, 'nodes'), { recursive: true });
  const userSqlite = () => { for (const p of SQLITE_PACKAGES) realCopy(path.join(mods, p), path.join(user, 'node_modules', p)); };
  if (layout === 'field') {
    for (const p of ['node-red-node-sqlite', ...SQLITE_PACKAGES]) fs.rmSync(path.join(fw, p), { recursive: true, force: true });
    realCopy(path.join(mods, 'node-red-node-sqlite'), path.join(user, 'node_modules/node-red-node-sqlite'));
    userSqlite();
  } else {
    const nested = path.join(fw, 'node-red-node-sqlite/node_modules');
    fs.mkdirSync(nested, { recursive: true });
    for (const p of SQLITE_PACKAGES) { realCopy(path.join(mods, p), path.join(nested, p)); fs.rmSync(path.join(fw, p), { recursive: true, force: true }); }
    userSqlite();
    if (layout === 'factory-npm') realCopy(path.join(mods, 'node-red-node-sqlite'), path.join(user, 'node_modules/node-red-node-sqlite'));
  }
  return { fw, user };
}

// Test-only evidence file, loaded after the product file: at each start it
// records, for every sqlitedb handle, whether it is marked serialized and
// which node_sqlite3.node files the process maps.
const EVIDENCE_NODE = `'use strict';
module.exports = function (RED) {
  const MARK = Symbol.for('osi.flowsDbSerialized');
  const handles = new WeakMap(); let next = 0;
  RED.events.on('flows:started', (e) => setImmediate(() => {
    const seen = [];
    RED.nodes.eachNode((c) => { if (c.type !== 'sqlitedb') return; const n = RED.nodes.getNode(c.id); const db = n && n.db;
      if (db && !handles.has(db)) handles.set(db, ++next);
      seen.push({ id: c.id, handle: db ? handles.get(db) : null, marked: !!(db && db[MARK]) }); });
    const maps = require('fs').readFileSync('/proc/self/maps', 'utf8').split('\\n').filter((l) => l.endsWith('node_sqlite3.node')).map((l) => l.split(/\\s+/).slice(5).join(' '));
    require('fs').appendFileSync(process.env.OSI_TEST_EVIDENCE, JSON.stringify({ type: e && e.type, seen, maps: [...new Set(maps)] }) + '\\n');
  }));
};
`;

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
}
function request(port, method, url, headers = {}, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, timeout: 3000 }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', () => resolve({ status: 0 })); req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    if (body) req.write(body); req.end();
  });
}
async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 100)); }
}

for (const mods of roots) {
  const version = require(path.join(mods, 'node-red/package.json')).version;
  for (const layout of ['field', 'factory', 'factory-npm']) {
    test(`Node-RED ${version}, ${layout} layout: serialized after start and after a restart, one sqlite3 addon`, { skip: !fs.existsSync('/proc/self/maps') && 'needs /proc/self/maps' }, async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `osi-serialize-${layout}-`));
      let child;
      try {
        const { fw, user } = buildLayout(mods, layout, work);
        for (const f of fs.readdirSync(NODE_DIR)) fs.copyFileSync(path.join(NODE_DIR, f), path.join(user, 'nodes', f));
        fs.writeFileSync(path.join(user, 'nodes/zz-osi-test-evidence.js'), EVIDENCE_NODE);
        fs.writeFileSync(path.join(user, 'nodes/zz-osi-test-evidence.html'), '');
        const port = await freePort();
        fs.writeFileSync(path.join(user, 'settings.js'), `module.exports = ${JSON.stringify({ uiPort: port, uiHost: '127.0.0.1', httpAdminRoot: '/admin', httpNodeRoot: '/', flowFile: 'flows.json', credentialSecret: false, logging: { console: { level: 'info', metrics: false, audit: false } } })};`);
        fs.writeFileSync(path.join(user, 'flows.json'), JSON.stringify([
          { id: 't1', type: 'tab', label: 'test' },
          { id: 'cfg1', type: 'sqlitedb', db: path.join(user, 'test.db'), mode: 'RWC' },
          { id: 'h1', type: 'http in', z: 't1', url: '/probe', method: 'get', wires: [['q1']] },
          { id: 'q1', type: 'sqlite', z: 't1', mydb: 'cfg1', sqlquery: 'fixed', sql: 'SELECT 2 AS two', wires: [['r1']] },
          { id: 'r1', type: 'http response', z: 't1', wires: [] },
        ]));
        const evidence = path.join(user, 'evidence.jsonl');
        const log = fs.openSync(path.join(user, 'nr.log'), 'w');
        child = spawn(process.execPath, [path.join(fw, 'node-red/red.js'), '-u', user, '-s', path.join(user, 'settings.js')], { cwd: user, env: { ...process.env, OSI_TEST_EVIDENCE: evidence }, stdio: ['ignore', log, log] });
        const lines = () => (fs.existsSync(evidence) ? fs.readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
        await waitFor(async () => lines().length >= 1 && (await request(port, 'GET', '/probe')).status === 200, 30000, 'the first start');
        const restart = await request(port, 'POST', '/admin/flows', { 'Node-RED-Deployment-Type': 'reload', 'Content-Type': 'application/json' }, '{}');
        assert.ok([200, 204].includes(restart.status), 'restart of the flows: ' + restart.status);
        await waitFor(async () => lines().length >= 2 && (await request(port, 'GET', '/probe')).status === 200, 30000, 'the restart');
        const [first, second] = lines();
        const nrLog = fs.readFileSync(path.join(user, 'nr.log'), 'utf8');
        assert.doesNotMatch(nrLog, /osi-sqlite-serialize/, 'no error line from the node file');
        assert.deepEqual(first.seen, [{ id: 'cfg1', handle: 1, marked: true }], 'serialized after the start');
        assert.deepEqual(second.seen, [{ id: 'cfg1', handle: 2, marked: true }], 'a new handle, serialized after the restart');
        const expected = layout === 'factory' ? path.join(fw, 'node-red-node-sqlite/node_modules/sqlite3') : path.join(user, 'node_modules/sqlite3');
        for (const e of [first, second]) {
          assert.equal(e.maps.length, 1, 'exactly one node_sqlite3.node mapped: ' + e.maps.join(', '));
          assert.ok(e.maps[0].startsWith(fs.realpathSync(expected) + path.sep), `the ${layout} layout's copy: ${e.maps[0]}`);
        }
      } finally {
        if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  }
}
