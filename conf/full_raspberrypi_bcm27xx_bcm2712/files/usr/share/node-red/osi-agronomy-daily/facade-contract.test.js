'use strict';

// Binds osi-agronomy-daily's runDaily EXACTLY as agronomy-daily-fn binds it:
// the flow node opens the DB with `new osiDb.Database(...)` from
// osi-db-helper, a sqlite3 callback facade (run/get/all/close/transaction)
// with NO `.prepare`, and every call outside a transaction goes through one
// queue. index.test.js proves runDaily against node:sqlite directly (a thin
// `all`/`run`/`transaction` wrapper), where a call on the outer handle inside
// transaction() merely throws; through the real facade that call waits on the
// queue the transaction holds and never returns. This file is the guard: a
// deadlock times out after 10 s instead of hanging, and a `.prepare`-only
// regression fails the way the flow node would. Modelled on
// osi-device-writer/facade-contract.test.js; sqlite3Adapter() and
// loadOsiDbHelper() below are copied verbatim from that file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const ad = require('./index');

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
const OM = 'open_meteo:46.80:6.95';

function within(ms, promise) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('runDaily did not return within ' + ms + ' ms (facade deadlock?)')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('runDaily works through the osi-db-helper facade exactly as agronomy-daily-fn binds it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-facade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'farming.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SEED);
  seed.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z')").run();
  seed.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, crop_type, phenological_stage, zone_uuid) VALUES (1, 1, 'A', 46.8, 6.95, 'Europe/Zurich', 'maize', 'mid_season', '00000000-0000-4000-8000-000000000001')").run();
  seed.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone) VALUES (?, 'open_meteo', 46.8, 6.95, 'Europe/Zurich')").run(OM);
  // The 24 hours of the local day 2026-09-25 in Europe/Zurich (UTC+2).
  const insert = seed.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, et0_mm, fetched_at) VALUES (?, ?, 0.2, '2026-09-26T05:00:00Z')");
  for (let i = 0; i < 24; i += 1) insert.run(OM, new Date(Date.parse('2026-09-24T22:00:00Z') + i * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  seed.close();
  const osiDb = loadOsiDbHelper();
  const db = new osiDb.Database(dbPath);
  // The same lines the flow node uses, including the transaction.
  const client = {
    all: (sql, params) => Promise.resolve(db.all(sql, params || [])),
    run: (sql, params) => Promise.resolve(db.run(sql, params || [])).then(() => undefined),
    transaction: (fn) => db.transaction(fn),
  };
  const args = { db: client, nowIso: '2026-09-26T06:00:00Z', deploymentDefault: 'open_meteo', warn: () => {} };
  ad.resetState();
  const first = await within(10000, ad.runDaily(args));
  // Seven latest completed days (19..25); the oldest stored hour is on 25, so
  // no older day is added.
  assert.equal(first.written, 7);
  const second = await within(10000, ad.runDaily(args));
  assert.equal(second.written, 0);
  assert.equal(second.unchanged, 7);
  await new Promise((resolve) => db.close(() => resolve()));
  const check = new DatabaseSync(dbPath);
  const r = check.prepare("SELECT et0_mm, kc, etc_mm FROM zone_daily_agronomy WHERE zone_id = 1 AND date = '2026-09-25'").get();
  assert.deepEqual([r.et0_mm, r.kc, r.etc_mm], [4.8, 1.2, 5.76]);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM zone_daily_agronomy').get().n, 7);
  check.close();
});
