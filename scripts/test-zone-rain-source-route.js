#!/usr/bin/env node
'use strict';

// Behavioural test for the zone rain gauge selection routes
//   GET /api/irrigation-zones/:zone_id/rain-source
//   PUT /api/irrigation-zones/:zone_id/rain-source   body { deveui: string | null }
// The PUT goes through the zone settings guard (scoped-zone-config-guard), the
// GET straight to the handler (zone reads are account-wide in scoped mode, W1).
// Both run the shipped function-node source through the flow-node harness.
//
// Run: node --test scripts/test-zone-rain-source-route.js

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');
const scopeHelper = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper'
);

const AUTH_SECRET = 'zone-rain-source-route-test-secret';
const FLAG_OFF = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
const FLAG_ON = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' };
const OWNER = { userId: 2, username: 'res1' };      // owns zone 1 ('Z One')
const STRANGER = { userId: 1, username: 'admin1' }; // owns zone 2
const VIEWER = { userId: 3, username: 'view1' };    // granted zone 1, cannot mutate

const LORAIN = 'A840410000000001';
const S2120 = 'A840410000000002';
const OTHER_ZONE_GAUGE = 'A840410000000003';
const GUARD_ROUTE_INDEX = 4;

// Zone 1 gets two gauges: a LoRain in the zone and an S2120 weather station
// that serves it through weather_station_zones. Zone 2 gets its own LoRain
// beside the seeded S2120 'WX1'.
function seedGauges(db) {
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
      ('${LORAIN}', 'Gauge north', 'AQUASCOPE_LORAIN', 2, 1, '2026-01-01', '2026-01-01'),
      ('${S2120}', 'Station east', 'SENSECAP_S2120', 2, NULL, '2026-01-01', '2026-01-01'),
      ('${OTHER_ZONE_GAUGE}', 'Gauge south', 'AQUASCOPE_LORAIN', 1, 2, '2026-01-01', '2026-01-01');
    INSERT INTO weather_station_zones (deveui, zone_id) VALUES ('${S2120}', 1);
  `);
}

function token(identity) {
  return makeAuthHeader({ userId: identity.userId, username: identity.username, secret: AUTH_SECRET });
}

function request({ method, zoneId = 1, body, authorization }) {
  return {
    req: {
      method,
      path: '/api/irrigation-zones/' + zoneId + '/rain-source',
      headers: authorization === undefined ? {} : { authorization },
      params: { zone_id: String(zoneId) },
      query: {},
      body: body === undefined ? {} : body,
    },
  };
}

async function getRoute(db, env, options) {
  scopeHelper._resetForTests();
  const handler = await executeFunction(loadNode('zone-rain-source-fn'), {
    msg: request({ method: 'GET', ...options }),
    env,
    db,
  });
  return handler.result;
}

async function putRoute(db, env, options) {
  scopeHelper._resetForTests();
  const guard = await executeFunction(loadNode('scoped-zone-config-guard'), {
    msg: request({ method: 'PUT', ...options }),
    env,
    db,
  });
  const failed = guard.result[guard.result.length - 1];
  if (failed) return { stage: 'guard', result: failed };
  const passed = guard.result[GUARD_ROUTE_INDEX];
  assert.ok(passed, 'the guard must pass the rain-source PUT on its own output');
  const handler = await executeFunction(loadNode('zone-rain-source-fn'), { msg: passed, env, db });
  return { stage: 'handler', result: handler.result };
}

function storedSelection(db, zoneId = 1) {
  return db.prepare('SELECT selected_deveui, selected_by_uuid FROM zone_rain_source WHERE zone_id = ?').get(zoneId);
}

test('flag-off: the owner reads an ambiguous zone with both candidates and the suggestion', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const result = await getRoute(db, FLAG_OFF, { authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.deepEqual(result.payload, {
      state: 'ambiguous',
      selected_deveui: null,
      basis: null,
      candidates: [
        { deveui: LORAIN, name: 'Gauge north', type_id: 'AQUASCOPE_LORAIN', via: 'direct' },
        { deveui: S2120, name: 'Station east', type_id: 'SENSECAP_S2120', via: 'weather_station' },
      ],
      suggested_deveui: LORAIN,
    });
  } finally {
    db.close();
  }
});

test('flag-off: a zone with one gauge reads as selected, basis only_candidate', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    db.exec("DELETE FROM weather_station_zones WHERE deveui = '" + S2120 + "'");
    const result = await getRoute(db, FLAG_OFF, { authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.state, 'selected');
    assert.equal(result.payload.selected_deveui, LORAIN);
    assert.equal(result.payload.basis, 'only_candidate');
    assert.equal(result.payload.suggested_deveui, null);
  } finally {
    db.close();
  }
});

test('flag-off: a foreign zone answers 404 on read and on write, and nothing is stored', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const read = await getRoute(db, FLAG_OFF, { authorization: token(STRANGER) });
    assert.equal(read.statusCode, 404, JSON.stringify(read.payload));
    const write = await putRoute(db, FLAG_OFF, { body: { deveui: LORAIN }, authorization: token(STRANGER) });
    assert.equal(write.result.statusCode, 404, JSON.stringify(write.result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});

test('no Authorization header answers 401 on read and on write', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const read = await getRoute(db, FLAG_OFF, { authorization: undefined });
    assert.equal(read.statusCode, 401, JSON.stringify(read.payload));
    const write = await putRoute(db, FLAG_OFF, { body: { deveui: LORAIN }, authorization: undefined });
    assert.equal(write.result.statusCode, 401, JSON.stringify(write.result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});

test('flag-off: the owner selects a candidate; the read then shows it as explicit', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const { stage, result } = await putRoute(db, FLAG_OFF, { body: { deveui: S2120.toLowerCase() }, authorization: token(OWNER) });
    assert.equal(stage, 'handler');
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.state, 'selected');
    assert.equal(result.payload.selected_deveui, S2120);
    assert.equal(result.payload.basis, 'explicit');
    assert.equal(storedSelection(db).selected_deveui, S2120);
    assert.equal(storedSelection(db).selected_by_uuid, 'u-res1');
    const read = await getRoute(db, FLAG_OFF, { authorization: token(OWNER) });
    assert.equal(read.payload.selected_deveui, S2120);
    assert.equal(read.payload.basis, 'explicit');
  } finally {
    db.close();
  }
});

test('flag-off: null clears the selection and the zone is ambiguous again', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    await putRoute(db, FLAG_OFF, { body: { deveui: LORAIN }, authorization: token(OWNER) });
    const { result } = await putRoute(db, FLAG_OFF, { body: { deveui: null }, authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.state, 'ambiguous');
    assert.equal(result.payload.selected_deveui, null);
    assert.equal(result.payload.suggested_deveui, LORAIN);
    assert.equal(storedSelection(db).selected_deveui, null);
  } finally {
    db.close();
  }
});

for (const [label, body] of [
  ['a gauge of another zone', { deveui: OTHER_ZONE_GAUGE }],
  ['a device that is not a gauge', { deveui: 'DENDRO1' }],
  ['an unknown device', { deveui: 'A8404100000000FF' }],
  ['an empty string', { deveui: '' }],
  ['a number', { deveui: 42 }],
  ['a body without deveui', {}],
]) {
  test('flag-off: ' + label + ' answers 400 and stores nothing', async () => {
    const db = seedScopedDb();
    seedGauges(db);
    try {
      const { result } = await putRoute(db, FLAG_OFF, { body, authorization: token(OWNER) });
      assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
      assert.equal(typeof result.payload.error, 'string');
      assert.equal(storedSelection(db), undefined);
    } finally {
      db.close();
    }
  });
}

test('scoped: a viewer reads the selection of a zone (account-wide read)', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const own = await getRoute(db, FLAG_ON, { authorization: token(VIEWER) });
    assert.equal(own.statusCode, 200, JSON.stringify(own.payload));
    assert.equal(own.payload.state, 'ambiguous');
    const other = await getRoute(db, FLAG_ON, { zoneId: 2, authorization: token(VIEWER) });
    assert.equal(other.statusCode, 200, JSON.stringify(other.payload));
  } finally {
    db.close();
  }
});

test('scoped: a viewer is refused 403 on write before anything is stored', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const { stage, result } = await putRoute(db, FLAG_ON, { body: { deveui: LORAIN }, authorization: token(VIEWER) });
    assert.equal(stage, 'guard');
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});

test('scoped: a researcher with no grant on the zone is refused without a write', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    db.exec("UPDATE user_zone_assignments SET deleted_at='2026-09-20T00:00:00Z' WHERE assignment_uuid='g-3'");
    const { stage, result } = await putRoute(db, FLAG_ON, { zoneId: 2, body: { deveui: OTHER_ZONE_GAUGE }, authorization: token(OWNER) });
    assert.equal(stage, 'guard');
    assert.ok(result.statusCode === 403 || result.statusCode === 404, String(result.statusCode));
    assert.equal(storedSelection(db, 2), undefined);
  } finally {
    db.close();
  }
});

test('scoped: a granted researcher selects the gauge of a zone it does not own', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const { stage, result } = await putRoute(db, FLAG_ON, { zoneId: 2, body: { deveui: OTHER_ZONE_GAUGE }, authorization: token(OWNER) });
    assert.equal(stage, 'handler');
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(storedSelection(db, 2).selected_deveui, OTHER_ZONE_GAUGE);
    assert.equal(storedSelection(db, 2).selected_by_uuid, 'u-res1');
  } finally {
    db.close();
  }
});

test('scoped: a disabled account cannot read', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    db.exec("UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'");
    const result = await getRoute(db, FLAG_ON, { authorization: token(VIEWER) });
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('scoped: a missing zone answers 404 on read', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const result = await getRoute(db, FLAG_ON, { zoneId: 999, authorization: token(STRANGER) });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('scoped: the handler called without the guard marker refuses the write', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    scopeHelper._resetForTests();
    const { result } = await executeFunction(loadNode('zone-rain-source-fn'), {
      msg: request({ method: 'PUT', body: { deveui: LORAIN }, authorization: token(OWNER) }),
      env: FLAG_ON,
      db,
    });
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});
