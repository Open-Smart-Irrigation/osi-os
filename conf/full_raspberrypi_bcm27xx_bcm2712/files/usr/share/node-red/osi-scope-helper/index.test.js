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

test('fresh zone assertion bypasses the read cache', async () => {
  let grantReads = 0;
  const db = fakeDb({
    get: () => ({ id: 7, username: 'user', role: 'researcher', disabled_at: null }),
    all: (sql) => {
      if (sql.includes('user_zone_assignments')) {
        grantReads += 1;
        return [{ zone_uuid: 'z1' }];
      }
      return [];
    },
  });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  await scope.assertZoneAccess(db, 'u1', 'z1', { scopedMode: true });
  assert.equal(grantReads, 1);
  await scope.assertFreshZoneAccess(db, 'u1', 'z1', { scopedMode: true });
  assert.equal(grantReads, 2);
});

test('resource and role denials carry stable HTTP status codes', async () => {
  const db = fakeDb({
    get: () => ({ id: 7, username: 'user', role: 'viewer', disabled_at: null }),
    all: () => [],
  });
  await assert.rejects(
    () => scope.assertZoneAccess(db, 'u1', 'z-foreign', { scopedMode: true }),
    (error) => error.status === 404 && error.statusCode === 404
  );
  await assert.rejects(
    () => scope.assertRole(db, 'u1', 'admin', { scopedMode: true }),
    (error) => error.status === 403 && error.statusCode === 403
  );
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

test('assertDeviceAccess: weather-class passes any enabled user; zone device needs scope', async () => {
  const makeDb = (device) => fakeDb({
    get: (sql) => {
      if (sql.includes('FROM devices')) return device;
      if (sql.includes('FROM users')) {
        return {
          id: 7,
          username: 'user',
          role: 'researcher',
          disabled_at: null,
          user_uuid: 'u1',
        };
      }
      return undefined;
    },
    all: () => [],
  });
  await scope.assertDeviceAccess(
    makeDb({ deveui: 'W1', type_id: 'SENSECAP_S2120', zone_uuid: 'z-foreign' }),
    'u1',
    'W1',
    { scopedMode: true }
  );
  await scope.assertDeviceAccess(
    makeDb({ deveui: 'W2', type_id: 'AQUASCOPE_LORAIN', zone_uuid: null }),
    'u1',
    'W2',
    { scopedMode: true }
  );
  await assert.rejects(
    () => scope.assertDeviceAccess(
      makeDb({ deveui: 'D1', type_id: 'DRAGINO_LSN50', zone_uuid: 'z-foreign' }),
      'u1',
      'D1',
      { scopedMode: true }
    ),
    (error) => error.status === 404
  );
});

test('assertDeviceAccess: unknown device is 404, not 403', async () => {
  const db = fakeDb({ get: () => undefined });
  await assert.rejects(
    () => scope.assertDeviceAccess(db, 'u1', 'NOPE', { scopedMode: true }),
    (error) => error.status === 404
  );
});

test('listScopeZoneUuids: wildcard returns null (no filter), scoped returns array', async () => {
  const unscopedDb = fakeDb({});
  assert.equal(
    await scope.listScopeZoneUuids(unscopedDb, 'u1', { scopedMode: false }),
    null
  );
  const scopedDb = fakeDb({
    get: () => ({
      id: 7,
      username: 'user',
      role: 'researcher',
      disabled_at: null,
      user_uuid: 'u1',
    }),
    all: (sql) => sql.includes('user_zone_assignments')
      ? [{ zone_uuid: 'z1' }]
      : [{ zone_uuid: 'z0' }],
  });
  assert.deepEqual(
    (await scope.listScopeZoneUuids(scopedDb, 'u1', { scopedMode: true })).sort(),
    ['z0', 'z1']
  );
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
