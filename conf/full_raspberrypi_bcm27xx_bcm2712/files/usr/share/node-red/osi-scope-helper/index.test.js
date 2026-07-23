'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scope = require('./index.js');

// Fake db: queues canned answers per SQL substring match.
function fakeDb(handlers) {
  const calls = [];
  return {
    calls,
    async all(sql, params) { calls.push({ sql, params }); return handlers.all ? handlers.all(sql, params) : []; },
    async get(sql, params) { calls.push({ sql, params }); return handlers.get ? handlers.get(sql, params) : undefined; },
  };
}

test.beforeEach(() => scope._resetForTests());

test('flag off: wildcard admin scope, zero db reads', async () => {
  const db = fakeDb({});
  const s = await scope.resolveScope(db, 'u1', { scopedMode: false });
  assert.equal(s.role, 'admin');
  assert.equal(s.wildcard, true);
  assert.equal(db.calls.length, 0);
});

test('union rule: owned zones (users.id) plus granted zones (user_uuid)', async () => {
  const db = fakeDb({
    get: (sql) => sql.includes('FROM users')
      ? { id: 7, role: 'researcher', disabled_at: null } : undefined,
    all: (sql) => {
      if (sql.includes('FROM irrigation_zones')) return [{ zone_uuid: 'z-owned' }];
      if (sql.includes('FROM user_zone_assignments')) return [{ zone_uuid: 'z-granted' }];
      if (sql.includes('FROM user_plot_assignments')) return [{ plot_uuid: 'p-granted' }];
      if (sql.includes('FROM journal_plots')) return [{ plot_uuid: 'p-owned' }];
      return [];
    },
  });
  const s = await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.deepEqual([...s.zoneUuids].sort(), ['z-granted', 'z-owned']);
  assert.deepEqual([...s.plotUuids].sort(), ['p-granted', 'p-owned']);
});

test('null user_uuid is a hard error, never an empty scope', async () => {
  const db = fakeDb({ get: () => ({ id: 7, role: 'researcher', disabled_at: null, user_uuid: null }) });
  await assert.rejects(() => scope.resolveScope(db, null, { scopedMode: true }), /user_uuid/);
});

test('cache: second resolve within TTL hits no db; invalidateScope forces re-read', async () => {
  let userReads = 0;
  const db = fakeDb({
    get: () => { userReads += 1; return { id: 7, role: 'viewer', disabled_at: null }; },
  });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.equal(userReads, 1);
  scope.invalidateScope('u1');
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.equal(userReads, 2);
});

test('fresh asserts bypass cache; cached read path does not', async () => {
  let grantReads = 0;
  const db = fakeDb({
    get: (sql) => sql.includes('FROM users') ? { id: 7, role: 'researcher', disabled_at: null } : undefined,
    all: (sql) => {
      if (sql.includes('user_zone_assignments')) { grantReads += 1; return [{ zone_uuid: 'z1' }]; }
      return [];
    },
  });
  await scope.resolveScope(db, 'u1', { scopedMode: true });           // grants read #1
  await scope.assertZoneAccess(db, 'u1', 'z1', { scopedMode: true }); // cached: no new read
  assert.equal(grantReads, 1);
  await scope.assertFreshZoneAccess(db, 'u1', 'z1', { scopedMode: true }); // bypass: read #2
  assert.equal(grantReads, 2);
});

test('assertZoneAccess throws {status:404} outside scope; assertRole throws {status:403}', async () => {
  const db = fakeDb({
    get: () => ({ id: 7, role: 'viewer', disabled_at: null }),
    all: () => [],
  });
  await assert.rejects(
    () => scope.assertZoneAccess(db, 'u1', 'z-foreign', { scopedMode: true }),
    (e) => e.status === 404);
  await assert.rejects(
    () => scope.assertRole(db, 'u1', 'admin', { scopedMode: true }),
    (e) => e.status === 403);
});

test('disabled account fails closed on fresh paths', async () => {
  const db = fakeDb({ get: () => ({ id: 7, role: 'admin', disabled_at: '2026-07-01' }) });
  await assert.rejects(
    () => scope.assertFreshZoneAccess(db, 'u1', 'z1', { scopedMode: true }),
    (e) => e.status === 403 && /disabled/.test(e.message));
});
