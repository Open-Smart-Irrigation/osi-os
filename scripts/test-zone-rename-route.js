#!/usr/bin/env node
'use strict';

// Behavioural test for PUT /api/irrigation-zones/:id/name (nodes
// zone-rename-scope-guard + zone-rename-fn in the canonical flows.json).
// Runs the shipped function-node source through the flow-node harness in
// scripts/lib/scoped-access-harness.js, the same harness that covers the
// sibling zone writes in scripts/test-zone-timezone-route.js.
//
// Run: node --test scripts/test-zone-rename-route.js

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const AUTH_SECRET = 'zone-rename-route-test-secret';
const FLAG_OFF = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
const FLAG_ON = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' };
const OWNER = { userId: 2, username: 'res1' };      // owns zone id 1 ('Z One')
const STRANGER = { userId: 1, username: 'admin1' }; // owns zone id 2
const VIEWER = { userId: 3, username: 'view1' };    // granted zone 1, cannot mutate

function renameRequest({ zoneId = 1, name, authorization }) {
  return {
    req: {
      method: 'PUT',
      path: '/api/irrigation-zones/' + zoneId + '/name',
      headers: authorization === undefined ? {} : { authorization },
      params: { id: String(zoneId) },
      body: name === undefined ? {} : { name },
    },
  };
}

function token(identity) {
  return makeAuthHeader({ userId: identity.userId, username: identity.username, secret: AUTH_SECRET });
}

function linkCloud(db) {
  db.exec("INSERT OR REPLACE INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) "
    + "VALUES ('cloud', 1, '0016C001F11715E2', datetime('now'))");
}

async function callRoute(db, env, options) {
  const guard = await executeFunction(loadNode('zone-rename-scope-guard'), {
    msg: renameRequest(options),
    env,
    db,
  });
  if (guard.result[1]) return { stage: 'guard', result: guard.result[1], warnings: guard.warnings };
  const handler = await executeFunction(loadNode('zone-rename-fn'), {
    msg: guard.result[0],
    env,
    db,
  });
  return { stage: 'handler', result: handler.result, warnings: handler.warnings };
}

test('flag-off: the owner renames the zone, one sync_version bump, one outbox row', async () => {
  const db = seedScopedDb();
  linkCloud(db);
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: '  North block \n', authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, 'North block');
    assert.equal(result.payload.changed, true);
    assert.equal(result.payload.zone_uuid, 'z-1');
    assert.equal(result.payload.id, 1);
    const row = db.prepare('SELECT name, sync_version FROM irrigation_zones WHERE id=1').get();
    assert.equal(row.name, 'North block');
    assert.equal(Number(row.sync_version), Number(result.payload.sync_version));
    const events = db.prepare("SELECT op, payload_json FROM sync_outbox WHERE aggregate_type='ZONE'").all();
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_UPSERTED');
    assert.equal(JSON.parse(events[0].payload_json).name, 'North block');
  } finally {
    db.close();
  }
});

test('flag-off: an unchanged name writes nothing and emits no event', async () => {
  const db = seedScopedDb();
  linkCloud(db);
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Z One', authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.changed, false);
    assert.equal(db.prepare("SELECT count(*) n FROM sync_outbox WHERE aggregate_type='ZONE'").get().n, 0);
    assert.equal(db.prepare('SELECT sync_version FROM irrigation_zones WHERE id=1').get().sync_version, 1);
  } finally {
    db.close();
  }
});

test('flag-off: a stranger gets 404, never 403, and the zone keeps its name', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Taken', authorization: token(STRANGER) });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});

test('no Authorization header answers 401', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Anything', authorization: undefined });
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('a shaped but unsigned bearer token answers 401', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Anything', authorization: 'Bearer not-real.also-not-real' });
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of [
  ['empty', '', 'name_empty'],
  ['blank', '   ', 'name_empty'],
  ['control character', 'Row\t7', 'name_control_characters'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['lone surrogate', '\ud83c', 'name_invalid_unicode'],
]) {
  test('flag-off: a ' + label + ' name is 400 with reason ' + reason, async () => {
    const db = seedScopedDb();
    try {
      const { result } = await callRoute(db, FLAG_OFF, { name: value, authorization: token(OWNER) });
      assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
      assert.equal(result.payload.reason, reason);
      assert.equal(typeof result.payload.message, 'string');
      assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
    } finally {
      db.close();
    }
  });
}

test('flag-off: a body with no name field is 400 with reason name_empty', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: undefined, authorization: token(OWNER) });
    assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
    assert.equal(result.payload.reason, 'name_empty');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});

test('scoped: a granted researcher renames a zone owned by someone else', async () => {
  const db = seedScopedDb();
  try {
    // res1 (u-res1) holds grant g-3 on z-2, which admin1 owns.
    const { result } = await callRoute(db, FLAG_ON, { zoneId: 2, name: 'Granted block', authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=2').get().name, 'Granted block');
  } finally {
    db.close();
  }
});

test('scoped: a viewer is refused 403 before any write', async () => {
  const db = seedScopedDb();
  try {
    const { stage, result } = await callRoute(db, FLAG_ON, { name: 'Viewer edit', authorization: token(VIEWER) });
    assert.equal(stage, 'guard');
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(result.payload.message, 'Forbidden');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});

test('scoped: a zone the actor has no access to is refused without a write', async () => {
  const db = seedScopedDb();
  try {
    // view1 has no grant on z-2 and does not own it.
    const { stage, result } = await callRoute(db, FLAG_ON, { zoneId: 2, name: 'Nope', authorization: token(VIEWER) });
    assert.equal(stage, 'guard');
    assert.ok(result.statusCode === 403 || result.statusCode === 404, String(result.statusCode));
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=2').get().name, 'Z Two');
  } finally {
    db.close();
  }
});

test('a deleted zone answers 404', async () => {
  const db = seedScopedDb();
  try {
    db.exec("UPDATE irrigation_zones SET deleted_at='2026-09-20T00:00:00Z' WHERE id=1");
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Gone', authorization: token(OWNER) });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

// --- T6-I1b (fix round 1): zone-rename-fn must fail closed on its own in
// scoped mode, never trusting that it was reached through
// zone-rename-scope-guard. The guard's authorization marker is
// msg._scopedZoneWriteAuthorized === true (set only after
// scope.assertFreshZoneAccess succeeds); msg._scopedZoneOwnerId carries the
// real owner it resolved. Both tests below call zone-rename-fn directly,
// bypassing the guard entirely -- exactly the shape of a request that would
// reach the handler if the guard's own wires were ever swapped (see the
// wiring pin added to scripts/test-flows-wiring.js for the wiring half of
// this defense).

test('T6-I1b: scoped ON, handler called directly with a valid owner bearer but no guard marker -- 403, not a write', async () => {
  const db = seedScopedDb();
  try {
    // OWNER (res1, userId 2) really does own zone 1 ('Z One') -- a stale or
    // pre-fix handler would fall back to auth.userId and let this succeed.
    const { result } = await executeFunction(loadNode('zone-rename-fn'), {
      msg: renameRequest({ zoneId: 1, name: 'Sneaky rename', authorization: token(OWNER) }),
      env: FLAG_ON,
      db,
    });
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(result.payload.message, 'Forbidden');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});

test('T6-I1b: scoped ON, handler called directly with the guard marker set -- 200, ownership comes from the marker not the bearer', async () => {
  const db = seedScopedDb();
  try {
    // STRANGER (admin1, userId 1) authenticates, but the marker names the
    // real owner (userId 2, res1) -- proves ownerId is sourced from the
    // guard's own resolved marker, not from whoever is merely authenticated.
    const msg = renameRequest({ zoneId: 1, name: 'Marker-authorized rename', authorization: token(STRANGER) });
    msg._scopedZoneWriteAuthorized = true;
    msg._scopedZoneOwnerId = 2;
    const { result } = await executeFunction(loadNode('zone-rename-fn'), { msg, env: FLAG_ON, db });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, 'Marker-authorized rename');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Marker-authorized rename');
  } finally {
    db.close();
  }
});

// --- T6-M3 (fix round 1): normalizeEntityName is only ever documented to
// throw one of the four reviewed reason codes (osi-entity-name/index.js), so
// provoking any other code requires a stubbed osi-lib loader rather than
// real input -- the same osiLibModules override the shared harness already
// exposes for scripts/test-zone-timezone-route.js's osi-system-settings stub.

test('T6-M3: a normalizeEntityName throw with an unrecognized (or missing) reason code answers 500, not a 400 with a fallback reason', async () => {
  const db = seedScopedDb();
  try {
    const stubbedEntityName = {
      normalizeEntityName: () => { throw new Error('unexpected internal failure'); }, // no .code at all
      renameZone: async () => { throw new Error('must not be called: name validation should have short-circuited'); },
    };
    const { result } = await executeFunction(loadNode('zone-rename-fn'), {
      msg: renameRequest({ name: 'Anything', authorization: token(OWNER) }),
      env: FLAG_OFF,
      db,
      osiLibModules: { 'entity-name': stubbedEntityName },
    });
    assert.equal(result.statusCode, 500, JSON.stringify(result.payload));
    assert.equal(typeof result.payload.message, 'string');
    assert.equal('reason' in result.payload, false, 'a 500 must not carry a name-validation reason code');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});
