#!/usr/bin/env node
'use strict';

// Behavioural test for PUT /api/devices/:deveui/name (nodes
// device-rename-scope-guard + device-rename-fn in the canonical flows.json).
// The ChirpStack helper is injected as a fake through the harness's
// osiLibModules hook: no gRPC, no network.
//
// Run: node --test scripts/test-device-rename-route.js

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const AUTH_SECRET = 'device-rename-route-test-secret';
const BASE_ENV = { AUTH_TOKEN_SECRET: AUTH_SECRET, CHIRPSTACK_API_URL: 'http://127.0.0.1:8080', CHIRPSTACK_API_KEY: 'k' };
const FLAG_OFF = Object.assign({ OSI_SCOPED_ACCESS: '0' }, BASE_ENV);
const FLAG_ON = Object.assign({ OSI_SCOPED_ACCESS: '1' }, BASE_ENV);
const OWNER = { userId: 2, username: 'res1' };      // owns DENDRO1 and VALVE1
const STRANGER = { userId: 1, username: 'admin1' };
const VIEWER = { userId: 3, username: 'view1' };

function fakeChirpStack(behaviour) {
  const calls = [];
  return {
    calls,
    module: {
      createProvisioningClientFromEnv(env) {
        if (behaviour.unconfigured) throw new Error('CHIRPSTACK_API_URL is required');
        return { marker: 'client', apiUrl: env.get('CHIRPSTACK_API_URL') };
      },
      async updateDeviceName(client, devEui, readCurrentName) {
        const seen = await readCurrentName();
        calls.push({ devEui, seen, client: client && client.marker });
        if (behaviour.reject) throw new Error('14 UNAVAILABLE: no connection');
        return behaviour.outcome || 'updated';
      },
    },
  };
}

function renameRequest({ deveui = 'DENDRO1', name, authorization }) {
  return {
    req: {
      method: 'PUT',
      path: '/api/devices/' + deveui + '/name',
      headers: authorization === undefined ? {} : { authorization },
      params: { deveui },
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

// Deviation from task-7-brief.md: osi-entity-name's renameDeviceInTransaction
// requires a strict 16-hex DevEUI (conf/.../osi-entity-name/index.js's EUI
// regex; its own index.test.js uses the hex constant 'AABBCCDDEEFF0011').
// scripts/lib/scoped-access-harness.js's shared seedScopedDb() fixture seeds
// human-readable placeholder DevEUIs ('DENDRO1'/'DENDRO2'/etc.) that are not
// hex, so any test that reaches an actual renameDevice call 500s with
// "renameDevice requires a 16-hex DevEUI" against them. Rather than touch the
// shared fixture (used by many other test files), this file inserts its own
// additional hex-format sibling rows, matching each DENDRO*'s ownership/zone.
const DEVICE_HEX_1 = 'AABBCCDDEEFF0011'; // sibling of DENDRO1: owned by OWNER (res1, userId 2), zone 1
const DEVICE_HEX_2 = 'AABBCCDDEEFF0022'; // sibling of DENDRO2: owned by STRANGER (admin1, userId 1), zone 2 (res1 has grant g-3)

function seedRenameableDevice(db, { deveui, name, userId, zoneId }) {
  db.prepare(
    'INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) '
    + "VALUES (?, ?, 'DRAGINO_LSN50', ?, ?, '2026-01-01', '2026-01-01')"
  ).run(deveui, name, userId, zoneId);
}

async function callRoute(db, env, options, chirpstack) {
  const osiLibModules = chirpstack ? { chirpstack: chirpstack.module } : {};
  const guard = await executeFunction(loadNode('device-rename-scope-guard'), {
    msg: renameRequest(options),
    env,
    db,
    osiLibModules,
  });
  if (guard.result[1]) return { stage: 'guard', result: guard.result[1], warnings: guard.warnings };
  const handler = await executeFunction(loadNode('device-rename-fn'), {
    msg: guard.result[0],
    env,
    db,
    osiLibModules,
  });
  return { stage: 'handler', result: handler.result, warnings: handler.warnings };
}

test('flag-off: the owner renames the device and ChirpStack is updated', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  linkCloud(db);
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { deveui: DEVICE_HEX_1, name: '\u00a0Bloc nord\u00a0', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, 'Bloc nord');
    assert.equal(result.payload.changed, true);
    assert.equal(result.payload.deveui, DEVICE_HEX_1);
    assert.equal(result.payload.chirpstack, 'updated');
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_HEX_1).name, 'Bloc nord');
    // readCurrentName runs against the still-open handle and sees the committed name.
    assert.deepEqual(cs.calls.map((c) => [c.devEui, c.seen]), [[DEVICE_HEX_1, 'Bloc nord']]);
    const events = db.prepare("SELECT op, payload_json FROM sync_outbox WHERE aggregate_type='DEVICE'").all();
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'DEVICE_FLAGS_UPDATED');
    assert.equal(JSON.parse(events[0].payload_json).name, 'Bloc nord');
  } finally {
    db.close();
  }
});

test('a gRPC failure leaves the rename committed and reports chirpstack failed', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  const cs = fakeChirpStack({ reject: true });
  try {
    const { result, warnings } = await callRoute(db, FLAG_OFF, { deveui: DEVICE_HEX_1, name: 'Tree A', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.changed, true);
    assert.equal(result.payload.chirpstack, 'failed');
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_HEX_1).name, 'Tree A');
    assert.ok(warnings.some((w) => /ChirpStack update failed/.test(w)), JSON.stringify(warnings));
  } finally {
    db.close();
  }
});

test('an unconfigured provisioning client reports chirpstack skipped, not failed', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  const cs = fakeChirpStack({ unconfigured: true });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { deveui: DEVICE_HEX_1, name: 'Tree B', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.chirpstack, 'skipped');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_HEX_1).name, 'Tree B');
  } finally {
    db.close();
  }
});

test("a ChirpStack 'unchanged' result reports skipped", async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  const cs = fakeChirpStack({ outcome: 'unchanged' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { deveui: DEVICE_HEX_1, name: 'Tree C', authorization: token(OWNER) }, cs);
    assert.equal(result.payload.chirpstack, 'skipped');
  } finally {
    db.close();
  }
});

test('an unchanged name writes nothing, emits nothing, and never calls ChirpStack', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  linkCloud(db);
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { deveui: DEVICE_HEX_1, name: 'Tree 1', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.changed, false);
    assert.equal(result.payload.chirpstack, 'skipped');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM sync_outbox WHERE aggregate_type='DEVICE'").get().n, 0);
  } finally {
    db.close();
  }
});

test('flag-off: a stranger gets 404 and no ChirpStack call', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Taken', authorization: token(STRANGER) }, cs);
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('no Authorization header answers 401', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Anything', authorization: undefined }, fakeChirpStack({}));
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of [
  ['empty', '', 'name_empty'],
  ['control character', 'Row\u00007', 'name_control_characters'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['trailing lone surrogate', '\udf31x', 'name_invalid_unicode'],
]) {
  test('flag-off: a ' + label + ' name is 400 with reason ' + reason, async () => {
    const db = seedScopedDb();
    const cs = fakeChirpStack({});
    try {
      const { result } = await callRoute(db, FLAG_OFF, { name: value, authorization: token(OWNER) }, cs);
      assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
      assert.equal(result.payload.reason, reason);
      assert.equal(cs.calls.length, 0);
      assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
    } finally {
      db.close();
    }
  });
}

test('a body with no name field is 400 with reason name_empty', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({});
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: undefined, authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
    assert.equal(result.payload.reason, 'name_empty');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('100 code points of a 2-unit emoji are accepted unchanged', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  const cs = fakeChirpStack({ outcome: 'updated' });
  const name = '\ud83c\udf31'.repeat(100);
  try {
    const { result } = await callRoute(db, FLAG_OFF, { deveui: DEVICE_HEX_1, name, authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, name);
  } finally {
    db.close();
  }
});

test('scoped: a granted researcher renames a device owned by someone else', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_2, name: 'Tree 2', userId: 1, zoneId: 2 });
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    // res1 holds grant g-3 on z-2; DEVICE_HEX_2 sits in zone 2 and is owned by admin1.
    const { result } = await callRoute(db, FLAG_ON, { deveui: DEVICE_HEX_2, name: 'Granted tree', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_HEX_2).name, 'Granted tree');
  } finally {
    db.close();
  }
});

// The plan's coverage row claims an admin case and a no-access case on this
// route. In scoped mode nobody holds a wildcard: osi-scope-helper's loadScope
// builds an admin's scope from owned zones plus grants, exactly as it does for
// a researcher, so the admin role buys canMutate and nothing more. The two
// tests below are the same actor on either side of that line.
test('scoped: an admin renames a device in a zone it owns', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_2, name: 'Tree 2', userId: 1, zoneId: 2 });
  linkCloud(db);
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    // admin1 (STRANGER here) owns z-2, where DEVICE_HEX_2 sits.
    const { stage, result } = await callRoute(db, FLAG_ON, { deveui: DEVICE_HEX_2, name: 'Admin tree', authorization: token(STRANGER) }, cs);
    assert.equal(stage, 'handler');
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.changed, true);
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_HEX_2).name, 'Admin tree');
  } finally {
    db.close();
  }
});

test('scoped: a mutation-capable actor with no grant on the device zone is refused without a write', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    // admin1 passes the role check and then fails the device check:
    // DEVICE_HEX_1 sits in z-1, which admin1 neither owns nor was granted.
    const { stage, result } = await callRoute(db, FLAG_ON, { deveui: DEVICE_HEX_1, name: 'Nope', authorization: token(STRANGER) }, cs);
    assert.equal(stage, 'guard');
    assert.ok(result.statusCode === 403 || result.statusCode === 404, String(result.statusCode));
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_HEX_1).name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('scoped: a viewer is refused 403 before any write or ChirpStack call', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { stage, result } = await callRoute(db, FLAG_ON, { name: 'Viewer edit', authorization: token(VIEWER) }, cs);
    assert.equal(stage, 'guard');
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(result.payload.message, 'Forbidden');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('an unknown DevEUI answers 404', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { deveui: 'NOPE0001', name: 'Ghost', authorization: token(OWNER) }, fakeChirpStack({}));
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

// --- T7-I1 (GLOBAL.md amendment A4.2, mirroring zone-rename-fn's T6-I1b):
// device-rename-fn must fail closed on its own in scoped mode, never trusting
// that it was reached through device-rename-scope-guard. The guard's
// authorization marker is msg._scopedDeviceWriteAuthorized === true (set only
// after scope.assertFreshDeviceAccess succeeds); msg._scopedDeviceOwnerId
// carries the real owner it resolved. Both tests below call device-rename-fn
// directly, bypassing the guard entirely -- exactly the shape of a request
// that would reach the handler if the guard's own wires were ever swapped
// (see the wiring pin added to scripts/test-flows-wiring.js for the wiring
// half of this defense).

test('T7-I1: scoped ON, handler called directly with a valid owner bearer but no guard marker -- 403, not a write', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    // OWNER (res1, userId 2) really does own DENDRO1 ('Tree 1') -- a stale or
    // pre-fix handler would fall back to auth.userId and let this succeed.
    const { result } = await executeFunction(loadNode('device-rename-fn'), {
      msg: renameRequest({ deveui: 'DENDRO1', name: 'Sneaky rename', authorization: token(OWNER) }),
      env: FLAG_ON,
      db,
      osiLibModules: { chirpstack: cs.module },
    });
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(result.payload.message, 'Forbidden');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('T7-I1: scoped ON, handler called directly with the guard marker set -- 200, ownership comes from the marker not the bearer', async () => {
  const db = seedScopedDb();
  seedRenameableDevice(db, { deveui: DEVICE_HEX_1, name: 'Tree 1', userId: 2, zoneId: 1 });
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    // STRANGER (admin1, userId 1) authenticates, but the marker names the
    // real owner (userId 2, res1) -- proves ownerId is sourced from the
    // guard's own resolved marker, not from whoever is merely authenticated.
    const msg = renameRequest({ deveui: DEVICE_HEX_1, name: 'Marker-authorized rename', authorization: token(STRANGER) });
    msg._scopedDeviceWriteAuthorized = true;
    msg._scopedDeviceOwnerId = 2;
    const { result } = await executeFunction(loadNode('device-rename-fn'), { msg, env: FLAG_ON, db, osiLibModules: { chirpstack: cs.module } });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, 'Marker-authorized rename');
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_HEX_1).name, 'Marker-authorized rename');
  } finally {
    db.close();
  }
});

// --- T7-M1 (GLOBAL.md amendment A4.3, mirroring zone-rename-fn's T6-M3):
// normalizeEntityName is only ever documented to throw one of the four
// reviewed reason codes (osi-entity-name/index.js), so provoking any other
// code requires a stubbed osi-lib loader rather than real input -- the same
// osiLibModules override the shared harness already exposes.

test('T7-M1: a normalizeEntityName throw with an unrecognized (or missing) reason code answers 500, not a 400 with a fallback reason', async () => {
  const db = seedScopedDb();
  try {
    const stubbedEntityName = {
      normalizeEntityName: () => { throw new Error('unexpected internal failure'); }, // no .code at all
      renameDevice: async () => { throw new Error('must not be called: name validation should have short-circuited'); },
    };
    const { result } = await executeFunction(loadNode('device-rename-fn'), {
      msg: renameRequest({ name: 'Anything', authorization: token(OWNER) }),
      env: FLAG_OFF,
      db,
      osiLibModules: { 'entity-name': stubbedEntityName },
    });
    assert.equal(result.statusCode, 500, JSON.stringify(result.payload));
    assert.equal(typeof result.payload.message, 'string');
    assert.equal('reason' in result.payload, false, 'a 500 must not carry a name-validation reason code');
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});
