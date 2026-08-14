'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const scope = require('./index.js');

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
    get: (sql) => {
      if (sql.includes('id = ? AND username = ?')) return { user_uuid: 'u-admin' };
      return {
        id: 7,
        username: 'admin',
        role: 'admin',
        disabled_at: null,
        user_uuid: 'u-admin',
      };
    },
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
    get: (sql) => {
      if (sql.includes('id = ? AND username = ?')) return { user_uuid: 'u-admin' };
      return {
        id: 7,
        username: 'admin',
        role: 'admin',
        disabled_at: null,
        user_uuid: 'u-admin',
      };
    },
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
