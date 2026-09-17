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
// Follow-up (verifier V-265, mutation testing on PR #265): dropping
// "AND user_id=<ownerId>" from the UPDATE's WHERE clause -- while leaving the
// pre-flight SELECT above untouched -- left every behavioral test in this
// file green. That's expected, not a harness gap: `zoneId` is the table's
// primary key, so once the pre-flight SELECT has already confirmed the
// caller owns that exact row, an UPDATE ... WHERE id=<zoneId> (with or
// without the redundant "AND user_id=...") touches the same single row in
// every one of this file's fixtures. The predicate is still required
// defense-in-depth (it is what every sibling route on this guard does, and
// it is the only thing that would matter if the SELECT and UPDATE ever
// stopped being atomic, e.g. a future refactor onto a real transaction
// boundary, a retry path, or a second write added between them) -- so its
// presence is enforced with a static source-scan assertion below instead of
// a behavioral one.
//
// Uses the shared flow-node-harness (scripts/lib/scoped-access-harness.js)
// already exercising sibling nodes on the same guard in
// scripts/test-scoped-access-writes.js.
//
// Run: node --test scripts/test-zone-timezone-route.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

// --- F53 mutation guard (verifier V-265) -----------------------------------
// Static source-scan, not a behavioral test: see the header comment above for
// why a behavioral test cannot distinguish "UPDATE ... WHERE id=<zoneId>"
// from "UPDATE ... WHERE id=<zoneId> AND user_id=<ownerId>" once the
// pre-flight SELECT has already run. This asserts the UPDATE statement's own
// WHERE clause carries the exact same ownership expression the SELECT (and
// every sibling route on this guard) uses -- checked against both maintained
// hardware profiles.

const PROFILE_FLOWS_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

function loadDendroTzFunc(relFlowsPath) {
  const absPath = path.join(ROOT, relFlowsPath);
  const flows = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  const node = flows.find((candidate) => candidate.id === 'dendro-tz-fn');
  assert.ok(node, `${relFlowsPath}: dendro-tz-fn node not found`);
  assert.equal(typeof node.func, 'string');
  return node.func;
}

test('F53 mutation guard: the UPDATE itself (not just the pre-flight SELECT) carries the "AND user_id=<owner>" predicate, on both profiles', () => {
  for (const relFlowsPath of PROFILE_FLOWS_PATHS) {
    const func = loadDendroTzFunc(relFlowsPath);

    // The owner expression every sibling route on scoped-zone-config-guard
    // uses: `const <ownerVar> = (msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId);`
    const ownerDeclMatch = func.match(
      /const\s+(\w+)\s*=\s*\(\s*msg\._scopedZoneWriteAuthorized\s*\?\s*msg\._scopedZoneOwnerId\s*:\s*auth\.userId\s*\)/
    );
    assert.ok(
      ownerDeclMatch,
      `${relFlowsPath}: dendro-tz-fn must declare the same owner ternary its sibling routes use ` +
      `(msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId)`
    );
    const ownerVar = ownerDeclMatch[1];

    // Isolate the UPDATE statement specifically (not the earlier SELECT,
    // which also legitimately contains "AND user_id=..."): from the
    // "UPDATE irrigation_zones SET timezone" keyword to the next statement
    // terminator.
    const updateIdx = func.indexOf('UPDATE irrigation_zones SET timezone');
    assert.notEqual(updateIdx, -1, `${relFlowsPath}: no UPDATE irrigation_zones SET timezone statement found`);
    const terminatorIdx = func.indexOf(';', updateIdx);
    assert.notEqual(terminatorIdx, -1, `${relFlowsPath}: UPDATE statement has no terminating ';'`);
    const updateStatement = func.slice(updateIdx, terminatorIdx);

    const predicateRe = new RegExp('AND\\s+user_id\\s*=\\s*"\\s*\\+\\s*' + ownerVar + '\\b');
    assert.ok(
      predicateRe.test(updateStatement),
      `${relFlowsPath}: the UPDATE statement's WHERE clause must include AND user_id="+${ownerVar} ` +
      `(same expression as the pre-flight SELECT), not rely on the SELECT alone -- found: ${JSON.stringify(updateStatement)}`
    );
  }
});

console.log('zone timezone route (F31/F31b/F53) behavioral tests defined; run with `node --test` to execute.');
