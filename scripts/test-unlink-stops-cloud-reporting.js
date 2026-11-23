'use strict';
// Issue #766 slice A: an unlinked gateway stops reporting to the cloud at once.
//
// Runs the shipped unlink, cloud-guard, REST builder and http function nodes
// of both profiles against a copy of the bundled seed database. The http
// nodes use the shipped osi-cloud-http module; the cloud is a local HTTP
// server that records every request that reaches it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Module = require('node:module');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY_EUI = '0016C001F1000001';
const JOURNAL = '/data/db/osi-account-link-config.json';
const RESTART_DIR = '/var/run/osi-node-red-restart-requests/';
// The REST nodes that pick their cloud target from the users table.
const REST_BUILDERS = [
  'sync-bootstrap-build',
  'sync-outbox-build',
  'sync-history-build',
  'sync-history-manifest-build',
  'sync-pending-build',
  'command-ack-build-batch',
  'sync-refresh-build',
];

function profileDir(profile) {
  return path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
}
function readFlows(profile) {
  return JSON.parse(fs.readFileSync(path.join(profileDir(profile), 'flows.json'), 'utf8'));
}
function findNode(flows, id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error('missing node ' + id);
  return node;
}

// sqlite3-shaped driver over node:sqlite; every open goes to the fixture file.
function sqlite3Adapter(redirectPath) {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(redirectPath, { readOnly: mode === 1 });
      this.native.exec('PRAGMA busy_timeout=2000');
      queueMicrotask(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    get(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try { callback.call(this, null, this.native.prepare(sql).get(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        if (callback) callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
      } catch (error) { if (callback) callback.call(this, error); }
    }
    exec(sql, callback) {
      try { this.native.exec(sql); if (callback) callback.call(this, null); } catch (error) { if (callback) callback.call(this, error); }
    }
    serialize(fn) { if (fn) fn(); }
    configure() {}
    close(callback) { try { this.native.close(); } catch (_) { /* already closed */ } if (callback) callback.call(this, null); }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4, verbose() { return this; } };
}

function freshRequire(file, overrides = {}) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) return overrides[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.dirname(file))) delete require.cache[key];
    return require(file);
  } finally {
    Module._load = original;
  }
}

// Gateway files the account path writes (journal, restart requests) live in
// memory; everything else reads the real (absent) paths read-only.
function gatewayIo() {
  const files = new Map();
  const config = new Map();
  const descriptors = new Map();
  let nextFd = 1;
  const memory = (p) => typeof p === 'string' && (p.startsWith(JOURNAL) || p.startsWith(RESTART_DIR) || p.startsWith('/var/run/osi-'));
  const fakeFs = {
    existsSync(p) { return memory(p) ? files.has(p) : fs.existsSync(p); },
    readFileSync(p, enc) {
      if (memory(p)) {
        if (!files.has(p)) throw Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
        return files.get(p);
      }
      return fs.readFileSync(p, enc);
    },
    readdirSync(p) { return [...files.keys()].filter((file) => path.dirname(file) === p.replace(/\/$/, '')).map((file) => path.basename(file)); },
    openSync(p, flags) { const fd = nextFd++; descriptors.set(fd, p); if (flags === 'wx') files.set(p, ''); return fd; },
    writeFileSync(p, data) {
      const target = typeof p === 'number' ? descriptors.get(p) : p;
      if (!memory(target)) throw new Error('fixture refuses write outside account files: ' + target);
      files.set(target, String(data));
    },
    closeSync(fd) { descriptors.delete(fd); },
    fsyncSync() {},
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    unlinkSync(p) { if (!files.delete(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    mkdirSync() {},
    statSync(p) { return fs.statSync(p); },
  };
  const cp = {
    execFileSync(command, args) {
      assert.equal(command, 'uci');
      const key = args.at(-1);
      if (args.includes('get')) {
        if (!config.has(key)) throw Object.assign(new Error('missing'), { status: 1 });
        return config.get(key);
      }
      if (args[0] === 'set') { const at = args[1].indexOf('='); config.set(args[1].slice(0, at), args[1].slice(at + 1)); }
      if (args.includes('delete')) config.delete(key);
      return '';
    },
  };
  return { fs: fakeFs, cp, files, config };
}

// The cloud: answers 503 to everything and records what arrived.
const cloud = { sent: [], url: '' };
let cloudServer;
test.before(async () => {
  cloudServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      cloud.sent.push({ method: req.method, path: req.url });
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"message":"fixture cloud"}');
    });
  });
  await new Promise((resolve) => cloudServer.listen(0, '127.0.0.1', resolve));
  cloud.url = 'http://127.0.0.1:' + cloudServer.address().port;
});
test.after(() => new Promise((resolve) => cloudServer.close(resolve)));

// node-red.init exports the UCI MQTT password to the Node-RED process; it is
// empty in a process that started unlinked.
function processStarted(linked) {
  process.env.DEVICE_MQTT_PASSWORD = linked ? 'old-mqtt' : '';
}

function fixture(profile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-unlink-reporting-'));
  const dbPath = path.join(tmp, 'farming.db');
  fs.copyFileSync(path.join(profileDir(profile), 'db/farming.db'), dbPath);
  const nodeRed = path.join(profileDir(profile), 'node-red');
  const sqlite3 = sqlite3Adapter(dbPath);
  const osiDb = freshRequire(path.join(nodeRed, 'osi-db-helper/index.js'), { sqlite3 });
  const previousBase = process.env.OSI_LIB_BASE;
  process.env.OSI_LIB_BASE = nodeRed;
  const osiLib = freshRequire(path.join(nodeRed, 'osi-lib/index.js'));
  if (previousBase === undefined) delete process.env.OSI_LIB_BASE; else process.env.OSI_LIB_BASE = previousBase;
  const osiCloudHttp = freshRequire(path.join(nodeRed, 'osi-cloud-http/index.js'));
  const io = gatewayIo();
  const native = new DatabaseSync(dbPath);
  const installationUuid = '123e4567-e89b-42d3-a456-426614174000';
  native.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at) VALUES(1,?,?,'now','now') ON CONFLICT(singleton_id) DO UPDATE SET installation_uuid=excluded.installation_uuid, current_gateway_device_eui=excluded.current_gateway_device_eui").run(installationUuid, GATEWAY_EUI);
  native.close();
  return {
    profile, tmp, dbPath, osiDb, osiLib, osiCloudHttp, io, installationUuid,
    flows: readFlows(profile),
    env: {
      DEVICE_EUI: GATEWAY_EUI,
      DEVICE_EUI_SOURCE: 'concentrator',
      DEVICE_EUI_CONFIDENCE: 'authoritative',
      LINK_GATEWAY_DEVICE_EUI: GATEWAY_EUI,
    },
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

function sql(f, text, ...params) {
  const db = new DatabaseSync(f.dbPath);
  try {
    return /^\s*select/i.test(text) ? db.prepare(text).all(...params) : db.prepare(text).run(...params);
  } finally { db.close(); }
}

// Two local accounts linked to the same cloud: the state a second farmer
// account reaches by linking after the first (the link path never clears
// other rows).
function seedTwoLinkedUsers(f) {
  sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,auth_mode,server_username,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,cloud_user_id,server_offline_verifier,server_offline_verifier_version) VALUES(901,'first','hash-1','2026-01-01T00:00:00Z','u-first','server','first@cloud',?,'token-first',1900000000000,'2026-01-01T00:00:00Z',11,'verifier-1',2)", cloud.url);
  sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,auth_mode,server_username,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,cloud_user_id,server_offline_verifier,server_offline_verifier_version) VALUES(902,'second','hash-2','2026-01-01T00:00:00Z','u-second','server','second@cloud',?,'token-second',1900000000000,'2026-02-01T00:00:00Z',11,'verifier-2',2)", cloud.url);
  sql(f, "INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,?,'11',?,?,'now') ON CONFLICT(peer_node) DO UPDATE SET linked=1, server_url=excluded.server_url, cloud_user_id=excluded.cloud_user_id, gateway_device_eui=excluded.gateway_device_eui, installation_uuid=excluded.installation_uuid", cloud.url, GATEWAY_EUI, f.installationUuid);
  // One pending event, so the outbox builder has something to send.
  sql(f, "INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui) VALUES('evt-766','ZONE','zone-766','ZONE_UPDATED','{}',1,'2026-03-01T00:00:00Z',?)", GATEWAY_EUI);
  for (const [key, value] of Object.entries({ server_host: 'cloud.example.org', mqtt_password: 'old-mqtt', mqtt_broker_url: 'wss://cloud.example.org/mqtt', link_gateway_device_eui: GATEWAY_EUI })) {
    f.io.config.set('osi-server.cloud.' + key, value);
  }
}

async function runNode(f, id, msg, flowStore, envOverride) {
  const node = findNode(f.flows, id);
  const scope = { osiDb: f.osiDb, osiLib: f.osiLib, osiCloudHttp: f.osiCloudHttp, crypto: require('node:crypto') };
  const bound = Object.fromEntries((node.libs || []).map((lib) => [lib.var, scope[lib.var]]));
  const fn = new vm.Script('(async function(msg,node,flow,env,context,global,get,set){' + node.func + '\n})')
    .runInNewContext(Object.assign({ Buffer, console, setTimeout, clearTimeout, URL, Date, Math, JSON, Promise }, bound));
  const env = Object.assign({}, f.env, envOverride || {});
  const warnings = [];
  const api = {
    flow: { get: (k) => flowStore.get(k), set: (k, v) => (v === undefined ? flowStore.delete(k) : flowStore.set(k, v)) },
    env: { get: (k) => env[k] },
    store: { get() { return undefined; }, set() {} },
    global: { get: (k) => (k === 'fs' ? f.io.fs : k === 'cp' ? f.io.cp : undefined), set() {} },
    node: { warn: (t) => warnings.push(String(t)), error: (t) => warnings.push(String(t)), log() {}, status() {}, send() {}, done() {} },
  };
  const result = await fn(msg, api.node, api.flow, api.env, api.store, api.global, () => undefined, () => {});
  return { result, warnings };
}

// Runs each builder and, for a message, its http node: what leaves the gateway.
async function restRequests(f, flowStore) {
  const before = cloud.sent.length;
  const emitted = {};
  for (const id of REST_BUILDERS) {
    const { result } = await runNode(f, id, { payload: Date.now() }, flowStore);
    const out = Array.isArray(result) ? result.find(Boolean) : result;
    emitted[id] = Boolean(out && out.url);
    if (out && out.url) {
      const builder = findNode(f.flows, id);
      const httpId = builder.wires.flat().find((wire) => /http/.test(findNode(f.flows, wire).name || '') || /-http$/.test(wire));
      if (httpId) await runNode(f, httpId, out, flowStore);
    }
  }
  return { emitted, sent: cloud.sent.slice(before) };
}

function linkedFlowStore() {
  return new Map([['account_linked', true], ['sync_state', {}]]);
}

async function unlinkAs(f, flowStore, userId, username) {
  const { result } = await runNode(f, 'al-unlink-db', { _unlinkAuth: { userId, username } }, flowStore);
  assert.ok(result[0], 'unlink must succeed: ' + JSON.stringify(result[1] && result[1].payload));
  const published = await runNode(f, 'al-unlink-restart-node-red', result[0], flowStore);
  assert.ok(published.result[0], 'unlink must publish its restart request');
  // The daemon restarts Node-RED and removes the request.
  for (const file of [...f.io.files.keys()]) if (file.startsWith(RESTART_DIR)) f.io.files.delete(file);
}

async function cloudGuards(f, flowStore) {
  const guards = f.flows.filter((n) => /^account-cloud-guard-/.test(n.id));
  assert.ok(guards.length >= 6, 'every cloud MQTT output has its guard');
  const passed = [];
  for (const guard of guards) {
    const { result } = await runNode(f, guard.id, { topic: 'fixture', payload: { fixture: true } }, flowStore);
    if (result) passed.push(guard.id);
  }
  return { guards: guards.map((g) => g.id), passed };
}

for (const profile of PROFILES) {
  test(`${profile}: baseline: a linked gateway sends REST sync requests and cloud MQTT messages`, async () => {
    const f = fixture(profile);
    try {
      processStarted(true);
      seedTwoLinkedUsers(f);
      const { sent } = await restRequests(f, linkedFlowStore());
      assert.ok(sent.some((r) => r.path.startsWith('/api/v1/sync/')), 'positive control: the builders reach the cloud while linked: ' + JSON.stringify(sent));
      const mqtt = await cloudGuards(f, linkedFlowStore());
      assert.deepEqual(mqtt.passed, mqtt.guards, 'positive control: the guards pass cloud MQTT while linked');
    } finally { f.cleanup(); }
  });

  test(`${profile}: after one of two linked local users unlinks, no REST sync request leaves the gateway`, async () => {
    const f = fixture(profile);
    try {
      processStarted(true);
      seedTwoLinkedUsers(f);
      const flowStore = linkedFlowStore();
      await unlinkAs(f, flowStore, 902, 'second');
      // Before the restart the process still holds the linked environment.
      const live = await restRequests(f, flowStore);
      // A Node-RED restart starts unlinked with empty flow context.
      processStarted(false);
      const restarted = await restRequests(f, new Map());
      assert.deepEqual({ live: live.sent, restarted: restarted.sent }, { live: [], restarted: [] },
        'builders that still emit: ' + JSON.stringify({ live: live.emitted, restarted: restarted.emitted }));
      const rows = sql(f, "SELECT id, auth_mode, server_url, server_sync_token, cloud_user_id, password_hash FROM users WHERE id IN (901,902) ORDER BY id");
      for (const row of rows) {
        assert.equal(row.server_url, null, 'user ' + row.id + ' keeps no cloud address');
        assert.equal(row.server_sync_token, null, 'user ' + row.id + ' keeps no sync token');
        assert.equal(row.auth_mode, 'local', 'user ' + row.id + ' signs in locally');
        assert.equal(row.password_hash, 'hash-' + (row.id - 900), 'user ' + row.id + ' keeps its local password');
      }
    } finally { f.cleanup(); }
  });

  test(`${profile}: a gateway unlinked before this fix, with a stale second linked account, sends nothing after the restart`, async () => {
    const f = fixture(profile);
    try {
      seedTwoLinkedUsers(f);
      // What the old unlink left: the caller's row and the peer cleared, the
      // other account row still linked.
      sql(f, "UPDATE users SET auth_mode='local', server_url=NULL, server_sync_token=NULL, server_linked_at=NULL, cloud_user_id=NULL WHERE id=902");
      sql(f, "UPDATE sync_link_state SET linked=0, server_url=NULL, cloud_user_id=NULL, gateway_device_eui=NULL WHERE peer_node='cloud'");
      processStarted(false);
      const { sent, emitted } = await restRequests(f, new Map());
      assert.deepEqual(sent, [], 'builders that still address the cloud are refused: ' + JSON.stringify(emitted));
      assert.ok(Object.values(emitted).some(Boolean), 'the stale row still makes a builder address the cloud; only the gate stops it');
    } finally { f.cleanup(); }
  });

  test(`${profile}: a process that started unlinked drops every cloud MQTT message`, async () => {
    const f = fixture(profile);
    try {
      processStarted(false);
      const { passed } = await cloudGuards(f, new Map());
      assert.deepEqual(passed, []);
    } finally { f.cleanup(); }
  });
}

test('the gate refuses only linked-only paths, and only while unlinked', () => {
  const cloudHttp = require(path.join(profileDir('bcm2712'), 'node-red/osi-cloud-http/index.js'));
  for (const p of ['/api/v1/sync/edge/events', '/api/v1/sync/gateways/X/pending-commands', '/api/v1/sync/chameleon/calibrations/lookup', '/api/v2/journal/gateways/X/entries', '/auth/refresh-sync']) {
    assert.equal(cloudHttp.linkedOnlyPath(p), true, p);
  }
  for (const p of ['/auth/local-sync', '/auth/local-sync/conditional-irrigation-v1', '/api/v1/support/edge/work-requests', '/auth/refresh-synced']) {
    assert.equal(cloudHttp.linkedOnlyPath(p), false, p);
  }
  assert.equal(cloudHttp.gatewayLinked({ DEVICE_MQTT_PASSWORD: 'x' }), true);
  assert.equal(cloudHttp.gatewayLinked({ DEVICE_MQTT_PASSWORD: '' }), false);
  assert.equal(cloudHttp.gatewayLinked({ DEVICE_MQTT_PASSWORD: '  ' }), false);
  assert.equal(cloudHttp.gatewayLinked({}), false, 'absent counts as unlinked; node-red.init always exports it');
});

test('an unlinked process still reaches the link and support routes', async () => {
  const cloudHttp = require(path.join(profileDir('bcm2712'), 'node-red/osi-cloud-http/index.js'));
  processStarted(false);
  const before = cloud.sent.length;
  await cloudHttp.requestJsonIpv4({ method: 'POST', url: cloud.url + '/auth/local-sync', payload: {} });
  await cloudHttp.requestJsonIpv4({ method: 'POST', url: cloud.url + '/api/v1/support/edge/work-requests', payload: {} });
  await assert.rejects(cloudHttp.requestJsonIpv4({ method: 'POST', url: cloud.url + '/api/v1/sync/edge/events', payload: {} }), { code: 'gateway_unlinked' });
  assert.deepEqual(cloud.sent.slice(before).map((r) => r.path), ['/auth/local-sync', '/api/v1/support/edge/work-requests']);
});

module.exports = { fixture, seedTwoLinkedUsers, runNode, restRequests, unlinkAs, linkedFlowStore, sql, REST_BUILDERS, GATEWAY_EUI, cloud, processStarted };
