'use strict';
// Issue #766 slice A: an unlinked gateway stops reporting to the cloud at once.
//
// Runs the shipped unlink, link, cloud-guard and REST builder function nodes
// of both profiles against a copy of the bundled seed database. The cloud
// side is a recording stand-in for osi-cloud-http: a request counts as sent
// when the real module would have opened a connection for it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY_EUI = '0016C001F1000001';
const SERVER = 'https://cloud.example.org';
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
  const sent = [];
  // Stand-in for the module the http nodes load as `osiCloudHttp`.
  const osiCloudHttp = {
    async requestJsonIpv4(request) {
      sent.push({ method: request.method, url: request.url });
      return { statusCode: 503, headers: {}, payload: { message: 'fixture cloud' }, rawBody: '', diagnostics: {} };
    },
  };
  const io = gatewayIo();
  const native = new DatabaseSync(dbPath);
  const installationUuid = '123e4567-e89b-42d3-a456-426614174000';
  native.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at) VALUES(1,?,?,'now','now') ON CONFLICT(singleton_id) DO UPDATE SET installation_uuid=excluded.installation_uuid, current_gateway_device_eui=excluded.current_gateway_device_eui").run(installationUuid, GATEWAY_EUI);
  native.close();
  return {
    profile, tmp, dbPath, osiDb, osiLib, osiCloudHttp, sent, io, installationUuid,
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
  sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,auth_mode,server_username,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,cloud_user_id,server_offline_verifier,server_offline_verifier_version) VALUES(901,'first','hash-1','2026-01-01T00:00:00Z','u-first','server','first@cloud',?,'token-first',1900000000000,'2026-01-01T00:00:00Z',11,'verifier-1',2)", SERVER);
  sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,auth_mode,server_username,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,cloud_user_id,server_offline_verifier,server_offline_verifier_version) VALUES(902,'second','hash-2','2026-01-01T00:00:00Z','u-second','server','second@cloud',?,'token-second',1900000000000,'2026-02-01T00:00:00Z',11,'verifier-2',2)", SERVER);
  sql(f, "INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,?,'11',?,?,'now') ON CONFLICT(peer_node) DO UPDATE SET linked=1, server_url=excluded.server_url, cloud_user_id=excluded.cloud_user_id, gateway_device_eui=excluded.gateway_device_eui, installation_uuid=excluded.installation_uuid", SERVER, GATEWAY_EUI, f.installationUuid);
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
  const before = f.sent.length;
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
  return { emitted, sent: f.sent.slice(before) };
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

for (const profile of PROFILES) {
  test(`${profile}: baseline: a linked gateway sends REST sync requests`, async () => {
    const f = fixture(profile);
    try {
      seedTwoLinkedUsers(f);
      const { sent } = await restRequests(f, linkedFlowStore());
      assert.ok(sent.length > 0, 'positive control: the builders reach the cloud while linked');
      assert.ok(sent.every((r) => r.url.startsWith(SERVER)), JSON.stringify(sent));
    } finally { f.cleanup(); }
  });

  test(`${profile}: after one of two linked local users unlinks, no REST sync request leaves the gateway`, async () => {
    const f = fixture(profile);
    try {
      seedTwoLinkedUsers(f);
      const flowStore = linkedFlowStore();
      await unlinkAs(f, flowStore, 902, 'second');
      const live = await restRequests(f, flowStore);
      // A Node-RED restart starts with empty flow context.
      const restarted = await restRequests(f, new Map());
      assert.deepEqual({ live: live.sent, restarted: restarted.sent }, { live: [], restarted: [] },
        'builders that still emit: ' + JSON.stringify({ live: live.emitted, restarted: restarted.emitted }));
      const rows = sql(f, "SELECT id, auth_mode, server_url, server_sync_token, cloud_user_id FROM users WHERE id IN (901,902) ORDER BY id");
      for (const row of rows) {
        assert.equal(row.server_url, null, 'user ' + row.id + ' keeps no cloud address');
        assert.equal(row.server_sync_token, null, 'user ' + row.id + ' keeps no sync token');
      }
    } finally { f.cleanup(); }
  });
}

module.exports = { fixture, seedTwoLinkedUsers, runNode, restRequests, unlinkAs, linkedFlowStore, sql, REST_BUILDERS, SERVER, GATEWAY_EUI };
