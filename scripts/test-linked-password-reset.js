#!/usr/bin/env node
'use strict';

// #521: the local admin password reset refuses linked (auth_mode='server')
// accounts with a stable 409 and keeps working for local accounts.
//
// Runs the shipped flow functions of both maintained profiles. Requests go
// over loopback HTTP into a dispatcher that follows each `http in` node's
// wires to its `http response` node; that last node is emulated (status from
// the node or msg.statusCode, node headers, JSON body). This is not
// Node-RED's own HTTP node code, and Node-RED catch events are not
// dispatched: a node.error() is recorded and asserted absent instead. The
// account router uses the real osi-db-helper, whose sqlite3 binding is
// replaced by a node:sqlite driver with fault hooks, so transaction,
// rollback and changes() behaviour come from the shipped facade. Login uses
// the real auth chain. State comparisons are logical rows (every user table
// plus sqlite_sequence), not database file bytes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, profilePaths } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY = '0016C001F1000001';
const SENSOR = 'A840410000000001';
const SECRET = crypto.randomBytes(32).toString('hex');
const REQUEST_TIMEOUT_MS = 15000;
const TEST = { timeout: 60000 };
const LINKED = {
  code: 'linked_account_password_reset_unsupported',
  message: 'This account uses linked sign-in. Its password cannot be reset on this gateway. ' +
    'Ask the linked-identity administrator for the approved recovery process.',
};
const RESET_FAILED = { message: 'The password reset could not be completed. Reload the user list before trying again.' };
const UNKNOWN_MODE = { message: 'The account sign-in type is not recognized. The password was not changed.' };
const NEW_PASSWORD = 'new-reset-pass-521';
const PREFLIGHT_SQL = /^SELECT auth_mode FROM users WHERE user_uuid=\? LIMIT 1$/;
const RESET_UPDATE = /^UPDATE users SET password_hash=\?,updated_at=\?,sync_version=sync_version\+1 WHERE user_uuid=\?/;
const CHANGES_SQL = /^SELECT changes\(\) AS n$/;
const ROLLBACK_SQL = /^ROLLBACK/;

function bind(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// sqlite3 stand-in for osi-db-helper. Hooks: { method, match, before(native),
// after(native), error, applyFirst, rows }; each fires once and is recorded.
// An exec hook with `error` and no `applyFirst` refuses the statement before
// it runs, so a refused ROLLBACK leaves the transaction open.
function makeDriver(dbPath, control) {
  function take(method, sql) {
    const hook = control.hooks.find((h) => !h.fired && h.method === method && h.match.test(String(sql).trim()));
    if (hook) {
      hook.fired = true;
      control.fired.push(hook.name || String(hook.match));
    }
    return hook;
  }
  return class Driver {
    constructor(_file, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(dbPath, { readOnly: mode === 1 });
      control.handles.push(this.native);
      setImmediate(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      setImmediate(() => {
        control.log.push(['all', String(sql).trim()]);
        const hook = take('all', sql);
        try {
          if (hook && hook.before) hook.before(this.native);
          if (hook && hook.error) return callback.call(this, hook.error);
          const rows = hook && Object.prototype.hasOwnProperty.call(hook, 'rows')
            ? hook.rows
            : this.native.prepare(sql).all(...(params || []).map(bind));
          if (hook && hook.after) hook.after(this.native);
          return callback.call(this, null, rows);
        } catch (error) {
          return callback.call(this, error);
        }
      });
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      setImmediate(() => {
        control.log.push(['run', String(sql).trim()]);
        const hook = take('run', sql);
        try {
          if (hook && hook.before) hook.before(this.native);
          if (hook && hook.error) return callback.call(this, hook.error);
          const out = this.native.prepare(sql).run(...(params || []).map(bind));
          return callback.call({ changes: Number(out.changes), lastID: Number(out.lastInsertRowid) }, null);
        } catch (error) {
          return callback.call(this, error);
        }
      });
    }
    exec(sql, callback) {
      setImmediate(() => {
        control.log.push(['exec', String(sql).trim()]);
        const hook = take('exec', sql);
        try {
          if (hook && hook.error && !hook.applyFirst) return callback.call(this, hook.error);
          this.native.exec(sql);
          return callback.call(this, hook && hook.error ? hook.error : null);
        } catch (error) {
          return callback.call(this, error);
        }
      });
    }
    close(callback) {
      // osi-db-helper's facade close() never reaches the shared handle.
      control.log.push(['close']);
      setImmediate(() => callback && callback.call(this, null));
    }
  };
}

function loadHelper(nodeRedModules, Driver) {
  const helperPath = path.join(nodeRedModules, 'osi-db-helper', 'index.js');
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) {
      return { Database: Driver, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
  } finally {
    Module._load = original;
    delete require.cache[require.resolve(helperPath)];
  }
}

function bcryptSpy(real, control) {
  return {
    ...real,
    hashSync(value, rounds) {
      control.log.push(['bcrypt', rounds]);
      if (control.bcryptError) throw control.bcryptError;
      return real.hashSync(value, 4);
    },
  };
}

// Logical rows of every user table and of sqlite_sequence.
function allTables(db) {
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name"
  ).all().map((row) => row.name);
  return Object.fromEntries(names.map((name) => [
    name,
    JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      (_k, v) => (typeof v === 'bigint' ? String(v) : v))),
  ]));
}

async function fixture(profile, options = {}) {
  const { flowsPath, nodeRedModules } = profilePaths(profile);
  const flows = options.flows || JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const byId = new Map(flows.map((node) => [node.id, node]));
  const realBcrypt = require(path.join(nodeRedModules, 'node_modules/bcryptjs'));
  const installation = require(path.join(nodeRedModules, 'osi-installation-helper'));
  const scope = require(path.join(nodeRedModules, 'osi-scope-helper'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-521-'));
  const dbPath = path.join(dir, 'farming.db');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  db.prepare('UPDATE scoped_access_emit SET enabled=? WHERE id=1').run(options.emit ? 1 : 0);
  const installationUuid = crypto.randomUUID();
  db.prepare('INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at) VALUES(1,?,?,?,?)')
    .run(installationUuid, GATEWAY, '2026-01-01', '2026-01-01');
  const hasGeneration = db.prepare("SELECT 1 AS found FROM pragma_table_info('users') WHERE name='local_auth_generation'").get() !== undefined;
  const control = { hooks: [], fired: [], log: [], handles: [], bcryptError: null, warnings: [], errors: [], privateRollbacks: 0 };
  const helper = loadHelper(nodeRedModules, makeDriver(dbPath, control));
  const bcrypt = bcryptSpy(realBcrypt, control);
  // The real scope helper; only invalidateScope is observed, every
  // authorization decision stays the shipped code.
  const scopeObserved = {
    ...scope,
    invalidateScope(userUuid) {
      control.log.push(['invalidateScope', userUuid === undefined ? null : userUuid]);
      return scope.invalidateScope(userUuid);
    },
  };
  const passwords = {};

  function insertUser(name, fields) {
    const row = {
      username: name, password_hash: realBcrypt.hashSync(`${name}-local-pass`, 4), created_at: '2026-01-01',
      user_uuid: crypto.randomUUID(), role: 'researcher', auth_mode: 'local', sync_version: 1, ...fields,
    };
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO users(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...columns.map((c) => row[c]));
    return db.prepare('SELECT * FROM users WHERE username=?').get(name);
  }
  function local(name, role = 'researcher', extra = {}) {
    passwords[name] = `${name}-local-pass`;
    return insertUser(name, { role, ...extra });
  }
  // kind: v2 (installation-bound), v1 (gateway-bound), hash (no verifier),
  // fallback (verifier subject cannot be derived at login; server hash used).
  function linked(name, kind) {
    const password = `${name}-linked-pass`;
    passwords[name] = password;
    const version = kind === 'v2' ? 2 : 1;
    let verifier = null;
    let serverHash = null;
    if (kind === 'v2' || kind === 'v1') {
      verifier = realBcrypt.hashSync(installation.verifierSubject(password, version, installationUuid, GATEWAY), 4);
    } else if (kind === 'hash') {
      serverHash = realBcrypt.hashSync(password, 4);
    } else if (kind === 'fallback') {
      verifier = realBcrypt.hashSync('not-derivable-subject', 4);
      serverHash = realBcrypt.hashSync(password, 4);
    }
    return insertUser(name, {
      password_hash: realBcrypt.hashSync('stale-local-hash', 4), auth_mode: 'server',
      server_username: `${name}-cloud`, server_password_hash: serverHash, server_offline_verifier: verifier,
      server_offline_verifier_version: kind === 'hash' ? 0 : version, cloud_user_id: 101,
      server_url: 'https://cloud.example.invalid',
      server_sync_token: kind === 'fallback' ? null : `synthetic-sync-token-${crypto.randomUUID()}`,
      server_sync_token_expires_at: 9999999999999, server_linked_at: '2026-01-01',
      last_auth_sync_at: '2026-01-01', last_auth_sync_status: 'up_to_date',
    });
  }

  function env(scoped, extra = {}) {
    return {
      AUTH_TOKEN_SECRET: SECRET, DEVICE_EUI: GATEWAY, LINK_GATEWAY_DEVICE_EUI: GATEWAY,
      OSI_SCOPED_ACCESS: scoped ? '1' : '0', ...extra,
    };
  }

  async function runNode(node, msg, envValues) {
    scope._resetForTests();
    const out = await executeFunction(node, {
      msg, env: envValues, db, nodeRedModules,
      osiLibModules: { installation, scope: scopeObserved },
      libOverrides: { osiDb: helper, bcrypt },
    });
    control.warnings.push(...out.warnings);
    control.errors.push(...out.errors);
    return out.result;
  }

  // Composition with #520 only: when the seed carries local_auth_generation,
  // emulate #520's admission seam by attaching the admitted actor, read when
  // the request arrives, as msg.req.osiLocalAdmission. Without the column
  // nothing is attached and nothing else changes.
  function admissionFor(req) {
    if (!hasGeneration) return undefined;
    try {
      const auth = scope.verifyBearer(req.headers.authorization, { configuredSecret: SECRET, fs, warn: () => {} });
      const row = db.prepare('SELECT id,username,user_uuid,local_auth_generation,role FROM users WHERE id=? AND username=?')
        .get(auth.userId, auth.username);
      if (!row) return undefined;
      return Object.freeze({ userId: row.id, username: row.username, userUuid: row.user_uuid, generation: row.local_auth_generation, role: row.role });
    } catch (_) {
      return undefined;
    }
  }

  // Follows the wires from an http in node to its http response node.
  async function dispatch(entry, msg, envValues) {
    let id = entry.wires[0][0];
    let current = msg;
    for (let hop = 0; hop < 10; hop += 1) {
      const node = byId.get(id);
      assert.ok(node, `wired node ${id} exists`);
      if (node.type === 'http response') {
        const headers = { ...(current.headers || {}), ...(node.headers || {}) };
        const status = Number(node.statusCode) || Number(current.statusCode) || 200;
        return { status, headers, payload: current.payload };
      }
      assert.equal(node.type, 'function', `${id} is a function node`);
      const result = await runNode(node, current, envValues);
      let port = 0;
      if (Array.isArray(result)) {
        const active = result.map((value, index) => (value ? index : -1)).filter((index) => index >= 0);
        assert.equal(active.length, 1, `${id} answers on exactly one output`);
        port = active[0];
        current = result[port];
      } else {
        current = result;
      }
      assert.ok(current, `${id} produced a message`);
      assert.equal(node.wires[port].length, 1, `${id} output ${port} has one wire`);
      id = node.wires[port][0];
    }
    throw new Error('route exceeded the hop limit');
  }

  const routes = flows
    .filter((node) => node.type === 'http in' && /^\/(auth\/login|api\/users)/.test(node.url))
    .map((node) => ({
      node,
      method: String(node.method).toUpperCase(),
      names: [...node.url.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]),
      pattern: new RegExp('^' + node.url.replace(/:[A-Za-z_]\w*/g, '([^/]+)') + '$'),
    }));
  let envForServer = env(true);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!route) { res.writeHead(404); res.end(); return; }
        const match = url.pathname.match(route.pattern);
        const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : {};
        const msg = {
          _msgid: crypto.randomUUID(),
          req: { method: req.method, path: url.pathname, url: req.url, headers: req.headers, params, body, query: {} },
          payload: body,
        };
        const admission = admissionFor(msg.req);
        if (admission) msg.req.osiLocalAdmission = admission;
        const answer = await dispatch(route.node, msg, envForServer);
        res.writeHead(answer.status, answer.headers);
        res.end(JSON.stringify(answer.payload));
      } catch (error) {
        res.writeHead(599, { 'Content-Type': 'text/plain' });
        res.end('harness failure: ' + (error && error.stack ? error.stack : error));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, urlPath, { token, body, scoped = true, envExtra } = {}) {
    envForServer = env(scoped, envExtra);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + urlPath, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    assert.notEqual(response.status, 599, text);
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  }
  async function login(username, password, envExtra) {
    return request('POST', '/auth/login', { body: { username, password }, envExtra });
  }
  async function tokenFor(username) {
    const answer = await login(username, passwords[username]);
    assert.equal(answer.status, 200, `fixture login for ${username}`);
    return answer.body.token;
  }
  function reset(token, uuid, body = { password: NEW_PASSWORD }, opts = {}) {
    return request('POST', `/api/users/${encodeURIComponent(uuid)}/password-reset`, { token, body, ...opts });
  }
  function bcryptCalls() { return control.log.filter((entry) => entry[0] === 'bcrypt'); }
  function resetUpdates() { return control.log.filter((e) => e[0] === 'run' && RESET_UPDATE.test(e[1])).length; }
  function begins() { return control.log.filter((e) => e[0] === 'exec' && /^BEGIN/.test(e[1])).length; }
  function invalidations() { return control.log.filter((e) => e[0] === 'invalidateScope'); }
  function clearLog() {
    control.log.length = 0; control.fired.length = 0; control.warnings.length = 0; control.errors.length = 0;
  }
  function hook(spec) { control.hooks.push(spec); }
  function user(uuid) { return { ...db.prepare('SELECT * FROM users WHERE user_uuid=?').get(uuid) }; }
  // The facade's one shared connection (the driver opens no other handle).
  function sharedHandle() {
    assert.equal(control.handles.length, 1, 'the facade opened exactly one shared handle');
    assert.equal(typeof control.handles[0].isTransaction, 'boolean', 'node:sqlite exposes isTransaction (Node >= 22.16)');
    return control.handles[0];
  }
  // Ends a transaction a test left open on purpose; returns whether one was open.
  function rollbackPrivately() {
    const native = sharedHandle();
    if (!native.isTransaction) return false;
    native.exec('ROLLBACK');
    control.privateRollbacks += 1;
    return true;
  }
  async function cleanup() {
    await new Promise((resolve) => server.close(resolve));
    for (const handle of control.handles) {
      try {
        if (handle.isOpen !== false && handle.isTransaction) { handle.exec('ROLLBACK'); control.privateRollbacks += 1; }
        handle.close();
      } catch (_) { /* already closed */ }
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return {
    db, dbPath, helper, control, flows, byId, passwords, installationUuid, hasGeneration, local, linked, login,
    tokenFor, reset, request, dispatch, env, bcryptCalls, resetUpdates, begins, invalidations, clearLog, hook, user,
    sharedHandle, rollbackPrivately, cleanup, snapshot: () => allTables(db),
  };
}

// Admin fixtures: two enabled admins so actor changes never meet the
// last-enabled-admin guard, one local researcher, and the four linked kinds.
async function standard(profile, options) {
  const f = await fixture(profile, options);
  f.admin = f.local('admin1', 'admin');
  f.admin2 = f.local('admin2', 'admin');
  f.researcher = f.local('research1', 'researcher');
  f.linkedV2 = f.linked('linkedv2', 'v2');
  f.linkedV1 = f.linked('linkedv1', 'v1');
  f.linkedHash = f.linked('linkedhash', 'hash');
  f.linkedFallback = f.linked('linkedfallback', 'fallback');
  f.token = await f.tokenFor('admin1');
  return f;
}

// Relationships, history, link state, outbox and a terminal command ACK that
// a linked refusal must leave exactly as they were.
function populateLinked(f, row) {
  const at = '2026-01-02T00:00:00.000Z';
  const zoneUuid = crypto.randomUUID();
  const plotUuid = crypto.randomUUID();
  const run = (sql, ...params) => f.db.prepare(sql).run(...params);
  run('INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,updated_at,installation_uuid) VALUES(?,?,?,?,?,?,?)',
    'cloud', 1, 'https://cloud.example.invalid', '101', GATEWAY, at, f.installationUuid);
  run('INSERT INTO irrigation_zones(name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
    'Linked zone', row.id, zoneUuid, GATEWAY, at, at);
  const zone = f.db.prepare('SELECT id FROM irrigation_zones WHERE zone_uuid=?').get(zoneUuid);
  run('INSERT INTO journal_plots(plot_uuid,plot_code,name,zone_uuid,gateway_device_eui,owner_user_uuid,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)',
    plotUuid, 'P-521', 'Linked plot', zoneUuid, GATEWAY, row.user_uuid, at, at);
  run('INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,assigned_by_user_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
    crypto.randomUUID(), row.user_uuid, zoneUuid, f.admin.user_uuid, GATEWAY, at, at);
  run('INSERT INTO user_plot_assignments(assignment_uuid,user_uuid,plot_uuid,assigned_by_user_uuid,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
    crypto.randomUUID(), row.user_uuid, plotUuid, f.admin.user_uuid, GATEWAY, at, at);
  run("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui) VALUES(?,?,'KIWI_SENSOR',?,?,?,?,?)",
    SENSOR, 'Linked sensor', row.id, at, at, zone.id, GATEWAY);
  for (let i = 0; i < 3; i += 1) {
    run('INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES(?,?,?)', SENSOR, `2026-01-02T0${i}:00:00.000Z`, 20 + i);
  }
  run('INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,delivered_at,gateway_device_eui) VALUES(?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(), 'USER', row.user_uuid, 'USER_UPSERTED', JSON.stringify({ user_uuid: row.user_uuid }), 1, at, at, GATEWAY);
  run('INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui) VALUES(?,?,?,?,?,?,?,?)',
    crypto.randomUUID(), 'ZONE', zoneUuid, 'ZONE_UPSERTED', JSON.stringify({ zone_uuid: zoneUuid }), 1, at, GATEWAY);
  run('INSERT INTO applied_commands(command_id,device_eui,command_type,applied_at,result,actor_user_uuid,resource_type,resource_id,gateway_device_eui) VALUES(?,?,?,?,?,?,?,?,?)',
    'cmd-521-terminal', GATEWAY, 'UPSERT_SCOPED_USER', at, 'APPLIED', f.admin.user_uuid, 'user', row.user_uuid, GATEWAY);
  run('INSERT INTO command_ack_outbox(command_id,payload_json,created_at,delivered_at) VALUES(?,?,?,?)',
    'cmd-521-terminal', JSON.stringify({ commandId: 'cmd-521-terminal', result: 'APPLIED' }), at, at);
  return { zoneUuid, plotUuid };
}

const FALLBACK_ENV = { DEVICE_EUI: '', LINK_GATEWAY_DEVICE_EUI: '' };
function loginEnv(kind) { return kind === 'fallback' ? FALLBACK_ENV : undefined; }

function assertNoLeak(text, f, extra = []) {
  const secrets = [NEW_PASSWORD, 'SQLITE', 'UPDATE users', 'SELECT ', '$2', ...extra];
  for (const row of f.db.prepare('SELECT password_hash,server_password_hash,server_offline_verifier,server_sync_token FROM users').all()) {
    for (const value of Object.values(row)) if (value) secrets.push(String(value));
  }
  for (const secret of secrets) assert.ok(!text.includes(secret), `public body must not contain ${secret.slice(0, 12)}`);
}

function assertUnchangedExceptTarget(before, after, targetUuid, allowed) {
  for (const table of Object.keys(before)) {
    if (table !== 'users') { assert.deepEqual(after[table], before[table], `${table} unchanged`); continue; }
    assert.equal(after.users.length, before.users.length);
    before.users.forEach((row, i) => {
      const next = after.users[i];
      if (row.user_uuid !== targetUuid) { assert.deepEqual(next, row, `user ${row.username} unchanged`); return; }
      for (const key of Object.keys(row)) {
        if (!allowed.includes(key)) assert.deepEqual(next[key], row[key], `target ${key} unchanged`);
      }
    });
  }
}

const LINKED_KINDS = [['v2', 'linkedV2'], ['v1', 'linkedV1'], ['hash', 'linkedHash'], ['fallback', 'linkedFallback']];

for (const profile of PROFILES) {
  // ---- Linked refusal: one test per login variant, so each is reachable.
  for (const [kind, field] of LINKED_KINDS) {
    test(`[${profile}] linked ${kind} account gets the exact 409 and nothing changes`, TEST, async () => {
      const f = await standard(profile);
      try {
        const row = f[field];
        const oldLogin = await f.login(row.username, f.passwords[row.username], loginEnv(kind));
        assert.equal(oldLogin.status, 200, `control: ${kind} linked password signs in before the reset`);
        const before = f.snapshot();
        f.clearLog();
        const answer = await f.reset(f.token, row.user_uuid);
        assert.equal(answer.status, 409, `${kind} reset status`);
        assert.deepEqual(answer.body, LINKED, `${kind} reset body`);
        assert.match(answer.headers.get('content-type'), /application\/json/);
        assert.equal(f.bcryptCalls().length, 0, `${kind}: refused before hashing`);
        assert.equal(f.begins(), 0, `${kind}: no write transaction`);
        assert.deepEqual(f.invalidations(), [], `${kind}: no scope invalidation`);
        assert.deepEqual(f.control.errors, [], `${kind}: no node.error, so no second response`);
        assert.deepEqual(f.snapshot(), before, `${kind}: every logical row unchanged`);
        assertNoLeak(answer.text, f);
        assert.equal((await f.login(row.username, f.passwords[row.username], loginEnv(kind))).status, 200, `${kind}: old linked password still signs in`);
        assert.equal((await f.login(row.username, NEW_PASSWORD, loginEnv(kind))).status, 401, `${kind}: submitted password does not sign in`);
      } finally {
        await f.cleanup();
      }
    });
  }

  test(`[${profile}] the temporary_password alias reaches the same linked refusal`, TEST, async () => {
    const f = await standard(profile);
    try {
      const before = f.snapshot();
      f.clearLog();
      const alias = await f.reset(f.token, f.linkedV2.user_uuid, { temporary_password: NEW_PASSWORD });
      assert.equal(alias.status, 409, 'alias reset status');
      assert.deepEqual(alias.body, LINKED);
      assert.equal(f.bcryptCalls().length, 0);
      assert.deepEqual(f.snapshot(), before);
    } finally {
      await f.cleanup();
    }
  });

  // ---- Populated preservation, emit off and on.
  for (const emit of [false, true]) {
    test(`[${profile}] linked refusal preserves a populated account (emit ${emit ? 'on' : 'off'})`, TEST, async () => {
      const f = await standard(profile, { emit });
      try {
        const created = populateLinked(f, f.linkedV2);
        assert.ok(f.snapshot().sqlite_sequence.length > 0, 'control: sqlite_sequence is populated');
        assert.equal((await f.login('linkedv2', f.passwords.linkedv2)).status, 200, 'control: linked login before');
        const before = f.snapshot();
        for (const table of ['irrigation_zones', 'journal_plots', 'user_zone_assignments', 'user_plot_assignments', 'devices',
          'device_data', 'sync_link_state', 'sync_outbox', 'applied_commands', 'command_ack_outbox', 'installation_identity']) {
          assert.ok(before[table].length > 0, `control: ${table} is populated`);
        }
        f.clearLog();
        const answer = await f.reset(f.token, f.linkedV2.user_uuid);
        assert.equal(answer.status, 409, 'populated reset status');
        assert.deepEqual(answer.body, LINKED);
        assert.equal(f.bcryptCalls().length, 0);
        assert.equal(f.begins(), 0);
        assert.deepEqual(f.invalidations(), [], 'no scope invalidation');
        const after = f.snapshot();
        assert.deepEqual(after, before, 'every logical row, link state, outbox, ACK and sqlite_sequence unchanged');
        assert.equal(after.user_zone_assignments.find((r) => r.zone_uuid === created.zoneUuid).user_uuid, f.linkedV2.user_uuid);
        assert.equal(after.journal_plots.find((r) => r.plot_uuid === created.plotUuid).owner_user_uuid, f.linkedV2.user_uuid);
        assert.equal((await f.login('linkedv2', f.passwords.linkedv2)).status, 200, 'linked login after');
      } finally {
        await f.cleanup();
      }
    });
  }

  // ---- Local reset controls (behavior unchanged from the base).
  for (const emit of [false, true]) {
    test(`[${profile}] control: local reset signs in with the new password (emit ${emit ? 'on' : 'off'})`, TEST, async () => {
      const f = await standard(profile, { emit });
      try {
        const before = f.snapshot();
        f.clearLog();
        const answer = await f.reset(f.token, f.researcher.user_uuid);
        assert.equal(answer.status, 200);
        assert.deepEqual(answer.body, { success: true });
        const after = f.snapshot();
        assertUnchangedExceptTarget(before, after, f.researcher.user_uuid, ['password_hash', 'updated_at', 'sync_version']);
        const row = f.user(f.researcher.user_uuid);
        assert.equal(row.sync_version, f.researcher.sync_version + 1);
        assert.notEqual(row.password_hash, f.researcher.password_hash);
        assert.deepEqual(after.sync_outbox, before.sync_outbox, 'a hash-only reset emits no USER event');
        assert.deepEqual(f.invalidations(), [], 'a reset invalidates no scope');
        assert.equal((await f.login('research1', NEW_PASSWORD)).status, 200);
        assert.equal((await f.login('research1', f.passwords.research1)).status, 401);
        const alias = await f.reset(f.token, f.researcher.user_uuid, { temporary_password: 'alias-pass-521' });
        assert.equal(alias.status, 200, 'control: temporary_password alias still resets a local account');
        assert.equal((await f.login('research1', 'alias-pass-521')).status, 200);
      } finally {
        await f.cleanup();
      }
    });
  }

  test(`[${profile}] local reset hashes once at cost 10 outside one conditional UPDATE transaction`, TEST, async () => {
    const f = await standard(profile);
    try {
      f.clearLog();
      const answer = await f.reset(f.token, f.researcher.user_uuid);
      assert.equal(answer.status, 200);
      const log = f.control.log;
      const hashAt = log.findIndex((e) => e[0] === 'bcrypt');
      const beginAt = log.findIndex((e) => e[0] === 'exec' && /^BEGIN IMMEDIATE/.test(e[1]));
      const updateAt = log.findIndex((e) => e[0] === 'run' && RESET_UPDATE.test(e[1]));
      const commitAt = log.findIndex((e) => e[0] === 'exec' && /^COMMIT/.test(e[1]));
      assert.deepEqual(f.bcryptCalls(), [['bcrypt', 10]]);
      assert.ok(hashAt >= 0 && beginAt > hashAt, 'bcrypt runs before the write lock');
      assert.ok(updateAt > beginAt && commitAt > updateAt, 'the UPDATE runs inside the transaction');
      assert.match(log[updateAt][1], /AND auth_mode='local'$/, 'the UPDATE is bound to local mode');
      assert.equal(f.resetUpdates(), 1);
      assert.ok(CHANGES_SQL.test(log[updateAt + 1][1]), 'changes() is read right after the UPDATE');
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] the user list carries only a normalized auth_mode discriminator`, TEST, async () => {
    const f = await standard(profile);
    try {
      const odd = f.local('legacyuser', 'viewer', { auth_mode: 'legacy-x' });
      const listed = await f.request('GET', '/api/users', { token: f.token });
      assert.equal(listed.status, 200);
      const byName = Object.fromEntries(listed.body.users.map((u) => [u.username, u]));
      assert.equal(byName.admin1.auth_mode, 'local', 'local row');
      assert.equal(byName.linkedv2.auth_mode, 'server', 'linked row');
      assert.equal(byName.legacyuser.auth_mode, 'unknown', 'unknown row');
      for (const row of listed.body.users) {
        assert.deepEqual(Object.keys(row).sort(), ['auth_mode', 'created_at', 'disabled_at', 'role', 'user_uuid', 'username']);
      }
      assertNoLeak(listed.text, f, [NEW_PASSWORD]);
      assert.equal(odd.auth_mode, 'legacy-x', 'the stored value itself is untouched');
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] create answers auth_mode local`, TEST, async () => {
    const f = await standard(profile);
    try {
      const created = await f.request('POST', '/api/users', { token: f.token, body: { username: 'created1', password: 'created-pass', role: 'viewer' } });
      assert.equal(created.status, 201);
      assert.equal(created.body.auth_mode, 'local', 'create answer');
      assert.equal(f.db.prepare("SELECT auth_mode FROM users WHERE username='created1'").get().auth_mode, 'local');
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] control: authorization and flag refusals precede any target disclosure`, TEST, async () => {
    const f = await standard(profile);
    try {
      const researcherToken = await f.tokenFor('research1');
      const disabledAdmin = f.local('admin3', 'admin');
      const disabledToken = await f.tokenFor('admin3');
      f.db.prepare("UPDATE users SET disabled_at='2026-02-01' WHERE id=?").run(disabledAdmin.id);
      const deleted = f.local('admin4', 'admin');
      const deletedToken = await f.tokenFor('admin4');
      f.db.prepare('DELETE FROM users WHERE id=?').run(deleted.id);
      const tampered = f.token.slice(0, -2) + (f.token.endsWith('AA') ? 'BB' : 'AA');
      const targets = [f.researcher.user_uuid, f.linkedV2.user_uuid, 'no-such-user'];
      const before = f.snapshot();
      f.clearLog();
      const cases = [
        ['no bearer', { token: null }, 401],
        ['tampered bearer', { token: tampered }, 401],
        ['deleted actor', { token: deletedToken }, 401],
        ['researcher', { token: researcherToken }, 403],
        ['disabled admin', { token: disabledToken }, 403],
        ['flag off', { token: f.token, scoped: false }, 404],
      ];
      for (const [label, opts, status] of cases) {
        const bodies = [];
        for (const uuid of targets) {
          const answer = await f.reset(opts.token, uuid, { password: NEW_PASSWORD }, { scoped: opts.scoped !== false });
          assert.equal(answer.status, status, `${label} -> ${uuid}`);
          assert.equal(answer.body.code, undefined);
          bodies.push(answer.text);
        }
        assert.equal(new Set(bodies).size, 1, `${label}: identical answer for local, linked and missing targets`);
      }
      assert.equal(f.bcryptCalls().length, 0);
      assert.deepEqual(f.snapshot(), before);
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] control: password validation precedes target classification`, TEST, async () => {
    const f = await standard(profile);
    try {
      const before = f.snapshot();
      f.clearLog();
      for (const uuid of [f.researcher.user_uuid, f.linkedV2.user_uuid, 'no-such-user']) {
        for (const body of [{}, { password: 'short' }, { temporary_password: 'short' }]) {
          const answer = await f.reset(f.token, uuid, body);
          assert.equal(answer.status, 400);
          assert.deepEqual(answer.body, { message: 'Password must be at least 6 characters' });
        }
      }
      assert.equal(f.bcryptCalls().length, 0);
      assert.deepEqual(f.snapshot(), before);
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] a missing target is refused before hashing`, TEST, async () => {
    const f = await standard(profile);
    try {
      const before = f.snapshot();
      f.clearLog();
      const missing = await f.reset(f.token, 'no-such-user');
      assert.equal(missing.status, 404, 'missing status');
      assert.deepEqual(missing.body, { message: 'User not found' });
      assert.equal(f.bcryptCalls().length, 0, 'missing: no bcrypt');
      assert.deepEqual(f.snapshot(), before);
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] an unknown sign-in type is refused before hashing`, TEST, async () => {
    const f = await standard(profile);
    try {
      const odd = f.local('legacyuser', 'viewer', { auth_mode: 'legacy-x' });
      const before = f.snapshot();
      f.clearLog();
      const unknown = await f.reset(f.token, odd.user_uuid);
      assert.equal(unknown.status, 500, 'unknown status');
      assert.deepEqual(unknown.body, UNKNOWN_MODE);
      assert.equal(f.bcryptCalls().length, 0);
      assert.deepEqual(f.snapshot(), before);
    } finally {
      await f.cleanup();
    }
  });

  // ---- Changes committed between the read-only preflight and the write
  // transaction: by a second connection (another process, such as the
  // recovery CLI), or queued on the shared facade ahead of the transaction.
  const races = [
    ['target becomes linked (other connection)', (f) => ({ after: () => f.db.prepare("UPDATE users SET auth_mode='server' WHERE user_uuid=?").run(f.researcher.user_uuid) }), 409, LINKED],
    ['target becomes linked (queued facade write)', (f) => ({ after: () => { new f.helper.Database(f.dbPath).run("UPDATE users SET auth_mode='server' WHERE user_uuid=?", [f.researcher.user_uuid]); } }), 409, LINKED],
    ['target deleted', (f) => ({ after: () => f.db.prepare('DELETE FROM users WHERE user_uuid=?').run(f.researcher.user_uuid) }), 404, { message: 'User not found' }],
    ['target mode becomes unknown', (f) => ({ after: () => f.db.prepare("UPDATE users SET auth_mode='legacy-x' WHERE user_uuid=?").run(f.researcher.user_uuid) }), 500, UNKNOWN_MODE],
    ['actor disabled', (f) => ({ after: () => f.db.prepare("UPDATE users SET disabled_at='2026-02-01' WHERE id=?").run(f.admin.id) }), 403, { message: 'Forbidden' }],
    ['actor demoted', (f) => ({ after: () => f.db.prepare("UPDATE users SET role='researcher' WHERE id=?").run(f.admin.id) }), 403, { message: 'Forbidden' }],
    ['actor deleted', (f) => ({ after: () => f.db.prepare('DELETE FROM users WHERE id=?').run(f.admin.id) }), 401, { message: 'Unauthorized' }],
    ['actor renamed', (f) => ({ after: () => f.db.prepare("UPDATE users SET username='admin1-renamed' WHERE id=?").run(f.admin.id) }), 401, { message: 'Unauthorized' }],
  ];
  for (const [label, makeHook, status, body] of races) {
    test(`[${profile}] race during hashing: ${label}`, TEST, async () => {
      const f = await standard(profile);
      try {
        const targetBefore = f.user(f.researcher.user_uuid);
        f.clearLog();
        f.hook({ name: 'after-preflight', method: 'all', match: PREFLIGHT_SQL, ...makeHook(f) });
        const answer = await f.reset(f.token, f.researcher.user_uuid);
        assert.equal(answer.status, status, 'race status');
        assert.deepEqual(answer.body, body);
        assert.deepEqual(f.control.fired, ['after-preflight'], 'the race hook fired after the preflight read');
        assert.equal(f.bcryptCalls().length, 1, 'the preflight passed, so the hash was computed once');
        assert.equal(f.resetUpdates(), 0, 'no reset UPDATE ran');
        assert.deepEqual(f.control.errors, []);
        const targetAfter = f.db.prepare('SELECT password_hash FROM users WHERE user_uuid=?').get(f.researcher.user_uuid);
        if (targetAfter) assert.equal(targetAfter.password_hash, targetBefore.password_hash);
      } finally {
        await f.cleanup();
      }
    });
  }

  test(`[${profile}] the transaction's current row decides: linked then local again resets`, TEST, async () => {
    const f = await standard(profile);
    try {
      f.hook({
        name: 'flip-and-back', method: 'all', match: PREFLIGHT_SQL,
        after: () => {
          f.db.prepare("UPDATE users SET auth_mode='server' WHERE user_uuid=?").run(f.researcher.user_uuid);
          f.db.prepare("UPDATE users SET auth_mode='local' WHERE user_uuid=?").run(f.researcher.user_uuid);
        },
      });
      const answer = await f.reset(f.token, f.researcher.user_uuid);
      assert.equal(answer.status, 200, 'flip-and-back status');
      assert.deepEqual(f.control.fired, ['flip-and-back'], 'the hook fired after the preflight read');
      assert.equal((await f.login('research1', NEW_PASSWORD)).status, 200);
    } finally {
      await f.cleanup();
    }
  });

  // ---- Defensive zero/odd count branches. The hooks act on the
  // transaction's own connection just before the UPDATE, or replace the
  // changes() row.
  const counts = [
    ['zero rows because the target became linked', { method: 'run', match: RESET_UPDATE, before: (f) => (n) => n.prepare("UPDATE users SET auth_mode='server' WHERE user_uuid=?").run(f.researcher.user_uuid) }, 409, LINKED, 'committed-flip'],
    ['zero rows because the target vanished', { method: 'run', match: RESET_UPDATE, before: (f) => (n) => n.prepare('DELETE FROM users WHERE user_uuid=?').run(f.researcher.user_uuid) }, 404, { message: 'User not found' }, 'committed-delete'],
    ['zero rows while still local', { method: 'all', match: CHANGES_SQL, rows: [{ n: 0 }] }, 500, RESET_FAILED, 'rolled-back'],
    ['two rows', { method: 'all', match: CHANGES_SQL, rows: [{ n: 2 }] }, 500, RESET_FAILED, 'rolled-back'],
    ['negative count', { method: 'all', match: CHANGES_SQL, rows: [{ n: -1 }] }, 500, RESET_FAILED, 'rolled-back'],
    ['string count', { method: 'all', match: CHANGES_SQL, rows: [{ n: '1' }] }, 500, RESET_FAILED, 'rolled-back'],
    ['fractional count', { method: 'all', match: CHANGES_SQL, rows: [{ n: 1.5 }] }, 500, RESET_FAILED, 'rolled-back'],
    ['null count', { method: 'all', match: CHANGES_SQL, rows: [{ n: null }] }, 500, RESET_FAILED, 'rolled-back'],
    ['no count row', { method: 'all', match: CHANGES_SQL, rows: [] }, 500, RESET_FAILED, 'rolled-back'],
    ['count read error', { method: 'all', match: CHANGES_SQL, error: new Error('SQLITE_IOERR: disk I/O error') }, 500, RESET_FAILED, 'rolled-back'],
  ];
  for (const [label, spec, status, body, effect] of counts) {
    test(`[${profile}] affected-row oracle: ${label}`, TEST, async () => {
      const f = await standard(profile);
      try {
        const before = f.user(f.researcher.user_uuid);
        f.clearLog();
        f.hook({ name: label, ...spec, before: spec.before ? spec.before(f) : undefined });
        const answer = await f.reset(f.token, f.researcher.user_uuid);
        assert.equal(answer.status, status, 'affected-row status');
        assert.deepEqual(answer.body, body);
        assert.deepEqual(f.control.fired, [label]);
        assertNoLeak(answer.text, f);
        const after = f.db.prepare('SELECT * FROM users WHERE user_uuid=?').get(f.researcher.user_uuid);
        if (effect === 'rolled-back') {
          assert.deepEqual({ ...after }, before, 'ROLLBACK restored the target row');
          assert.ok(f.control.log.some((e) => e[0] === 'exec' && ROLLBACK_SQL.test(e[1])));
          assert.equal(f.sharedHandle().isTransaction, false, 'no transaction left open');
        } else if (effect === 'committed-flip') {
          assert.equal(after.password_hash, before.password_hash);
          assert.equal(after.auth_mode, 'server');
        } else {
          assert.equal(after, undefined);
        }
      } finally {
        await f.cleanup();
      }
    });
  }

  // ---- Faults: one test each, so every case is reachable on its own.
  const faults = [
    ['preflight read error', (f) => f.hook({ name: 'p', method: 'all', match: PREFLIGHT_SQL, error: new Error('SQLITE_IOERR: disk I/O error') }), { bcrypt: 0, fired: ['p'] }],
    ['hash failure', (f) => { f.control.bcryptError = new Error('bcrypt exploded'); }, { bcrypt: 1, fired: [], noBegin: true }],
    ['busy write lock', (f) => f.hook({ name: 'b', method: 'exec', match: /^BEGIN IMMEDIATE/, error: new Error('SQLITE_BUSY: database is locked') }), { bcrypt: 1, fired: ['b'] }],
    // The generic router catch would turn this message into a 409.
    ['constraint-shaped UPDATE error', (f) => f.hook({ name: 'u', method: 'run', match: RESET_UPDATE, error: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.user_uuid') }), { bcrypt: 1, fired: ['u'] }],
    ['commit refused before applying', (f) => f.hook({ name: 'c', method: 'exec', match: /^COMMIT/, error: new Error('SQLITE_BUSY: cannot commit') }), { bcrypt: 1, fired: ['c'] }],
  ];
  for (const [label, arrange, expect] of faults) {
    test(`[${profile}] fault answers a safe 500: ${label}`, TEST, async () => {
      const f = await standard(profile);
      try {
        const before = f.snapshot();
        f.clearLog();
        arrange(f);
        const answer = await f.reset(f.token, f.researcher.user_uuid);
        assert.equal(answer.status, 500, `${label}: status`);
        assert.deepEqual(answer.body, RESET_FAILED, `${label}: body`);
        assert.deepEqual(f.control.fired, expect.fired, `${label}: hooks`);
        assertNoLeak(answer.text, f, ['bcrypt exploded', 'constraint', 'disk I/O', 'cannot commit', 'locked']);
        assert.equal(f.bcryptCalls().length, expect.bcrypt, `${label}: hash count`);
        if (expect.noBegin) assert.equal(f.begins(), 0);
        assert.equal(f.sharedHandle().isTransaction, false, `${label}: no transaction left open`);
        assert.deepEqual(f.snapshot(), before, `${label}: logical rows unchanged (read back, not inferred)`);
        assert.ok(f.control.warnings.some((w) => /password reset failed/.test(w)), `${label}: private warning recorded`);
        assert.deepEqual(f.control.errors, [], `${label}: no node.error`);
        assert.equal((await f.login('research1', f.passwords.research1)).status, 200, `${label}: old local password still works`);
      } finally {
        await f.cleanup();
      }
    });
  }

  test(`[${profile}] an applied commit that reports failure is a 500 with uncertain state and no retry`, TEST, async () => {
    const f = await standard(profile);
    try {
      f.clearLog();
      f.hook({ name: 'commit-applied', method: 'exec', match: /^COMMIT/, applyFirst: true, error: new Error('SQLITE_IOERR: commit reported failure') });
      const answer = await f.reset(f.token, f.researcher.user_uuid);
      assert.equal(answer.status, 500, 'applied-commit status');
      assert.deepEqual(answer.body, RESET_FAILED, 'the answer does not claim the password is unchanged');
      assert.equal(f.bcryptCalls().length, 1, 'no automatic retry hashes again');
      assert.equal(f.resetUpdates(), 1, 'no automatic retry updates again');
      assert.ok(f.control.warnings.some((w) => /rollback also failed/.test(w)), 'the private warning records the failed rollback');
      // The row did change: an HTTP error alone never proves unchanged state.
      assert.equal((await f.login('research1', NEW_PASSWORD)).status, 200);
    } finally {
      await f.cleanup();
    }
  });

  // ---- ROLLBACK failure after an ordinary reset fault.
  for (const [mode, applyFirst] of [['applied then reported failed', true], ['refused before applying', false]]) {
    test(`[${profile}] a rollback ${mode} after a count fault answers the safe 500`, TEST, async () => {
      const f = await standard(profile);
      try {
        const before = f.user(f.researcher.user_uuid);
        f.clearLog();
        f.hook({ name: 'two', method: 'all', match: CHANGES_SQL, rows: [{ n: 2 }] });
        f.hook({ name: 'rollback', method: 'exec', match: ROLLBACK_SQL, applyFirst, error: new Error('SQLITE_IOERR: rollback reported failure') });
        const answer = await f.reset(f.token, f.researcher.user_uuid);
        assert.equal(answer.status, 500, 'rollback-failure status');
        assert.deepEqual(answer.body, RESET_FAILED);
        assert.deepEqual(f.control.fired, ['two', 'rollback']);
        assertNoLeak(answer.text, f, ['rollback reported failure']);
        assert.ok(f.control.warnings.some((w) => /rollback also failed: SQLITE_IOERR: rollback reported failure/.test(w)));
        assert.equal(f.resetUpdates(), 1, 'one UPDATE, no retry');
        // State is read back, never inferred from the 500. A refused ROLLBACK
        // leaves the UPDATE pending in an open transaction; end it privately.
        assert.equal(f.rollbackPrivately(), !applyFirst, 'an open transaction exists only when the ROLLBACK was refused');
        assert.deepEqual(f.user(f.researcher.user_uuid), before, 'after the transaction ended the target row is unchanged');
      } finally {
        await f.cleanup();
      }
    });
  }

  // ---- ROLLBACK failure outranks a 401 or 403 raised inside the transaction.
  const precedence = [
    ['actor renamed', true, (f) => f.db.prepare("UPDATE users SET username='admin1-renamed' WHERE id=?").run(f.admin.id), /Unauthorized/],
    ['actor renamed', false, (f) => f.db.prepare("UPDATE users SET username='admin1-renamed' WHERE id=?").run(f.admin.id), /Unauthorized/],
    ['actor disabled', false, (f) => f.db.prepare("UPDATE users SET disabled_at='2026-02-01' WHERE id=?").run(f.admin.id), /account disabled/],
    ['actor demoted', true, (f) => f.db.prepare("UPDATE users SET role='researcher' WHERE id=?").run(f.admin.id), /insufficient role/],
  ];
  for (const [label, applyFirst, change, reason] of precedence) {
    const mode = applyFirst ? 'applied then reported failed' : 'refused before applying';
    test(`[${profile}] ${label} inside the transaction with a rollback ${mode} answers the safe 500`, TEST, async () => {
      const f = await standard(profile);
      try {
        const targetBefore = f.user(f.researcher.user_uuid);
        f.clearLog();
        f.hook({ name: 'after-preflight', method: 'all', match: PREFLIGHT_SQL, after: () => change(f) });
        f.hook({ name: 'rollback', method: 'exec', match: ROLLBACK_SQL, applyFirst, error: new Error('SQLITE_IOERR: rollback reported failure') });
        const answer = await f.reset(f.token, f.researcher.user_uuid);
        assert.equal(answer.status, 500, 'precedence status');
        assert.deepEqual(answer.body, RESET_FAILED, 'safe body, not Unauthorized or Forbidden');
        assert.equal(answer.body.code, undefined);
        assert.deepEqual(f.control.fired, ['after-preflight', 'rollback']);
        assertNoLeak(answer.text, f, ['Unauthorized', 'Forbidden', 'account disabled', 'insufficient role', 'rollback reported failure']);
        const warning = f.control.warnings.find((w) => /password reset failed/.test(w));
        assert.ok(warning, 'private warning recorded');
        assert.match(warning, reason, 'the warning keeps the original refusal');
        assert.match(warning, /rollback also failed: SQLITE_IOERR: rollback reported failure/);
        assert.deepEqual(f.control.errors, []);
        assert.equal(f.bcryptCalls().length, 1, 'one hash, no retry');
        assert.equal(f.begins(), 1, 'one transaction, no retry');
        assert.equal(f.resetUpdates(), 0, 'the refusal came before any reset UPDATE');
        assert.equal(f.rollbackPrivately(), !applyFirst, 'an open transaction exists only when the ROLLBACK was refused');
        assert.equal(f.user(f.researcher.user_uuid).password_hash, targetBefore.password_hash, 'target hash read back unchanged');
      } finally {
        await f.cleanup();
      }
    });
  }

  test(`[${profile}] control: the linked code appears on no other 409`, TEST, async () => {
    const f = await standard(profile);
    try {
      const duplicate = await f.request('POST', '/api/users', { token: f.token, body: { username: 'research1', password: 'dupe-pass', role: 'viewer' } });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.code, undefined);
      f.db.prepare("UPDATE users SET disabled_at='2026-02-01' WHERE id=?").run(f.admin2.id);
      const lastAdmin = await f.request('PUT', `/api/users/${f.admin.user_uuid}/disabled`, { token: f.token, body: { disabled: true } });
      assert.equal(lastAdmin.status, 409);
      assert.equal(lastAdmin.body.code, undefined);
    } finally {
      await f.cleanup();
    }
  });

  // ---- Composition with #520 (conditional). On a base without
  // users.local_auth_generation the sentinel passes and the three cases skip.
  // Once the column exists, the router must carry the generation check and
  // all three cases run; an allowlist alone cannot pass them.
  test(`[${profile}] #520 composition sentinel: a generation column requires the router generation check`, TEST, async () => {
    const f = await fixture(profile);
    try {
      const router = f.byId.get('scoped-admin-account-router').func;
      if (f.hasGeneration) {
        assert.match(router, /local_auth_generation/, 'the composed router rechecks the actor generation inside the reset transaction');
      } else {
        assert.doesNotMatch(router, /local_auth_generation/, 'no generation reference without the column');
      }
    } finally {
      await f.cleanup();
    }
  });

  const GENERATION_SKIP = 'requires users.local_auth_generation from #520; see the plan, "Composition with #520"';
  async function generationFixture(t) {
    const probe = await fixture(profile);
    const present = probe.hasGeneration;
    await probe.cleanup();
    if (!present) { t.skip(GENERATION_SKIP); return null; }
    return standard(profile);
  }
  const generations = (f) => Object.fromEntries(f.db.prepare('SELECT user_uuid,local_auth_generation FROM users').all().map((r) => [r.user_uuid, r.local_auth_generation]));

  test(`[${profile}] #520: a committed local reset rotates exactly the target generation`, TEST, async (t) => {
    const f = await generationFixture(t);
    if (!f) return;
    try {
      const before = f.snapshot();
      const genBefore = generations(f);
      const answer = await f.reset(f.token, f.researcher.user_uuid);
      assert.equal(answer.status, 200);
      const genAfter = generations(f);
      assert.notEqual(genAfter[f.researcher.user_uuid], genBefore[f.researcher.user_uuid], 'target generation rotated');
      for (const [uuid, generation] of Object.entries(genBefore)) {
        if (uuid !== f.researcher.user_uuid) assert.equal(genAfter[uuid], generation, `generation of ${uuid} unchanged`);
      }
      assertUnchangedExceptTarget(before, f.snapshot(), f.researcher.user_uuid,
        ['password_hash', 'updated_at', 'sync_version', 'local_auth_generation']);
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] #520: linked refusal and a proven rollback leave every generation unchanged`, TEST, async (t) => {
    const f = await generationFixture(t);
    if (!f) return;
    try {
      const genBefore = generations(f);
      const refused = await f.reset(f.token, f.linkedV2.user_uuid);
      assert.equal(refused.status, 409);
      assert.deepEqual(generations(f), genBefore, 'linked refusal rotates nothing');
      f.hook({ name: 'two', method: 'all', match: CHANGES_SQL, rows: [{ n: 2 }] });
      const rolledBack = await f.reset(f.token, f.researcher.user_uuid);
      assert.equal(rolledBack.status, 500);
      assert.equal(f.sharedHandle().isTransaction, false, 'the rollback succeeded');
      assert.deepEqual(generations(f), genBefore, 'a proven rollback rotates nothing');
    } finally {
      await f.cleanup();
    }
  });

  test(`[${profile}] #520: an actor generation revoked after admission is denied inside the reset transaction`, TEST, async (t) => {
    const f = await generationFixture(t);
    if (!f) return;
    try {
      const targetBefore = f.user(f.researcher.user_uuid);
      f.clearLog();
      f.hook({
        name: 'revoke-actor', method: 'all', match: PREFLIGHT_SQL,
        after: () => f.db.prepare('UPDATE users SET local_auth_generation=lower(hex(randomblob(16))) WHERE id=?').run(f.admin.id),
      });
      const answer = await f.reset(f.token, f.researcher.user_uuid);
      assert.deepEqual(f.control.fired, ['revoke-actor']);
      assert.equal(answer.status, 401, 'revoked actor generation');
      assert.equal(f.bcryptCalls().length, 1);
      assert.equal(f.resetUpdates(), 0, 'no reset UPDATE for a revoked actor');
      assert.deepEqual(f.user(f.researcher.user_uuid), targetBefore);
    } finally {
      await f.cleanup();
    }
  });
}

// ---- Named mutants (bcm2712): each applies one reviewed regression to the
// shipped router text and shows that the oracle above would catch it.
const ROUTER_ID = 'scoped-admin-account-router';
function mutatedFlows(find, replace) {
  const { flowsPath } = profilePaths('bcm2712');
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const router = flows.find((node) => node.id === ROUTER_ID);
  const occurrences = router.func.split(find).length - 1;
  assert.equal(occurrences, 1, `mutant anchor occurs exactly once: ${find.slice(0, 60)}`);
  router.func = router.func.replace(find, replace);
  return flows;
}

// Calls the route without HTTP so a deadlocked mutant can be observed. The
// race resolves the string 'timeout'; the pending facade promise is abandoned
// and the fixture cleanup closes the backing handles. Only M5, whose declared
// regression is that deadlock, may count a timeout as its violation.
async function direct(f, uuid, timeoutMs = 3000) {
  const entry = f.byId.get('admin-users-password-http');
  const msg = {
    _msgid: crypto.randomUUID(),
    req: {
      method: 'POST', path: `/api/users/${uuid}/password-reset`, url: `/api/users/${uuid}/password-reset`,
      headers: { authorization: `Bearer ${f.token}` }, params: { uuid }, body: { password: NEW_PASSWORD }, query: {},
    },
    payload: { password: NEW_PASSWORD },
  };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    return await Promise.race([f.dispatch(entry, msg, f.env(true)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A completed route answer: an integer HTTP status and a JSON object body.
function completed(r) {
  return r !== 'timeout' && r !== null && typeof r === 'object' && Number.isInteger(r.status) &&
    r.status >= 100 && r.status <= 599 && r.payload !== null && typeof r.payload === 'object' && !Array.isArray(r.payload);
}
function describe(r) { return r === 'timeout' ? 'timeout' : `${r && r.status} ${JSON.stringify(r && r.payload)}`; }

// Each mutant names the shipped answer (`expect`) and the regression the
// mutant must show (`violation`), both on a completed answer except M5's
// deadlock. `fired` lists the hooks that must have fired in both runs.
const MUTANTS = [
  {
    name: 'M1 conditional UPDATE loses its auth_mode predicate',
    find: "WHERE user_uuid=? AND auth_mode='local'\"", replace: 'WHERE user_uuid=?"',
    arrange: (f) => f.hook({ name: 'm1-linked-before-update', method: 'run', match: RESET_UPDATE, before: (n) => n.prepare("UPDATE users SET auth_mode='server' WHERE user_uuid=?").run(f.researcher.user_uuid) }),
    fired: ['m1-linked-before-update'],
    target: (f) => f.researcher.user_uuid,
    expect: (r) => r.status === 409 && r.payload.code === LINKED.code,
    violation: (r, f) => r.status === 200 && f.resetUpdates() === 1,
  },
  {
    name: 'M2 preflight removed, linked targets are hashed',
    find: "      if (preflight !== 'local') return refuse(preflight);\n", replace: '',
    fired: [],
    target: (f) => f.linkedV2.user_uuid,
    expect: (r, f) => r.status === 409 && r.payload.code === LINKED.code && f.bcryptCalls().length === 0,
    violation: (r, f) => r.status === 409 && r.payload.code === LINKED.code && f.bcryptCalls().length === 1,
  },
  {
    name: 'M3 old UUID-only UPDATE without the transaction recheck',
    find: "        if (target !== 'local') return target;\n        await tx.run(\n          \"UPDATE users SET password_hash=?,updated_at=?,sync_version=sync_version+1 WHERE user_uuid=? AND auth_mode='local'\",",
    replace: "        await tx.run(\n          \"UPDATE users SET password_hash=?,updated_at=?,sync_version=sync_version+1 WHERE user_uuid=?\",",
    arrange: (f) => f.hook({ name: 'm3-linked-after-preflight', method: 'all', match: PREFLIGHT_SQL, after: () => f.db.prepare("UPDATE users SET auth_mode='server' WHERE user_uuid=?").run(f.researcher.user_uuid) }),
    fired: ['m3-linked-after-preflight'],
    target: (f) => f.researcher.user_uuid,
    expect: (r, f) => r.status === 409 && r.payload.code === LINKED.code && f.resetUpdates() === 0,
    violation: (r, f) => r.status === 200 && f.resetUpdates() === 1,
  },
  {
    name: 'M4 affected-row check accepts more than one row',
    find: "if (n === 1) return 'reset';", replace: "if (n >= 1) return 'reset';",
    arrange: (f) => f.hook({ name: 'm4-two-rows', method: 'all', match: CHANGES_SQL, rows: [{ n: 2 }] }),
    fired: ['m4-two-rows'],
    target: (f) => f.researcher.user_uuid,
    expect: (r) => r.status === 500 && r.payload.message === RESET_FAILED.message,
    violation: (r) => r.status === 200 && r.payload.success === true,
  },
  {
    name: 'M5 fresh-role recheck uses the queued facade inside the transaction',
    find: 'await scope.assertFreshRole(tx, actor.user_uuid', replace: 'await scope.assertFreshRole(db, actor.user_uuid',
    fired: [],
    target: (f) => f.researcher.user_uuid,
    expect: (r) => r.status === 200 && r.payload.success === true,
    deadlock: true,
  },
  {
    name: 'M6 transaction skips the token identity recheck',
    find: 'if (!current || current.user_uuid !== actor.user_uuid) {', replace: 'if (false) {',
    arrange: (f) => f.hook({ name: 'm6-actor-renamed', method: 'all', match: PREFLIGHT_SQL, after: () => f.db.prepare("UPDATE users SET username='admin1-renamed' WHERE id=?").run(f.admin.id) }),
    fired: ['m6-actor-renamed'],
    target: (f) => f.researcher.user_uuid,
    expect: (r, f) => r.status === 401 && f.resetUpdates() === 0,
    violation: (r, f) => r.status === 200 && f.resetUpdates() === 1,
  },
  {
    name: 'M7 linked refusal thrown into the catch instead of answered',
    find: "      if (preflight !== 'local') return refuse(preflight);\n",
    replace: "      if (preflight === 'server') throw Object.assign(new Error('linked'), { statusCode: 409, code: 'linked_account_password_reset_unsupported' });\n      if (preflight !== 'local') return refuse(preflight);\n",
    fired: [],
    target: (f) => f.linkedV2.user_uuid,
    expect: (r) => r.status === 409 && r.payload.code === LINKED.code,
    violation: (r) => r.status === 500 && r.payload.message === RESET_FAILED.message && r.payload.code === undefined,
  },
  {
    name: 'M9 reset faults fall through to the generic catch',
    find: 'if (!rollbackError && resetError && (resetError.statusCode === 401 || resetError.statusCode === 403)) throw resetError;', replace: 'throw resetError;',
    arrange: (f) => f.hook({ name: 'm9-constraint', method: 'run', match: RESET_UPDATE, error: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.user_uuid') }),
    fired: ['m9-constraint'],
    target: (f) => f.researcher.user_uuid,
    expect: (r) => r.status === 500 && r.payload.message === RESET_FAILED.message,
    violation: (r) => r.status === 409 && String(r.payload.message).includes('SQLITE_CONSTRAINT'),
  },
  {
    name: 'M10 a failed ROLLBACK no longer outranks a 401 raised inside the transaction',
    find: 'if (!rollbackError && resetError && (resetError.statusCode === 401 || resetError.statusCode === 403)) throw resetError;',
    replace: 'if (resetError && (resetError.statusCode === 401 || resetError.statusCode === 403)) throw resetError;',
    arrange: (f) => {
      f.hook({ name: 'm10-actor-renamed', method: 'all', match: PREFLIGHT_SQL, after: () => f.db.prepare("UPDATE users SET username='admin1-renamed' WHERE id=?").run(f.admin.id) });
      f.hook({ name: 'm10-rollback-refused', method: 'exec', match: ROLLBACK_SQL, error: new Error('SQLITE_IOERR: rollback reported failure') });
    },
    fired: ['m10-actor-renamed', 'm10-rollback-refused'],
    target: (f) => f.researcher.user_uuid,
    expect: (r) => r.status === 500 && r.payload.message === RESET_FAILED.message,
    violation: (r) => r.status === 401 && r.payload.message === 'Unauthorized',
  },
];

for (const mutant of MUTANTS) {
  test(`mutant ${mutant.name} is detected`, TEST, async () => {
    for (const flows of [null, mutatedFlows(mutant.find, mutant.replace)]) {
      const f = await standard('bcm2712', flows ? { flows } : {});
      try {
        f.clearLog();
        if (mutant.arrange) mutant.arrange(f);
        const result = await direct(f, mutant.target(f));
        if (!flows) {
          assert.ok(completed(result), `shipped router completes (${describe(result)})`);
          assert.ok(mutant.expect(result, f), `shipped router meets the oracle (${describe(result)})`);
          assert.deepEqual(f.control.fired, mutant.fired, 'shipped run: the arranged hooks fired');
        } else if (mutant.deadlock) {
          assert.equal(result, 'timeout', `the mutant deadlocks on the queued facade (${describe(result)})`);
        } else {
          // A timeout or a malformed answer is never counted as a detection.
          assert.ok(completed(result), `mutant run completes; a timeout is not a detection (${describe(result)})`);
          assert.deepEqual(f.control.fired, mutant.fired, 'mutant run: the arranged hooks fired');
          assert.ok(!mutant.expect(result, f), `mutant escaped the oracle (${describe(result)})`);
          assert.ok(mutant.violation(result, f), `mutant shows its named regression (${describe(result)})`);
        }
      } finally {
        await f.cleanup();
      }
    }
  });
}

test('mutant M8 list returns the raw auth_mode is detected', TEST, async () => {
  const find = "\"CASE auth_mode WHEN 'local' THEN 'local' WHEN 'server' THEN 'server' ELSE 'unknown' END AS auth_mode \" +";
  for (const flows of [null, mutatedFlows(find, "'auth_mode ' +")]) {
    const f = await standard('bcm2712', flows ? { flows } : {});
    try {
      f.local('legacyuser', 'viewer', { auth_mode: 'legacy-x' });
      const listed = await f.request('GET', '/api/users', { token: f.token });
      const mode = listed.body.users.find((u) => u.username === 'legacyuser').auth_mode;
      if (!flows) assert.equal(mode, 'unknown');
      else assert.equal(mode, 'legacy-x');
    } finally {
      await f.cleanup();
    }
  }
});
