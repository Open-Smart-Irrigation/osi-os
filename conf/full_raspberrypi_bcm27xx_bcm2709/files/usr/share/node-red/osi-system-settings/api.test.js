'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { handleHttpRequest } = require('./api');

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

test('GET /api/system/settings defaults to UTC when no gateway_timezone row exists', async () => {
  const dbPath = await tempDb();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'UTC' });
});

test('GET /api/system/settings returns the stored gateway_timezone', async () => {
  const dbPath = await tempDb();
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO app_settings(key, value) VALUES ('gateway_timezone', 'Europe/Zurich')").run();
  raw.close();
  const out = await call(dbPath, req('GET'));
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich' });
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
  assert.deepEqual(out.payload, { gatewayTimezone: 'UTC' });
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
  assert.deepEqual(put.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 0 });
  const get = await call(dbPath, req('GET'));
  assert.deepEqual(get.payload, { gatewayTimezone: 'Europe/Zurich' });
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
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 1 });
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
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 1 }, 'must count only the caller\'s own zone');
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
  assert.deepEqual(out.payload, { gatewayTimezone: 'Europe/Zurich', zonesUpdated: 1 }, 'the soft-deleted zone must not be counted');
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
