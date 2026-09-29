'use strict';

// Binds osi-weather-provider's runTick EXACTLY as weather-provider-fn (Task 7)
// binds it: the flow node opens the DB with `new osiDb.Database(...)` from
// osi-db-helper, a sqlite3 callback facade (run/get/all/close) with NO
// `.prepare`. index.test.js only proves runTick against node:sqlite's
// DatabaseSync directly (via a thin `all`/`run` wrapper around `.prepare`),
// which is why the module/caller mismatch (db.prepare is not a function)
// would be invisible to that suite. This file is the guard: it must fail the
// same way the real flow node would fail if runTick ever regressed to a
// `.prepare`-only implementation. Modelled on
// osi-device-writer/facade-contract.test.js; sqlite3Adapter() and
// loadOsiDbHelper() below are copied verbatim from that file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const wp = require('./index');

const DB_HELPER_PATH = path.join(__dirname, '..', 'osi-db-helper', 'index.js');

// Same node:sqlite-backed sqlite3 adapter shape as
// scripts/test-osi-db-helper-read-snapshot.js, scoped (via Module._load) to
// osi-db-helper's own `require('sqlite3')` only -- this is what makes the
// facade real (run/get/all/close, promise-returning, no .prepare) without
// needing the native sqlite3 addon built for this machine.
function sqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }

    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const rows = this.native.prepare(sql).all(...(params || []));
        callback.call(this, null, rows);
      } catch (error) {
        callback.call(this, error);
      }
    }

    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes) }, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    exec(sql, callback) {
      try {
        this.native.exec(sql);
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    close(callback) {
      try {
        this.native.close();
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function loadOsiDbHelper() {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) {
      return sqlite3Adapter();
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally {
    Module._load = original;
  }
}

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO_ROOT, 'database/seed-blank.sql'), 'utf8');

test('runTick works through the osi-db-helper facade exactly as weather-provider-fn binds it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-facade-'));
  const dbPath = path.join(dir, 'farming.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SEED);
  seed.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z')").run();
  seed.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, zone_uuid) VALUES (1, 1, 'A', 46.8, 6.95, 'Europe/Zurich', '00000000-0000-4000-8000-000000000001')").run();
  seed.close();
  const osiDb = loadOsiDbHelper();
  const db = new osiDb.Database(dbPath);
  // The same three lines the flow node uses.
  const client = {
    all: (sql, params) => Promise.resolve(db.all(sql, params || [])),
    run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined),
  };
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'open_meteo_past2.json'), 'utf8'));
  const summary = await wp.runTick({ db: client, nowIso: '2026-09-25T15:20:00Z', deploymentDefault: 'open_meteo', deps: { requestJson: async () => payload, requestBuffer: async () => { throw new Error('offline'); } }, warn: () => {} });
  await new Promise((resolve) => db.close(() => resolve()));
  // Same 64-row first-fetch count as index.test.js's single-zone runTick test
  // (see the comment there): window.fromUtc is 92 days back, so all 64 of the
  // fixture's hour_starts before toUtc (15:00) are in range.
  assert.deepEqual(summary, { zones: 1, locations: 1, stored: 64, failed: 0 });
  const check = new DatabaseSync(dbPath);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM weather_provider_hours').get().n, 64);
  check.close();
});
