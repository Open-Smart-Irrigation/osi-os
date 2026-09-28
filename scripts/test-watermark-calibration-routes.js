#!/usr/bin/env node
'use strict';

// WATERMARK calibration HTTP routes: GET/PUT/DELETE
// /api/devices/:deveui/watermark/calibration. Every request runs through the
// whole shipped chain in the canonical flows.json, following each node's real
// `wires`: http in -> (scoped-device-config-guard for PUT/DELETE) ->
// watermark-cal-fn -> device-response. The function nodes execute through
// scripts/lib/flow-node-harness.js against one in-memory seed-blank.sql DB via
// the real osi-db-helper facade (the scripts/test-watermark-ingest-flow.js
// pattern) and the real osi-watermark-helper / osi-scope-helper.
// The bcm2709 mirror is byte-identical (scripts/verify-profile-parity.js).
//
// Fixture: user A (owner, researcher), B (other researcher), V (viewer) and
// R (researcher with no assignment); A owns zone Z and the DRAGINO_LSN50 in
// it; B and V are assigned to Z.
//
// Express answers HEAD with the GET route, so HEAD enters the chain at
// watermark-cal-get-http (no guard); the handler must refuse it (405).
//
// The same fixture drives PUT /api/devices/:deveui/soil-moisture-depths
// (put-soil-depth-http -> guard output 17 -> put-soil-depth-fn), the route
// the WATERMARK depth form saves through: flag off it keeps the bearer +
// owner filter; scoped, a message the guard vouched for (actor_user_uuid)
// skips the owner filter, so an assigned researcher can save depths.
//
// Run: node scripts/test-watermark-calibration-routes.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, makeAuthHeader } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const FLOWS = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const SEED_SQL = path.join(ROOT, 'database/seed-blank.sql');
const DB_HELPER_PATH = path.join(NR, 'osi-db-helper', 'index.js');

const watermarkHelper = require(path.join(NR, 'osi-watermark-helper'));
const scopeHelper = require(path.join(NR, 'osi-scope-helper'));

const AUTH_SECRET = 'watermark-calibration-test-secret';
const ENV_OFF = Object.freeze({ AUTH_TOKEN_SECRET: AUTH_SECRET });
const ENV_SCOPED = Object.freeze({ AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' });
const DEVEUI = 'A84041A171000001';
const ROUTE_PATH = '/api/devices/' + DEVEUI + '/watermark/calibration';
const DEPTH_PATH = '/api/devices/' + DEVEUI + '/soil-moisture-depths';
const HTTP = Object.freeze({
  GET: 'watermark-cal-get-http',
  HEAD: 'watermark-cal-get-http',
  PUT: 'watermark-cal-put-http',
  DELETE: 'watermark-cal-delete-http',
});
const USERS = Object.freeze({
  A: { id: 1, username: 'owner_a' },
  B: { id: 2, username: 'res_b' },
  V: { id: 3, username: 'view_v' },
  R: { id: 4, username: 'res_r' },
});
const VALUES = Object.freeze({
  pullup_1_ohm: 47000, pulldown_1_ohm: 47000, series_fwd_1_ohm: 120, series_rev_1_ohm: 110,
  pullup_2_ohm: 46800, pulldown_2_ohm: 47100, series_fwd_2_ohm: 130, series_rev_2_ohm: 125,
});

// ---------------------------------------------------------------- helpers --

const FLOW_NODES = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const BY_ID = new Map(FLOW_NODES.map((n) => [n.id, n]));

// node:sqlite-backed sqlite3 adapter bound to one pre-seeded DatabaseSync, so
// the real osi-db-helper opens exactly that DB whatever path a node passes
// (same adapter as scripts/test-watermark-ingest-flow.js).
function sqlite3Adapter(native) {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = native;
      queueMicrotask(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); }
      catch (error) { callback.call(this, error); }
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
      } catch (error) { callback.call(this, error); }
    }
    exec(sql, callback) {
      try { this.native.exec(sql); callback.call(this, null); }
      catch (error) { callback.call(this, error); }
    }
    close(callback) { if (callback) callback.call(this, null); }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

// A fresh copy of the real osi-db-helper (its shared connection is a module
// singleton) whose require('sqlite3') resolves to the adapter above.
function realOsiDb(native) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) return sqlite3Adapter(native);
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally {
    Module._load = original;
  }
}

function freshDb() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(SEED_SQL, 'utf8'));
  native.exec(`
    INSERT INTO users (id, username, password_hash, created_at, user_uuid, role, sync_version) VALUES
      (1, 'owner_a', 'h', '2026-01-01', 'u-a', 'researcher', 1),
      (2, 'res_b',   'h', '2026-01-01', 'u-b', 'researcher', 1),
      (3, 'view_v',  'h', '2026-01-01', 'u-v', 'viewer', 1),
      (4, 'res_r',   'h', '2026-01-01', 'u-r', 'researcher', 1);
    INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, timezone, scheduling_mode) VALUES
      (1, 'Z A', 1, 'z-a', 'UTC', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
      ('${DEVEUI}', 'Watermark 1+2', 'DRAGINO_LSN50', 1, 1, '2026-01-01', '2026-01-01');
    INSERT INTO user_zone_assignments (assignment_uuid, user_uuid, zone_uuid, created_at) VALUES
      ('g-b', 'u-b', 'z-a', '2026-01-01'),
      ('g-v', 'u-v', 'z-a', '2026-01-01');
  `);
  return native;
}

function calibrationRow(native) {
  const row = native.prepare('SELECT * FROM watermark_calibrations WHERE deveui = ?').get(DEVEUI);
  return row ? { ...row } : null;
}

// Node-RED http-in message: msg.req (Express shape) + msg.payload = parsed body.
function request(method, who, { body, query = {}, bearer = true, path: routePath = ROUTE_PATH } = {}) {
  const user = who ? USERS[who] : null;
  const headers = bearer && user
    ? { authorization: makeAuthHeader({ userId: user.id, username: user.username, secret: AUTH_SECRET }) }
    : {};
  return {
    req: { method, path: routePath, url: routePath, headers, params: { deveui: DEVEUI }, query, body: body || {} },
    payload: method === 'GET' || method === 'HEAD' ? query : (body || {}),
  };
}

// osiLib stand-in: resolves the two helpers the chain needs and records every
// name. With the flag off, require('scope') throws, so reaching it fails the
// case (the verify-auth-flag-off-hermetic.js contract, exercised end to end).
function osiLibSpy(scoped, requested) {
  return {
    require(name) {
      requested.push(name);
      if (name === 'scope') {
        if (!scoped) throw new Error("osiLib.require('scope') reached with OSI_SCOPED_ACCESS unset");
        return { ok: true, value: scopeHelper };
      }
      if (name === 'watermark-helper') return { ok: true, value: watermarkHelper };
      return { ok: false, error: 'not provided in this test: ' + name };
    },
  };
}

// Follows the shipped wiring from the http-in node to the http response node,
// executing each function node on the way. Exactly one output may carry the
// message at each hop.
async function runChain(native, method, who, options = {}) {
  const scoped = options.scoped === true;
  const env = scoped ? ENV_SCOPED : ENV_OFF;
  const requested = [];
  const httpInId = options.httpIn || HTTP[method];
  const httpIn = BY_ID.get(httpInId);
  assert.ok(httpIn, 'http in node missing: ' + httpInId);
  let msg = request(method, who, options);
  const trail = [httpIn.id];
  let targets = httpIn.wires[0];
  for (let hop = 0; hop < 8; hop += 1) {
    assert.equal(targets.length, 1, trail.join(' -> ') + ': expected exactly one wire target');
    const next = BY_ID.get(targets[0]);
    assert.ok(next, 'wired to a missing node: ' + targets[0]);
    trail.push(next.id);
    if (next.type === 'http response') {
      return { status: msg.statusCode, body: msg.payload, trail, requested };
    }
    assert.equal(next.type, 'function', next.id + ' is not a function node');
    if (scoped) scopeHelper._resetForTests();
    let out;
    try {
      out = await executeFunction(next, {
        msg,
        env,
        libOverrides: { osiDb: realOsiDb(native), osiLib: osiLibSpy(scoped, requested) },
      });
    } catch (error) {
      // A handler that throws (put-soil-depth-fn's bearer check) is answered
      // by the tab's catch node from error.statusCode and msg._osiAuthFailure.
      return { status: error && error.statusCode, thrown: error, authFailure: msg._osiAuthFailure || null, trail, requested };
    }
    assert.deepEqual(out.errors, [], next.id + ' node.error: ' + out.errors.join('; '));
    const outputs = Array.isArray(out.result) ? out.result : [out.result];
    const live = outputs.map((m, i) => [m, i]).filter(([m]) => m);
    assert.equal(live.length, 1, next.id + ': expected exactly one output message, got ' + live.length);
    assert.ok(live[0][1] < next.wires.length, next.id + ': output ' + live[0][1] + ' has no wire');
    msg = live[0][0];
    targets = next.wires[live[0][1]];
  }
  throw new Error('chain did not reach an http response: ' + trail.join(' -> '));
}

// Runs watermark-cal-fn alone on a hand-built message (no guard in front).
async function runHandler(native, msg, scoped) {
  const requested = [];
  if (scoped) scopeHelper._resetForTests();
  const out = await executeFunction(BY_ID.get('watermark-cal-fn'), {
    msg,
    env: scoped ? ENV_SCOPED : ENV_OFF,
    libOverrides: { osiDb: realOsiDb(native), osiLib: osiLibSpy(scoped, requested) },
  });
  assert.deepEqual(out.errors, []);
  return { status: out.result.statusCode, body: out.result.payload, requested };
}

// The 8 values plus expected_sync_version as query strings (what a HEAD carries).
const QUERY_WRITE = Object.freeze(Object.fromEntries(
  Object.entries({ ...VALUES, expected_sync_version: 0 }).map(([k, v]) => [k, String(v)])
));

const VIA_GUARD = ['scoped-device-config-guard', 'watermark-cal-fn', 'device-response'];
const DIRECT = ['watermark-cal-fn', 'device-response'];

// ------------------------------------------------------------------ cases --

const CASES = [
  {
    name: 'wiring: GET -> watermark-cal-fn; PUT/DELETE -> guard outputs 25/26 -> watermark-cal-fn; guard error output 27',
    async run() {
      const url = '/api/devices/:deveui/watermark/calibration';
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const id = HTTP[method];
        const n = BY_ID.get(id);
        assert.ok(n, 'missing ' + id);
        assert.equal(n.type, 'http in');
        assert.equal(n.z, 'device-api-tab');
        assert.equal(n.url, url);
        assert.equal(n.method, method.toLowerCase());
        assert.deepEqual(n.wires, [[method === 'GET' ? 'watermark-cal-fn' : 'scoped-device-config-guard']]);
      }
      const fn = BY_ID.get('watermark-cal-fn');
      assert.equal(fn.z, 'device-api-tab');
      assert.equal(fn.outputs, 1);
      assert.deepEqual(fn.wires, [['device-response']]);
      const guard = BY_ID.get('scoped-device-config-guard');
      assert.equal(guard.outputs, 28);
      assert.equal(guard.wires.length, 28);
      assert.deepEqual(guard.wires[25], ['watermark-cal-fn']);
      assert.deepEqual(guard.wires[26], ['watermark-cal-fn']);
      assert.deepEqual(guard.wires[27], ['device-response']);
      assert.ok(guard.func.includes('{"method":"PUT","suffix":"/watermark/calibration","index":25},{"method":"DELETE","suffix":"/watermark/calibration","index":26}]'));
    },
  },
  {
    name: 'flag off (a)-(e): GET, versioned PUT, stale PUT 409, dry run, versioned DELETE by the owner',
    async run() {
      const native = freshDb();
      // (a)
      const a = await runChain(native, 'GET', 'A');
      assert.deepEqual(a.trail.slice(1), DIRECT);
      assert.equal(a.status, 200);
      assert.deepEqual(a.body, { deveui: DEVEUI, sync_version: 0, calibration: null });
      // (b)
      const body = { ...VALUES, expected_sync_version: 0, method: 'bench', notes: 'first' };
      const b = await runChain(native, 'PUT', 'A', { body });
      assert.deepEqual(b.trail.slice(1), VIA_GUARD);
      assert.equal(b.status, 200, JSON.stringify(b.body));
      assert.equal(b.body.sync_version, 1);
      assert.equal(b.body.calibration.pullup_1_ohm, 47000);
      assert.equal(calibrationRow(native).sync_version, 1);
      // (c)
      const c = await runChain(native, 'PUT', 'A', { body });
      assert.equal(c.status, 409);
      assert.equal(c.body.code, 'stale_sync_version');
      assert.equal(c.body.current_sync_version, 1);
      assert.equal(typeof c.body.message, 'string');
      assert.equal(c.body.field, null);
      // (d)
      const before = calibrationRow(native);
      const d = await runChain(native, 'PUT', 'A', { body: { ...VALUES, pullup_1_ohm: 30000, dry_run: true } });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.equal(d.body.dry_run, true);
      assert.deepEqual(calibrationRow(native), before, 'dry run changed the stored calibration');
      // (e)
      const e = await runChain(native, 'DELETE', 'A', { query: { expected_sync_version: '1' } });
      assert.deepEqual(e.trail.slice(1), VIA_GUARD);
      assert.equal(e.status, 200, JSON.stringify(e.body));
      assert.deepEqual(e.body, { deveui: DEVEUI, sync_version: 2, calibration: null });
      const deleted = calibrationRow(native);
      assert.equal(deleted.sync_version, 2);
      assert.ok(deleted.deleted_at, 'DELETE left no tombstone');
      const after = await runChain(native, 'GET', 'A');
      assert.deepEqual(after.body, { deveui: DEVEUI, sync_version: 2, calibration: null });
      for (const r of [a, b, c, d, e, after]) assert.ok(!r.requested.includes('scope'));
      native.close();
    },
  },
  {
    name: 'flag off (f): another researcher gets 404 on PUT, DELETE and GET for the owner\'s device; nothing changes',
    async run() {
      const native = freshDb();
      const f = await runChain(native, 'PUT', 'B', { body: { ...VALUES, expected_sync_version: 0 } });
      assert.equal(f.status, 404, JSON.stringify(f.body));
      assert.equal(f.body.code, 'device_not_found');
      assert.equal(calibrationRow(native), null);
      await runChain(native, 'PUT', 'A', { body: { ...VALUES, expected_sync_version: 0 } });
      const before = calibrationRow(native);
      const del = await runChain(native, 'DELETE', 'B', { query: { expected_sync_version: '1' } });
      assert.equal(del.status, 404);
      const get = await runChain(native, 'GET', 'B');
      assert.equal(get.status, 404);
      assert.deepEqual(calibrationRow(native), before);
      native.close();
    },
  },
  {
    name: 'flag off (g): no bearer -> 401 on GET, PUT and DELETE; nothing changes',
    async run() {
      const native = freshDb();
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const r = await runChain(native, method, 'A', {
          bearer: false,
          body: { ...VALUES, expected_sync_version: 0 },
          query: { expected_sync_version: '0' },
        });
        assert.equal(r.status, 401, method + ' ' + JSON.stringify(r.body));
        assert.ok(!r.requested.includes('scope'));
      }
      assert.equal(calibrationRow(native), null);
      native.close();
    },
  },
  {
    name: 'scoped (h): researcher B, assigned to the device\'s zone but not its owner, PUT -> 200 and DELETE -> 200 through the guard',
    async run() {
      const native = freshDb();
      const h = await runChain(native, 'PUT', 'B', { scoped: true, body: { ...VALUES, expected_sync_version: 0 } });
      assert.deepEqual(h.trail.slice(1), VIA_GUARD);
      assert.equal(h.status, 200, JSON.stringify(h.body));
      assert.equal(h.body.sync_version, 1);
      assert.equal(calibrationRow(native).sync_version, 1);
      const del = await runChain(native, 'DELETE', 'B', { scoped: true, query: { expected_sync_version: '1' } });
      assert.equal(del.status, 200, JSON.stringify(del.body));
      assert.equal(del.body.sync_version, 2);
      native.close();
    },
  },
  {
    name: 'scoped (i): viewer V (assigned to the zone) PUT -> 403 from the guard, the handler never runs, DB unchanged',
    async run() {
      const native = freshDb();
      await runChain(native, 'PUT', 'A', { scoped: true, body: { ...VALUES, expected_sync_version: 0 } });
      const before = calibrationRow(native);
      const i = await runChain(native, 'PUT', 'V', { scoped: true, body: { ...VALUES, pullup_1_ohm: 30000, expected_sync_version: 1 } });
      assert.equal(i.status, 403, JSON.stringify(i.body));
      assert.deepEqual(i.trail.slice(1), ['scoped-device-config-guard', 'device-response']);
      assert.deepEqual(calibrationRow(native), before);
      const del = await runChain(native, 'DELETE', 'V', { scoped: true, query: { expected_sync_version: '1' } });
      assert.equal(del.status, 403);
      assert.deepEqual(calibrationRow(native), before);
      native.close();
    },
  },
  {
    name: 'scoped (j): researcher B GET -> 200 (account-wide read); no bearer -> 401',
    async run() {
      const native = freshDb();
      await runChain(native, 'PUT', 'A', { scoped: true, body: { ...VALUES, expected_sync_version: 0 } });
      const j = await runChain(native, 'GET', 'B', { scoped: true });
      assert.deepEqual(j.trail.slice(1), DIRECT);
      assert.equal(j.status, 200, JSON.stringify(j.body));
      assert.equal(j.body.sync_version, 1);
      assert.equal(j.body.calibration.series_rev_2_ohm, 125);
      assert.ok(j.requested.includes('scope'), 'scoped GET must check the account through the scope helper');
      const anon = await runChain(native, 'GET', 'B', { scoped: true, bearer: false });
      assert.equal(anon.status, 401);
      native.close();
    },
  },
  {
    name: 'HEAD (enters through the GET http-in, bypassing the guard) -> 405 before auth, scoped without a bearer and flag off with one; nothing written',
    async run() {
      const native = freshDb();
      const scoped = await runChain(native, 'HEAD', 'A', { scoped: true, bearer: false, query: QUERY_WRITE });
      assert.deepEqual(scoped.trail.slice(1), DIRECT);
      assert.equal(scoped.status, 405, JSON.stringify(scoped.body));
      assert.equal(scoped.body.code, 'method_not_allowed');
      assert.equal(calibrationRow(native), null, 'scoped HEAD wrote a calibration');
      const off = await runChain(native, 'HEAD', 'A', { query: QUERY_WRITE });
      assert.equal(off.status, 405, JSON.stringify(off.body));
      assert.equal(off.body.code, 'method_not_allowed');
      assert.ok(!off.requested.includes('scope'));
      assert.equal(calibrationRow(native), null, 'flag-off HEAD wrote a calibration');
      const post = await runChain(native, 'HEAD', 'A', { scoped: true, query: QUERY_WRITE });
      assert.equal(post.status, 405);
      assert.equal(calibrationRow(native), null);
      native.close();
    },
  },
  {
    name: 'scoped PUT/DELETE injected straight into watermark-cal-fn without the guard\'s actor_user_uuid: 401 without a bearer, 403 with one; nothing written',
    async run() {
      const native = freshDb();
      const body = { ...VALUES, expected_sync_version: 0 };
      const anon = await runHandler(native, request('PUT', 'B', { body, bearer: false }), true);
      assert.equal(anon.status, 401, JSON.stringify(anon.body));
      const bearer = await runHandler(native, request('PUT', 'B', { body }), true);
      assert.equal(bearer.status, 403, JSON.stringify(bearer.body));
      assert.equal(bearer.body.code, 'scope_guard_required');
      const owner = await runHandler(native, request('PUT', 'A', { body }), true);
      assert.equal(owner.status, 403, 'even the owner needs the guard in scoped mode');
      assert.equal(calibrationRow(native), null);
      await runChain(native, 'PUT', 'A', { scoped: true, body });
      const before = calibrationRow(native);
      const del = await runHandler(native, request('DELETE', 'B', { query: { expected_sync_version: '1' } }), true);
      assert.equal(del.status, 403, JSON.stringify(del.body));
      assert.deepEqual(calibrationRow(native), before);
      native.close();
    },
  },
  {
    name: 'scoped GET by a disabled account -> 403 from assertEnabledAccount',
    async run() {
      const native = freshDb();
      native.prepare("UPDATE users SET disabled_at = '2026-09-01T00:00:00Z' WHERE id = 2").run();
      const r = await runChain(native, 'GET', 'B', { scoped: true });
      assert.deepEqual(r.trail.slice(1), DIRECT);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.message, 'account disabled');
      native.close();
    },
  },
  {
    name: 'scoped PUT by a researcher not assigned to the device\'s zone -> denied by the guard (404), handler never runs, DB unchanged',
    async run() {
      const native = freshDb();
      const r = await runChain(native, 'PUT', 'R', { scoped: true, body: { ...VALUES, expected_sync_version: 0 } });
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.deepEqual(r.trail.slice(1), ['scoped-device-config-guard', 'device-response']);
      assert.equal(calibrationRow(native), null);
      native.close();
    },
  },
];

// ------------------------------------------------- soil depth route cases --
// External final review: put-soil-depth-fn filtered by owner even after the
// guard authorized an assigned researcher, so the WATERMARK depth form failed
// for that role. Scoped + guard-vouched now skips the owner filter.

const DEPTH_VIA_GUARD = ['scoped-device-config-guard', 'put-soil-depth-fn', 'device-response'];

function depthRow(native) {
  const row = native.prepare('SELECT soil_moisture_probe_depths_json AS depths, soil_moisture_probe_depths_configured AS configured, sync_version FROM devices WHERE deveui = ?').get(DEVEUI);
  return { ...row };
}

function depthRequest(native, who, depths, options = {}) {
  return runChain(native, 'PUT', who, {
    ...options,
    httpIn: 'put-soil-depth-http',
    path: DEPTH_PATH,
    body: { soilMoistureProbeDepths: depths },
  });
}

// put-soil-depth-fn alone on a hand-built message (no guard in front).
async function runDepthHandler(native, msg, scoped) {
  const requested = [];
  if (scoped) scopeHelper._resetForTests();
  try {
    const out = await executeFunction(BY_ID.get('put-soil-depth-fn'), {
      msg,
      env: scoped ? ENV_SCOPED : ENV_OFF,
      libOverrides: { osiDb: realOsiDb(native), osiLib: osiLibSpy(scoped, requested) },
    });
    assert.deepEqual(out.errors, []);
    return { status: out.result.statusCode, body: out.result.payload, requested };
  } catch (error) {
    return { status: error && error.statusCode, thrown: error, requested };
  }
}

CASES.push(
  {
    name: 'soil depths wiring: PUT http in -> guard output 17 -> put-soil-depth-fn -> device-response',
    async run() {
      const httpIn = BY_ID.get('put-soil-depth-http');
      assert.equal(httpIn.url, '/api/devices/:deveui/soil-moisture-depths');
      assert.equal(httpIn.method, 'put');
      assert.deepEqual(httpIn.wires, [['scoped-device-config-guard']]);
      assert.deepEqual(BY_ID.get('scoped-device-config-guard').wires[17], ['put-soil-depth-fn']);
      assert.deepEqual(BY_ID.get('put-soil-depth-fn').wires, [['device-response']]);
    },
  },
  {
    name: 'soil depths flag off: owner A -> 200 and saved; researcher B (not owner) -> 404; no bearer -> 401; scope helper never loaded',
    async run() {
      const native = freshDb();
      const before = depthRow(native);
      const b = await depthRequest(native, 'B', { swt_1: 30 });
      assert.deepEqual(b.trail.slice(1), DEPTH_VIA_GUARD);
      assert.equal(b.status, 404, JSON.stringify(b.body));
      assert.deepEqual(depthRow(native), before);
      const anon = await depthRequest(native, 'A', { swt_1: 30 }, { bearer: false });
      assert.equal(anon.status, 401);
      assert.equal(anon.authFailure && anon.authFailure.code, 'MISSING_BEARER');
      assert.deepEqual(depthRow(native), before);
      const a = await depthRequest(native, 'A', { swt_1: 30, swt_2: 60 });
      assert.deepEqual(a.trail.slice(1), DEPTH_VIA_GUARD);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.deepEqual(a.body.soil_moisture_probe_depths_json, { swt_1: 30, swt_2: 60 });
      const saved = depthRow(native);
      assert.deepEqual(JSON.parse(saved.depths), { swt_1: 30, swt_2: 60 });
      assert.equal(saved.configured, 1);
      for (const r of [a, b, anon]) assert.ok(!r.requested.includes('scope'), 'flag off reached osiLib.require(scope)');
      native.close();
    },
  },
  {
    name: 'soil depths scoped: assigned researcher B (not the owner) -> 200 through the guard and saved; unassigned R -> 404 and viewer V -> 403 from the guard, handler never runs',
    async run() {
      const native = freshDb();
      const before = depthRow(native);
      const r = await depthRequest(native, 'R', { swt_1: 30 }, { scoped: true });
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.deepEqual(r.trail.slice(1), ['scoped-device-config-guard', 'device-response']);
      const v = await depthRequest(native, 'V', { swt_1: 30 }, { scoped: true });
      assert.equal(v.status, 403, JSON.stringify(v.body));
      assert.deepEqual(v.trail.slice(1), ['scoped-device-config-guard', 'device-response']);
      assert.deepEqual(depthRow(native), before);
      const b = await depthRequest(native, 'B', { swt_1: 25, swt_2: 50 }, { scoped: true });
      assert.deepEqual(b.trail.slice(1), DEPTH_VIA_GUARD);
      assert.equal(b.status, 200, JSON.stringify(b.body));
      assert.deepEqual(b.body.soil_moisture_probe_depths_json, { swt_1: 25, swt_2: 50 });
      const saved = depthRow(native);
      assert.deepEqual(JSON.parse(saved.depths), { swt_1: 25, swt_2: 50 });
      assert.equal(saved.sync_version, (before.sync_version || 0) + 1);
      native.close();
    },
  },
  {
    name: 'soil depths scoped, injected straight into put-soil-depth-fn without the guard\'s actor_user_uuid: bearer + owner filter still apply',
    async run() {
      const native = freshDb();
      const body = { soilMoistureProbeDepths: { swt_1: 40 } };
      const anon = await runDepthHandler(native, request('PUT', 'B', { body, bearer: false, path: DEPTH_PATH }), true);
      assert.equal(anon.status, 401);
      const nonOwner = await runDepthHandler(native, request('PUT', 'B', { body, path: DEPTH_PATH }), true);
      assert.equal(nonOwner.status, 404, JSON.stringify(nonOwner.body));
      assert.equal(depthRow(native).depths, null);
      const owner = await runDepthHandler(native, request('PUT', 'A', { body, path: DEPTH_PATH }), true);
      assert.equal(owner.status, 200, JSON.stringify(owner.body));
      assert.deepEqual(JSON.parse(depthRow(native).depths), { swt_1: 40 });
      native.close();
    },
  },
);


// ----------------------------------------------------------------- runner --

(async () => {
  let failed = 0;
  for (const c of CASES) {
    try {
      await c.run();
      console.log('ok - ' + c.name);
    } catch (error) {
      failed += 1;
      console.log('not ok - ' + c.name + '\n  ' + String(error && error.stack ? error.stack : error).split('\n').slice(0, 6).join('\n  '));
    }
  }
  if (failed) {
    console.log('FAIL: ' + failed + ' of ' + CASES.length + ' WATERMARK calibration + soil depth route case(s) failed');
    process.exit(1);
  }
  console.log('PASS: ' + CASES.length + ' WATERMARK calibration + soil depth route cases');
})();
