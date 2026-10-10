'use strict';
// Binds osi-rain's ingestLoRainUplink and recomputeInstrumentDay EXACTLY as
// lorain-ingest-fn does: `new osiDb.Database(...)` from osi-db-helper, then
// `db.transaction((t) => ...)`, where `t` has only run/get/all/exec and `run`
// resolves to undefined (no lastID). index.test.js covers the pure rules; this
// file guards the module/caller shape. The sqlite3 binding is replaced by a
// node:sqlite adapter scoped to osi-db-helper's own require('sqlite3').
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const R = require('./index');

const DB_HELPER_PATH = path.join(__dirname, '..', 'osi-db-helper', 'index.js');
const SEED = path.resolve(__dirname, '../../../../../../../database/seed-blank.sql');

function sqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes) }, null);
      } catch (error) { callback.call(this, error); }
    }
    exec(sql, callback) {
      try { this.native.exec(sql); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
    close(callback) {
      try { this.native.close(); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function loadOsiDbHelper() {
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) return sqlite3Adapter();
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally {
    Module._load = original;
  }
}

test('ingestLoRainUplink and recomputeInstrumentDay through the osi-db-helper transaction facade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-rain-facade-'));
  try {
    const file = path.join(dir, 'farming.db');
    const native = new DatabaseSync(file);
    native.exec(fs.readFileSync(SEED, 'utf8'));
    native.exec(`INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
      INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z', 1, 'z-1', 'Europe/Zurich', 'local');
      INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
        VALUES ('A840410000000001', 'Gauge', 'AQUASCOPE_LORAIN', 1, 1, '2026-01-01', '2026-01-01');`);
    native.close();
    const osiDb = loadOsiDbHelper();
    const db = new osiDb.Database(file);
    const uplink = { deveui: 'A840410000000001', eventId: 'ev-1', devAddr: '01000001', fCnt: 3, time: '2026-10-08T10:00:00.000Z',
      fPort: 2, data: Buffer.from('06030005060100b8068100021221000a', 'hex').toString('base64'), object: { rain_tips_delta: 2 } };
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const first = await db.transaction((t) => R.ingestLoRainUplink(t, uplink, { nowMs }));
    assert.equal(first.outcome, 'accepted');
    assert.ok(Number.isInteger(first.observationId) && Number.isInteger(first.deviceDataId), 'ids come from last_insert_rowid()');
    assert.deepEqual(first.zoneDays, [{ zoneId: 1, date: '2026-10-08' }]);
    const again = await db.transaction((t) => R.ingestLoRainUplink(t, uplink, { nowMs }));
    assert.equal(again.outcome, 'duplicate');
    const recomputed = await db.transaction((t) => R.recomputeInstrumentDay(t, 'A840410000000001', '2026-10-08', 'Europe/Zurich', { nowMs }));
    assert.deepEqual(recomputed.zoneDays, [{ zoneId: 1, date: '2026-10-08' }]);
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(check.prepare('SELECT device_data_id FROM rain_observations').get().device_data_id, first.deviceDataId);
      assert.equal(check.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'").get().rainfall_mm, 1);
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
