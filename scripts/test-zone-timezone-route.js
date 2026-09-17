#!/usr/bin/env node
'use strict';

// Behavioral regression test for PUT /api/irrigation-zones/:zone_id/timezone
// (dendro-tz-fn in the canonical flows.json), covering two defects found by
// the 2026-09-17 Silvan harness / T16c auth sweep:
//
// F31 (run-full2/ST1.md checks #17-18): the route persisted ANY string as a
// zone's timezone ("Not/AZone" -> 200, stored verbatim) while
// PUT /api/system/settings validates the same kind of value with
// Intl.DateTimeFormat and answers 422. Fixed by extracting that check into
// osi-system-settings's validateTimezone() (see api.js/api.test.js) and
// calling it here via osiLib.require('osi-system-settings').
//
// F31b (mid-task orchestrator finding, T16c auth sweep): the route's own
// "auth" check only tested that an Authorization header was present and
// shaped like "Bearer <x>" -- it never verified the token's HMAC signature
// or expiry. scoped-zone-config-guard (this route's upstream gate) does
// ZERO authentication of its own on the flag-off/default path (it is a pure
// passthrough when OSI_SCOPED_ACCESS is unset), so this was a full
// authentication bypass on the default configuration: any request shaped
// like `Authorization: Bearer x.x` reached the UPDATE. Fixed by copying the
// exact getAuthSecret()/verifyBearer() block this route's tab-mates on the
// same guard already use (zone-config-fn, dendro-location-fn).
//
// Uses the shared flow-node-harness (scripts/lib/scoped-access-harness.js)
// already exercising sibling nodes on the same guard in
// scripts/test-scoped-access-writes.js.
//
// Run: node --test scripts/test-zone-timezone-route.js

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
const systemSettings = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings'
));

const AUTH_SECRET = 'zone-timezone-route-test-secret';
const ENV = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
const OSI_LIB_MODULES = { 'osi-system-settings': systemSettings };

function tzRequest({ zoneId = 1, timezone, authorization }) {
  return {
    req: {
      headers: authorization === undefined ? {} : { authorization },
      params: { zone_id: String(zoneId) },
      body: timezone === undefined ? {} : { timezone },
    },
  };
}

async function callDendroTz(db, options) {
  return executeFunction(loadNode('dendro-tz-fn'), {
    msg: tzRequest(options),
    env: ENV,
    db,
    osiLibModules: OSI_LIB_MODULES,
  });
}

function validToken(userId = 2, username = 'res1') {
  return makeAuthHeader({ userId, username, secret: AUTH_SECRET });
}

test('F31b: PUT .../timezone with no Authorization header answers 401', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callDendroTz(db, { timezone: 'Africa/Kampala', authorization: undefined });
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('F31b: PUT .../timezone with a syntactically-shaped but unsigned/garbage bearer token answers 401, not 200 -- this is exactly the auth bypass', async () => {
  const db = seedScopedDb();
  try {
    // Before the fix, dendro-tz-fn only checked authHeader.startsWith('Bearer '),
    // so this garbage-but-shaped token would have sailed through to a 200.
    const { result } = await callDendroTz(db, {
      timezone: 'Africa/Kampala',
      authorization: 'Bearer not-a-real-token.also-not-real',
    });
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('F31b: PUT .../timezone with a validly-signed bearer token is authenticated (reaches validation/update)', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callDendroTz(db, {
      timezone: 'Africa/Kampala',
      authorization: validToken(),
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.timezone, 'Africa/Kampala');

    const row = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get();
    assert.equal(row.timezone, 'Africa/Kampala', 'the zone row must actually be updated');
  } finally {
    db.close();
  }
});

test('F31: an invalid (non-IANA) zone timezone is rejected the way the gateway-level route rejects one (422), not stored', async () => {
  const db = seedScopedDb();
  const before = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get().timezone;
  try {
    const { result } = await callDendroTz(db, { timezone: 'Not/AZone', authorization: validToken() });
    assert.equal(result.statusCode, 422, JSON.stringify(result.payload));
    assert.equal(result.payload.error, 'invalid_timezone');
    assert.equal(result.payload.message, 'timezone must be a valid IANA time zone');

    const row = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get();
    assert.equal(row.timezone, before, 'a rejected write must leave the previous value intact');
  } finally {
    db.close();
  }
});

test('F31: a missing zone timezone is rejected with 422, not silently defaulted to UTC', async () => {
  const db = seedScopedDb();
  const before = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get().timezone;
  try {
    const { result } = await callDendroTz(db, { timezone: undefined, authorization: validToken() });
    assert.equal(result.statusCode, 422, JSON.stringify(result.payload));
    assert.equal(result.payload.error, 'invalid_timezone');

    const row = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get();
    assert.equal(row.timezone, before, 'a rejected write must leave the previous value intact');
  } finally {
    db.close();
  }
});

console.log('zone timezone route (F31/F31b) behavioral tests defined; run with `node --test` to execute.');
