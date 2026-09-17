'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { handleHttpRequest, validateTimezone } = require('./api');
const { MODULE_DEFAULTS } = require('../osi-module-defaults');

function facade(raw) {
  return {
    get: (sql, params) => Promise.resolve(raw.prepare(sql).get(...(params || []))),
    all: (sql, params) => Promise.resolve(raw.prepare(sql).all(...(params || []))),
    run: (sql, params) => { raw.prepare(sql).run(...(params || [])); return Promise.resolve(undefined); }, // matches the live osi-db-helper facade: run() resolves undefined
    async transaction(executor) {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await executor(facade(raw)); raw.exec('COMMIT'); return out; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw e; }
    },
    close: (cb) => { try { raw.close(); } catch (_) { /* closed */ } if (cb) cb(); },
  };
}
function TestDatabase(dbPath) { return facade(new DatabaseSync(dbPath)); }

async function tempDb() {
  const src = path.resolve(__dirname, '../../db/farming.db');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sys-settings-')), 'farming.db');
  fs.copyFileSync(src, dbPath);
  return dbPath;
}

// Every module at its shipped default, plus the `moduleDefaults` object the
// route reports alongside the effective values. Derived from
// osi-module-defaults rather than written out here on purpose: a customer
// branch flips a default in that one file, and these payload assertions have to
// follow it instead of needing to be edited in the same pick.
const DEFAULT_MODULES_PAYLOAD = Object.assign({}, MODULE_DEFAULTS, { moduleDefaults: MODULE_DEFAULTS });

const SECRET = 'test-secret';
function token(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, username: 'u', exp: Date.now() + 60000 })).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function req(method, body, auth) {
  return { req: { method, headers: { authorization: auth === undefined ? token(1) : auth } }, payload: body };
}
async function call(dbPath, msg) {
  return handleHttpRequest({ msg, Database: TestDatabase, environment: { authTokenSecret: SECRET, dbPath }, warn: () => {} });
}

// PR-N (Fable consult Q5/Q7, consult-consolidated.md): PUT /api/system/settings
// verified a bearer token but never a role, so under scope any authenticated
// viewer could change gateway settings -- main's own W1 rule is
// "ownership+role-gated writes". tokenAs lets a test authenticate as a
// specific username (the default token() above always claims 'u'), which the
// role check needs to resolve a real users row.
function tokenAs(userId, username) {
  const payload = Buffer.from(JSON.stringify({ userId, username, exp: Date.now() + 60000 })).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function reqAs(method, body, userId, username) {
  return { req: { method, headers: { authorization: tokenAs(userId, username) } }, payload: body };
}
function insertUser(dbPath, { id, username, role }) {
  const raw = new DatabaseSync(dbPath);
  raw.prepare(
    "INSERT INTO users(id, username, password_hash, created_at, role) VALUES (?, ?, 'x', datetime('now'), ?)"
  ).run(id, username, role);
  raw.close();
}
async function callScoped(dbPath, msg, extra = {}) {
  return handleHttpRequest({ msg, Database: TestDatabase, environment: { authTokenSecret: SECRET, dbPath }, scopedMode: true, warn: () => {}, ...extra });
}

test('GET /api/system/settings defaults to UTC when no gateway_timezone row exists', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'UTC', ...DEFAULT_MODULES_PAYLOAD });
});

test('GET /api/system/settings returns the stored gateway_timezone', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO app_settings(key, value) VALUES ('gateway_timezone', 'Europe/Zurich')").run();
  raw.close();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', ...DEFAULT_MODULES_PAYLOAD });
});

test('GET /api/system/settings: no token -> 401', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('GET', undefined, null));
  assert.equal(out.statusCode, 401);
});

test('GET /api/system/settings: table-missing-safe, does not 500 on a pre-migration DB', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.exec('DROP TABLE app_settings');
  raw.close();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'UTC', ...DEFAULT_MODULES_PAYLOAD });
});

test('PUT /api/system/settings validates the timezone with Intl and rejects garbage with 422', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Not/A_Real_Zone' }));
  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, 'invalid_timezone');
});

test('PUT /api/system/settings rejects a missing gatewayTimezone with 422', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', {}));
  assert.equal(out.statusCode, 422);
});

test('PUT /api/system/settings upserts the value and a subsequent GET reflects it', async () => {
  const dbPath = await tempDb();
  const put = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich' }));
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 0, ...DEFAULT_MODULES_PAYLOAD });
  const get = await call(dbPath, req('GET'));
  assert.deepEqual(get.payload, { gatewayTimezone: 'Europe/Zurich', ...DEFAULT_MODULES_PAYLOAD });
  // Second PUT (UPDATE branch of the UPSERT), still one row.
  const put2 = await call(dbPath, req('PUT', { gatewayTimezone: 'America/New_York' }));
  assert.equal(put2.statusCode, 200);
  const raw = new DatabaseSync(dbPath);
  const rows = raw.prepare("SELECT value FROM app_settings WHERE key='gateway_timezone'").all();
  raw.close();
  assert.equal(rows.length, 1, 'UPSERT must not leave a duplicate row');
  assert.equal(rows[0].value, 'America/New_York');
});

test('PUT applyToAllZones updates only the caller\'s zones whose timezone differs and reports the count', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('A', 1, 'UTC')").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('B', 1, 'Europe/Zurich')").run();
  raw.close();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich', applyToAllZones: true }));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 1, ...DEFAULT_MODULES_PAYLOAD });
  const raw2 = new DatabaseSync(dbPath);
  const rows = raw2.prepare('SELECT name, timezone FROM irrigation_zones ORDER BY name').all();
  raw2.close();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: 'A', timezone: 'Europe/Zurich' }, { name: 'B', timezone: 'Europe/Zurich' }]);
});

test('PUT applyToAllZones (FW-T5 review R1, M1) never touches another user\'s zones', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))").run();
  raw.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (2,'other','x',datetime('now'))").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Mine', 1, 'UTC')").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('OtherUser', 2, 'UTC')").run();
  raw.close();
  // token(1) (the default auth() helper below) authenticates as user 1.
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich', applyToAllZones: true }));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 1, ...DEFAULT_MODULES_PAYLOAD }, 'must count only the caller\'s own zone');
  const raw2 = new DatabaseSync(dbPath);
  const rows = raw2.prepare('SELECT name, user_id, timezone FROM irrigation_zones ORDER BY name').all();
  raw2.close();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { name: 'Mine', user_id: 1, timezone: 'Europe/Zurich' },
    { name: 'OtherUser', user_id: 2, timezone: 'UTC' },
  ]);
});

test('PUT applyToAllZones (FW-T5 review R1, M2) excludes soft-deleted zones from both the count and the write', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('Live', 1, 'UTC')").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone, deleted_at) VALUES ('Gone', 1, 'UTC', datetime('now'))").run();
  raw.close();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich', applyToAllZones: true }));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 1, ...DEFAULT_MODULES_PAYLOAD }, 'the soft-deleted zone must not be counted');
  const raw2 = new DatabaseSync(dbPath);
  const rows = raw2.prepare('SELECT name, timezone FROM irrigation_zones ORDER BY name').all();
  raw2.close();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { name: 'Gone', timezone: 'UTC' },
    { name: 'Live', timezone: 'Europe/Zurich' },
  ], 'the soft-deleted zone\'s timezone must be left untouched (and so must never re-fire its sync trigger)');
});

test('PUT applyToAllZones (FW-T5 review R1, M3) bumps sync_version and updated_at on every zone it touches', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone, sync_version, updated_at) VALUES ('A', 1, 'UTC', 4, '2020-01-01T00:00:00.000Z')").run();
  raw.close();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich', applyToAllZones: true }));
  assert.equal(out.payload.zonesUpdated, 1);
  const raw2 = new DatabaseSync(dbPath);
  const row = raw2.prepare("SELECT sync_version, updated_at FROM irrigation_zones WHERE name='A'").get();
  raw2.close();
  assert.equal(row.sync_version, 5, 'sync_version must be bumped exactly like every other zone writer (zone-config-fn precedent)');
  assert.notEqual(row.updated_at, '2020-01-01T00:00:00.000Z', 'updated_at must be refreshed, not left stale');
});

test('PUT without applyToAllZones leaves existing zone timezones untouched', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))").run();
  raw.prepare("INSERT INTO irrigation_zones(name, user_id, timezone) VALUES ('A', 1, 'UTC')").run();
  raw.close();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich' }));
  assert.equal(out.payload.zonesUpdated, 0);
  const raw2 = new DatabaseSync(dbPath);
  const row = raw2.prepare("SELECT timezone FROM irrigation_zones WHERE name='A'").get();
  raw2.close();
  assert.equal(row.timezone, 'UTC');
});

test('PUT /api/system/settings: no token -> 401, no write happens', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich' }, null));
  assert.equal(out.statusCode, 401);
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare("SELECT value FROM app_settings WHERE key='gateway_timezone'").get();
  raw.close();
  assert.equal(row, undefined);
});

test('PUT /api/system/settings: table-missing-safe, returns 503 schema_pending instead of 500 on a pre-migration DB', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.exec('DROP TABLE app_settings');
  raw.close();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Europe/Zurich' }));
  assert.equal(out.statusCode, 503);
  assert.equal(out.payload.error, 'schema_pending');
});

test('PUT /api/system/settings (scoped mode): a viewer is rejected with 403 and no write happens', async () => {
  const dbPath = await tempDb();
  insertUser(dbPath, { id: 1, username: 'viewer1', role: 'viewer' });
  const out = await callScoped(dbPath, reqAs('PUT', { gatewayTimezone: 'Europe/Zurich' }, 1, 'viewer1'));
  assert.equal(out.statusCode, 403);
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare("SELECT value FROM app_settings WHERE key='gateway_timezone'").get();
  raw.close();
  assert.equal(row, undefined, 'a role-denied PUT must never write app_settings');
});

test('PUT /api/system/settings (scoped mode): a researcher (mutation-capable elsewhere, not admin here) is rejected with 403', async () => {
  const dbPath = await tempDb();
  insertUser(dbPath, { id: 1, username: 'res1', role: 'researcher' });
  const out = await callScoped(dbPath, reqAs('PUT', { gatewayTimezone: 'Europe/Zurich' }, 1, 'res1'));
  assert.equal(out.statusCode, 403, 'system settings are admin-only, unlike zone/device writes');
});

test('PUT /api/system/settings (scoped mode): an admin is allowed and the write happens', async () => {
  const dbPath = await tempDb();
  insertUser(dbPath, { id: 1, username: 'admin1', role: 'admin' });
  const out = await callScoped(dbPath, reqAs('PUT', { gatewayTimezone: 'Europe/Zurich' }, 1, 'admin1'));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 0, ...DEFAULT_MODULES_PAYLOAD });
});

test('GET /api/system/settings (scoped mode): reads stay open for a non-admin', async () => {
  const dbPath = await tempDb();
  insertUser(dbPath, { id: 1, username: 'viewer1', role: 'viewer' });
  const out = await callScoped(dbPath, reqAs('GET', undefined, 1, 'viewer1'));
  assert.equal(out.statusCode, 200, 'GET must stay open -- only the write path is role-gated');
});

test('PUT /api/system/settings: flag-off preserves the legacy bearer-only behavior for a non-admin', async () => {
  const dbPath = await tempDb();
  insertUser(dbPath, { id: 1, username: 'viewer1', role: 'viewer' });
  // scopedMode omitted -- defaults to false, matching production when
  // sys-settings-router-fn reads OSI_SCOPED_ACCESS unset/'0'.
  const out = await handleHttpRequest({
    msg: reqAs('PUT', { gatewayTimezone: 'Europe/Zurich' }, 1, 'viewer1'),
    Database: TestDatabase,
    environment: { authTokenSecret: SECRET, dbPath },
    warn: () => {},
  });
  assert.equal(out.statusCode, 200, 'flag-off must not role-gate the legacy route');
});

test('PUT /api/system/settings: flag-off never touches the scope helper (hermetic, mirrors #201)', async () => {
  const dbPath = await tempDb();
  insertUser(dbPath, { id: 1, username: 'viewer1', role: 'viewer' });
  const scopeMustNotBeTouched = {
    assertAuthenticatedRole() {
      throw new Error('scope helper must never be referenced when scopedMode is false');
    },
  };
  const out = await handleHttpRequest({
    msg: reqAs('PUT', { gatewayTimezone: 'Europe/Zurich' }, 1, 'viewer1'),
    Database: TestDatabase,
    environment: { authTokenSecret: SECRET, dbPath },
    scope: scopeMustNotBeTouched,
    warn: () => {},
  });
  assert.equal(out.statusCode, 200);
});

// F31 (2026-09-17 Silvan harness, run-full2/ST1.md checks #17-18): this
// validator is now the single source of truth both PUT /api/system/settings
// (above) and PUT /api/irrigation-zones/:id/timezone (dendro-tz-fn in
// flows.json, via osiLib.require('osi-system-settings').validateTimezone)
// enforce. Exercised directly here so the exported contract itself is
// pinned, independent of either HTTP route's wiring.
test('validateTimezone: rejects an empty/missing value with a labeled 422-shaped error', () => {
  assert.throws(
    () => validateTimezone('', 'timezone'),
    (error) => error.statusCode === 422 && error.code === 'invalid_timezone' && error.message === 'timezone is required'
  );
  assert.throws(
    () => validateTimezone(undefined, 'timezone'),
    (error) => error.statusCode === 422 && error.code === 'invalid_timezone'
  );
});

test('validateTimezone: rejects a non-IANA string with a labeled 422-shaped error', () => {
  assert.throws(
    () => validateTimezone('Not/AZone', 'timezone'),
    (error) =>
      error.statusCode === 422 &&
      error.code === 'invalid_timezone' &&
      error.message === 'timezone must be a valid IANA time zone'
  );
});

test('validateTimezone: trims and returns a valid IANA timezone unchanged', () => {
  assert.equal(validateTimezone('  Africa/Kampala  ', 'timezone'), 'Africa/Kampala');
  assert.equal(validateTimezone('UTC', 'gatewayTimezone'), 'UTC');
});

// ---------------------------------------------------------------------------
// Journal module gate (owner decision 2026-09-17)
// ---------------------------------------------------------------------------
// The Field Journal became a switchable module, and switching it off has to
// stop the journal-v2 replication worker from talking to the cloud at all --
// which a per-browser localStorage preference cannot do. The setting therefore
// lives in the existing gateway-level app_settings store and rides the existing
// GET/PUT /api/system/settings route: no new route, no schema migration.

test('GET /api/system/settings reports the journal module at its shipped default', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.journalModuleEnabled, MODULE_DEFAULTS.journalModuleEnabled);
});

test('PUT /api/system/settings persists a journal module switch-off', async () => {
  const dbPath = await tempDb();
  const put = await call(dbPath, req('PUT', { journalModuleEnabled: false }));
  assert.equal(put.statusCode, 200);
  assert.equal(put.payload.journalModuleEnabled, false);

  const get = await call(dbPath, req('GET'));
  assert.equal(get.payload.journalModuleEnabled, false);

  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare("SELECT value FROM app_settings WHERE key='journal_module_enabled'").get();
  raw.close();
  assert.equal(row.value, '0');
});

test('PUT /api/system/settings switches the journal module back on', async () => {
  const dbPath = await tempDb();
  await call(dbPath, req('PUT', { journalModuleEnabled: false }));
  const put = await call(dbPath, req('PUT', { journalModuleEnabled: true }));
  assert.equal(put.statusCode, 200);
  assert.equal(put.payload.journalModuleEnabled, true);
  assert.equal((await call(dbPath, req('GET'))).payload.journalModuleEnabled, true);
});

test('PUT /api/system/settings rejects a non-boolean journal module value', async () => {
  const dbPath = await tempDb();
  for (const value of ['false', 0, null, 'off']) {
    const out = await call(dbPath, req('PUT', { journalModuleEnabled: value }));
    assert.equal(out.statusCode, 422, 'value ' + JSON.stringify(value) + ' must be rejected');
    assert.equal(out.payload.error, 'invalid_request');
  }
  assert.equal((await call(dbPath, req('GET'))).payload.journalModuleEnabled, MODULE_DEFAULTS.journalModuleEnabled);
});

// The timezone contract must not loosen: a PUT that carries no
// journalModuleEnabled is still a timezone PUT and still requires a valid one.
test('PUT /api/system/settings still requires a valid timezone when no journal flag is sent', async () => {
  const dbPath = await tempDb();
  const missing = await call(dbPath, req('PUT', {}));
  assert.equal(missing.statusCode, 422);
  assert.equal(missing.payload.error, 'invalid_timezone');

  const bogus = await call(dbPath, req('PUT', { gatewayTimezone: 'Not/AZone' }));
  assert.equal(bogus.statusCode, 422);
  assert.equal(bogus.payload.error, 'invalid_timezone');
});

test('PUT /api/system/settings still validates a timezone sent alongside the journal flag', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Not/AZone', journalModuleEnabled: false }));
  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, 'invalid_timezone');
  // Nothing may be persisted from a rejected request.
  assert.equal((await call(dbPath, req('GET'))).payload.journalModuleEnabled, MODULE_DEFAULTS.journalModuleEnabled);
});

test('PUT /api/system/settings writes both fields when both are sent', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Africa/Kampala', journalModuleEnabled: false }));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.gatewayTimezone, 'Africa/Kampala');
  assert.equal(out.payload.journalModuleEnabled, false);

  const get = await call(dbPath, req('GET'));
  assert.equal(get.payload.gatewayTimezone, 'Africa/Kampala');
  assert.equal(get.payload.journalModuleEnabled, false);
});

// ---------------------------------------------------------------------------
// Data view / Network / Gateway modules promoted to gateway level (Phil, 2026-09-17)
// ---------------------------------------------------------------------------
// These three started as per-browser display preferences. They are now gateway
// settings alongside journal_module_enabled, so every user of a gateway sees
// the same surface and the choice survives a browser change.

const GATEWAY_MODULE_FIELDS = [
  ['dataModuleEnabled', 'data_module_enabled'],
  ['networkModuleEnabled', 'network_module_enabled'],
  ['gatewayHubModuleEnabled', 'gateway_hub_module_enabled'],
];

test('GET /api/system/settings reports every module at its shipped default', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  for (const [field] of GATEWAY_MODULE_FIELDS) {
    assert.equal(out.payload[field], MODULE_DEFAULTS[field], field);
  }
});

// The GUI has no compiled-in copy of these defaults: it renders nothing until
// this response arrives, then follows it. So the route has to say what the
// defaults ARE, not only what the effective values are -- otherwise a browser
// could not tell "switched off here" from "shipped off".
test('GET /api/system/settings reports the defaults themselves, not only the effective values', async () => {
  const dbPath = await tempDb();
  const fresh = await call(dbPath, req('GET'));
  assert.deepEqual(fresh.payload.moduleDefaults, MODULE_DEFAULTS);

  // A stored row moves the effective value and leaves the declared default alone.
  await call(dbPath, req('PUT', { dataModuleEnabled: !MODULE_DEFAULTS.dataModuleEnabled }));
  const stored = await call(dbPath, req('GET'));
  assert.equal(stored.payload.dataModuleEnabled, !MODULE_DEFAULTS.dataModuleEnabled);
  assert.deepEqual(stored.payload.moduleDefaults, MODULE_DEFAULTS, 'a stored row must not move the declared default');

  // PUT answers in the same shape, so the GUI can fold its response into the
  // settings cache without losing the defaults it renders from.
  const put = await call(dbPath, req('PUT', { dataModuleEnabled: MODULE_DEFAULTS.dataModuleEnabled }));
  assert.deepEqual(put.payload.moduleDefaults, MODULE_DEFAULTS);
});

test('PUT /api/system/settings persists each module switch under its own app_settings key', async () => {
  for (const [field, key] of GATEWAY_MODULE_FIELDS) {
    const dbPath = await tempDb();
    const put = await call(dbPath, req('PUT', { [field]: false }));
    assert.equal(put.statusCode, 200, field);
    assert.equal(put.payload[field], false, field);

    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    raw.close();
    assert.equal(row.value, '0', key);

    const get = await call(dbPath, req('GET'));
    assert.equal(get.payload[field], false, field);
    // Switching one module must not disturb its neighbours.
    for (const [other] of GATEWAY_MODULE_FIELDS) {
      if (other !== field) assert.equal(get.payload[other], MODULE_DEFAULTS[other], other + ' after ' + field);
    }
    assert.equal(get.payload.journalModuleEnabled, MODULE_DEFAULTS.journalModuleEnabled, 'journal after ' + field);
  }
});

test('PUT /api/system/settings switches a module back on', async () => {
  const dbPath = await tempDb();
  await call(dbPath, req('PUT', { dataModuleEnabled: false }));
  const put = await call(dbPath, req('PUT', { dataModuleEnabled: true }));
  assert.equal(put.payload.dataModuleEnabled, true);
  assert.equal((await call(dbPath, req('GET'))).payload.dataModuleEnabled, true);
});

test('PUT /api/system/settings rejects a non-boolean value for every module field', async () => {
  const dbPath = await tempDb();
  for (const [field] of GATEWAY_MODULE_FIELDS) {
    for (const value of ['false', 0, null, 'off']) {
      const out = await call(dbPath, req('PUT', { [field]: value }));
      assert.equal(out.statusCode, 422, field + ' = ' + JSON.stringify(value));
      assert.equal(out.payload.error, 'invalid_request');
    }
    assert.equal((await call(dbPath, req('GET'))).payload[field], MODULE_DEFAULTS[field], field + ' unchanged');
  }
});

test('PUT /api/system/settings writes several module switches in one request', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', {
    dataModuleEnabled: false,
    networkModuleEnabled: false,
    journalModuleEnabled: false,
  }));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.dataModuleEnabled, false);
  assert.equal(out.payload.networkModuleEnabled, false);
  assert.equal(out.payload.journalModuleEnabled, false);
  assert.equal(out.payload.gatewayHubModuleEnabled, MODULE_DEFAULTS.gatewayHubModuleEnabled, 'an unsent module keeps its value');

  const get = await call(dbPath, req('GET'));
  assert.equal(get.payload.dataModuleEnabled, false);
  assert.equal(get.payload.networkModuleEnabled, false);
  assert.equal(get.payload.journalModuleEnabled, false);
  assert.equal(get.payload.gatewayHubModuleEnabled, MODULE_DEFAULTS.gatewayHubModuleEnabled);
});

// One bad field rejects the whole request: a partial write would leave the
// gateway in a state the caller never asked for.
test('PUT /api/system/settings rejects the whole request when one module value is invalid', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', { dataModuleEnabled: false, networkModuleEnabled: 'nope' }));
  assert.equal(out.statusCode, 422);
  const get = await call(dbPath, req('GET'));
  assert.equal(get.payload.dataModuleEnabled, MODULE_DEFAULTS.dataModuleEnabled, 'nothing may be persisted from a rejected request');
  assert.equal(get.payload.networkModuleEnabled, MODULE_DEFAULTS.networkModuleEnabled);
});

test('PUT /api/system/settings still requires a valid timezone when no module flag is sent', async () => {
  const dbPath = await tempDb();
  const missing = await call(dbPath, req('PUT', {}));
  assert.equal(missing.statusCode, 422);
  assert.equal(missing.payload.error, 'invalid_timezone');
});

test('PUT /api/system/settings still validates a timezone sent alongside a module flag', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('PUT', { gatewayTimezone: 'Not/AZone', dataModuleEnabled: false }));
  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, 'invalid_timezone');
  assert.equal((await call(dbPath, req('GET'))).payload.dataModuleEnabled, MODULE_DEFAULTS.dataModuleEnabled);
});

test('GET /api/system/settings module reads are table-missing-safe and fall back to the shipped defaults', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.exec('DROP TABLE app_settings');
  raw.close();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  // A gateway whose DB predates app_settings behaves exactly like a fresh one
  // on the same firmware -- not like one with everything switched on.
  for (const [field] of GATEWAY_MODULE_FIELDS) {
    assert.equal(out.payload[field], MODULE_DEFAULTS[field], field + ' must fall back on a pre-migration DB');
  }
  assert.equal(out.payload.journalModuleEnabled, MODULE_DEFAULTS.journalModuleEnabled);
  assert.deepEqual(out.payload.moduleDefaults, MODULE_DEFAULTS);
});

// The journal module's app_settings key is written here and read independently
// by osi-journal-replication (which cannot import this module -- it runs inside
// the Node-RED worker and must not depend on an HTTP route). Both now take the
// key AND the default from osi-module-defaults; this pins that they really do,
// because a second literal on either side would silently stop the switch gating
// the worker, with no visible symptom beyond the cloud noise it was meant to
// stop.
test('the journal module key matches the one the replication worker reads', async () => {
  const { MODULE_SETTINGS } = require('./api');
  const journal = MODULE_SETTINGS.find((module) => module.field === 'journalModuleEnabled');
  assert.ok(journal, 'journalModuleEnabled must be a known module setting');

  const dbPath = await tempDb();
  await call(dbPath, req('PUT', { journalModuleEnabled: false }));

  const replication = require('../osi-journal-replication');
  const raw = new DatabaseSync(dbPath);
  const db = { get: (sql, params) => Promise.resolve(raw.prepare(sql).get(...(params || []))) };
  const enabled = await replication.journalModuleEnabled(db);
  raw.close();

  assert.equal(enabled, false, 'the worker must observe the switch this route wrote');
});

// The other half of that contract: with no row written at all, the worker and
// the route must land on the SAME default. A customer branch that ships the
// Field Journal hidden also has to ship the worker quiet, and this is what
// makes one edit do both.
test('the journal module default matches the one the replication worker applies', async () => {
  const replication = require('../osi-journal-replication');
  const dbPath = await tempDb();

  const get = await call(dbPath, req('GET'));
  const raw = new DatabaseSync(dbPath);
  const db = { get: (sql, params) => Promise.resolve(raw.prepare(sql).get(...(params || []))) };
  const workerDefault = await replication.journalModuleEnabled(db);
  raw.close();

  assert.equal(get.payload.journalModuleEnabled, MODULE_DEFAULTS.journalModuleEnabled);
  assert.equal(workerDefault, MODULE_DEFAULTS.journalModuleEnabled,
    'the worker must start from the same shipped default the route reports');
});
