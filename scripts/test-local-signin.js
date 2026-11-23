#!/usr/bin/env node
'use strict';
// Local sign-in (POST /auth/login, node auth-process-result) with the staged
// node body from scripts/fixtures/local-signin/auth-process-result.json and
// osi-local-password-reset's verifyLocalLogin, in both profiles.
//
// The node runs in a vm sandbox, as in scripts/test-auth-credential-isolation.js.
// Its osiLib stub serves the profile's real osi-local-password-reset and
// installation helper, plus a database facade over node:sqlite with
// osi-db-helper's contract: tx.run resolves to undefined, so the module reads
// changes() itself, and a failed statement inside transaction() rolls back.
//
// LOCAL_SIGNIN_NODE=shipped drives the body that ships in flows.json today
// instead of the staged one (used for the red run in the PR evidence).
//
// Run: node --test scripts/test-local-signin.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const handoff = require('./local-signin-handoff');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'test-signing-value-not-real';
const USERS_SQL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, auth_mode TEXT NOT NULL DEFAULT 'local',
  server_username TEXT, server_password_hash TEXT, server_linked_at TEXT, user_uuid TEXT, cloud_user_id INTEGER,
  server_url TEXT, server_sync_token TEXT, server_sync_token_expires_at INTEGER, server_offline_verifier TEXT,
  edge_originated INTEGER DEFAULT 0, server_offline_verifier_version INTEGER DEFAULT 0, last_auth_sync_at TEXT,
  last_auth_sync_status TEXT, last_auth_sync_error TEXT,
  role TEXT NOT NULL DEFAULT 'researcher' CHECK (role IN ('admin','researcher','viewer')), disabled_at TEXT,
  sync_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE installation_identity (singleton_id INTEGER PRIMARY KEY, installation_uuid TEXT NOT NULL);
INSERT INTO installation_identity VALUES (1, '123e4567-e89b-42d3-a456-426614174000');
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`;
// The login lookup in auth-db-query, unchanged.
const LOOKUP_SQL = 'SELECT users.*, (SELECT installation_uuid FROM installation_identity WHERE singleton_id=1) AS installation_uuid FROM users WHERE username = ? OR server_username = ? ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id ASC';

const PROFILES = handoff.PROFILES.map((rel) => ({
  name: rel.includes('bcm2712') ? 'bcm2712' : 'bcm2709',
  rel,
  modules: path.join(ROOT, path.dirname(rel), 'node-red'),
}));

function nodeBody(profile) {
  const flows = handoff.readProfile(ROOT, profile.rel);
  if (process.env.LOCAL_SIGNIN_NODE === 'shipped') return flows.find((n) => n.id === 'auth-process-result');
  const patch = handoff.loadPatch();
  return handoff.patchedFlows(ROOT, profile.rel, patch).find((n) => n.id === patch.id);
}

// One gateway: a node:sqlite database plus the hooks a test uses to make one
// statement fail.
// sqlite3 stand-in for the real osi-db-helper: every open goes to dbPath.
function sqlite3Driver(dbPath) {
  return class Driver {
    constructor(_file, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(dbPath);
      setImmediate(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      setImmediate(() => {
        try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); } catch (error) { callback.call(this, error); }
      });
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      setImmediate(() => {
        try {
          const out = this.native.prepare(sql).run(...(params || []));
          callback.call({ changes: Number(out.changes), lastID: Number(out.lastInsertRowid) }, null);
        } catch (error) { callback.call(this, error); }
      });
    }
    exec(sql, callback) {
      setImmediate(() => {
        try { this.native.exec(sql); callback.call(this, null); } catch (error) { callback.call(this, error); }
      });
    }
    close(callback) {
      setImmediate(() => {
        let error = null;
        try { this.native.close(); } catch (closeError) { error = closeError; }
        if (callback) callback.call(this, error);
      });
    }
  };
}

function loadRealHelper(profile, dbPath) {
  const helperPath = path.join(profile.modules, 'osi-db-helper', 'index.js');
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) {
      return { Database: sqlite3Driver(dbPath), OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
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

// realHelper: the node opens the farming database through the profile's real
// osi-db-helper (temp file) instead of the in-memory facade.
function gateway(profile, { realHelper = false } = {}) {
  const dir = realHelper ? fs.mkdtempSync(path.join(os.tmpdir(), 'osi-local-signin-')) : null;
  const native = new DatabaseSync(realHelper ? path.join(dir, 'farming.db') : ':memory:');
  if (realHelper) native.exec('PRAGMA journal_mode=WAL;');
  native.exec(USERS_SQL);
  const realDb = realHelper ? loadRealHelper(profile, path.join(dir, 'farming.db')) : null;
  const hooks = [];
  const statements = [];
  let opens = 0;
  function maybeFail(sql) {
    statements.push(sql);
    const hook = hooks.find((h) => !h.fired && h.match.test(sql));
    if (hook) {
      hook.fired = !hook.always;
      // A hook with `before` changes the database ahead of the statement
      // (a concurrent writer) and lets the statement run.
      if (hook.before) { hook.before(native); return; }
      throw new Error(hook.message || 'injected failure');
    }
  }
  const tx = {
    async get(sql, params = []) { maybeFail(sql); return native.prepare(sql).get(...params); },
    async run(sql, params = []) { maybeFail(sql); native.prepare(sql).run(...params); return undefined; },
  };
  class Database {
    constructor(filename) {
      assert.equal(filename, '/data/db/farming.db');
      opens += 1;
      this.closed = false;
    }
    async get(sql, params) { return tx.get(sql, params); }
    async run(sql, params) { return tx.run(sql, params); }
    async transaction(executor) {
      native.exec('BEGIN IMMEDIATE;');
      try {
        const result = await executor(tx);
        native.exec('COMMIT;');
        return result;
      } catch (error) {
        native.exec('ROLLBACK;');
        throw error;
      }
    }
    async close() { this.closed = true; }
  }
  const bcrypt = require(path.join(profile.modules, 'node_modules/bcryptjs'));
  const local = require(path.join(profile.modules, 'osi-local-password-reset'));
  const installation = require(path.join(profile.modules, 'osi-installation-helper'));
  const available = { 'local-password-reset': true, 'osi-db-helper': true };
  const requested = [];
  const osiLib = {
    require(name) {
      requested.push(name);
      if (name === 'installation') return { ok: true, value: installation };
      if (name === 'local-password-reset' && available[name]) return { ok: true, value: local };
      if (name === 'osi-db-helper' && available[name]) return { ok: true, value: realDb || { Database } };
      return { ok: false, error: 'not available: ' + name };
    },
  };
  function addUser(fields) {
    const row = { created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...fields };
    const cols = Object.keys(row);
    native.prepare(`INSERT INTO users(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    return native.prepare('SELECT * FROM users WHERE username=?').get(row.username);
  }
  const user = (id) => ({ ...native.prepare('SELECT * FROM users WHERE id=?').get(id) });
  const pending = (id) => native.prepare('SELECT value FROM app_settings WHERE key=?').get(local.CHANGE_KEY_PREFIX + id);
  const writes = () => statements.filter((s) => /^(UPDATE|INSERT|DELETE)/.test(s));

  async function login(body, env = {}) {
    const node = nodeBody(profile);
    const warnings = [];
    const errors = [];
    const rows = native.prepare(LOOKUP_SQL).all(body.username, body.username, body.username).map((r) => ({ ...r }));
    const msg = {
      checkType: 'login',
      payload: rows,
      _authwork: { username: String(body.username).trim(), password: body.password },
      req: { body },
    };
    const fn = new vm.Script(`(async function(msg,node,flow,env,context,global){${node.func}\n})`)
      .runInNewContext({ Buffer, console, setTimeout, clearTimeout, bcrypt, crypto, osiLib });
    const nodeApi = { warn: (m) => warnings.push(String(m)), error: (m) => errors.push(String(m)), status() {} };
    const store = { get() { return undefined; }, set() {} };
    const envApi = { get: (k) => ({ AUTH_TOKEN_SECRET: SECRET, ...env })[k] };
    const out = await fn(msg, nodeApi, store, envApi, store, { get: () => undefined });
    assert.ok(Array.isArray(out) && out.length === 2, 'node answers on two outputs');
    assert.equal(out[0], null, 'login never continues to the insert node');
    return { status: out[1].statusCode, payload: JSON.parse(JSON.stringify(out[1].payload)), warnings, errors };
  }
  const cleanup = () => { native.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); };
  return {
    native, hooks, statements, addUser, user, pending, writes, login, bcrypt, available, requested, cleanup,
    get opens() { return opens; },
  };
}

function tokenClaims(token) {
  const [body, sig] = String(token).split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  assert.equal(sig, expected, 'token signature');
  return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

const BCRYPT_COST_10 = /^\$2[aby]\$10\$/;
const ORDINARY_CLAIMS = ['userId', 'username', 'iat', 'exp'];

// The sign-in step gate from the shipped settings.js (httpNodeMiddleware).
const SETTINGS_PATH = path.join(ROOT, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js');
function signInGate() {
  const original = console.error;
  console.error = (line, ...rest) => { if (!String(line).startsWith('[osi-db-startup]')) original(line, ...rest); };
  try {
    delete require.cache[SETTINGS_PATH];
    return require(SETTINGS_PATH).httpNodeMiddleware;
  } finally {
    console.error = original;
  }
}
// Answers 'allowed' or the refusal code for a request with this token.
function gateDecision(token, method, reqPath) {
  let decision = null;
  const res = { status(code) { decision = String(code); return this; }, json(body) { decision += ' ' + body.code; return this; } };
  signInGate()({ method, path: reqPath, headers: { authorization: 'Bearer ' + token } }, res, () => { decision = 'allowed'; });
  return decision;
}
const REFUSED = '403 password_change_required';

for (const profile of PROFILES) {
  const t = (name, fn) => test(`[${profile.name}] ${name}`, fn);

  t('a bcrypt value signs in with bcrypt only: no rehash, no database access, plain token payload', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync('owner-pass-1', 10) });
    const u = g.addUser({ username: 'grower', password_hash: g.bcrypt.hashSync('grower-pass-1', 10) });
    const before = g.user(u.id);
    const ok = await g.login({ username: 'grower', password: 'grower-pass-1' });
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.payload), ['token']);
    assert.equal(tokenClaims(ok.payload.token).userId, u.id);
    assert.deepEqual(g.user(u.id), before);
    assert.equal(g.opens, 0);
    assert.deepEqual(ok.warnings, []);
    assert.equal((await g.login({ username: 'grower', password: 'grower-pass-2' })).status, 401);
  });

  t('a bcrypt value is never compared as stored text, even when the password equals it', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync('owner-pass-1', 10) });
    const stored = g.bcrypt.hashSync('grower-pass-1', 10);
    g.addUser({ username: 'grower', password_hash: stored });
    assert.equal((await g.login({ username: 'grower', password: stored })).status, 401);
    // A malformed value that still starts with $2 stays on the bcrypt path.
    g.addUser({ username: 'broken', password_hash: '$2-not-a-real-hash' });
    const broken = await g.login({ username: 'broken', password: '$2-not-a-real-hash' });
    assert.equal(broken.status, 401);
    assert.deepEqual(g.writes(), []);
  });

  t('a value not yet in bcrypt form signs in, is rehashed at cost 10 before the token, and the next sign-in uses bcrypt', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync('owner-pass-1', 10) });
    const u = g.addUser({ username: 'grower', password_hash: 'synthetic-old-value-7', sync_version: 4 });
    const first = await g.login({ username: 'grower', password: 'synthetic-old-value-7' });
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.payload), ['token'], 'only the first account is asked to change');
    const after = g.user(u.id);
    assert.match(after.password_hash, BCRYPT_COST_10);
    assert.ok(g.bcrypt.compareSync('synthetic-old-value-7', after.password_hash));
    assert.equal(after.sync_version, 4, 'a rehash does not bump sync_version');
    assert.equal(g.pending(u.id), undefined);
    assert.deepEqual(first.warnings, []);
    g.statements.length = 0;
    const second = await g.login({ username: 'grower', password: 'synthetic-old-value-7' });
    assert.equal(second.status, 200);
    assert.deepEqual(g.writes(), [], 'the second sign-in compares with bcrypt and writes nothing');
    assert.equal(g.user(u.id).password_hash, after.password_hash);
  });

  t('a failed rehash write still signs in, warns visibly, and is retried at the next sign-in', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync('owner-pass-1', 10) });
    const u = g.addUser({ username: 'grower', password_hash: 'synthetic-old-value-8' });
    g.hooks.push({ match: /^UPDATE users SET password_hash/, message: 'disk I/O error' });
    const first = await g.login({ username: 'grower', password: 'synthetic-old-value-8' });
    assert.equal(first.status, 200);
    assert.ok(first.payload.token);
    assert.equal(g.user(u.id).password_hash, 'synthetic-old-value-8');
    assert.equal(first.warnings.length, 1);
    assert.match(first.warnings[0], /rehash failed for user \d+; it is retried at the next sign-in: disk I\/O error/);
    const second = await g.login({ username: 'grower', password: 'synthetic-old-value-8' });
    assert.equal(second.status, 200);
    assert.match(g.user(u.id).password_hash, BCRYPT_COST_10);
    assert.deepEqual(second.warnings, []);
  });

  t('without a database helper the sign-in still succeeds and warns', async () => {
    const g = gateway(profile);
    const u = g.addUser({ username: 'grower', password_hash: 'synthetic-old-value-9' });
    g.available['osi-db-helper'] = false;
    const res = await g.login({ username: 'grower', password: 'synthetic-old-value-9' });
    assert.equal(res.status, 200);
    assert.equal(res.payload.passwordChangeRequired, true, 'id 1 on a value not yet in bcrypt form');
    assert.equal(tokenClaims(res.payload.token).mustChangePassword, true, 'detected at sign-in, so the token is restricted');
    assert.equal(g.user(u.id).password_hash, 'synthetic-old-value-9');
    assert.ok(res.warnings.some((w) => /database unavailable/.test(w)));
    assert.ok(res.warnings.some((w) => /rehash skipped/.test(w)));
  });

  t('a wrong password on a value not yet in bcrypt form answers 401 and writes nothing', async () => {
    const g = gateway(profile);
    const owner = g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const res = await g.login({ username: 'first-owner', password: 'synthetic-old-value-2' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.payload, { message: 'Invalid username or password' });
    assert.equal(g.user(owner.id).password_hash, 'synthetic-old-value-1');
    assert.equal(g.opens, 0);
    assert.deepEqual(g.writes(), []);
    assert.equal((await g.login({ username: 'first-owner', password: 12345 })).status, 401, 'a non-string password');
  });

  t('the first account on a value not yet in bcrypt form gets a token and must set a new password, across sign-ins', async () => {
    const g = gateway(profile);
    const owner = g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1', sync_version: 2 });
    assert.equal(owner.id, 1);
    const first = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.equal(first.status, 200);
    assert.equal(tokenClaims(first.payload.token).userId, 1);
    assert.equal(first.payload.passwordChangeRequired, true);
    assert.match(g.user(1).password_hash, BCRYPT_COST_10, 'rehashed in the same request');
    assert.ok(g.pending(1), 'the pending change is recorded with the rehash');

    // The value is bcrypt now; the recorded requirement keeps the flag, and
    // it follows row 1, not its username (a cloud upsert can rename it).
    g.native.prepare("UPDATE users SET username='renamed-owner' WHERE id=1").run();
    const renamed = await g.login({ username: 'renamed-owner', password: 'synthetic-old-value-1' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.payload.passwordChangeRequired, true);
    g.native.prepare("UPDATE users SET username='first-owner' WHERE id=1").run();
    const second = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.equal(second.status, 200);
    assert.equal(second.payload.passwordChangeRequired, true);

    const short = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'abc' });
    assert.equal(short.status, 200);
    assert.equal(short.payload.passwordChangeRequired, true);
    assert.equal(short.payload.passwordChange, 'rejected');
    assert.equal(short.payload.passwordChangeError, 'password_too_short');
    const same = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'synthetic-old-value-1' });
    assert.equal(same.payload.passwordChangeError, 'password_unchanged');

    const changed = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' });
    assert.equal(changed.status, 200);
    assert.ok(changed.payload.token);
    assert.equal(changed.payload.passwordChange, 'changed');
    assert.equal(changed.payload.passwordChangeRequired, undefined);
    assert.equal(g.pending(1), undefined);
    assert.equal(g.user(1).sync_version, 3, 'a chosen password bumps sync_version like the admin reset');

    assert.equal((await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' })).status, 401);
    const after = await g.login({ username: 'first-owner', password: 'chosen-pass-42' });
    assert.equal(after.status, 200);
    assert.deepEqual(Object.keys(after.payload), ['token']);
  });

  t('the first account can set its new password in its first sign-in request', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const res = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' });
    assert.equal(res.status, 200);
    assert.equal(res.payload.passwordChange, 'changed');
    assert.equal(res.payload.passwordChangeRequired, undefined);
    assert.ok(g.bcrypt.compareSync('chosen-pass-42', g.user(1).password_hash));
    assert.equal(g.pending(1), undefined);
  });

  t('a failed new-password write keeps the token and the requirement, and warns', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    g.hooks.push({ match: /^DELETE FROM app_settings/, message: 'database is locked' });
    const res = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' });
    assert.equal(res.status, 200);
    assert.ok(res.payload.token);
    assert.equal(res.payload.passwordChange, 'failed');
    assert.equal(res.payload.passwordChangeRequired, true);
    assert.ok(g.bcrypt.compareSync('synthetic-old-value-1', g.user(1).password_hash), 'rolled back');
    assert.ok(g.pending(1));
    assert.ok(res.warnings.some((w) => /new password could not be stored for user 1: database is locked/.test(w)));
  });

  t('a failed pending-record write rolls back the rehash, warns, and both land at the next sign-in', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    g.hooks.push({ match: /^INSERT INTO app_settings/, message: 'database is locked' });
    const first = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.equal(first.status, 200);
    assert.ok(first.payload.token);
    assert.equal(first.payload.passwordChangeRequired, true);
    assert.equal(g.user(1).password_hash, 'synthetic-old-value-1', 'the rehash is not committed without the pending record');
    assert.equal(g.pending(1), undefined);
    assert.equal(first.warnings.length, 1);
    assert.match(first.warnings[0], /rehash failed for user 1; it is retried at the next sign-in: database is locked/);
    const second = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.equal(second.payload.passwordChangeRequired, true);
    assert.match(g.user(1).password_hash, BCRYPT_COST_10);
    assert.ok(g.pending(1));
    assert.deepEqual(second.warnings, []);
  });

  t('a new password with a wrong current password is refused with 401 and writes nothing', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const legacy = await g.login({ username: 'first-owner', password: 'synthetic-old-value-9', newPassword: 'chosen-pass-42' });
    assert.equal(legacy.status, 401);
    assert.equal(legacy.payload.token, undefined);
    assert.deepEqual(g.writes(), []);
    assert.equal(g.opens, 0);
    assert.equal(g.user(1).password_hash, 'synthetic-old-value-1');

    await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.ok(g.pending(1));
    const pendingHash = g.user(1).password_hash;
    const opens = g.opens;
    g.statements.length = 0;
    const pending = await g.login({ username: 'first-owner', password: 'synthetic-old-value-9', newPassword: 'chosen-pass-42' });
    assert.equal(pending.status, 401);
    assert.equal(pending.payload.token, undefined);
    assert.deepEqual(g.writes(), []);
    assert.equal(g.opens, opens);
    assert.equal(g.user(1).password_hash, pendingHash);
    assert.ok(g.pending(1));
  });

  t('a password that is not a string answers 401 against a bcrypt value and warns', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync('owner-pass-1', 10) });
    g.addUser({ username: 'grower', password_hash: g.bcrypt.hashSync('grower-pass-1', 10) });
    for (const password of [12345, { value: 'grower-pass-1' }, ['grower-pass-1']]) {
      const res = await g.login({ username: 'grower', password });
      assert.equal(res.status, 401, JSON.stringify(password));
      assert.deepEqual(res.payload, { message: 'Invalid username or password' });
      assert.ok(res.warnings.some((w) => /password comparison failed/.test(w)), JSON.stringify(res.warnings));
    }
    assert.deepEqual(g.writes(), []);
  });

  t('a new password longer than 72 bytes is rejected like a short one and stores nothing', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    const before = g.user(1).password_hash;
    const long = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'x'.repeat(73) });
    assert.equal(long.status, 200);
    assert.equal(long.payload.passwordChange, 'rejected');
    assert.equal(long.payload.passwordChangeError, 'password_too_long');
    assert.equal(long.payload.passwordChangeRequired, true);
    // 37 two-byte characters are 74 bytes although only 37 characters long.
    const wide = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: '\u00e9'.repeat(37) });
    assert.equal(wide.payload.passwordChangeError, 'password_too_long');
    assert.equal(g.user(1).password_hash, before);
    assert.ok(g.pending(1));
    const exact = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'y'.repeat(72) });
    assert.equal(exact.payload.passwordChange, 'changed');
  });

  t('a new password racing another writer is not stored and the sign-in answers 401', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    const concurrent = g.bcrypt.hashSync('reset-by-admin-7', 10);
    // The other writer lands after this request read the account and before
    // its write transaction starts.
    g.hooks.push({
      match: /^SELECT 1 AS pending FROM app_settings/,
      before: (native) => native.prepare('UPDATE users SET password_hash=? WHERE id=1').run(concurrent),
    });
    const res = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' });
    assert.equal(res.status, 401, 'the password this request verified is no longer current');
    assert.deepEqual(res.payload, { message: 'Invalid username or password' });
    assert.equal(g.user(1).password_hash, concurrent);
    assert.ok(g.pending(1));
    assert.ok(res.warnings.some((w) => /new password could not be stored for user 1: password change matched 0 rows/.test(w)));
  });

  t('the sign-in step token is refused on protected routes until the new password is set (first sign-in)', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const first = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    const pending = first.payload.token;
    assert.deepEqual(Object.keys(tokenClaims(pending)), [...ORDINARY_CLAIMS, 'mustChangePassword']);
    assert.equal(gateDecision(pending, 'GET', '/api/devices'), REFUSED);
    assert.equal(gateDecision(pending, 'POST', '/api/valve/A840410000000001'), REFUSED);
    assert.equal(gateDecision(pending, 'GET', '/api/me'), 'allowed');
    assert.equal(gateDecision(pending, 'POST', '/auth/login'), 'allowed');
    const changed = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' });
    assert.equal(changed.payload.passwordChange, 'changed');
    assert.deepEqual(Object.keys(tokenClaims(changed.payload.token)), ORDINARY_CLAIMS);
    assert.equal(gateDecision(changed.payload.token, 'GET', '/api/devices'), 'allowed');
    assert.equal(gateDecision(pending, 'GET', '/api/devices'), REFUSED, 'the earlier step token stays restricted');
    const later = await g.login({ username: 'first-owner', password: 'chosen-pass-42' });
    assert.deepEqual(Object.keys(tokenClaims(later.payload.token)), ORDINARY_CLAIMS);
  });

  t('the sign-in step token is refused while the recorded requirement is pending (bcrypt value)', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.match(g.user(1).password_hash, BCRYPT_COST_10);
    const again = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.equal(again.payload.passwordChangeRequired, true);
    assert.equal(tokenClaims(again.payload.token).mustChangePassword, true);
    assert.equal(gateDecision(again.payload.token, 'GET', '/api/irrigation-zones'), REFUSED);
    assert.equal(gateDecision(again.payload.token, 'GET', '/api/me'), 'allowed');
    const changed = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' });
    assert.equal(gateDecision(changed.payload.token, 'GET', '/api/irrigation-zones'), 'allowed');
  });

  t('other local accounts and linked accounts get ordinary tokens the gate lets through', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync('owner-pass-1', 10) });
    g.addUser({ username: 'grower', password_hash: 'synthetic-old-value-2' });
    g.addUser({
      username: 'edge-linked', server_username: 'cloud-linked', auth_mode: 'server',
      server_password_hash: g.bcrypt.hashSync('linked-pass-1', 10), password_hash: 'synthetic-old-value-3',
    });
    for (const [body, env] of [
      [{ username: 'first-owner', password: 'owner-pass-1' }, {}],
      [{ username: 'grower', password: 'synthetic-old-value-2' }, {}],
      [{ username: 'cloud-linked', password: 'linked-pass-1' }, { DEVICE_EUI: '0016C001F1000001' }],
    ]) {
      const res = await g.login(body, env);
      assert.equal(res.status, 200, body.username);
      assert.deepEqual(Object.keys(res.payload), ['token']);
      assert.deepEqual(Object.keys(tokenClaims(res.payload.token)), ORDINARY_CLAIMS, body.username);
      assert.equal(gateDecision(res.payload.token, 'GET', '/api/devices'), 'allowed', body.username);
    }
  });

  t('a new password that bcrypt cannot tell apart from the current one is refused', async () => {
    const g = gateway(profile);
    const current = 'a'.repeat(72);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync(current, 10) });
    g.native.prepare("INSERT INTO app_settings(key,value) VALUES('local_password_change_required:1','{}')").run();
    const res = await g.login({ username: 'first-owner', password: current + 'x', newPassword: current });
    assert.equal(res.status, 200);
    assert.equal(res.payload.passwordChange, 'rejected');
    assert.equal(res.payload.passwordChangeError, 'password_unchanged');
    assert.equal(res.payload.passwordChangeRequired, true);
    assert.ok(g.pending(1), 'the requirement stays recorded');
    assert.ok(g.bcrypt.compareSync(current, g.user(1).password_hash));
  });

  t('a stored value longer than 72 bytes is kept, not rehashed, and its prefix does not sign in', async () => {
    const g = gateway(profile);
    const long = 'a'.repeat(72) + 'secret';
    g.addUser({ username: 'first-owner', password_hash: long });
    const u = g.addUser({ username: 'grower', password_hash: long + '-2' });
    const grower = await g.login({ username: 'grower', password: long + '-2' });
    assert.equal(grower.status, 200);
    assert.equal(g.user(u.id).password_hash, long + '-2');
    assert.ok(grower.warnings.some((w) => /rehash skipped for user \d+: password longer than 72 bytes/.test(w)));
    assert.equal((await g.login({ username: 'grower', password: 'a'.repeat(72) })).status, 401);

    const first = await g.login({ username: 'first-owner', password: long });
    assert.equal(first.status, 200);
    assert.equal(first.payload.passwordChangeRequired, true);
    assert.equal(gateDecision(first.payload.token, 'GET', '/api/devices'), REFUSED);
    assert.equal(g.user(1).password_hash, long);
    assert.equal(g.pending(1), undefined);
    assert.equal((await g.login({ username: 'first-owner', password: 'a'.repeat(72) })).status, 401);
    const changed = await g.login({ username: 'first-owner', password: long, newPassword: 'chosen-pass-42' });
    assert.equal(changed.payload.passwordChange, 'changed');
    assert.equal(gateDecision(changed.payload.token, 'GET', '/api/devices'), 'allowed');
  });

  t('a pending record that cannot be read still asks for a new password and leaves the token ordinary', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    g.hooks.push({ match: /^SELECT 1 AS pending FROM app_settings/, message: 'no such table: app_settings' });
    const res = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
    assert.equal(res.status, 200);
    assert.equal(res.payload.passwordChangeRequired, true);
    assert.deepEqual(Object.keys(tokenClaims(res.payload.token)), ORDINARY_CLAIMS);
    assert.ok(res.warnings.some((w) => /pending password change could not be read; asking for a new password: no such table: app_settings/.test(w)));

    const h = gateway(profile);
    h.addUser({ username: 'first-owner', password_hash: h.bcrypt.hashSync('owner-pass-1', 10) });
    h.available['osi-db-helper'] = false;
    const noDb = await h.login({ username: 'first-owner', password: 'owner-pass-1' });
    assert.equal(noDb.payload.passwordChangeRequired, true);
    assert.deepEqual(Object.keys(tokenClaims(noDb.payload.token)), ORDINARY_CLAIMS);
    assert.ok(noDb.warnings.some((w) => /pending password change could not be read; asking for a new password$/.test(w)));
  });

  t('a correct password on a disabled account answers 403 and writes nothing', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1', disabled_at: '2026-02-01T00:00:00.000Z' });
    const res = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' }, { OSI_SCOPED_ACCESS: '1' });
    assert.equal(res.status, 403);
    assert.equal(res.payload.token, undefined);
    assert.equal(g.user(1).password_hash, 'synthetic-old-value-1');
    assert.equal(g.pending(1), undefined);
    assert.equal(g.opens, 0);
    assert.deepEqual(g.writes(), []);
  });

  t('a new password is ignored without a pending change, and refused for a disabled account', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: g.bcrypt.hashSync('owner-pass-1', 10) });
    const ignored = await g.login({ username: 'first-owner', password: 'owner-pass-1', newPassword: 'chosen-pass-42' });
    assert.deepEqual(Object.keys(ignored.payload), ['token']);
    assert.ok(g.bcrypt.compareSync('owner-pass-1', g.user(1).password_hash));

    const h = gateway(profile);
    h.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1', disabled_at: '2026-02-01T00:00:00.000Z' });
    const scoped = { OSI_SCOPED_ACCESS: '1' };
    const res = await h.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' }, scoped);
    assert.equal(res.status, 403);
    assert.equal(res.payload.token, undefined);
    assert.ok(!h.bcrypt.compareSync('chosen-pass-42', h.user(1).password_hash));
  });

  t('through the real osi-db-helper: rehash, pending record and new password all land', async () => {
    const g = gateway(profile, { realHelper: true });
    try {
      g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1', sync_version: 5 });
      const u = g.addUser({ username: 'grower', password_hash: 'synthetic-old-value-2' });
      const grower = await g.login({ username: 'grower', password: 'synthetic-old-value-2' });
      assert.equal(grower.status, 200);
      assert.deepEqual(grower.warnings, []);
      assert.match(g.user(u.id).password_hash, BCRYPT_COST_10);

      const first = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
      assert.equal(first.payload.passwordChangeRequired, true);
      assert.deepEqual(first.warnings, []);
      assert.match(g.user(1).password_hash, BCRYPT_COST_10);
      assert.ok(g.pending(1));
      const again = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1' });
      assert.equal(again.payload.passwordChangeRequired, true);

      const changed = await g.login({ username: 'first-owner', password: 'synthetic-old-value-1', newPassword: 'chosen-pass-42' });
      assert.equal(changed.payload.passwordChange, 'changed');
      assert.deepEqual(changed.warnings, []);
      assert.equal(g.pending(1), undefined);
      assert.equal(g.user(1).sync_version, 6);
      assert.ok(g.bcrypt.compareSync('chosen-pass-42', g.user(1).password_hash));
    } finally {
      g.cleanup();
    }
  });

  t('a missing local helper answers 503 for local accounts only', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'grower', password_hash: g.bcrypt.hashSync('grower-pass-1', 10) });
    g.available['local-password-reset'] = false;
    const res = await g.login({ username: 'grower', password: 'grower-pass-1' });
    assert.equal(res.status, 503);
    assert.ok(res.warnings.some((w) => /local-password-reset unavailable/.test(w)));
  });

  t('linked accounts sign in exactly as before and never load the local helper', async () => {
    const g = gateway(profile);
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const linked = g.addUser({
      username: 'edge-linked', server_username: 'cloud-linked', auth_mode: 'server',
      server_password_hash: g.bcrypt.hashSync('linked-pass-1', 10), password_hash: 'unused-local-value',
    });
    const verifierUser = g.addUser({
      username: 'edge-verifier', server_username: 'cloud-verifier', auth_mode: 'server',
      server_offline_verifier: g.bcrypt.hashSync('linked-pass-2::0016C001F1000001', 10),
      server_offline_verifier_version: 1, password_hash: 'unused-local-value',
    });
    const env = { DEVICE_EUI: '0016C001F1000001' };
    const cases = [
      [{ username: 'cloud-linked', password: 'linked-pass-1' }, 200, linked.id],
      [{ username: 'cloud-linked', password: 'unused-local-value' }, 401],
      [{ username: 'cloud-verifier', password: 'linked-pass-2' }, 200, verifierUser.id],
      [{ username: 'cloud-verifier', password: 'linked-pass-3' }, 401],
    ];
    for (const [body, status, userId] of cases) {
      const res = await g.login(body, env);
      assert.equal(res.status, status, JSON.stringify(body));
      if (userId) {
        assert.deepEqual(Object.keys(res.payload), ['token']);
        assert.equal(tokenClaims(res.payload.token).userId, userId);
      } else {
        assert.deepEqual(res.payload, { message: 'Invalid username or password' });
      }
    }
    assert.ok(!g.requested.includes('local-password-reset'));
    assert.deepEqual(g.writes(), []);
    assert.equal(g.user(linked.id).password_hash, 'unused-local-value');
  });
}

test('both profiles ship the staged body and identical module copies', () => {
  const shipped = PROFILES.map((p) => handoff.readProfile(ROOT, p.rel).find((n) => n.id === 'auth-process-result').func);
  assert.equal(shipped[0], shipped[1]);
  assert.equal(shipped[0], handoff.loadPatch().func, 'run node scripts/local-signin-handoff.js --apply');
  const [m1, m2] = PROFILES.map((p) => fs.readFileSync(path.join(p.modules, 'osi-local-password-reset/index.js'), 'utf8'));
  assert.equal(m1, m2);
});
