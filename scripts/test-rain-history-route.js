#!/usr/bin/env node
'use strict';

// Behavioural test for GET /api/devices/:deveui/rain-history (node
// rain-history-fn, both profiles): the farm day comes from the device's zone
// timezone on the gateway, the viewer's tz_offset_min is ignored, and a
// device the caller does not own leaks nothing (flag off).
//
// Run: node --test scripts/test-rain-history-route.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
const SECRET = 'rain-history-route-test-secret';
const FLAG_OFF = { AUTH_TOKEN_SECRET: SECRET, OSI_SCOPED_ACCESS: '0' };
const FLAG_ON = { AUTH_TOKEN_SECRET: SECRET, OSI_SCOPED_ACCESS: '1' };
const GAUGE = 'A840410000000001';
const NOW_MS = Date.parse('2026-07-02T10:00:00.000Z');

function flowsPath(profile) {
  return path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json');
}

// Zone z-2 (owned by admin1, user 1) in Zurich, with a gauge in it.
function seedRainDb() {
  const db = seedScopedDb();
  db.exec(`
    UPDATE irrigation_zones SET timezone = 'Europe/Zurich' WHERE zone_uuid = 'z-2';
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
      SELECT '${GAUGE}', 'Gauge', 'AQUASCOPE_LORAIN', 1, id, '2026-01-01', '2026-01-01'
        FROM irrigation_zones WHERE zone_uuid = 'z-2';
    INSERT INTO device_data (deveui, recorded_at, rain_mm_delta) VALUES
      ('${GAUGE}', '2026-07-01T21:30:00.000Z', 0.5),
      ('${GAUGE}', '2026-07-01T22:30:00.000Z', 1.0);
  `);
  return db;
}

function request(user, query) {
  return {
    req: {
      headers: { authorization: makeAuthHeader({ userId: user.userId, username: user.username, secret: SECRET }) },
      params: { deveui: GAUGE.toLowerCase() },
      query,
    },
  };
}

async function call(profile, db, user, query, env = FLAG_OFF) {
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    const response = await executeFunction(loadNode('rain-history-fn', flowsPath(profile)), {
      msg: request(user, query),
      env,
      db,
    });
    return response.result;
  } finally {
    Date.now = realNow;
  }
}

for (const profile of PROFILES) {
  const label = profile.replace('full_raspberrypi_bcm27xx_', '');

  test(`${label}: rain history answers the farm's days (version 2) and ignores tz_offset_min`, async () => {
    const db = seedRainDb();
    try {
      const owner = { userId: 1, username: 'admin1' };
      const result = await call(profile, db, owner, { days: '2', tz_offset_min: '-600' });
      assert.equal(result.statusCode, 200);
      assert.equal(result.payload.version, 2);
      assert.equal(result.payload.deveui, GAUGE);
      assert.equal(result.payload.timezone, 'Europe/Zurich');
      assert.equal(result.payload.timezone_basis, 'zone');
      assert.deepEqual(
        result.payload.days.map((day) => [day.day, day.total_mm, day.samples, day.quality, day.so_far]),
        [['2026-07-01', 0.5, 1, 'received_only', false], ['2026-07-02', 1, 1, 'received_only', true]]
      );
      assert.equal(result.payload.period_start, '2026-06-30T22:00:00.000Z');
      assert.equal(result.payload.period_end, '2026-07-02T10:00:00.000Z');

      const withoutOffset = await call(profile, db, owner, { days: '2' });
      const winterOffset = await call(profile, db, owner, { days: '2', tz_offset_min: '60' });
      assert.deepEqual(withoutOffset.payload, result.payload, 'tz_offset_min changes nothing');
      assert.deepEqual(winterOffset.payload, result.payload, 'a winter offset changes nothing (finding 9)');
    } finally {
      db.close();
    }
  });

  test(`${label}: flag off, a device the caller does not own answers 200 and leaks nothing`, async () => {
    const db = seedRainDb();
    try {
      const result = await call(profile, db, { userId: 2, username: 'res1' }, { days: '2' });
      assert.equal(result.statusCode, 200);
      assert.equal(result.payload.version, 2);
      assert.equal(result.payload.timezone, 'UTC');
      assert.equal(result.payload.timezone_basis, 'unassigned_default');
      assert.equal(result.payload.days.length, 2);
      assert.ok(result.payload.days.every((day) => day.samples === 0 && day.total_mm === null));
    } finally {
      db.close();
    }
  });

  test(`${label}: flag on, device reads stay account-wide`, async () => {
    const db = seedRainDb();
    try {
      const result = await call(profile, db, { userId: 3, username: 'view1' }, { days: '2' }, FLAG_ON);
      assert.equal(result.statusCode, 200);
      assert.equal(result.payload.timezone, 'Europe/Zurich');
      assert.deepEqual(result.payload.days.map((day) => day.total_mm), [0.5, 1]);
    } finally {
      db.close();
    }
  });

  test(`${label}: a missing token is still 401`, async () => {
    const db = seedRainDb();
    try {
      const response = await executeFunction(loadNode('rain-history-fn', flowsPath(profile)), {
        msg: { req: { headers: {}, params: { deveui: GAUGE }, query: { days: '2' } } },
        env: FLAG_OFF,
        db,
      });
      assert.equal(response.result.statusCode, 401);
    } finally {
      db.close();
    }
  });
}
