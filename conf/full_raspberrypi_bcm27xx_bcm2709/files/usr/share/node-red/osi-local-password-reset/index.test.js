'use strict';
// Co-located tests for osi-local-password-reset (#521). They call
// resetLocalPassword directly against a seeded node:sqlite database through a
// small facade with osi-db-helper's transaction contract (BEGIN IMMEDIATE,
// COMMIT, ROLLBACK, rollbackError on a failed ROLLBACK) and the real scope
// helper. scripts/test-linked-password-reset.js runs the same module through
// the shipped account router and the real osi-db-helper.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const reset = require('./index');
const scope = require('../osi-scope-helper');

const repo = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');
const NOW = '2026-11-09T10:00:00.000Z';
const PASSWORD = 'new-reset-pass-521';
const LINKED = {
  code: 'linked_account_password_reset_unsupported',
  message: 'This account uses linked sign-in. Its password cannot be reset on this gateway. ' +
    'Ask the linked-identity administrator for the approved recovery process.',
};
const RESET_FAILED = { message: 'The password reset could not be completed. Reload the user list before trying again.' };
const UNKNOWN_MODE = { message: 'The account sign-in type is not recognized. The password was not changed.' };
const UPDATE_SQL = /^UPDATE users SET password_hash=\?/;

// hooks: [{ method, match, before(native), after(native), rows, error }];
// each fires once.
function fixture() {
  const native = new DatabaseSync(':memory:');
  native.exec(SEED);
  const log = [];
  const hooks = [];
  const warnings = [];
  const hashes = [];
  function take(method, sql) {
    const hook = hooks.find((h) => !h.fired && h.method === method && h.match.test(sql));
    if (hook) hook.fired = true;
    return hook;
  }
  function connection(kind) {
    return {
      async get(sql, params = []) {
        log.push([kind, 'get', sql]);
        const hook = take('get', sql);
        if (hook && hook.before) hook.before(native);
        if (hook && hook.error) throw hook.error;
        const result = hook && hook.rows ? hook.rows[0] : native.prepare(sql).get(...params);
        if (hook && hook.after) hook.after(native);
        return result;
      },
      async all(sql, params = []) {
        log.push([kind, 'all', sql]);
        return native.prepare(sql).all(...params);
      },
      async run(sql, params = []) {
        log.push([kind, 'run', sql]);
        const hook = take('run', sql);
        if (hook && hook.before) hook.before(native);
        if (hook && hook.error) throw hook.error;
        const out = native.prepare(sql).run(...params);
        return { changes: Number(out.changes), lastID: Number(out.lastInsertRowid) };
      },
    };
  }
  function exec(sql) {
    log.push(['db', 'exec', sql]);
    const hook = take('exec', sql);
    if (hook && hook.error) throw hook.error;
    native.exec(sql);
  }
  const db = connection('db');
  db.transaction = async function(executor) {
    exec('BEGIN IMMEDIATE;');
    try {
      const result = await executor(connection('tx'));
      exec('COMMIT;');
      return result;
    } catch (error) {
      try { exec('ROLLBACK;'); } catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
  };
  function user(name, fields = {}) {
    const row = {
      username: name, password_hash: `old-hash-${name}`, created_at: '2026-01-01', updated_at: '2026-01-01',
      user_uuid: crypto.randomUUID(), role: 'researcher', auth_mode: 'local', sync_version: 1, ...fields,
    };
    const columns = Object.keys(row);
    native.prepare(`INSERT INTO users(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...columns.map((c) => row[c]));
    return native.prepare('SELECT * FROM users WHERE username=?').get(name);
  }
  const admin = user('admin1', { role: 'admin' });
  user('admin2', { role: 'admin' });
  const researcher = user('research1');
  const linked = user('linked1', { auth_mode: 'server', server_username: 'linked1-cloud' });
  const bcrypt = { hashSync(value, rounds) { hashes.push(rounds); return `hash:${value}`; } };
  const node = { warn(message) { warnings.push(String(message)); } };
  function call(userUuid, body = { password: PASSWORD }) {
    return reset.resetLocalPassword({
      db, scope, bcrypt, node, body, userUuid, now: NOW,
      auth: { userId: admin.id, username: admin.username },
      actor: { user_uuid: admin.user_uuid, role: admin.role },
    });
  }
  const row = (uuid) => ({ ...native.prepare('SELECT * FROM users WHERE user_uuid=?').get(uuid) });
  const users = () => native.prepare('SELECT * FROM users ORDER BY id').all().map((r) => ({ ...r }));
  const updates = () => log.filter((e) => e[1] === 'run' && UPDATE_SQL.test(e[2]));
  const begins = () => log.filter((e) => e[1] === 'exec' && /^BEGIN/.test(e[2])).length;
  return { native, log, hooks, warnings, hashes, admin, researcher, linked, user, call, row, users, updates, begins };
}

test('a local account resets: one hash at cost 10, one conditional UPDATE, only the target changes', async () => {
  const f = fixture();
  const before = f.users();
  assert.deepEqual(await f.call(f.researcher.user_uuid), { statusCode: 200, payload: { success: true } });
  assert.deepEqual(f.hashes, [10]);
  assert.equal(f.updates().length, 1);
  assert.equal(f.updates()[0][0], 'tx', 'the UPDATE runs on the transaction connection');
  assert.match(f.updates()[0][2], /WHERE user_uuid=\? AND auth_mode='local'$/);
  const after = f.users();
  for (const [i, prior] of before.entries()) {
    if (prior.user_uuid !== f.researcher.user_uuid) { assert.deepEqual(after[i], prior); continue; }
    assert.equal(after[i].password_hash, `hash:${PASSWORD}`);
    assert.equal(after[i].updated_at, NOW);
    assert.equal(after[i].sync_version, prior.sync_version + 1);
    assert.deepEqual({ ...after[i], password_hash: 0, updated_at: 0, sync_version: 0 },
      { ...prior, password_hash: 0, updated_at: 0, sync_version: 0 });
  }
  assert.deepEqual(f.warnings, []);
});

test('the temporary_password alias resets a local account', async () => {
  const f = fixture();
  assert.equal((await f.call(f.researcher.user_uuid, { temporary_password: 'alias-pass-521' })).statusCode, 200);
  assert.equal(f.row(f.researcher.user_uuid).password_hash, 'hash:alias-pass-521');
});

test('a password shorter than 6 characters throws 400 before any database read', async () => {
  const f = fixture();
  for (const body of [{}, { password: '12345' }, { temporary_password: 'abc' }]) {
    await assert.rejects(f.call(f.researcher.user_uuid, body),
      (error) => error.statusCode === 400 && error.message === 'Password must be at least 6 characters');
  }
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.hashes, []);
});

test('a linked account is refused with the exact 409 before hashing and without a transaction', async () => {
  const f = fixture();
  const before = f.users();
  assert.deepEqual(await f.call(f.linked.user_uuid), { statusCode: 409, payload: LINKED });
  assert.deepEqual(f.hashes, []);
  assert.equal(f.begins(), 0);
  assert.deepEqual(f.users(), before);
});

test('a missing account is refused with 404 before hashing', async () => {
  const f = fixture();
  assert.deepEqual(await f.call(crypto.randomUUID()), { statusCode: 404, payload: { message: 'User not found' } });
  assert.deepEqual(f.hashes, []);
  assert.equal(f.begins(), 0);
});

test('an unknown sign-in type fails closed with 500 before hashing', async () => {
  const f = fixture();
  const odd = f.user('legacy1', { auth_mode: 'legacy-x' });
  const before = f.users();
  assert.deepEqual(await f.call(odd.user_uuid), { statusCode: 500, payload: UNKNOWN_MODE });
  assert.deepEqual(f.hashes, []);
  assert.equal(f.begins(), 0);
  assert.deepEqual(f.users(), before);
});

test('a target linked after the preflight is refused inside the transaction without an UPDATE', async () => {
  const f = fixture();
  f.hooks.push({ method: 'get', match: /^SELECT auth_mode FROM users/, after: (n) => n.prepare("UPDATE users SET auth_mode='server' WHERE user_uuid=?").run(f.researcher.user_uuid) });
  assert.deepEqual(await f.call(f.researcher.user_uuid), { statusCode: 409, payload: LINKED });
  assert.deepEqual(f.hashes, [10]);
  assert.equal(f.updates().length, 0);
  assert.equal(f.row(f.researcher.user_uuid).password_hash, f.researcher.password_hash);
});

test('a target deleted after the preflight answers 404 without an UPDATE', async () => {
  const f = fixture();
  f.hooks.push({ method: 'get', match: /^SELECT auth_mode FROM users/, after: (n) => n.prepare('DELETE FROM users WHERE user_uuid=?').run(f.researcher.user_uuid) });
  assert.deepEqual(await f.call(f.researcher.user_uuid), { statusCode: 404, payload: { message: 'User not found' } });
  assert.deepEqual(f.hashes, [10], 'the preflight saw a local account');
  assert.equal(f.updates().length, 0);
});

test('a target linked between the transaction read and the UPDATE matches no row and answers 409', async () => {
  const f = fixture();
  f.hooks.push({ method: 'run', match: UPDATE_SQL, before: (n) => n.prepare("UPDATE users SET auth_mode='server' WHERE user_uuid=?").run(f.researcher.user_uuid) });
  assert.deepEqual(await f.call(f.researcher.user_uuid), { statusCode: 409, payload: LINKED });
  assert.equal(f.row(f.researcher.user_uuid).password_hash, f.researcher.password_hash);
});

test('an actor renamed after the preflight is rethrown as 401 and the transaction rolls back', async () => {
  const f = fixture();
  f.hooks.push({ method: 'get', match: /^SELECT auth_mode FROM users/, after: (n) => n.prepare("UPDATE users SET username='admin1-renamed' WHERE id=?").run(f.admin.id) });
  await assert.rejects(f.call(f.researcher.user_uuid), (error) => error.statusCode === 401 && error.message === 'Unauthorized');
  assert.deepEqual(f.hashes, [10]);
  assert.equal(f.updates().length, 0);
  assert.ok(f.log.some((e) => e[2] === 'ROLLBACK;'));
  assert.equal(f.native.isTransaction, false);
  assert.deepEqual(f.warnings, []);
});

test('an actor demoted after the preflight is rethrown as 403 by the fresh role check on tx', async () => {
  const f = fixture();
  f.hooks.push({ method: 'get', match: /^SELECT auth_mode FROM users/, after: (n) => n.prepare("UPDATE users SET role='viewer' WHERE id=?").run(f.admin.id) });
  await assert.rejects(f.call(f.researcher.user_uuid), (error) => error.statusCode === 403);
  assert.deepEqual(f.hashes, [10]);
  assert.equal(f.updates().length, 0);
  assert.ok(f.log.some((e) => e[0] === 'tx' && e[1] !== 'run'), 'the role check reads on the transaction connection');
  assert.equal(f.row(f.researcher.user_uuid).password_hash, f.researcher.password_hash);
});

test('an UPDATE that reports two changed rows rolls back and answers the fixed 500', async () => {
  const f = fixture();
  f.hooks.push({ method: 'get', match: /^SELECT changes\(\) AS n$/, rows: [{ n: 2 }] });
  assert.deepEqual(await f.call(f.researcher.user_uuid), { statusCode: 500, payload: RESET_FAILED });
  assert.equal(f.row(f.researcher.user_uuid).password_hash, f.researcher.password_hash, 'rolled back');
  assert.deepEqual(f.warnings, ['admin account API password reset failed: password reset matched 2 rows']);
});

test('a database fault answers the fixed 500 and keeps the SQLite text in node.warn only', async () => {
  const f = fixture();
  f.hooks.push({ method: 'run', match: UPDATE_SQL, error: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.user_uuid') });
  const answer = await f.call(f.researcher.user_uuid);
  assert.deepEqual(answer, { statusCode: 500, payload: RESET_FAILED });
  assert.doesNotMatch(JSON.stringify(answer), /SQLITE|UPDATE|\$2|new-reset/);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /SQLITE_CONSTRAINT/);
});

test('a failed ROLLBACK outranks a 401 raised inside the transaction', async () => {
  const f = fixture();
  f.hooks.push({ method: 'get', match: /^SELECT auth_mode FROM users/, after: (n) => n.prepare("UPDATE users SET username='admin1-renamed' WHERE id=?").run(f.admin.id) });
  f.hooks.push({ method: 'exec', match: /^ROLLBACK/, error: new Error('SQLITE_IOERR: rollback reported failure') });
  assert.deepEqual(await f.call(f.researcher.user_uuid), { statusCode: 500, payload: RESET_FAILED });
  assert.deepEqual(f.warnings, ['admin account API password reset failed: Unauthorized (rollback also failed: SQLITE_IOERR: rollback reported failure)']);
  f.native.exec('ROLLBACK');
});

test('signInType maps rows to local, server, unknown or missing', () => {
  assert.equal(reset.signInType(undefined), 'missing');
  assert.equal(reset.signInType({ auth_mode: 'local' }), 'local');
  assert.equal(reset.signInType({ auth_mode: 'server' }), 'server');
  assert.equal(reset.signInType({ auth_mode: null }), 'unknown');
  assert.equal(reset.signInType({ auth_mode: 'LOCAL' }), 'unknown');
});

test('the module requires nothing; the router injects every dependency', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'), /\brequire\(/);
});
