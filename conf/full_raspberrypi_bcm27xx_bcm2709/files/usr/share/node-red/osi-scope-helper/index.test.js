'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const scope = require('./index.js');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

function fakeDb(handlers) {
  const calls = [];
  return {
    calls,
    async all(sql, params) {
      calls.push({ sql, params });
      return handlers.all ? handlers.all(sql, params) : [];
    },
    async get(sql, params) {
      calls.push({ sql, params });
      return handlers.get ? handlers.get(sql, params) : undefined;
    },
  };
}

test.beforeEach(() => scope._resetForTests());

test('flag off returns wildcard admin scope without database reads', async () => {
  const db = fakeDb({});
  const result = await scope.resolveScope(db, 'u1', { scopedMode: false });
  assert.equal(result.role, 'admin');
  assert.equal(result.wildcard, true);
  assert.equal(db.calls.length, 0);
});

test('scope unions owned and granted zones and plots', async () => {
  const db = fakeDb({
    get: (sql) => sql.includes('FROM users')
      ? { id: 7, username: 'user', role: 'researcher', disabled_at: null }
      : undefined,
    all: (sql) => {
      if (sql.includes('FROM irrigation_zones')) return [{ zone_uuid: 'z-owned' }];
      if (sql.includes('FROM user_zone_assignments')) return [{ zone_uuid: 'z-granted' }];
      if (sql.includes('FROM journal_plots')) return [{ plot_uuid: 'p-owned' }];
      if (sql.includes('FROM user_plot_assignments')) return [{ plot_uuid: 'p-granted' }];
      return [];
    },
  });
  const result = await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.deepEqual([...result.zoneUuids].sort(), ['z-granted', 'z-owned']);
  assert.deepEqual([...result.plotUuids].sort(), ['p-granted', 'p-owned']);
});

test('null user UUID is a hard error', async () => {
  const db = fakeDb({});
  await assert.rejects(
    () => scope.resolveScope(db, null, { scopedMode: true }),
    /user_uuid/
  );
});

test('cache reuses scope until invalidated', async () => {
  let reads = 0;
  const db = fakeDb({
    get: () => {
      reads += 1;
      return { id: 7, username: 'user', role: 'viewer', disabled_at: null };
    },
  });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.equal(reads, 1);
  scope.invalidateScope('u1');
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.equal(reads, 2);
});

test('the read-filter API is retired: write-only scoping exports no read predicate', () => {
  for (const name of [
    'assertZoneAccess',
    'assertPlotAccess',
    'assertDeviceAccess',
    'listScopeZoneUuids',
    'filterZoneUuids',
  ]) {
    assert.equal(scope[name], undefined, `${name} must not be exported (W1)`);
  }
  for (const name of [
    'assertEnabledAccount',
    'assertFreshZoneAccess',
    'assertFreshPlotAccess',
    'assertFreshDeviceAccess',
    'assertFreshRole',
    'assertRole',
    'authorizeAdminRead',
    'canMutate',
    'resolveZoneUuidById',
  ]) {
    assert.equal(typeof scope[name], 'function', `${name} must survive`);
  }
});

test('disabled account fails closed on fresh paths', async () => {
  const db = fakeDb({
    get: () => ({
      id: 7,
      username: 'user',
      role: 'admin',
      disabled_at: '2026-07-01',
    }),
  });
  await assert.rejects(
    () => scope.assertFreshZoneAccess(db, 'u1', 'z1', { scopedMode: true }),
    (error) => error.status === 403 && /disabled/.test(error.message)
  );
});

test('fresh role assertion observes a demotion hidden by cached assertion', async () => {
  let reads = 0;
  const db = fakeDb({
    get: () => {
      reads += 1;
      return {
        id: 7,
        username: 'user',
        role: reads === 1 ? 'admin' : 'viewer',
        disabled_at: null,
      };
    },
  });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  await scope.assertRole(db, 'u1', 'admin', { scopedMode: true });
  assert.equal(reads, 1);
  await assert.rejects(
    () => scope.assertFreshRole(db, 'u1', 'admin', { scopedMode: true }),
    (error) => error.status === 403 && /insufficient role/.test(error.message)
  );
  assert.equal(reads, 2);
});

test('resolveZoneUuidById maps numeric id to uuid; null when missing', async () => {
  const db = fakeDb({
    get: (sql) => sql.includes('irrigation_zones') ? { zone_uuid: 'z1' } : undefined,
  });
  assert.equal(await scope.resolveZoneUuidById(db, 3), 'z1');
  const missingDb = fakeDb({ get: () => undefined });
  assert.equal(await scope.resolveZoneUuidById(missingDb, 99), null);
});

test('verifyBearer accepts the edge two-part HMAC token and rejects forged tokens', () => {
  const secret = 'scope-auth-test-secret';
  const payload = Buffer.from(JSON.stringify({
    userId: 7,
    username: 'researcher',
    exp: Date.now() + 60000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  assert.deepEqual(
    scope.verifyBearer(`Bearer ${payload}.${signature}`, { configuredSecret: secret }),
    { userId: 7, username: 'researcher' }
  );
  assert.throws(
    () => scope.verifyBearer(`Bearer ${payload}.forged`, { configuredSecret: secret }),
    (error) => error.statusCode === 401
  );
});

test('concurrent auth-secret resolution reuses the one persisted secret', async () => {
  const files = new Map();
  const fakeFs = {
    readFileSync(path) {
      if (!files.has(path)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(path);
    },
    writeFileSync(path, value) {
      files.set(path, value);
    },
  };
  const [first, second] = await Promise.all([
    scope.resolveAuthSecret({ fs: fakeFs }),
    scope.resolveAuthSecret({ fs: fakeFs }),
  ]);
  assert.equal(first, second);
  assert.equal(files.size, 1);
  assert.equal(files.values().next().value.trim(), first);
});

test('assertAuthenticatedRole binds token id and username before checking role', async () => {
  const db = fakeDb({
    get: () => ({
      id: 7,
      username: 'admin',
      role: 'admin',
      disabled_at: null,
      user_uuid: 'u-admin',
    }),
    all: () => [],
  });
  await scope.assertAuthenticatedRole(
    db,
    { userId: 7, username: 'admin' },
    'admin',
    { scopedMode: true }
  );
  const missingDb = fakeDb({ get: () => undefined });
  await assert.rejects(
    () => scope.assertAuthenticatedRole(
      missingDb,
      { userId: 7, username: 'admin' },
      'admin',
      { scopedMode: true }
    ),
    (error) => error.statusCode === 401
  );
});

test('authorizeAdminRead verifies, authorizes, and closes its database handle', async () => {
  const secret = 'admin-read-test-secret';
  const payload = Buffer.from(JSON.stringify({
    userId: 7,
    username: 'admin',
    exp: Date.now() + 60000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  let closeCalls = 0;
  const db = fakeDb({
    get: () => ({
      id: 7,
      username: 'admin',
      role: 'admin',
      disabled_at: null,
      user_uuid: 'u-admin',
    }),
    all: () => [],
  });
  db.close = (callback) => {
    closeCalls += 1;
    callback();
  };
  await scope.authorizeAdminRead({
    Database: function Database() { return db; },
    authorization: `Bearer ${payload}.${signature}`,
    configuredSecret: secret,
  });
  assert.equal(closeCalls, 1);
});

test('assertEnabledAccount accepts every enabled role and rejects disabled accounts', async () => {
  const enabled = fakeDb({
    get: () => ({
      id: 3,
      username: 'viewer',
      role: 'viewer',
      disabled_at: null,
      user_uuid: 'u-viewer',
    }),
    all: () => [],
  });
  const resolved = await scope.assertEnabledAccount(
    enabled,
    'u-viewer',
    { scopedMode: true }
  );
  assert.equal(resolved.role, 'viewer');

  const disabled = fakeDb({
    get: () => ({
      id: 4,
      username: 'disabled',
      role: 'researcher',
      disabled_at: '2026-07-01',
      user_uuid: 'u-disabled',
    }),
    all: () => [],
  });
  await assert.rejects(
    () => scope.assertEnabledAccount(disabled, 'u-disabled', { scopedMode: true }),
    (error) => error.status === 403
  );
});

test('assertFreshDeviceAccess bypasses cache and honors zone scope', async () => {
  let deviceReads = 0;
  const db = fakeDb({
    get: (sql) => {
      if (sql.includes('FROM devices')) {
        deviceReads += 1;
        return {
          deveui: 'D1',
          type_id: 'DRAGINO_LSN50',
          zone_uuid: 'z1',
        };
      }
      if (sql.includes('FROM users')) {
        return {
          id: 7,
          username: 'researcher',
          role: 'researcher',
          disabled_at: null,
          user_uuid: 'u1',
        };
      }
      return undefined;
    },
    all: (sql) => sql.includes('user_zone_assignments')
      ? [{ zone_uuid: 'z1' }]
      : [],
  });

  await scope.assertFreshDeviceAccess(db, 'u1', 'D1', { scopedMode: true });
  await scope.assertFreshDeviceAccess(db, 'u1', 'D1', { scopedMode: true });
  assert.equal(deviceReads, 2);
});

test('assertFreshDeviceAccess gives admins no zone-scope bypass', async () => {
  const db = fakeDb({
    get: (sql) => {
      if (sql.includes('FROM devices')) {
        return {
          deveui: 'D1',
          type_id: 'DRAGINO_LSN50',
          zone_uuid: 'z-foreign',
        };
      }
      if (sql.includes('FROM users')) {
        return {
          id: 1,
          username: 'admin',
          role: 'admin',
          disabled_at: null,
          user_uuid: 'u-admin',
        };
      }
      return undefined;
    },
    all: () => [],
  });

  await assert.rejects(
    () => scope.assertFreshDeviceAccess(
      db,
      'u-admin',
      'D1',
      { scopedMode: true }
    ),
    (error) => error.status === 404
  );
});

// A device row with no zone (irrigation_zone_id NULL), owned through
// devices.user_id by the account `ownerUuid`, and the calling account.
function unassignedDeviceDb({ typeId = 'DRAGINO_LSN50', ownerUuid = 'u-owner', zoneId = null, zoneUuid = null,
  caller = { id: 7, role: 'researcher', disabled_at: null, user_uuid: 'u-owner' } } = {}) {
  return fakeDb({
    get: (sql) => {
      if (sql.includes('FROM devices')) {
        return {
          deveui: 'A840410000000001',
          type_id: typeId,
          irrigation_zone_id: zoneId,
          zone_uuid: zoneUuid,
          owner_user_uuid: ownerUuid,
        };
      }
      if (sql.includes('FROM users')) return { username: 'caller', ...caller };
      return undefined;
    },
    all: () => [],
  });
}

const OWNER_OPT_IN = { scopedMode: true, allowUnassignedOwner: true };
const isNotFound = (error) => error.status === 404;

test('assertFreshDeviceAccess: an unassigned device stays hidden unless the route opts in', async () => {
  await assert.rejects(
    () => scope.assertFreshDeviceAccess(unassignedDeviceDb(), 'u-owner', 'A840410000000001', { scopedMode: true }),
    isNotFound
  );
});

test('assertFreshDeviceAccess: the writing owner of an unassigned soil sensor may configure it when the route opts in', async () => {
  for (const typeId of ['DRAGINO_LSN50', 'DRAGINO_SDI12', 'KIWI_SENSOR', 'TEKTELIC_CLOVER']) {
    const result = await scope.assertFreshDeviceAccess(
      unassignedDeviceDb({ typeId }), 'u-owner', 'A840410000000001', OWNER_OPT_IN
    );
    assert.equal(result.role, 'researcher', typeId);
  }
  const admin = await scope.assertFreshDeviceAccess(
    unassignedDeviceDb({ caller: { id: 1, role: 'admin', disabled_at: null, user_uuid: 'u-owner' } }),
    'u-owner', 'A840410000000001', OWNER_OPT_IN
  );
  assert.equal(admin.role, 'admin');
});

const ADMIN = Object.freeze({ id: 1, role: 'admin', disabled_at: null, user_uuid: 'u-admin' });

test('assertFreshDeviceAccess: an enabled admin who is not the owner may configure an unassigned soil sensor when the route opts in', async () => {
  for (const typeId of ['DRAGINO_LSN50', 'DRAGINO_SDI12', 'KIWI_SENSOR', 'TEKTELIC_CLOVER']) {
    const result = await scope.assertFreshDeviceAccess(
      unassignedDeviceDb({ typeId, caller: ADMIN }), 'u-admin', 'A840410000000001', OWNER_OPT_IN
    );
    assert.equal(result.role, 'admin', typeId);
  }
  const ownerless = await scope.assertFreshDeviceAccess(
    unassignedDeviceDb({ ownerUuid: null, caller: ADMIN }), 'u-admin', 'A840410000000001', OWNER_OPT_IN
  );
  assert.equal(ownerless.role, 'admin', 'a soil sensor without an owner');
});

test('assertFreshDeviceAccess: the admin exception keeps every other refusal', async () => {
  const cases = [
    ['a disabled admin', unassignedDeviceDb({ caller: { ...ADMIN, disabled_at: '2026-01-02' } }), (error) => error.status === 403],
    ['a route that does not opt in', unassignedDeviceDb({ caller: ADMIN }), isNotFound, { scopedMode: true }],
    ['an unassigned valve', unassignedDeviceDb({ typeId: 'STREGA_VALVE', caller: ADMIN }), isNotFound],
    ['a device whose zone row is gone', unassignedDeviceDb({ zoneId: 99, caller: ADMIN }), isNotFound],
    ['a sensor in a zone outside the admin\'s scope', unassignedDeviceDb({ zoneId: 3, zoneUuid: 'z-other', caller: ADMIN }), isNotFound],
  ];
  for (const [label, db, expected, options = OWNER_OPT_IN] of cases) {
    await assert.rejects(
      () => scope.assertFreshDeviceAccess(db, 'u-admin', 'A840410000000001', options),
      expected,
      label
    );
  }
});

test('assertFreshDeviceAccess: the owner exception refuses everyone and everything else', async () => {
  const cases = [
    ['another researcher', unassignedDeviceDb({ caller: { id: 8, role: 'researcher', disabled_at: null, user_uuid: 'u-other' } }), 'u-other', isNotFound],
    ['another researcher on an SDI-12 node', unassignedDeviceDb({ typeId: 'DRAGINO_SDI12', caller: { id: 8, role: 'researcher', disabled_at: null, user_uuid: 'u-other' } }), 'u-other', isNotFound],
    ['a researcher on a sensor without an owner', unassignedDeviceDb({ ownerUuid: null, caller: { id: 8, role: 'researcher', disabled_at: null, user_uuid: 'u-other' } }), 'u-other', isNotFound],
    ['a viewer who does not own it', unassignedDeviceDb({ caller: { id: 9, role: 'viewer', disabled_at: null, user_uuid: 'u-viewer' } }), 'u-viewer', isNotFound],
    ['a viewer who owns it', unassignedDeviceDb({ caller: { id: 7, role: 'viewer', disabled_at: null, user_uuid: 'u-owner' } }), 'u-owner', isNotFound],
    ['a viewer who owns an SDI-12 node', unassignedDeviceDb({ typeId: 'DRAGINO_SDI12', caller: { id: 7, role: 'viewer', disabled_at: null, user_uuid: 'u-owner' } }), 'u-owner', isNotFound],
    ['a corrupted role', unassignedDeviceDb({ caller: { id: 7, role: 'superuser', disabled_at: null, user_uuid: 'u-owner' } }), 'u-owner', isNotFound],
    ['a disabled owner', unassignedDeviceDb({ caller: { id: 7, role: 'researcher', disabled_at: '2026-01-02', user_uuid: 'u-owner' } }), 'u-owner', (error) => error.status === 403],
    ['a device without an owner', unassignedDeviceDb({ ownerUuid: null }), 'u-owner', isNotFound],
    ['an unassigned valve', unassignedDeviceDb({ typeId: 'STREGA_VALVE' }), 'u-owner', isNotFound],
    ['a device whose zone row is gone', unassignedDeviceDb({ zoneId: 99 }), 'u-owner', isNotFound],
  ];
  for (const [label, db, caller, expected] of cases) {
    await assert.rejects(
      () => scope.assertFreshDeviceAccess(db, caller, 'A840410000000001', OWNER_OPT_IN),
      expected,
      label
    );
  }
});

test('assertFreshDeviceAccess: the owner exception changes nothing with the flag off', async () => {
  const db = unassignedDeviceDb();
  const result = await scope.assertFreshDeviceAccess(db, 'u-other', 'A840410000000001', { allowUnassignedOwner: true });
  assert.equal(result.wildcard, true);
  assert.equal(db.calls.length, 0);
});

test('buildDisableUserGuardedSql protects only the last enabled admin', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'researcher',
      disabled_at TEXT
    );
    INSERT INTO users (user_uuid, role)
    VALUES ('u-admin','admin'), ('u-res','researcher');
  `);
  const sql = scope.buildDisableUserGuardedSql();
  assert.match(sql, /role != 'admin'/);

  assert.equal(db.prepare(sql).run('u-res').changes, 1);
  assert.ok(
    db.prepare("SELECT disabled_at FROM users WHERE user_uuid='u-res'").get().disabled_at
  );
  assert.equal(db.prepare(sql).run('u-admin').changes, 0);

  db.exec("INSERT INTO users (user_uuid, role) VALUES ('u-admin2','admin')");
  assert.equal(db.prepare(sql).run('u-admin').changes, 1);
  db.close();
});

test('buildDeroleUserGuardedSql protects the last enabled admin', () => {
  const sql = scope.buildDeroleUserGuardedSql();
  assert.match(sql, /^UPDATE users SET role = \?/);
  assert.match(sql, /disabled_at IS NOT NULL/);
  assert.match(sql, /COUNT\(\*\).*role='admin'/);
});

test('admin guarded SQL exposes stable replacement anchors and deroles a disabled admin', () => {
  const disableSql = scope.buildDisableUserGuardedSql();
  const deroleSql = scope.buildDeroleUserGuardedSql();
  assert.match(disableSql, /SET disabled_at =/);
  assert.match(deroleSql, /SET role = \?/);

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      user_uuid TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      disabled_at TEXT
    );
    INSERT INTO users (user_uuid, role, disabled_at)
    VALUES ('u-enabled','admin',NULL), ('u-disabled','admin','2026-01-01T00:00:00.000Z');
  `);
  assert.equal(db.prepare(deroleSql).run('researcher', 'u-disabled', 'researcher').changes, 1);
  db.close();
});

test('canMutate is an allowlist: only admin/researcher, everything else (including a corrupted role) fails closed', () => {
  assert.equal(scope.canMutate('admin'), true);
  assert.equal(scope.canMutate('researcher'), true);
  assert.equal(scope.canMutate('viewer'), false);
  assert.equal(scope.canMutate('gibberish'), false);
  assert.equal(scope.canMutate(''), false);
  assert.equal(scope.canMutate(null), false);
  assert.equal(scope.canMutate(undefined), false);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function observedFacade(raw) {
  const calls = [];
  const gates = [];
  let nextGetError = null;
  let closeError = null;
  let closeCount = 0;
  return {
    calls,
    get closeCount() { return closeCount; },
    pauseNextScopeUserGet() {
      const entered = deferred();
      const release = deferred();
      gates.push({ entered, release });
      return { entered: entered.promise, release: () => release.resolve() };
    },
    rejectNextGet(error) { nextGetError = error; },
    failClose(error) { closeError = error; },
    async get(sql, params = []) {
      calls.push({ method: 'get', sql, params: [...params] });
      if (nextGetError) {
        const error = nextGetError;
        nextGetError = null;
        throw error;
      }
      const row = raw.prepare(sql).get(...params);
      if (sql === 'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE user_uuid = ?' && gates.length) {
        const gate = gates.shift();
        gate.entered.resolve(row);
        await gate.release.promise;
      }
      return row;
    },
    async all(sql, params = []) {
      calls.push({ method: 'all', sql, params: [...params] });
      return raw.prepare(sql).all(...params);
    },
    close(callback) {
      closeCount += 1;
      callback(closeError);
    },
  };
}

function signedToken(userId, username, secret, exp = Date.now() + 60000) {
  const payload = Buffer.from(JSON.stringify({ userId, username, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return 'Bearer ' + payload + '.' + signature;
}

const ISSUE434_SECRET = 'issue-434-test-secret';
const ISSUE434_USER_SQL =
  'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1';

function fixture434() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE users(id INTEGER, username TEXT, role TEXT, disabled_at TEXT, user_uuid TEXT);
    CREATE TABLE irrigation_zones(user_id INTEGER, deleted_at TEXT, zone_uuid TEXT);
    CREATE TABLE user_zone_assignments(user_uuid TEXT, deleted_at TEXT, zone_uuid TEXT);
    CREATE TABLE journal_plots(owner_user_uuid TEXT, deleted_at TEXT, plot_uuid TEXT);
    CREATE TABLE user_plot_assignments(user_uuid TEXT, deleted_at TEXT, plot_uuid TEXT);
    INSERT INTO users VALUES(7,'admin','admin',NULL,'u-admin');
    INSERT INTO users VALUES(8,'other','viewer',NULL,'u-other');
  `);
  const observed = observedFacade(raw);
  const Database = function Database() { return observed; };
  const options = (authorization = signedToken(7, 'admin', ISSUE434_SECRET), extra = {}) => ({
    Database, authorization, configuredSecret: ISSUE434_SECRET, ...extra,
  });
  return {
    raw, observed, options,
    close() { scope._resetForTests(); raw.close(); },
  };
}

function userGets434(f) {
  return f.observed.calls.filter((call) => call.method === 'get' &&
    call.sql.includes('FROM users'));
}

test('H1 fresh admin read rejects a warm-cache demotion', { concurrency: false }, async () => {
  const f = fixture434();
  try {
    await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    f.observed.calls.length = 0;
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
    assert.deepEqual(f.observed.calls, [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }]);
    assert.equal(f.observed.closeCount, 1);
  } finally { f.close(); }
});

test('H2 disabled and restored roles are read on each admin request', { concurrency: false }, async () => {
  const f = fixture434();
  try {
    await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    f.observed.calls.length = 0;
    f.raw.exec("UPDATE users SET disabled_at='2026-10-26' WHERE id=7");
    await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
    f.raw.exec("UPDATE users SET disabled_at=NULL WHERE id=7");
    assert.equal((await scope.authorizeAdminRead(f.options())).role, 'admin');
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
    f.raw.exec("UPDATE users SET role='admin' WHERE id=7");
    assert.equal((await scope.authorizeAdminRead(f.options())).role, 'admin');
    assert.equal(f.observed.closeCount, 4);
    assert.equal(userGets434(f).filter((c) => c.sql === ISSUE434_USER_SQL).length, 4);
  } finally { f.close(); }
});

test('H3 admin read uses one bound user statement and no scope tables even on cache hit', { concurrency: false }, async () => {
  const f = fixture434();
  try {
    for (let i = 0; i < 2; i += 1) {
      const before = f.observed.calls.length;
      const result = await scope.authorizeAdminRead(f.options());
      assert.deepEqual(f.observed.calls.slice(before),
        [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }],
        `call ${i + 1}: one bound get and zero all`);
      assert.deepEqual({ role: result.role, username: result.username, wildcard: result.wildcard,
        zoneUuids: result.zoneUuids, plotUuids: result.plotUuids },
      { role: 'admin', username: 'admin', wildcard: false, zoneUuids: null, plotUuids: null });
      if (i === 0) {
        await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
        f.observed.calls.length = 0;
      }
    }
    assert.deepEqual(f.observed.calls,
      [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }]);
    assert.equal(f.observed.closeCount, 2);
  } finally { f.close(); }
});

test('H4 token and current id plus username binding reject missing identities', { concurrency: false }, async () => {
  const invalid = [null, 'Bearer x', 'Bearer x.forged',
    signedToken(7, 'admin', ISSUE434_SECRET, Date.now() - 1000)];
  for (const authorization of invalid) {
    const f = fixture434();
    let opens = 0;
    try {
      await assert.rejects(scope.authorizeAdminRead({ ...f.options(authorization),
        Database: function Database() { opens += 1; return f.observed; } }),
      (e) => e.status === 401);
      assert.equal(opens, 0);
      assert.equal(f.observed.calls.length, 0);
      assert.equal(f.observed.closeCount, 0);
    } finally { f.close(); }
  }
  for (const [sql, token] of [
    ["DELETE FROM users WHERE id=7", signedToken(7, 'admin', ISSUE434_SECRET)],
    ['', signedToken(7, 'old-name', ISSUE434_SECRET)],
    ['', signedToken(9, 'admin', ISSUE434_SECRET)],
    ["UPDATE users SET user_uuid=NULL WHERE id=7", signedToken(7, 'admin', ISSUE434_SECRET)],
  ]) {
    const f = fixture434();
    try {
      if (sql) f.raw.exec(sql);
      await assert.rejects(scope.authorizeAdminRead(f.options(token)), (e) => e.status === 401);
      assert.equal(f.observed.calls.length, 1);
      assert.equal(f.observed.calls[0].sql, ISSUE434_USER_SQL);
      assert.equal(f.observed.calls[0].params.length, 2);
      assert.equal(f.observed.closeCount, 1);
    } finally { f.close(); }
  }
});

test('H5 disabled, viewer, researcher and unknown roles all fail closed', { concurrency: false }, async () => {
  for (const [role, disabled] of [['viewer', null], ['researcher', null],
    ['unknown-role', null], ['admin', '2026-10-26']]) {
    const f = fixture434();
    try {
      f.raw.prepare('UPDATE users SET role=?, disabled_at=? WHERE id=7').run(role, disabled);
      await assert.rejects(scope.authorizeAdminRead(f.options()), (e) => e.status === 403);
      assert.deepEqual(f.observed.calls, [{ method: 'get', sql: ISSUE434_USER_SQL, params: [7, 'admin'] }]);
      assert.equal(f.observed.closeCount, 1);
    } finally { f.close(); }
  }
});

test('H6 query cause and close warning remain observable', { concurrency: false }, async () => {
  const f = fixture434();
  const cause = new Error('fixture-read-failed');
  const warnings = [];
  try {
    f.observed.rejectNextGet(cause);
    await assert.rejects(scope.authorizeAdminRead(f.options()),
      (e) => e.status === 500 && e.statusCode === 500 && e.cause === cause);
    assert.equal(f.observed.closeCount, 1);
    assert.equal(f.observed.calls.filter((c) => c.method === 'all').length, 0);
    assert.equal((await scope.authorizeAdminRead(f.options())).role, 'admin');
    assert.equal(f.observed.closeCount, 2);
    f.observed.failClose(new Error('fixture-close-failed'));
    assert.equal((await scope.authorizeAdminRead(f.options(undefined,
      { warn: (message) => warnings.push(message) }))).role, 'admin');
    assert.equal(f.observed.closeCount, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /fixture-close-failed/);
    assert.equal(userGets434(f).filter((c) => c.sql === ISSUE434_USER_SQL).length, 3);
  } finally { f.close(); }
});

test('H7 per-user invalidation discards old result for cache and waiter', { concurrency: false }, async () => {
  const f = fixture434();
  const gate = f.observed.pauseNextScopeUserGet();
  try {
    const waiting = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await gate.entered;
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    scope.invalidateScope('u-admin');
    gate.release();
    assert.equal((await waiting).role, 'viewer');
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 2);
  } finally { gate.release(); f.close(); }
});

test('H8 global invalidation discards old result for cache and waiter', { concurrency: false }, async () => {
  const f = fixture434();
  const gate = f.observed.pauseNextScopeUserGet();
  try {
    const waiting = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await gate.entered;
    f.raw.exec("UPDATE users SET disabled_at='2026-10-26' WHERE id=7");
    scope.invalidateScope();
    gate.release();
    assert.equal((await waiting).disabled, true);
    await assert.rejects(scope.assertRole(f.observed, 'u-admin', 'admin', { scopedMode: true }),
      (e) => e.status === 403);
    assert.equal(userGets434(f).length, 2);
  } finally { gate.release(); f.close(); }
});

test('H9 old-last load cannot overwrite a newer published scope', { concurrency: false }, async () => {
  for (const globalClear of [false, true]) {
    const f = fixture434();
    const gate = f.observed.pauseNextScopeUserGet();
    try {
      const old = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
      await gate.entered;
      f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
      scope.invalidateScope(globalClear ? undefined : 'u-admin');
      const newer = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
      assert.equal(newer.role, 'viewer');
      gate.release();
      assert.strictEqual(await old, newer);
      assert.strictEqual(await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), newer);
      assert.equal(userGets434(f).length, 2);
    } finally { gate.release(); f.close(); }
  }
});

test('H10 second invalidation ends after two loads; route 500 mappings are explicit', { concurrency: false }, async () => {
  const f = fixture434();
  const first = f.observed.pauseNextScopeUserGet();
  const second = f.observed.pauseNextScopeUserGet();
  try {
    const waiting = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await first.entered;
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    scope.invalidateScope('u-admin');
    first.release();
    // Both outcomes settle this race, so the test never waits on a barrier
    // that the code under test does not open.
    const afterFirst = await Promise.race([
      waiting.then(() => 'settled', () => 'settled'),
      second.entered.then(() => 'retried'),
    ]);
    assert.equal(afterFirst, 'retried', 'an invalidated first load must not settle the original request');
    scope.invalidateScope('u-admin');
    second.release();
    await assert.rejects(waiting, (e) => e.status === 503 && e.statusCode === 503);
    assert.equal(userGets434(f).length, 2);
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 3);
  } finally { first.release(); second.release(); f.close(); }

  const root = path.resolve(__dirname, '../../../../../../../');
  const { executeFunction, loadNode, makeAuthHeader, seedScopedDb } =
    require(path.join(root, 'scripts/lib/scoped-access-harness'));
  const profile = __dirname.includes('bcm2709') ? 'bcm2709' : 'bcm2712';
  const flowPath = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const raw = seedScopedDb();
  const changed = Object.assign(new Error('scope changed during read'), { status: 503, statusCode: 503 });
  const injected = { ...scope,
    resolveScope: async () => { throw changed; },
    assertEnabledAccount: async () => { throw changed; } };
  const env = { OSI_SCOPED_ACCESS: '1', AUTH_TOKEN_SECRET: 'scoped-access-test-secret' };
  const msg = { authUserId: 1, authUsername: 'admin1', req: { headers: {
    authorization: makeAuthHeader({ userId: 1, username: 'admin1' }) } } };
  try {
    const me = await executeFunction(loadNode('api-me-fn', flowPath),
      { msg, db: raw, env, osiLibModules: { scope: injected } });
    assert.equal(me.result.statusCode, 500);
    assert.deepEqual(me.result.payload, { message: 'unable to resolve scope' });
    const sdi = await executeFunction(loadNode('sdi12-profiles-scope-fn', flowPath), {
      msg: { req: { method: 'GET', path: '/api/sdi12/probe-profiles', headers: {
        authorization: makeAuthHeader({ userId: 1, username: 'admin1' }) }, params: {} } },
      db: raw, env, osiLibModules: { scope: injected },
    });
    assert.equal(sdi.result[0], null);
    assert.equal(sdi.result[1].statusCode, 500);
    assert.deepEqual(sdi.result[1].payload, { message: 'Unable to authorize SDI-12 profiles' });
  } finally { raw.close(); scope._resetForTests(); }
});

test('H11 same-user waiters and unrelated-user cache isolation', { concurrency: false }, async () => {
  const f = fixture434();
  const first = f.observed.pauseNextScopeUserGet();
  const second = f.observed.pauseNextScopeUserGet();
  try {
    const a = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    const b = scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    await Promise.all([first.entered, second.entered]);
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    scope.invalidateScope('u-admin');
    first.release(); second.release();
    assert.deepEqual([(await a).role, (await b).role], ['viewer', 'viewer']);
    const adminCached = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    const other = await scope.resolveScope(f.observed, 'u-other', { scopedMode: true });
    const before = userGets434(f).length;
    scope.invalidateScope('u-admin');
    assert.notStrictEqual(await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), adminCached);
    assert.equal(userGets434(f).length, before + 1);
    assert.strictEqual(await scope.resolveScope(f.observed, 'u-other', { scopedMode: true }), other);
    assert.equal(userGets434(f).length, before + 1);
    scope.invalidateScope();
    assert.notStrictEqual(await scope.resolveScope(f.observed, 'u-other', { scopedMode: true }), other);
    assert.equal(userGets434(f).length, before + 2);
  } finally { first.release(); second.release(); f.close(); }
});

test('H12 TTL boundary, failed load, and flag-off wildcard remain bounded', { concurrency: false }, async () => {
  const f = fixture434();
  const realNow = Date.now;
  const oldFlag = process.env.OSI_SCOPED_ACCESS;
  let now = 1000000;
  try {
    Date.now = () => now;
    const original = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true });
    now += 29999;
    assert.strictEqual(await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), original);
    f.raw.exec("UPDATE users SET role='viewer' WHERE id=7");
    now += 1;
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 2);
    scope.invalidateScope('u-admin');
    f.observed.rejectNextGet(new Error('load failed'));
    await assert.rejects(scope.resolveScope(f.observed, 'u-admin', { scopedMode: true }), /load failed/);
    assert.equal((await scope.resolveScope(f.observed, 'u-admin', { scopedMode: true })).role, 'viewer');
    assert.equal(userGets434(f).length, 4);
    process.env.OSI_SCOPED_ACCESS = '';
    const before = f.observed.calls.length;
    const wildcard = await scope.resolveScope(f.observed, 'u-admin', { scopedMode: false });
    assert.equal(wildcard.wildcard, true);
    assert.equal(wildcard.role, 'admin');
    assert.equal(f.observed.calls.length, before);
  } finally {
    Date.now = realNow;
    if (oldFlag === undefined) delete process.env.OSI_SCOPED_ACCESS;
    else process.env.OSI_SCOPED_ACCESS = oldFlag;
    f.close();
  }
});
