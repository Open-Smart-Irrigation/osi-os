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
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      cloud.sent.push({ method: req.method, path: req.url });
      const answer = cloud.respond && cloud.respond(req, Buffer.concat(chunks).toString('utf8'));
      // No keep-alive: a reused socket that this server times out between
      // tests would reset the next request (ECONNRESET).
      res.writeHead(answer ? answer.status : 503, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(answer ? answer.body : { message: 'fixture cloud' }));
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
// other rows). Both are enabled admins, so either may unlink (#766).
function seedTwoLinkedUsers(f) {
  sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode,server_username,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,cloud_user_id,server_offline_verifier,server_offline_verifier_version) VALUES(901,'first','hash-1','2026-01-01T00:00:00Z','u-first','admin','server','first@cloud',?,'token-first',1900000000000,'2026-01-01T00:00:00Z',11,'verifier-1',2)", cloud.url);
  sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode,server_username,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,cloud_user_id,server_offline_verifier,server_offline_verifier_version) VALUES(902,'second','hash-2','2026-01-01T00:00:00Z','u-second','admin','server','second@cloud',?,'token-second',1900000000000,'2026-02-01T00:00:00Z',11,'verifier-2',2)", cloud.url);
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

// beforeRestart runs while the account_unlink restart request is queued and
// the process still holds the linked environment.
async function unlinkAs(f, flowStore, userId, username, beforeRestart) {
  const { result } = await runNode(f, 'al-unlink-db', { _unlinkAuth: { userId, username } }, flowStore);
  assert.ok(result[0], 'unlink must succeed: ' + JSON.stringify(result[1] && result[1].payload));
  const published = await runNode(f, 'al-unlink-restart-node-red', result[0], flowStore);
  assert.ok(published.result[0], 'unlink must publish its restart request');
  assert.ok([...f.io.files.keys()].some((file) => file.startsWith(RESTART_DIR) && /account_unlink-/.test(file)), 'the account_unlink restart request is queued');
  if (beforeRestart) await beforeRestart();
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
      await unlinkAs(f, flowStore, 902, 'second', async () => {
        // The restart request is queued and the process is still linked: the
        // cloud MQTT guards already drop every message.
        const mqtt = await cloudGuards(f, flowStore);
        assert.deepEqual(mqtt.passed, [], 'pre-restart: cloud MQTT dropped while the unlink restart is queued');
      });
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
  // A cloud reached under a base path is gated the same way.
  for (const p of ['/osi/api/v1/sync/edge/events', '/a/b/api/v2/journal/gateways/X/entries', '/osi/auth/refresh-sync']) {
    assert.equal(cloudHttp.linkedOnlyPath(p), true, p);
  }
  for (const p of ['/auth/local-sync', '/auth/local-sync/conditional-irrigation-v1', '/osi/auth/local-sync', '/api/v1/support/edge/work-requests', '/auth/refresh-synced', '/api/v1/syncx/edge', '/xapi/v1/sync/edge']) {
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
  await assert.rejects(cloudHttp.requestJsonIpv4({ method: 'POST', url: cloud.url + '/osi/api/v1/sync/edge/events', payload: {} }), { code: 'gateway_unlinked' });
  assert.deepEqual(cloud.sent.slice(before).map((r) => r.path), ['/auth/local-sync', '/api/v1/support/edge/work-requests']);
});

// Follows the success port of the shipped link chain, from the request
// builder to the restart request, as Node-RED would.
const LINK_CHAIN_END = 'al-link-restart-node-red';
async function linkAs(f, userId, username, cloudUserId) {
  const flowStore = new Map([
    ['al_local_username', username], ['al_local_user_id', userId], ['al_action', 'link'],
    ['al_server_url', cloud.url], ['al_server_username', username + '@cloud'], ['al_server_password', 'fixture-password'],
    ['al_gateway_device_eui', GATEWAY_EUI], ['al_gateway_device_eui_confidence', 'authoritative'],
  ]);
  cloud.respond = (req) => (req.url.startsWith('/auth/local-sync') ? {
    status: 200,
    body: {
      username: username + '@cloud', userId: cloudUserId, token: 'token-' + username,
      offlineVerifier: 'verifier-' + username, offlineVerifierVersion: 2, syncTokenExpiresAt: 1900000000000,
      mqttPassword: 'mqtt-' + username, mqttBrokerUrl: 'wss://cloud.example.org/mqtt', installationUuid: f.installationUuid,
      capabilities: [],
    },
  } : null);
  const sentBefore = cloud.sent.length;
  try {
    let id = 'al-link-build-req';
    let msg = { authUserId: userId, authUsername: username };
    const path = [];
    for (let hops = 0; hops < 12; hops++) {
      path.push(id);
      const { result, warnings } = await runNode(f, id, msg, flowStore, { ALLOW_PRIVATE_SERVER_URLS: '1' });
      const outputs = Array.isArray(result) ? result : [result];
      if (!outputs[0]) {
        const failure = outputs.find(Boolean);
        throw new Error('link stopped at ' + id + ': ' + JSON.stringify(failure && failure.payload) + ' ' + warnings.join('; '));
      }
      msg = outputs[0];
      if (id === LINK_CHAIN_END) break;
      id = findNode(f.flows, id).wires[0].find((next) => findNode(f.flows, next).type === 'function');
    }
    assert.equal(path.at(-1), LINK_CHAIN_END, 'link reached its restart request: ' + path.join(' > '));
    assert.ok(cloud.sent.slice(sentBefore).some((r) => r.method === 'POST' && r.path.startsWith('/auth/local-sync')),
      'the link request went out through osi-cloud-http');
  } finally {
    cloud.respond = null;
  }
  // The daemon restarts Node-RED, which starts linked.
  for (const file of [...f.io.files.keys()]) if (file.startsWith(RESTART_DIR)) f.io.files.delete(file);
  assert.equal(f.io.config.get('osi-server.cloud.mqtt_password'), 'mqtt-' + username, 'link stores the MQTT password node-red.init exports');
}

for (const profile of PROFILES) {
  test(`${profile}: two local accounts link through the shipped nodes; one unlink stops all reporting; a relink restores it`, async () => {
    const f = fixture(profile);
    try {
      sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode) VALUES(901,'first','hash-1','2026-01-01T00:00:00Z','u-first','admin','local'),(902,'second','hash-2','2026-01-01T00:00:00Z','u-second','admin','local')");
      processStarted(false);
      await linkAs(f, 901, 'first', 11);
      processStarted(true);
      await linkAs(f, 902, 'second', 11);
      const linkedRows = sql(f, "SELECT id FROM users WHERE id IN (901,902) AND server_url IS NOT NULL AND server_sync_token IS NOT NULL ORDER BY id");
      assert.deepEqual(linkedRows.map((r) => r.id), [901, 902], 'the shipped link path leaves both accounts linked');

      sql(f, "INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui) VALUES('evt-766','ZONE','zone-766','ZONE_UPDATED','{}',1,'2026-03-01T00:00:00Z',?)", GATEWAY_EUI);
      const linked = await restRequests(f, linkedFlowStore());
      assert.ok(linked.sent.some((r) => r.path.startsWith('/api/v1/sync/')), 'linked: sync reaches the cloud');

      await unlinkAs(f, linkedFlowStore(), 902, 'second');
      assert.equal(f.io.config.get('osi-server.cloud.mqtt_password'), '', 'unlink empties the MQTT password');
      processStarted(false);
      const unlinked = await restRequests(f, new Map());
      assert.deepEqual(unlinked.sent, [], 'unlinked: nothing reaches the cloud ' + JSON.stringify(unlinked.emitted));
      assert.deepEqual((await cloudGuards(f, new Map())).passed, [], 'unlinked: cloud MQTT dropped');

      await linkAs(f, 901, 'first', 11);
      processStarted(true);
      const relinked = await restRequests(f, linkedFlowStore());
      assert.ok(relinked.sent.some((r) => r.path.startsWith('/api/v1/sync/')), 'relinked: sync reaches the cloud again');
      const mqtt = await cloudGuards(f, linkedFlowStore());
      assert.deepEqual(mqtt.passed, mqtt.guards, 'relinked: cloud MQTT passes again');
    } finally { f.cleanup(); }
  });
}

for (const profile of PROFILES) {
  test(`${profile}: start warns when the database records a link but the process has no MQTT password`, async () => {
    const f = fixture(profile);
    try {
      const helper = require(path.join(profileDir(profile), 'node-red/osi-installation-helper/index.js'));
      const startWarnings = async (linked) => {
        processStarted(linked);
        const warnings = [];
        await helper.recoverAccountConfigOnStart({ osiDb: f.osiDb, fs: f.io.fs, cp: f.io.cp, warn: (t) => warnings.push(t) });
        return warnings.filter((t) => /no MQTT password is in UCI/.test(t));
      };
      seedTwoLinkedUsers(f);
      assert.equal((await startWarnings(false)).length, 1, 'peer linked, process unlinked: one warning');
      assert.equal((await startWarnings(true)).length, 0, 'peer linked, process linked: no warning');
      // A gateway unlinked by the old code: peer cleared, a stale account row left.
      sql(f, "UPDATE sync_link_state SET linked=0 WHERE peer_node='cloud'");
      assert.equal((await startWarnings(false)).length, 0, 'stale account rows alone do not warn');
    } finally { f.cleanup(); }
  });
}

test('settings.js never refills DEVICE_MQTT_PASSWORD from the env file', () => {
  const source = fs.readFileSync(path.join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js'), 'utf8');
  const literal = source.match(/const protectedKeys = new Set\((\[[\s\S]*?\])\);/);
  assert.ok(literal, 'protectedKeys set found');
  const keys = vm.runInNewContext(literal[1]);
  assert.ok(keys.includes('DEVICE_MQTT_PASSWORD'));
});

// Unlinking is a gateway system command: an enabled gateway admin may do it,
// with scoped access off or on. On a gateway that has an enabled admin, the
// account that linked the gateway is admitted only as an admin (the owner
// stand-in for gateways without an admin is tested further down).
const SECRET = 'fixture-auth-secret';
function bearer(userId, username) {
  const crypto = require('node:crypto');
  const b64 = (v) => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const payload = b64(JSON.stringify({ userId, username, exp: Date.now() + 3600000 }));
  return 'Bearer ' + payload + '.' + b64(crypto.createHmac('sha256', SECRET).update(payload).digest());
}

// Runs DELETE /api/account-link from its first function node along the
// success port to the database stage, as Node-RED would.
async function unlinkRoute(f, flowStore, authorization, scoped) {
  const env = { AUTH_TOKEN_SECRET: SECRET, OSI_SCOPED_ACCESS: scoped ? '1' : '' };
  let id = findNode(f.flows, 'al-unlink-in').wires[0][0];
  let msg = { req: { headers: { authorization } }, payload: {} };
  for (let hops = 0; hops < 8; hops++) {
    const { result } = await runNode(f, id, msg, flowStore, env);
    const outputs = Array.isArray(result) ? result : [result];
    if (!outputs[0]) return { refusedAt: id, response: outputs.find(Boolean) };
    msg = outputs[0];
    if (id === 'al-unlink-db') return { unlinked: true };
    id = findNode(f.flows, id).wires[0].find((next) => findNode(f.flows, next).type === 'function');
  }
  throw new Error('unlink route did not reach its database stage');
}

const UNLINK_CALLERS = [
  // [label, id, username, role, disabled, linked account, allowed]
  ['enabled admin', 911, 'admin1', 'admin', false, false, true],
  ['admin who linked the gateway (cloud owner)', 912, 'owner', 'admin', false, true, true],
  ['member (researcher)', 913, 'member', 'researcher', false, false, false],
  ['viewer', 914, 'viewer', 'viewer', false, false, false],
  ['disabled admin', 915, 'admin2', 'admin', true, false, false],
  ['member who linked the gateway (cloud owner, not admin)', 916, 'linker', 'researcher', false, true, false],
];

for (const profile of PROFILES) {
  for (const scoped of [false, true]) {
    for (const [label, id, username, role, disabled, linkedAccount, allowed] of UNLINK_CALLERS) {
      test(`${profile} scoped ${scoped ? 'on' : 'off'}: unlink by ${label} is ${allowed ? 'allowed' : 'refused with 403'}`, async () => {
        const f = fixture(profile);
        const previous = process.env.OSI_SCOPED_ACCESS;
        process.env.OSI_SCOPED_ACCESS = scoped ? '1' : '';
        try {
          processStarted(true);
          seedTwoLinkedUsers(f);
          for (const [, uid, name, r, off, linkedRow] of UNLINK_CALLERS) {
            sql(f, `INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,disabled_at,auth_mode,server_url,server_sync_token,server_linked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
              uid, name, 'hash-' + uid, '2026-01-01T00:00:00Z', 'uuid-' + uid, r, off ? '2026-02-01T00:00:00Z' : null,
              linkedRow ? 'server' : 'local', linkedRow ? cloud.url : null, linkedRow ? 'token-' + uid : null, linkedRow ? '2026-03-01T00:00:00Z' : null);
          }
          const outcome = await unlinkRoute(f, linkedFlowStore(), bearer(id, username), scoped);
          const peer = sql(f, "SELECT linked FROM sync_link_state WHERE peer_node='cloud'")[0];
          if (allowed) {
            assert.equal(outcome.unlinked, true, JSON.stringify(outcome));
            assert.equal(peer.linked, 0, 'the gateway is unlinked');
          } else {
            assert.equal(outcome.response && outcome.response.statusCode, 403, JSON.stringify(outcome));
            // The payload comes from the function sandbox: compare its content.
            assert.deepEqual(JSON.parse(JSON.stringify(outcome.response.payload)), { message: 'Forbidden', code: 'forbidden' });
            assert.equal(peer.linked, 1, 'a refused caller leaves the link in place');
            assert.equal(f.io.config.get('osi-server.cloud.mqtt_password'), 'old-mqtt', 'a refused caller leaves the MQTT password in place');
          }
        } finally {
          if (previous === undefined) delete process.env.OSI_SCOPED_ACCESS; else process.env.OSI_SCOPED_ACCESS = previous;
          f.cleanup();
        }
      });
    }
  }

  test(`${profile}: account-link status reports canUnlink only for an enabled admin while the gateway has one`, async () => {
    const f = fixture(profile);
    try {
      for (const [, uid, name, r, off] of UNLINK_CALLERS) {
        sql(f, 'INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,disabled_at) VALUES(?,?,?,?,?,?,?)',
          uid, name, 'hash-' + uid, '2026-01-01T00:00:00Z', 'uuid-' + uid, r, off ? '2026-02-01T00:00:00Z' : null);
      }
      for (const [label, uid, name, , , , allowed] of UNLINK_CALLERS) {
        let id = findNode(f.flows, 'al-status-in').wires[0][0];
        let msg = { req: { headers: { authorization: bearer(uid, name) } } };
        for (let hops = 0; hops < 4 && id; hops++) {
          const { result } = await runNode(f, id, msg, new Map(), { AUTH_TOKEN_SECRET: SECRET });
          msg = (Array.isArray(result) ? result : [result]).find(Boolean);
          const node = findNode(f.flows, id);
          id = (node.wires[0] || []).find((next) => findNode(f.flows, next).type === 'function');
        }
        assert.equal(msg.statusCode, 200, label + ': ' + JSON.stringify(msg.payload));
        assert.equal(msg.payload.canUnlink, allowed, label);
        assert.equal(Object.keys(msg.payload).some((k) => /password|verifier$|token/i.test(k)), false, 'no secret in the status payload');
      }
    } finally { f.cleanup(); }
  });
}

// Account-link status through the shipped nodes (decode, then the helper's
// formatter): the query loads the verifier metadata, the response reports
// package validity and repair requirements, and a stale "up_to_date" sync
// status is downgraded when the linked-auth package is incomplete.
async function statusFor(f, userId, username) {
  let id = findNode(f.flows, 'al-status-in').wires[0][0];
  let msg = { req: { headers: { authorization: bearer(userId, username) } } };
  for (let hops = 0; hops < 4 && id; hops++) {
    const { result } = await runNode(f, id, msg, new Map(), { AUTH_TOKEN_SECRET: SECRET });
    msg = (Array.isArray(result) ? result : [result]).find(Boolean);
    id = (findNode(f.flows, id).wires[0] || []).find((next) => findNode(f.flows, next).type === 'function');
  }
  return JSON.parse(JSON.stringify(msg.payload));
}

for (const profile of PROFILES) {
  test(`${profile}: account-link status reports linked-auth package validity and downgrades a stale state`, async () => {
    const f = fixture(profile);
    try {
      const insert = 'INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode,server_username,server_url,server_linked_at,server_offline_verifier,server_offline_verifier_version,last_auth_sync_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)';
      sql(f, insert, 921, 'valid', 'h', 'now', 'u-921', 'admin', 'server', 'valid@cloud', 'https://cloud.example.org', '2026-01-01T00:00:00Z', 'verifier', 2, 'up_to_date');
      sql(f, insert, 922, 'stale', 'h', 'now', 'u-922', 'admin', 'server', 'stale@cloud', 'https://cloud.example.org', '2026-01-01T00:00:00Z', null, 0, 'up_to_date');
      sql(f, insert, 923, 'local', 'h', 'now', 'u-923', 'admin', 'local', null, null, null, null, 0, null);
      // Each half of package validity on its own, and a blank verifier.
      sql(f, insert, 924, 'noversion', 'h', 'now', 'u-924', 'admin', 'server', 'nv@cloud', 'https://cloud.example.org', '2026-01-01T00:00:00Z', 'verifier', 0, 'up_to_date');
      sql(f, insert, 925, 'noverifier', 'h', 'now', 'u-925', 'admin', 'server', 'nf@cloud', 'https://cloud.example.org', '2026-01-01T00:00:00Z', null, 2, 'up_to_date');
      sql(f, insert, 926, 'blankverifier', 'h', 'now', 'u-926', 'admin', 'server', 'bv@cloud', 'https://cloud.example.org', '2026-01-01T00:00:00Z', '   ', 2, 'up_to_date');
      const valid = await statusFor(f, 921, 'valid');
      assert.equal(valid.linked, true);
      assert.equal(valid.linkedAuthPackageValid, true);
      assert.equal(valid.linkedAuthRepairRequired, false);
      assert.equal(valid.linkedAuthSyncStatus, 'up_to_date');
      assert.equal(valid.offlineVerifierVersion, 2, 'the query loads the verifier version');
      const stale = await statusFor(f, 922, 'stale');
      assert.equal(stale.linkedAuthPackageValid, false);
      assert.equal(stale.linkedAuthRepairRequired, true);
      assert.equal(stale.linkedAuthSyncStatus, 'repair_required', 'a stale up_to_date state is downgraded');
      for (const [uid, name] of [[924, 'noversion'], [925, 'noverifier'], [926, 'blankverifier']]) {
        const status = await statusFor(f, uid, name);
        assert.equal(status.linkedAuthPackageValid, false, name + ': package invalid');
        assert.equal(status.linkedAuthRepairRequired, true, name + ': repair required');
        assert.equal(status.linkedAuthSyncStatus, 'repair_required', name + ': stale state downgraded');
      }
      const local = await statusFor(f, 923, 'local');
      assert.equal(local.linked, false);
      assert.equal(local.linkedAuthRepairRequired, false);
      assert.equal(local.offlineVerifierVersion, 0);
    } finally { f.cleanup(); }
  });
}

// A gateway installed from the current seed with scoped access off: the first
// registered account is a researcher and no account is an admin. The linked
// account stands in for the gateway owner then (unless it is a viewer), so the
// farmer who linked the gateway can unlink it. Reported by the round-2 review
// with this sequence: register, link through the shipped chain, unlink.
for (const profile of PROFILES) {
  for (const scoped of [false, true]) {
    test(`${profile} scoped ${scoped ? 'on' : 'off'}: the first registered account links and then unlinks the gateway`, async () => {
      const f = fixture(profile);
      const previous = process.env.OSI_SCOPED_ACCESS;
      process.env.OSI_SCOPED_ACCESS = scoped ? '1' : '';
      try {
        processStarted(true);
        sql(f, 'DELETE FROM users');
        const env = { AUTH_TOKEN_SECRET: SECRET, OSI_SCOPED_ACCESS: scoped ? '1' : '' };
        const registered = await runNode(f, 'auth-db-insert', { userInsert: { username: 'farmer', passwordHash: 'h', createdAt: '2026-01-01T00:00:00Z' } }, new Map(), env);
        assert.ok(registered.result[0], 'registered');
        const user = sql(f, "SELECT id, role FROM users WHERE username='farmer'")[0];
        assert.equal(user.role, scoped ? 'admin' : 'researcher', 'the role registration gives the first account');
        await linkAs(f, user.id, 'farmer', 501);
        processStarted(true);
        const outcome = await unlinkRoute(f, linkedFlowStore(), bearer(user.id, 'farmer'), scoped);
        assert.equal(outcome.unlinked, true, 'the only account on the gateway can unlink: ' + JSON.stringify(outcome));
      } finally {
        if (previous === undefined) delete process.env.OSI_SCOPED_ACCESS; else process.env.OSI_SCOPED_ACCESS = previous;
        f.cleanup();
      }
    });

    test(`${profile} scoped ${scoped ? 'on' : 'off'}: unlink with a missing or malformed token is refused`, async () => {
      const f = fixture(profile);
      const previous = process.env.OSI_SCOPED_ACCESS;
      process.env.OSI_SCOPED_ACCESS = scoped ? '1' : '';
      try {
        processStarted(true);
        seedTwoLinkedUsers(f);
        for (const authorization of [undefined, 'Bearer x.y', 'Basic abc']) {
          const outcome = await unlinkRoute(f, linkedFlowStore(), authorization, scoped);
          assert.ok(!outcome.unlinked, String(authorization));
          assert.equal(outcome.response.statusCode, 401, String(authorization));
          assert.equal(sql(f, "SELECT linked FROM sync_link_state WHERE peer_node='cloud'")[0].linked, 1);
        }
      } finally {
        if (previous === undefined) delete process.env.OSI_SCOPED_ACCESS; else process.env.OSI_SCOPED_ACCESS = previous;
        f.cleanup();
      }
    });
  }

  // Scoped access off. [label, role, linked, disabled, gateway has an enabled admin, allowed]
  const OWNER_PROXY_CASES = [
    ['researcher who linked, no admin on the gateway', 'researcher', true, false, false, true],
    ['researcher who did not link, no admin on the gateway', 'researcher', false, false, false, false],
    ['viewer who linked, no admin on the gateway', 'viewer', true, false, false, false],
    ['disabled researcher who linked, no admin on the gateway', 'researcher', true, true, false, false],
    ['researcher who linked, with an enabled admin on the gateway', 'researcher', true, false, true, false],
    ['researcher who linked, with only a disabled admin on the gateway', 'researcher', true, false, 'disabled', true],
    // auth_mode 'server' without a cloud address is not a current link.
    ['researcher with auth_mode server but no server_url, no admin on the gateway', 'researcher', 'no-url', false, false, false],
  ];
  for (const [label, role, linkedRow, disabled, admin, allowed] of OWNER_PROXY_CASES) {
    test(`${profile} scoped off: unlink by a ${label} is ${allowed ? 'allowed' : 'refused with 403'}, and canUnlink agrees`, async () => {
      const f = fixture(profile);
      try {
        processStarted(true);
        sql(f, 'DELETE FROM users');
        sql(f, "INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,?,'11',?,?,'now') ON CONFLICT(peer_node) DO UPDATE SET linked=1", cloud.url, GATEWAY_EUI, f.installationUuid);
        for (const [key, value] of Object.entries({ server_host: 'cloud.example.org', mqtt_password: 'old-mqtt', mqtt_broker_url: 'wss://cloud.example.org/mqtt', link_gateway_device_eui: GATEWAY_EUI })) {
          f.io.config.set('osi-server.cloud.' + key, value);
        }
        sql(f, 'INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,disabled_at,auth_mode,server_url,server_sync_token,server_linked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          931, 'caller', 'h', 'now', 'u-931', role, disabled ? '2026-02-01T00:00:00Z' : null,
          linkedRow ? 'server' : 'local', linkedRow === true ? cloud.url : null, linkedRow ? 'token-931' : null, linkedRow ? '2026-03-01T00:00:00Z' : null);
        if (admin) {
          sql(f, 'INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,disabled_at) VALUES(932,?,?,?,?,?,?)',
            'admin', 'h', 'now', 'u-932', 'admin', admin === 'disabled' ? '2026-02-01T00:00:00Z' : null);
        }
        const status = await statusFor(f, 931, 'caller');
        assert.equal(status.canUnlink, allowed, 'canUnlink');
        const usersBefore = sql(f, 'SELECT * FROM users ORDER BY id');
        const outcome = await unlinkRoute(f, linkedFlowStore(), bearer(931, 'caller'), false);
        const peer = sql(f, "SELECT linked FROM sync_link_state WHERE peer_node='cloud'")[0];
        if (allowed) {
          assert.equal(outcome.unlinked, true, JSON.stringify(outcome));
          assert.equal(peer.linked, 0);
        } else {
          assert.equal(outcome.response && outcome.response.statusCode, 403, JSON.stringify(outcome));
          assert.deepEqual(JSON.parse(JSON.stringify(outcome.response.payload)), { message: 'Forbidden', code: 'forbidden' });
          assert.equal(peer.linked, 1, 'a refused caller leaves the link in place');
          assert.equal(f.io.config.get('osi-server.cloud.mqtt_password'), 'old-mqtt', 'a refused caller leaves the MQTT password in place');
          assert.deepEqual(sql(f, 'SELECT * FROM users ORDER BY id'), usersBefore, 'a refused caller leaves every account row unchanged');
        }
      } finally { f.cleanup(); }
    });
  }
}

// An enabled admin whose own account is local, on a gateway that another
// account linked: the status reports the gateway as linked and the admin as
// able to unlink, and the admin's unlink clears every account's link.
for (const profile of PROFILES) {
  test(`${profile} scoped off: an admin whose own account is local unlinks a gateway another account linked`, async () => {
    const f = fixture(profile);
    try {
      processStarted(true);
      sql(f, 'DELETE FROM users');
      sql(f, "INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,?,'11',?,?,'now') ON CONFLICT(peer_node) DO UPDATE SET linked=1", cloud.url, GATEWAY_EUI, f.installationUuid);
      for (const [key, value] of Object.entries({ server_host: 'cloud.example.org', mqtt_password: 'old-mqtt', mqtt_broker_url: 'wss://cloud.example.org/mqtt', link_gateway_device_eui: GATEWAY_EUI })) {
        f.io.config.set('osi-server.cloud.' + key, value);
      }
      sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode) VALUES(941,'admin','h','now','u-941','admin','local')");
      sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode,server_url,server_sync_token,server_linked_at) VALUES(942,'linker','h','now','u-942','researcher','server',?,'token-942','2026-03-01T00:00:00Z')", cloud.url);
      const status = await statusFor(f, 941, 'admin');
      assert.equal(status.linked, false, 'the admin account itself is not linked');
      assert.equal(status.gatewayLinked, true, 'the gateway is linked');
      assert.equal(status.canUnlink, true, 'the admin may unlink it');
      const linkerStatus = await statusFor(f, 942, 'linker');
      assert.equal(linkerStatus.gatewayLinked, true);
      assert.equal(linkerStatus.canUnlink, false, 'with an enabled admin present, the linking researcher may not');
      const outcome = await unlinkRoute(f, linkedFlowStore(), bearer(941, 'admin'), false);
      assert.equal(outcome.unlinked, true, JSON.stringify(outcome));
      assert.equal(sql(f, "SELECT linked FROM sync_link_state WHERE peer_node='cloud'")[0].linked, 0);
      assert.deepEqual(sql(f, "SELECT id FROM users WHERE server_url IS NOT NULL OR server_sync_token IS NOT NULL OR auth_mode <> 'local'"), [], 'every account row gives up its link');
      assert.equal((await statusFor(f, 941, 'admin')).gatewayLinked, false, 'after the unlink the gateway reads as unlinked');
    } finally { f.cleanup(); }
  });
}

// A request built before an unlink commits can still reach the http node
// afterwards (the builder and the send are separate steps, and one journal
// replication tick sends several requests with one token). Until Node-RED
// restarts, the process holds the linked environment, so osi-cloud-http reads
// the account-work gate at send time and refuses restricted paths.
for (const profile of PROFILES) {
  test(`${profile}: a request built before the unlink commits is refused at send time until the restart`, async () => {
    const f = fixture(profile);
    f.osiCloudHttp.useAccountWorkFsForTests(f.io.fs);
    try {
      processStarted(true);
      seedTwoLinkedUsers(f);
      const flowStore = linkedFlowStore();
      // Built while linked, with the old token, and not sent yet.
      const { result } = await runNode(f, 'sync-pending-build', { payload: Date.now() }, flowStore);
      const prebuilt = Array.isArray(result) ? result.find(Boolean) : result;
      assert.ok(prebuilt && /\/api\/v1\/sync\/gateways\//.test(prebuilt.url) && /Bearer /.test(prebuilt.headers.Authorization), 'a pending-command request was built');
      const before = cloud.sent.length;
      await unlinkAs(f, flowStore, 902, 'second', async () => {
        const sent = await runNode(f, 'sync-pending-http', prebuilt, flowStore);
        const out = Array.isArray(sent.result) ? sent.result.find(Boolean) : sent.result;
        assert.equal(out.statusCode, 0, 'the http node reports a transport refusal');
        assert.equal(out.error && out.error.code, 'account_restart_pending');
        await assert.rejects(f.osiCloudHttp.requestJsonIpv4({ method: 'POST', url: cloud.url + '/api/v1/sync/edge/events', headers: { Authorization: 'Bearer token-first' }, payload: {} }), { code: 'account_restart_pending' });
        await assert.rejects(f.osiCloudHttp.requestJsonIpv4({ method: 'GET', url: cloud.url + '/api/v2/journal/gateways/X/entries' }), { code: 'account_restart_pending' });
      });
      assert.deepEqual(cloud.sent.slice(before), [], 'nothing reached the cloud between the unlink and the restart');
    } finally {
      f.osiCloudHttp.useAccountWorkFsForTests(null);
      f.cleanup();
    }
  });

  test(`${profile}: a pending link or identity change also holds restricted sends; the link route itself still goes out`, async () => {
    const f = fixture(profile);
    f.osiCloudHttp.useAccountWorkFsForTests(f.io.fs);
    try {
      processStarted(true);
      const before = cloud.sent.length;
      f.io.files.set(RESTART_DIR + 'account_link-fixture.json', '{}');
      await assert.rejects(f.osiCloudHttp.requestJsonIpv4({ method: 'GET', url: cloud.url + '/api/v1/sync/gateways/X/pending-commands' }), { code: 'account_restart_pending' });
      await f.osiCloudHttp.requestJsonIpv4({ method: 'POST', url: cloud.url + '/auth/local-sync', payload: {} });
      f.io.files.delete(RESTART_DIR + 'account_link-fixture.json');
      f.io.files.set('/var/run/osi-identity-restart.json', '{}');
      await assert.rejects(f.osiCloudHttp.requestJsonIpv4({ method: 'GET', url: cloud.url + '/api/v1/sync/gateways/X/pending-commands' }), { code: 'account_restart_pending' });
      f.io.files.delete('/var/run/osi-identity-restart.json');
      await f.osiCloudHttp.requestJsonIpv4({ method: 'GET', url: cloud.url + '/api/v1/sync/gateways/X/pending-commands' });
      assert.deepEqual(cloud.sent.slice(before).map((r) => r.path), ['/auth/local-sync', '/api/v1/sync/gateways/X/pending-commands'], 'only the link request and the send after the restart went out');
    } finally {
      f.osiCloudHttp.useAccountWorkFsForTests(null);
      f.cleanup();
    }
  });
}

// Send-gate edges (#766): the window between the unlink commit and the
// restart request, a gate read error, and a gate that cannot be loaded.
function captureWarnings() {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore() { console.warn = original; } };
}

for (const profile of PROFILES) {
  test(`${profile}: between the unlink commit and the restart request, the account journal alone holds restricted sends`, async () => {
    const f = fixture(profile);
    f.osiCloudHttp.useAccountWorkFsForTests(f.io.fs);
    try {
      processStarted(true);
      seedTwoLinkedUsers(f);
      const flowStore = linkedFlowStore();
      const { result } = await runNode(f, 'al-unlink-db', { _unlinkAuth: { userId: 902, username: 'second' } }, flowStore);
      assert.ok(result[0], 'the unlink committed');
      assert.ok(f.io.files.has(JOURNAL), 'the account journal is in place');
      assert.ok(![...f.io.files.keys()].some((file) => file.startsWith(RESTART_DIR)), 'no restart request is published yet');
      const before = cloud.sent.length;
      await assert.rejects(f.osiCloudHttp.requestJsonIpv4({ method: 'GET', url: cloud.url + '/api/v1/sync/gateways/X/pending-commands', headers: { Authorization: 'Bearer token-first' } }), { code: 'account_restart_pending' });
      assert.deepEqual(cloud.sent.slice(before), []);
    } finally {
      f.osiCloudHttp.useAccountWorkFsForTests(null);
      f.cleanup();
    }
  });

  test(`${profile}: the send gate fails closed and warns when it cannot read the account state`, async () => {
    const f = fixture(profile);
    const failingFs = Object.assign({}, f.io.fs, {
      readdirSync() { throw Object.assign(new Error('fixture read failure'), { code: 'EIO' }); },
    });
    f.osiCloudHttp.useAccountWorkFsForTests(failingFs);
    const warnings = captureWarnings();
    try {
      processStarted(true);
      const before = cloud.sent.length;
      await assert.rejects(f.osiCloudHttp.requestJsonIpv4({ method: 'GET', url: cloud.url + '/api/v1/sync/gateways/X/pending-commands' }), { code: 'account_restart_pending' });
      assert.deepEqual(cloud.sent.slice(before), []);
      assert.equal(warnings.lines.filter((line) => /osi-cloud-http: .*unreadable/.test(line)).length, 1, 'one warning names the unreadable state: ' + JSON.stringify(warnings.lines));
    } finally {
      warnings.restore();
      f.osiCloudHttp.useAccountWorkFsForTests(null);
      f.cleanup();
    }
  });

  test(`${profile}: a send gate that cannot be loaded or run refuses with account_gate_unavailable and warns`, async () => {
    const f = fixture(profile);
    const warnings = captureWarnings();
    try {
      processStarted(true);
      const before = cloud.sent.length;
      for (const [label, loader] of [
        ['helper missing', () => { throw new Error('fixture: cannot find module'); }],
        ['gate not exported', () => ({})],
        ['gate throws', () => ({ gatewayWorkBlocked() { throw new Error('fixture: gate failed'); } })],
      ]) {
        f.osiCloudHttp.useAccountGateLoaderForTests(loader);
        await assert.rejects(f.osiCloudHttp.requestJsonIpv4({ method: 'GET', url: cloud.url + '/api/v1/sync/gateways/X/pending-commands' }), { code: 'account_gate_unavailable' }, label);
      }
      assert.deepEqual(cloud.sent.slice(before), [], 'nothing reached the cloud');
      assert.equal(warnings.lines.filter((line) => /^osi-cloud-http: account-work gate (could not be loaded|failed)/.test(line)).length, 3, JSON.stringify(warnings.lines));
      // The link route never consults the gate.
      await f.osiCloudHttp.requestJsonIpv4({ method: 'POST', url: cloud.url + '/auth/local-sync', payload: {} });
      assert.deepEqual(cloud.sent.slice(before).map((r) => r.path), ['/auth/local-sync']);
    } finally {
      f.osiCloudHttp.useAccountGateLoaderForTests(null);
      warnings.restore();
      f.cleanup();
    }
  });
}

module.exports = { fixture, seedTwoLinkedUsers, runNode, restRequests, unlinkAs, linkedFlowStore, sql, REST_BUILDERS, GATEWAY_EUI, cloud, processStarted };
