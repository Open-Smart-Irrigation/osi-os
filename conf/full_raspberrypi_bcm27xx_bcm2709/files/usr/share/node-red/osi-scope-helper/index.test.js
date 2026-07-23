'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
    (error) => error.status === 404
  );
  await assert.rejects(
    () => scope.assertRole(db, 'u1', 'admin', { scopedMode: true }),
    (error) => error.status === 403
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
