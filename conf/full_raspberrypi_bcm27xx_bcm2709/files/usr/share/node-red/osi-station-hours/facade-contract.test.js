'use strict';

// Binds osi-station-hours's aggregateStationHours EXACTLY as station-hours-fn
// binds it: the flow node opens the DB with `new osiDb.Database(...)` from
// osi-db-helper, a sqlite3 callback facade (run/get/all/close) with NO
// `.prepare`. index.test.js only proves aggregateStationHours against
// node:sqlite's DatabaseSync directly (via a thin `all`/`run`/`transaction`
// wrapper around `.prepare`), which is why the module/caller mismatch
// (db.prepare is not a function) would be invisible to that suite. This file
// is the guard: it must fail the same way the real flow node would fail if
// aggregateStationHours ever regressed to a `.prepare`-only implementation.
// Modelled on osi-device-writer/facade-contract.test.js; sqlite3Adapter() and
// loadOsiDbHelper() below are copied verbatim from that file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const sh = require('./index');

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

test('aggregateStationHours works through the osi-db-helper facade exactly as station-hours-fn binds it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-facade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'farming.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SEED);
  seed.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z')").run();
  seed.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, zone_uuid) VALUES (1, 1, 'A', 46.8, 6.95, 'Europe/Zurich', '00000000-0000-4000-8000-000000000001')").run();
  seed.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES ('S2120AAAA00000001', 'S2120 0001', 'SENSECAP_S2120', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')").run();
  seed.prepare("INSERT INTO weather_station_zones (deveui, zone_id) VALUES ('S2120AAAA00000001', 1)").run();
  seed.prepare("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity, wind_speed_mps, barometric_pressure_hpa, light_lux, rain_mm_delta) VALUES ('S2120AAAA00000001', '2026-09-25T13:05:00.000Z', 20, 50, 1, 960, 10000, 0)").run();
  seed.prepare("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity, wind_speed_mps, barometric_pressure_hpa, light_lux, rain_mm_delta) VALUES ('S2120AAAA00000001', '2026-09-25T14:10:00.000Z', 23, 50, 1, 960, 40000, 0)").run();
  seed.close();
  const osiDb = loadOsiDbHelper();
  const db = new osiDb.Database(dbPath);
  // The same three lines the flow node uses.
  const client = {
    all: (sql, params) => Promise.resolve(db.all(sql, params || [])),
    run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined),
    transaction: (fn) => db.transaction(fn),
  };
  const first = await sh.aggregateStationHours({ db: client, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(first, { devices: 1, hours: 2, written: 2, unchanged: 0, failed: 0 });
  const second = await sh.aggregateStationHours({ db: client, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(second, { devices: 1, hours: 2, written: 0, unchanged: 2, failed: 0 });
  await new Promise((resolve) => db.close(() => resolve()));
  const check = new DatabaseSync(dbPath);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM weather_station_hours').get().n, 2);
  check.close();
});
