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
// F53 (2026-09-17 overnight, T16d, CWE-639/IDOR): even a validly-signed
// bearer token could retime ANY zone by numeric id -- the UPDATE carried no
// ownership predicate at all. Every sibling write behind the same
// scoped-zone-config-guard (zone-config-fn, dendro-location-fn,
// zone-calibration-fn) already scopes both a pre-flight ownership SELECT and
// its UPDATE to
// `user_id = (msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId)`.
// That ternary IS the legacy (flag-off) contract too: a bearer token's own
// userId gates it to that user's own zones -- never "any authenticated user
// may edit any zone". Fixed by applying the identical predicate here.
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

async function callDendroTzWithEnv(db, env, options) {
  return executeFunction(loadNode('dendro-tz-fn'), {
    msg: tzRequest(options),
    env,
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

const SCOPED_ENV = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' };

function scopedTzRequest(userId, username, zoneId, timezone) {
  return {
    req: {
      method: 'PUT',
      path: `/api/irrigation-zones/${zoneId}/timezone`,
      headers: { authorization: makeAuthHeader({ userId, username, secret: AUTH_SECRET }) },
      params: { zone_id: String(zoneId) },
      query: {},
      body: timezone === undefined ? {} : { timezone },
    },
  };
}

test('F53: scoped ON -- a grantee reaches the legacy write as the resource owner, not as themselves (mirrors dendro-location-fn\'s W7 guard contract)', async () => {
  const db = seedScopedDb();
  try {
    // Zone 2 is owned by user 1 (admin1); user 2 (res1) only holds a scoped
    // grant to it (seedScopedDb's g-3 row). This proves _scopedZoneOwnerId
    // (the real owner, resolved by the guard) -- not the caller's own
    // auth.userId -- is what must gate the write.
    const guarded = await executeFunction(loadNode('scoped-zone-config-guard'), {
      msg: scopedTzRequest(2, 'res1', 2, 'Africa/Kampala'),
      env: SCOPED_ENV,
      db,
    });
    assert.equal(guarded.result[0]._scopedZoneOwnerId, 1, 'guard must resolve the real zone owner, not the grantee');

    const written = await executeFunction(loadNode('dendro-tz-fn'), {
      msg: guarded.result[0],
      env: SCOPED_ENV,
      db,
      osiLibModules: OSI_LIB_MODULES,
    });
    assert.equal(written.result.statusCode, 200, JSON.stringify(written.result.payload));
    assert.equal(written.result.payload.timezone, 'Africa/Kampala');
    const row = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 2').get();
    assert.equal(row.timezone, 'Africa/Kampala');
  } finally {
    db.close();
  }
});

test('F53: scoped ON -- this node does not trust it was reached through the guard: a bearer token for a non-owner/non-grantee user is rejected 404, not written (red before the fix: this answered 200)', async () => {
  const db = seedScopedDb();
  const before = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get().timezone;
  try {
    // Calls dendro-tz-fn directly, bypassing scoped-zone-config-guard
    // entirely, so msg._scopedZoneWriteAuthorized/_scopedZoneOwnerId are
    // never set -- exactly the F53 shape (any signed token reaching this
    // node). admin1 (user 1) owns zone 2, not zone 1, and has no grant to
    // zone 1 in seedScopedDb.
    const { result } = await callDendroTzWithEnv(db, SCOPED_ENV, {
      zoneId: 1,
      timezone: 'Africa/Kampala',
      authorization: validToken(1, 'admin1'),
    });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
    assert.equal(result.payload.error, 'Zone not found or access denied');
    const row = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get();
    assert.equal(row.timezone, before, 'a rejected write must leave the previous value intact');
  } finally {
    db.close();
  }
});

test('F53: flag off -- the legacy contract is "own zone only" via the bearer token\'s userId: the actual owner still succeeds', async () => {
  const db = seedScopedDb();
  try {
    // Zone 1 is owned by user 2 (res1); validToken() defaults to userId 2.
    const { result } = await callDendroTz(db, { zoneId: 1, timezone: 'Africa/Kampala', authorization: validToken() });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.timezone, 'Africa/Kampala');
    const row = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 1').get();
    assert.equal(row.timezone, 'Africa/Kampala');
  } finally {
    db.close();
  }
});

test('F53: flag off -- a signed token for a different user cannot retime a zone it does not own (this was the exact IDOR: 200 before the fix)', async () => {
  const db = seedScopedDb();
  const before = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 2').get().timezone;
  try {
    // Zone 2 is owned by user 1 (admin1); token belongs to user 2 (res1), who
    // owns zone 1 but not zone 2. Flag-off ignores the scope tables entirely
    // and gates purely on auth.userId, per the sibling routes.
    const { result } = await callDendroTz(db, { zoneId: 2, timezone: 'Africa/Kampala', authorization: validToken(2, 'res1') });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
    assert.equal(result.payload.error, 'Zone not found or access denied');
    const row = db.prepare('SELECT timezone FROM irrigation_zones WHERE id = 2').get();
    assert.equal(row.timezone, before, 'a rejected write must leave the previous value intact');
  } finally {
    db.close();
  }
});

console.log('zone timezone route (F31/F31b/F53) behavioral tests defined; run with `node --test` to execute.');
