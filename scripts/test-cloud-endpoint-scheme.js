'use strict';
// Cloud endpoint scheme policy: a cloud address uses TLS (https:, wss:,
// mqtts:) unless its host is loopback (127.0.0.0/8, ::1 or localhost).
//
// Covers the shared rule in osi-cloud-http, the cloud REST client, the
// account-link path (shipped link nodes of both profiles), the zone
// environment summary (on the X3 fixture) and the once-per-start warning.
// The network is a loopback HTTP server or a recording stand-in: a request
// that would leave the gateway for a host outside loopback over http or ws
// reaches the stand-in and fails the test. Nothing here opens a connection
// to another host.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const urlLib = require('node:url');
const vm = require('node:vm');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { execute, LEGACY } = require('./lib/x3-zone-env-harness');
const { adaptNode } = require('./x3-zone-env-adapters');

const root = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY_EUI = '0016C001F1000001';
const TOKEN_SECRET = 'scheme-policy-fixture-secret';
const SYNC_PATH = '/api/v1/sync/edge/events';

function profileDir(profile) {
  return path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
}
const cloudHttpFile = (profile) => path.join(profileDir(profile), 'node-red/osi-cloud-http/index.js');

// Stands in for the network: records every request and answers `reply`
// (status and body) or 200 {}. A refused request must never reach it.
function stubTransport(t, reply) {
  const calls = [];
  const restore = [];
  for (const [name, mod] of [['http', http], ['https', https]]) {
    const original = mod.request;
    mod.request = (options, callback) => {
      calls.push({ transport: name, protocol: options.protocol, hostname: options.hostname, path: options.path, method: options.method });
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = () => true;
      req.destroy = (error) => req.emit('error', error);
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = reply ? reply.status : 200;
        res.headers = { 'content-type': 'application/json' };
        res.complete = true;
        callback(res);
        res.emit('data', JSON.stringify(reply ? reply.body : {}));
        res.emit('end');
      };
      return req;
    };
    restore.push(() => { mod.request = original; });
  }
  t.after(() => restore.forEach((undo) => undo()));
  return calls;
}

// The first refusal in a process writes one console.warn line. The tests
// below trigger it more than once, so they keep it out of the test output;
// the warning itself is checked in a child process.
function silenceConsoleWarn(t) {
  const original = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = original; });
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(server.address().port); });
  });
}
function close(server) {
  if (server.closeAllConnections) server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function processStarted(linked) {
  // node-red.init exports the UCI MQTT password to the Node-RED process; it
  // is empty in a process that started unlinked (#766).
  process.env.DEVICE_MQTT_PASSWORD = linked ? 'fixture-mqtt' : '';
}

const previousPassword = process.env.DEVICE_MQTT_PASSWORD;
test.after(() => {
  if (previousPassword === undefined) delete process.env.DEVICE_MQTT_PASSWORD; else process.env.DEVICE_MQTT_PASSWORD = previousPassword;
});

// ---------------------------------------------------------------------------
// The shared rule
// ---------------------------------------------------------------------------

for (const profile of PROFILES) {
  const cloudHttp = require(cloudHttpFile(profile));

  test(`${profile}: loopback is 127.0.0.0/8, ::1 and localhost`, () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      assert.equal(cloudHttp.isLoopbackHostname(host), true, 'loopback: ' + host);
    }
    for (const host of ['128.0.0.1', '126.255.255.255', '0.0.0.0', '127.0.0.256', '1270.0.0.1', '127.0.0.1.example.test',
      'localhost.example.test', 'localhost.', '::2', '::ffff:127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
      '169.254.1.1', '192.0.2.1', 'example.test', '', undefined, null]) {
      assert.equal(cloudHttp.isLoopbackHostname(host), false, 'not loopback: ' + String(host));
    }
  });

  test(`${profile}: the rule allows TLS anywhere and anything else only on loopback`, () => {
    for (const [protocol, hostname] of [['http:', 'cloud.example.test'], ['http:', '10.0.0.1'], ['http:', '192.168.1.1'],
      ['ws:', 'broker.example.test'], ['mqtt:', 'broker.example.net'], ['ftp:', 'cloud.example.test'], ['', 'cloud.example.test'],
      ['http:', '127.0.0.1.example.test']]) {
      const refusal = cloudHttp.cloudEndpointRefusal(protocol, hostname, { quiet: true });
      assert.equal(refusal && refusal.code, 'cloud_endpoint_scheme', 'refused: ' + protocol + ' ' + hostname);
    }
    for (const [protocol, hostname] of [['https:', 'cloud.example.test'], ['HTTPS:', 'cloud.example.test'],
      ['wss:', 'broker.example.test'], ['mqtts:', 'broker.example.net'], ['http:', '127.0.0.1'], ['http:', '127.8.8.8'],
      ['http:', 'localhost'], ['ws:', '[::1]'], ['mqtt:', '::1']]) {
      assert.equal(cloudHttp.cloudEndpointRefusal(protocol, hostname, { quiet: true }), null, 'allowed: ' + protocol + ' ' + hostname);
    }
  });

  test(`${profile}: cloud REST refuses http to a host outside loopback before any request is sent`, async (t) => {
    silenceConsoleWarn(t);
    const calls = stubTransport(t);
    processStarted(true);
    for (const address of ['http://cloud.example.test', 'http://192.0.2.10', 'http://10.0.0.1', 'http://127.0.0.1.example.test']) {
      for (const route of [SYNC_PATH, '/osi' + SYNC_PATH, '/auth/local-sync']) {
        await assert.rejects(cloudHttp.requestJsonIpv4({ method: 'POST', url: address + route, payload: {} }), { code: 'cloud_endpoint_scheme' }, address + route);
      }
    }
    assert.deepEqual(calls, [], 'no request reached the network');
  });

  test(`${profile}: https passes the rule`, async (t) => {
    const calls = stubTransport(t);
    processStarted(true);
    const result = await cloudHttp.requestJsonIpv4({ method: 'POST', url: 'https://cloud.example.test' + SYNC_PATH, payload: { a: 1 } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, {});
    assert.deepEqual(calls, [{ transport: 'https', protocol: 'https:', hostname: 'cloud.example.test', path: SYNC_PATH, method: 'POST' }]);
  });

  test(`${profile}: http passes the rule on loopback`, async (t) => {
    processStarted(true);
    const seen = [];
    const ports = {};
    const answer = (req, res) => {
      seen.push(req.headers.host + ' ' + req.url);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ echo: req.url }));
    };
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost']) {
      const server = http.createServer(answer);
      let port;
      try {
        port = await listen(server, host === 'localhost' ? '127.0.0.1' : host);
      } catch (error) {
        // Hosts that do not offer this address of the 127/8 block are not an
        // error of the rule; the shared-rule test covers the address.
        assert.equal(error.code, 'EADDRNOTAVAIL', String(error));
        continue;
      }
      ports[host] = port;
      t.after(() => close(server));
      const result = await cloudHttp.requestJsonIpv4({ method: 'POST', url: `http://${host}:${port}` + SYNC_PATH, payload: {} });
      assert.equal(result.statusCode, 200, host);
      assert.deepEqual(result.payload, { echo: SYNC_PATH }, host);
    }
    assert.deepEqual(seen, ['127.0.0.1:' + ports['127.0.0.1'] + ' ' + SYNC_PATH, '127.0.0.2:' + ports['127.0.0.2'] + ' ' + SYNC_PATH, 'localhost:' + ports.localhost + ' ' + SYNC_PATH]);
    // ::1 passes the rule too. The client asks IPv4 only, so the request is
    // shown on the stand-in instead of a listener.
    const calls = stubTransport(t);
    await cloudHttp.requestJsonIpv4({ method: 'POST', url: 'http://[::1]:1883/auth/local-sync', payload: {} });
    assert.deepEqual(calls.map((call) => call.hostname), ['[::1]']);
  });
}

test('the refusal is logged once per process, across copies of the module, and names the fix', () => {
  // A child process stands for one Node-RED start. It loads the module twice,
  // as an image does (one copy per profile here), and is refused four times.
  const script = `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    const copies = process.argv.slice(1).map((file) => require(file));
    assert.notEqual(copies[0], copies[1]);
    process.env.DEVICE_MQTT_PASSWORD = 'fixture-mqtt';
    for (const name of ['http', 'https']) require('node:' + name).request = (options, callback) => {
      const req = new EventEmitter();
      req.setTimeout = () => {}; req.write = () => true;
      req.end = () => process.nextTick(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.complete = true;
        callback(res); res.emit('data', '{}'); res.emit('end');
      });
      return req;
    };
    const warnings = [];
    console.warn = (line) => warnings.push(String(line));
    (async () => {
      const outcomes = [];
      for (const copy of [copies[0], copies[1], copies[0], copies[1]]) {
        try {
          await copy.requestJsonIpv4({ method: 'POST', url: 'http://cloud.example.test${SYNC_PATH}', payload: {} });
          outcomes.push('sent');
        } catch (error) { outcomes.push(error.code); }
      }
      process.stdout.write(JSON.stringify({ outcomes, warnings }));
    })().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });
  `;
  const child = spawnSync(process.execPath, ['-e', script, ...PROFILES.map(cloudHttpFile)], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const { outcomes, warnings } = JSON.parse(child.stdout);
  assert.deepEqual(outcomes, ['cloud_endpoint_scheme', 'cloud_endpoint_scheme', 'cloud_endpoint_scheme', 'cloud_endpoint_scheme']);
  assert.equal(warnings.length, 1, 'one line per process: ' + JSON.stringify(warnings));
  assert.match(warnings[0], /^osi-cloud-http: /);
  assert.match(warnings[0], /cloud\.example\.test/, 'the line names the refused host');
  assert.match(warnings[0], /relink the gateway with its https address/, 'the line names the fix');
});

// ---------------------------------------------------------------------------
// Zone environment summary: the one cloud call that does not go through
// osi-cloud-http's client
// ---------------------------------------------------------------------------

const legacyZoneEnv = LEGACY.find((node) => node.id === 'zone-env-fn');

// Runs the shipped summary on the X3 fixture with the linked cloud address
// set to serverUrl; returns the URLs that reached the recorded transport.
async function zoneEnvironmentRequests(profile, serverUrl) {
  const run = await execute(profile, adaptNode(legacyZoneEnv), { linked: true }, async (source, msg, deps) => {
    const db = new deps.osiDb.Database('/data/db/farming.db');
    await new Promise((resolve, reject) => db.run("UPDATE users SET server_url='" + serverUrl + "'", [], (error) => (error ? reject(error) : resolve())));
    await new Promise((resolve) => db.close(resolve));
    return new Function('msg', ...Object.keys(deps), source.func)(msg, ...Object.values(deps));
  });
  return { urls: run.trace.filter((item) => item.kind === 'http').map((item) => item.url), msg: run.msg, thrown: run.thrown };
}

for (const profile of PROFILES) {
  test(`${profile}: zone environment summary does not fetch the cloud bundle over http outside loopback`, async (t) => {
    silenceConsoleWarn(t);
    const refused = await zoneEnvironmentRequests(profile, 'http://cloud.example.test');
    assert.equal(refused.thrown, undefined, JSON.stringify(refused.thrown));
    assert.deepEqual(refused.urls.filter((url) => url.startsWith('http://cloud.example.test')), [], 'the cloud address reached the transport');
    assert.equal(refused.msg.statusCode, 200);
    // The caller treats it like a cloud that cannot be reached.
    assert.match(JSON.stringify(refused.msg.payload), /Using local fallback because the OSI Server bundle is unavailable\./);
    // Controls: TLS, and http on loopback, still fetch the bundle.
    for (const serverUrl of ['https://cloud.example.test', 'http://127.0.0.1:1883']) {
      const allowed = await zoneEnvironmentRequests(profile, serverUrl);
      assert.ok(allowed.urls.some((url) => url.startsWith(serverUrl + '/api/v1/sync/gateways/')), serverUrl + ': the bundle is fetched');
      assert.equal(allowed.msg.statusCode, 200);
    }
  });
}

// ---------------------------------------------------------------------------
// Account link: the shipped link nodes of each profile
// ---------------------------------------------------------------------------

// The gateway fixture mirrors scripts/test-unlink-stops-cloud-reporting.js:
// a copy of the bundled seed database, the shipped modules, and the account
// files and UCI in memory.

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

function gatewayIo() {
  const files = new Map();
  const config = new Map();
  const descriptors = new Map();
  let nextFd = 1;
  const memory = (p) => typeof p === 'string' && (p.startsWith('/data/db/osi-account-link-config.json') || p.startsWith('/var/run/osi-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-endpoint-scheme-'));
  const dbPath = path.join(tmp, 'farming.db');
  fs.copyFileSync(path.join(profileDir(profile), 'db/farming.db'), dbPath);
  const nodeRed = path.join(profileDir(profile), 'node-red');
  const osiDb = freshRequire(path.join(nodeRed, 'osi-db-helper/index.js'), { sqlite3: sqlite3Adapter(dbPath) });
  const previousBase = process.env.OSI_LIB_BASE;
  process.env.OSI_LIB_BASE = nodeRed;
  const osiLib = freshRequire(path.join(nodeRed, 'osi-lib/index.js'));
  if (previousBase === undefined) delete process.env.OSI_LIB_BASE; else process.env.OSI_LIB_BASE = previousBase;
  const osiCloudHttp = freshRequire(path.join(nodeRed, 'osi-cloud-http/index.js'));
  const io = gatewayIo();
  const native = new DatabaseSync(dbPath);
  const installationUuid = '123e4567-e89b-42d3-a456-426614174000';
  native.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at) VALUES(1,?,?,'now','now')").run(installationUuid, GATEWAY_EUI);
  native.prepare("INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode) VALUES(901,'first','hash-1','2026-01-01T00:00:00Z','u-first','admin','local')").run();
  native.close();
  const flows = JSON.parse(fs.readFileSync(path.join(profileDir(profile), 'flows.json'), 'utf8'));
  return {
    profile, tmp, dbPath, osiDb, osiLib, osiCloudHttp, io, installationUuid, flows,
    env: { DEVICE_EUI: GATEWAY_EUI, DEVICE_EUI_SOURCE: 'concentrator', DEVICE_EUI_CONFIDENCE: 'authoritative', LINK_GATEWAY_DEVICE_EUI: GATEWAY_EUI },
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

function findNode(flows, id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error('missing node ' + id);
  return node;
}

function sql(f, text, ...params) {
  const db = new DatabaseSync(f.dbPath);
  try {
    return /^\s*select/i.test(text) ? db.prepare(text).all(...params) : db.prepare(text).run(...params);
  } finally { db.close(); }
}

async function runNode(f, id, msg, flowStore, envOverride) {
  const node = findNode(f.flows, id);
  const scope = { osiDb: f.osiDb, osiLib: f.osiLib, osiCloudHttp: f.osiCloudHttp, crypto, net, urlLib };
  const bound = Object.fromEntries((node.libs || []).map((lib) => [lib.var, scope[lib.var]]));
  const fn = new vm.Script('(async function(msg,node,flow,env,context,global,get,set){' + node.func + '\n})')
    .runInNewContext(Object.assign({ Buffer, console, setTimeout, clearTimeout, URL, Date, Math, JSON, Promise }, bound));
  const env = Object.assign({}, f.env, { AUTH_TOKEN_SECRET: TOKEN_SECRET }, envOverride || {});
  const warnings = [];
  const api = {
    flow: { get: (k) => flowStore.get(k), set: (k, v) => (v === undefined ? flowStore.delete(k) : flowStore.set(k, v)) },
    env: { get: (k) => env[k] },
    store: { get() { return undefined; }, set() {} },
    global: { get: (k) => (k === 'fs' ? f.io.fs : k === 'cp' ? f.io.cp : undefined), set() {} },
    node: { warn: (text) => warnings.push(String(text)), error: (text) => warnings.push(String(text)), log() {}, status() {}, send() {}, done() {} },
  };
  const result = await fn(msg, api.node, api.flow, api.env, api.store, api.global, () => undefined, () => {});
  return { result, warnings };
}

// What the cloud answers to the link request.
function linkReply(f, mqttBrokerUrl) {
  return {
    status: 200,
    body: {
      username: 'first@cloud', userId: 11, token: 'token-first', offlineVerifier: 'verifier-first',
      offlineVerifierVersion: 2, syncTokenExpiresAt: 1900000000000, mqttPassword: 'mqtt-first',
      mqttBrokerUrl, installationUuid: f.installationUuid, capabilities: [],
    },
  };
}

// A local session token for the first local account.
function bearer() {
  const payload = Buffer.from(JSON.stringify({ userId: 901, username: 'first', exp: Date.now() + 3600000 })).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
}

// Follows the success port of the shipped link chain from its first node, as
// Node-RED would, and reports where it stopped. The link keeps its state on
// the message (msg._alState), so beforeNode can change it before a node runs.
const LINK_CHAIN_END = 'al-link-restart-node-red';
async function linkChain(f, serverUrl, envOverride, beforeNode) {
  const flowStore = new Map();
  let id = 'al-link-validate';
  let msg = {
    req: { headers: { authorization: bearer() } },
    payload: { serverUrl, action: 'login', username: 'first@cloud', password: 'fixture-password' },
  };
  const path = [];
  for (let hops = 0; hops < 12; hops += 1) {
    path.push(id);
    if (beforeNode) beforeNode(id, msg);
    const { result, warnings } = await runNode(f, id, msg, flowStore, envOverride);
    const outputs = Array.isArray(result) ? result : [result];
    if (!outputs[0]) return { path, stoppedAt: id, failure: outputs.find(Boolean), warnings, flowStore };
    msg = outputs[0];
    if (id === LINK_CHAIN_END) return { path, stoppedAt: null, msg, warnings, flowStore };
    id = findNode(f.flows, id).wires[0].find((next) => findNode(f.flows, next).type === 'function');
  }
  throw new Error('the link chain did not end at ' + LINK_CHAIN_END + ': ' + path.join(' > '));
}

function assertNothingStored(f) {
  assert.equal(sql(f, 'SELECT count(*) AS n FROM users WHERE server_url IS NOT NULL')[0].n, 0, 'no account keeps a cloud address');
  assert.equal(f.io.config.size, 0, 'no MQTT configuration was written to UCI: ' + JSON.stringify([...f.io.config]));
  assert.equal(f.io.files.size, 0, 'no account journal or restart request was written');
}

// The loopback cloud: answers what `cloud.respond` says, else 503.
const cloud = { respond: null };
let cloudServer;
test.before(async () => {
  cloudServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const answer = cloud.respond && cloud.respond(req.url);
      res.writeHead(answer ? answer.status : 503, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(answer ? answer.body : { message: 'fixture cloud' }));
    });
  });
  await listen(cloudServer, '127.0.0.1');
});
test.after(() => close(cloudServer));
const loopbackCloud = () => 'http://127.0.0.1:' + cloudServer.address().port;

for (const profile of PROFILES) {
  test(`${profile}: with the private-target flag on, a link to an http address outside loopback stops at the cloud request`, async (t) => {
    silenceConsoleWarn(t);
    const f = fixture(profile);
    try {
      processStarted(false);
      const calls = stubTransport(t, linkReply(f, 'wss://cloud.example.org/mqtt'));
      const outcome = await linkChain(f, 'http://cloud.example.test', { ALLOW_PRIVATE_SERVER_URLS: '1' });
      // The link form still admits the address; the cloud request refuses it.
      assert.deepEqual(outcome.path, ['al-link-validate', 'al-link-build-req', 'al-link-server-auth', 'al-link-handle-auth'], 'the link stops at its cloud request');
      assert.equal(outcome.failure._alState.al_server_url, 'http://cloud.example.test', 'the link form admitted the address');
      assert.equal(outcome.failure.statusCode, 502);
      assert.equal(outcome.failure.payload.code, 'cloud_endpoint_scheme');
      assert.match(outcome.failure.payload.message, /relink the gateway with its https address/, outcome.failure.payload.message);
      assert.deepEqual(calls, [], 'no request left the gateway');
      assertNothingStored(f);
    } finally { f.cleanup(); }
  });

  test(`${profile}: without the flag the link form refuses http before any request`, async (t) => {
    const f = fixture(profile);
    try {
      processStarted(false);
      const calls = stubTransport(t);
      const outcome = await linkChain(f, 'http://cloud.example.test', {});
      assert.deepEqual(outcome.path, ['al-link-validate']);
      assert.equal(outcome.failure.statusCode, 400);
      assert.equal(outcome.failure.payload.message, 'serverUrl must use https');
      assert.deepEqual(calls, []);
      assertNothingStored(f);
    } finally { f.cleanup(); }
  });

  test(`${profile}: a link over http to a loopback cloud still completes with the flag on`, async () => {
    const f = fixture(profile);
    try {
      processStarted(false);
      cloud.respond = () => linkReply(f, 'wss://cloud.example.org/mqtt');
      const outcome = await linkChain(f, loopbackCloud(), { ALLOW_PRIVATE_SERVER_URLS: '1' });
      assert.equal(outcome.stoppedAt, null, 'the link reached its restart request: ' + outcome.path.join(' > ') + ' ' + JSON.stringify(outcome.failure && outcome.failure.payload) + outcome.warnings.join('; '));
      assert.equal(f.io.config.get('osi-server.cloud.server_host'), 'cloud.example.org');
      assert.equal(f.io.config.get('osi-server.cloud.mqtt_broker_url'), 'wss://cloud.example.org/mqtt');
      assert.equal(sql(f, 'SELECT server_url FROM users WHERE id = 901')[0].server_url, loopbackCloud());
    } finally { cloud.respond = null; f.cleanup(); }
  });

  for (const [scheme, label] of [['ws', 'ws://'], ['mqtt', 'mqtt://']]) {
    test(`${profile}: a ${scheme}:// broker address outside loopback in the cloud reply fails the link`, async (t) => {
      silenceConsoleWarn(t);
      const f = fixture(profile);
      try {
        processStarted(false);
        const calls = stubTransport(t, linkReply(f, `${label}broker.example.test:8081/mqtt`));
        // The cloud itself is reached over TLS; only its broker address is plain.
        const outcome = await linkChain(f, 'https://cloud.example.test', {});
        assert.deepEqual(outcome.path.slice(0, -1), ['al-link-validate', 'al-link-build-req', 'al-link-server-auth'], 'the cloud was asked over the stand-in');
        assert.equal(outcome.stoppedAt, 'al-link-handle-auth');
        assert.equal(outcome.failure.statusCode, 502);
        assert.equal(outcome.failure.payload.reason, 'cloud_endpoint_scheme');
        assert.match(outcome.failure.payload.message, /wss:\/\/ or mqtts:\/\//, outcome.failure.payload.message);
        assert.equal(calls.length, 1, 'only the link request was sent');
        assert.equal(outcome.failure._alState.al_mqtt_broker_url, undefined, 'the broker address is not kept');
        assertNothingStored(f);
      } finally { f.cleanup(); }
    });
  }

  test(`${profile}: the link finalizer refuses a broker address without TLS even when the earlier check was skipped`, async (t) => {
    silenceConsoleWarn(t);
    const f = fixture(profile);
    try {
      processStarted(false);
      cloud.respond = () => linkReply(f, 'wss://cloud.example.org/mqtt');
      const outcome = await linkChain(f, loopbackCloud(), { ALLOW_PRIVATE_SERVER_URLS: '1' }, (id, msg) => {
        if (id === 'al-link-finalize') msg._alState.al_mqtt_broker_url = 'mqtt://broker.example.net:1883';
      });
      assert.equal(outcome.stoppedAt, 'al-link-finalize', 'the link stops at its finalizer: ' + outcome.path.join(' > '));
      assert.equal(outcome.failure.statusCode, 502);
      assert.equal(outcome.failure.payload.reason, 'cloud_endpoint_scheme');
      assert.match(outcome.failure.payload.detail, /wss:\/\/ or mqtts:\/\//, outcome.failure.payload.detail);
      assertNothingStored(f);
    } finally { cloud.respond = null; f.cleanup(); }
  });

  test(`${profile}: wss, mqtts and loopback broker addresses in the cloud reply are stored as given`, async () => {
    for (const broker of ['wss://cloud.example.org/mqtt', 'mqtts://broker.example.net:8883', 'ws://127.0.0.1:8081/mqtt']) {
      const f = fixture(profile);
      try {
        processStarted(false);
        cloud.respond = () => linkReply(f, broker);
        const outcome = await linkChain(f, loopbackCloud(), { ALLOW_PRIVATE_SERVER_URLS: '1' });
        assert.equal(outcome.stoppedAt, null, broker + ': the link reached its restart request: ' + outcome.path.join(' > ') + ' ' + JSON.stringify(outcome.failure && outcome.failure.payload) + outcome.warnings.join('; '));
        assert.equal(f.io.config.get('osi-server.cloud.mqtt_broker_url'), broker);
        const rows = sql(f, 'SELECT count(*) AS n FROM users WHERE id = 901 AND server_url IS NOT NULL');
        assert.equal(rows[0].n, 1, broker + ': the account is linked');
      } finally { cloud.respond = null; f.cleanup(); }
    }
  });

  test(`${profile}: a stored http address outside loopback sends no sync request`, async (t) => {
    silenceConsoleWarn(t);
    const f = fixture(profile);
    try {
      // A gateway linked over such an address before this rule existed.
      sql(f, "INSERT INTO users(id,username,password_hash,created_at,user_uuid,role,auth_mode,server_username,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,cloud_user_id,server_offline_verifier,server_offline_verifier_version) VALUES(902,'second','hash-2','2026-01-01T00:00:00Z','u-second','admin','server','second@cloud','http://cloud.example.test','token-second',1900000000000,'2026-01-01T00:00:00Z',11,'verifier-2',2)");
      sql(f, "INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,'http://cloud.example.test','11',?,?,'now')", GATEWAY_EUI, f.installationUuid);
      processStarted(true);
      const calls = stubTransport(t);
      const flowStore = new Map([['account_linked', true], ['sync_state', {}]]);
      const builder = findNode(f.flows, 'sync-pending-build');
      const built = await runNode(f, builder.id, { payload: Date.now() }, flowStore);
      const request = Array.isArray(built.result) ? built.result.find(Boolean) : built.result;
      assert.match(request.url, /^http:\/\/cloud\.example\.test\/api\/v1\/sync\/gateways\//);
      const httpId = builder.wires.flat().find((wire) => /-http$/.test(wire));
      const sent = await runNode(f, httpId, request, flowStore);
      assert.equal(sent.result.statusCode, 0);
      assert.equal(sent.result.error.code, 'cloud_endpoint_scheme');
      assert.deepEqual(calls, [], 'no request reached the network');
    } finally { f.cleanup(); }
  });
}
