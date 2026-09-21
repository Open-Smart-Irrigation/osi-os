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
