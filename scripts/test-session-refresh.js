#!/usr/bin/env node
'use strict';
// One-time refresh of local sessions (osi-local-password-reset
// refreshSessionsOnce, called from settings.js at Node-RED start).
//
// The shipped auth-process-result body signs tokens and osi-scope-helper
// verifyBearer checks them; both read the session secret through an fs whose
// two secret paths are redirected to a temporary directory. The database is a
// node:sqlite file; the sqlite3 CLI the refresh uses is replaced by a stand-in
// over the same file, and one test runs the real CLI when it is installed.
//
// Run: node --test scripts/test-session-refresh.js
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const MODULES = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const local = require(path.join(MODULES, 'osi-local-password-reset'));
const scope = require(path.join(MODULES, 'osi-scope-helper'));
const installation = require(path.join(MODULES, 'osi-installation-helper'));
const bcrypt = require(path.join(MODULES, 'node_modules/bcryptjs'));
const handoff = require('./local-signin-handoff');

const LOOKUP_SQL = 'SELECT users.*, (SELECT installation_uuid FROM installation_identity WHERE singleton_id=1) AS installation_uuid FROM users WHERE username = ? OR server_username = ? ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id ASC';
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY_EUI = '0016C001F1000001';

function gateway({ withSettings = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-session-refresh-'));
  const dbPath = path.join(dir, 'farming.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SEED);
  if (!withSettings) db.exec('DROP TABLE app_settings');
  db.prepare('INSERT OR REPLACE INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at) VALUES(1,?,?,?,?)')
    .run('123e4567-e89b-42d3-a456-426614174000', GATEWAY_EUI, '2026-01-01', '2026-01-01');
  const secretPaths = [path.join(dir, 'data-db-secret'), path.join(dir, 'fallback-secret')];
  const markerPath = path.join(dir, 'osi_session_refresh_v1');
  fs.writeFileSync(secretPaths[0], crypto.randomBytes(48).toString('hex') + '\n', { mode: 0o600 });
  // The node and the scope helper read the two shipped secret paths.
  const redirect = new Map(local.SESSION_SECRET_PATHS.map((shipped, i) => [shipped, secretPaths[i]]));
  const gatewayFs = { ...fs, readFileSync: (p, ...rest) => fs.readFileSync(redirect.get(p) || p, ...rest),
    writeFileSync: (p, ...rest) => fs.writeFileSync(redirect.get(p) || p, ...rest) };
  const spawned = [];
  // Stand-in for execFile('sqlite3', ['-readonly', '-cmd', '.timeout 2000', <db>, <sql>]).
  function execFile(command, args, opts, callback) {
    spawned.push(args[args.length - 1]);
    assert.equal(command, 'sqlite3');
    assert.deepEqual(args.slice(0, 3), ['-readonly', '-cmd', '.timeout 2000']);
    setImmediate(() => {
      try {
        const reader = new DatabaseSync(args[3], { readOnly: true });
        try {
          const row = reader.prepare(args[4]).get();
          callback(null, String(Object.values(row)[0]) + '\n', '');
        } finally {
          reader.close();
        }
      } catch (error) {
        callback(Object.assign(new Error('Command failed'), { code: 1 }), '', 'Error: ' + error.message);
      }
    });
  }
  function addUser(fields) {
    const row = { created_at: '2026-01-01', user_uuid: crypto.randomUUID(), ...fields };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO users(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    return db.prepare('SELECT * FROM users WHERE username=?').get(row.username);
  }
  function refresh(extra = {}) {
    return local.refreshSessionsOnce({ fs, execFile, crypto, env: {}, markerPath, secretPaths, dbPath, warn: (m) => warnings.push(m), ...extra });
  }
  const warnings = [];
  class Database {
    async get(sql, params = []) { return db.prepare(sql).get(...params); }
    async run(sql, params = []) { db.prepare(sql).run(...params); }
    async transaction(executor) {
      db.exec('BEGIN IMMEDIATE;');
      try { const r = await executor(this); db.exec('COMMIT;'); return r; } catch (e) { db.exec('ROLLBACK;'); throw e; }
    }
    async close() {}
  }
  const osiLib = { require(name) {
    if (name === 'installation') return { ok: true, value: installation };
    if (name === 'local-password-reset') return { ok: true, value: local };
    if (name === 'osi-db-helper') return { ok: true, value: { Database } };
    return { ok: false, error: 'not available: ' + name };
  } };
  // Signs in through the shipped auth-process-result body (flag off, no
  // configured secret: the node reads the secret file).
  async function login(body, env = {}) {
    const node = handoff.readProfile(ROOT, handoff.PROFILES[0]).find((n) => n.id === 'auth-process-result');
    const rows = db.prepare(LOOKUP_SQL).all(body.username, body.username, body.username).map((r) => ({ ...r }));
    const msg = { checkType: 'login', payload: rows, _authwork: { username: body.username, password: body.password }, req: { body } };
    const fn = new vm.Script(`(async function(msg,node,flow,env,context,global){${node.func}\n})`)
      .runInNewContext({ Buffer, console, setTimeout, clearTimeout, bcrypt, crypto, osiLib });
    const store = { get() { return undefined; }, set() {} };
    const out = await fn(msg, { warn: (m) => warnings.push(m), error() {}, status() {} }, store,
      { get: (k) => env[k] }, store, { get: (k) => (k === 'fs' ? gatewayFs : undefined) });
    return { status: out[1].statusCode, payload: JSON.parse(JSON.stringify(out[1].payload)) };
  }
  // Verifies a bearer token the way every protected route does.
  function verify(token) {
    try {
      return scope.verifyBearer('Bearer ' + token, { fs: gatewayFs });
    } catch (error) {
      return { refused: error.statusCode, message: error.message };
    }
  }
  const secret = () => fs.readFileSync(secretPaths[0], 'utf8');
  const marker = () => (fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null);
  const dump = () => JSON.stringify(['users', 'installation_identity', 'app_settings']
    .filter((t) => db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t))
    .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { db, dbPath, secretPaths, markerPath, spawned, warnings, addUser, refresh, login, verify, secret, marker, dump, cleanup };
}

test('an account that still needs the sign-in step: earlier sessions end once, a fresh offline sign-in works', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    g.addUser({ username: 'grower', password_hash: bcrypt.hashSync('grower-pass-1', 4) });
    const before = await g.login({ username: 'grower', password: 'grower-pass-1' });
    const oldToken = before.payload.token;
    assert.equal(g.verify(oldToken).username, 'grower');
    const oldSecret = g.secret();

    assert.deepEqual(await g.refresh(), { status: 'rotated', message: 'local sessions refreshed once after the sign-in update' });
    assert.notEqual(g.secret(), oldSecret);
    assert.match(g.secret(), /^[0-9a-f]{96}\n$/);
    assert.equal(fs.statSync(g.secretPaths[0]).mode & 0o777, 0o600);
    assert.equal(g.marker().status, 'rotated');
    assert.deepEqual(g.verify(oldToken), { refused: 401, message: 'Invalid token' });

    const fresh = await g.login({ username: 'grower', password: 'grower-pass-1' });
    assert.equal(fresh.status, 200);
    assert.equal(g.verify(fresh.payload.token).username, 'grower');
  } finally {
    g.cleanup();
  }
});

test('a pending record on a bcrypt value also refreshes sessions once', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: bcrypt.hashSync('owner-pass-1', 4) });
    g.db.prepare("INSERT INTO app_settings(key,value) VALUES('local_password_change_required:1','{}')").run();
    assert.equal((await g.refresh()).status, 'rotated');
  } finally {
    g.cleanup();
  }
});

test('the linked account keeps its link and signs in offline after the refresh', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const linked = g.addUser({
      username: 'edge-linked', server_username: 'cloud-linked', auth_mode: 'server', password_hash: 'unused-local',
      server_offline_verifier: bcrypt.hashSync('linked-pass-1::' + GATEWAY_EUI, 4), server_offline_verifier_version: 1,
      server_sync_token: 'synthetic-sync-token-1', server_sync_token_expires_at: 9999999999999,
      server_url: 'https://cloud.example.invalid', cloud_user_id: 101, server_linked_at: '2026-01-01',
    });
    const env = { DEVICE_EUI: GATEWAY_EUI };
    const before = await g.login({ username: 'cloud-linked', password: 'linked-pass-1' }, env);
    assert.equal(before.status, 200);
    const dump = g.dump();
    assert.equal((await g.refresh()).status, 'rotated');
    assert.equal(g.dump(), dump, 'the refresh reads the database only');
    assert.equal(g.verify(before.payload.token).refused, 401);
    const after = await g.login({ username: 'cloud-linked', password: 'linked-pass-1' }, env);
    assert.equal(after.status, 200);
    assert.equal(g.verify(after.payload.token).userId, linked.id);
    assert.equal(g.db.prepare('SELECT server_sync_token FROM users WHERE id=?').get(linked.id).server_sync_token, 'synthetic-sync-token-1');
  } finally {
    g.cleanup();
  }
});

test('no account needs the step: sessions are kept and the marker is written', async () => {
  for (const withSettings of [true, false]) {
    const g = gateway({ withSettings });
    try {
      g.addUser({ username: 'first-owner', password_hash: bcrypt.hashSync('owner-pass-1', 4) });
      const token = (await g.login({ username: 'first-owner', password: 'owner-pass-1' })).payload.token;
      const secret = g.secret();
      assert.deepEqual(await g.refresh(), { status: 'not_needed', message: '' });
      assert.equal(g.secret(), secret);
      assert.equal(g.marker().status, 'not_needed');
      assert.equal(g.verify(token).username, 'first-owner');
    } finally {
      g.cleanup();
    }
  }
});

test('a linked account in row 1 does not count: its local value is never used to sign in', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'edge-linked', server_username: 'cloud-linked', auth_mode: 'server', password_hash: 'unused-local' });
    const secret = g.secret();
    assert.equal((await g.refresh()).status, 'not_needed');
    assert.equal(g.secret(), secret);
  } finally {
    g.cleanup();
  }
});

test('the refresh never runs twice, even when an account needs the step later', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    assert.equal((await g.refresh()).status, 'rotated');
    const secret = g.secret();
    const queries = g.spawned.length;
    assert.deepEqual(await g.refresh(), { status: 'done', message: '' });
    g.db.prepare("INSERT INTO app_settings(key,value) VALUES('local_password_change_required:1','{}')").run();
    assert.deepEqual(await g.refresh(), { status: 'done', message: '' });
    assert.equal(g.secret(), secret);
    assert.equal(g.spawned.length, queries, 'no query once the marker exists');
  } finally {
    g.cleanup();
  }
});

test('a check that cannot read the database writes no marker and runs again at the next start', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const secret = g.secret();
    const failed = await g.refresh({ dbPath: path.join(path.dirname(g.dbPath), 'missing.db') });
    assert.deepEqual(failed, { status: 'retry', message: '' });
    assert.equal(g.marker(), null);
    assert.equal(g.secret(), secret);
    assert.ok(g.warnings.some((w) => /session refresh check did not run; it is tried again at the next start/.test(w)));
    assert.equal((await g.refresh()).status, 'rotated');
  } finally {
    g.cleanup();
  }
});

test('a secret set in the environment is left alone and the marker records why', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const secret = g.secret();
    assert.equal((await g.refresh({ env: { AUTH_TOKEN_SECRET: 'configured-value-not-real' } })).status, 'configured_secret');
    assert.equal(g.secret(), secret);
    assert.equal(g.marker().status, 'configured_secret');
    assert.ok(g.warnings.some((w) => /set in the environment/.test(w)));
  } finally {
    g.cleanup();
  }
});

test('only the fallback secret exists: that one is replaced', async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    const value = g.secret();
    fs.rmSync(g.secretPaths[0]);
    fs.writeFileSync(g.secretPaths[1], value);
    assert.equal((await g.refresh()).status, 'rotated');
    assert.notEqual(fs.readFileSync(g.secretPaths[1], 'utf8'), value);
    assert.equal(fs.existsSync(g.secretPaths[0]), false);
  } finally {
    g.cleanup();
  }
});

test('the real sqlite3 CLI gives the same answer', { skip: childProcess.spawnSync('sqlite3', ['-version']).status !== 0 && 'sqlite3 CLI not installed' }, async () => {
  const g = gateway();
  try {
    g.addUser({ username: 'first-owner', password_hash: 'synthetic-old-value-1' });
    assert.equal((await g.refresh({ execFile: childProcess.execFile })).status, 'rotated');
  } finally {
    g.cleanup();
  }
});
