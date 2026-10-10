'use strict';
// Binds osi-rain's ingestLoRainUplink, recomputeInstrumentDay and
// ingestS2120Uplink EXACTLY as lorain-ingest-fn and s2120-ingest-fn do: `new osiDb.Database(...)` from osi-db-helper, then
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
    const recomputed = await db.transaction((t) => R.recomputeInstrumentDay(t, 'A840410000000001', '2026-10-08', 'Europe/Zurich', { nowMs, reassess: true }));
    assert.deepEqual({ date: recomputed.date, timezone: recomputed.timezone, instrumentType: recomputed.instrumentType, coverage: recomputed.coverage,
      receivedMm: recomputed.receivedMm, amountMm: recomputed.amountMm },
    { date: '2026-10-08', timezone: 'Europe/Zurich', instrumentType: 'AQUASCOPE_LORAIN', coverage: 'unknown', receivedMm: 1, amountMm: null });
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(check.prepare('SELECT device_data_id FROM rain_observations').get().device_data_id, first.deviceDataId);
      assert.deepEqual({ ...check.prepare("SELECT rainfall_mm, rain_received_mm, rain_coverage FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'").get() },
        { rainfall_mm: null, rain_received_mm: 1, rain_coverage: 'unknown' });
      assert.equal(check.prepare("SELECT coverage FROM rain_instrument_days WHERE deveui = 'A840410000000001' AND date = '2026-10-08'").get().coverage, 'unknown');
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestS2120Uplink through the osi-db-helper transaction facade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-rain-facade-'));
  try {
    const file = path.join(dir, 'farming.db');
    const native = new DatabaseSync(file);
    native.exec(fs.readFileSync(SEED, 'utf8'));
    native.exec(`INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
      INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z', 1, 'z-1', 'Europe/Zurich', 'local');
      INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
        VALUES ('A840410000000002', 'Station', 'SENSECAP_S2120', 1, 1, '2026-01-01', '2026-01-01');`);
    native.close();
    const osiDb = loadOsiDbHelper();
    const db = new osiDb.Database(file);
    const cache = new Map();
    const markerCache = { get: (eui) => cache.get(eui), set: (eui, value) => cache.set(eui, value) };
    const uplink = (n, mm) => ({ deveui: 'A840410000000002', eventId: 'ev-s' + n, devAddr: '01000002', fCnt: n, fPort: 3,
      time: new Date(Date.parse('2026-10-08T10:00:00.000Z') + n * 600000).toISOString(),
      object: { messages: [[{ measurementId: 4113, measurementValue: 0 }, { measurementId: 4213, measurementValue: mm }]] } });
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const baseline = await db.transaction((t) => R.ingestS2120Uplink(t, uplink(0, 10), { nowMs, markerCache }));
    assert.equal(baseline.outcome, 'accepted');
    assert.equal(baseline.rainDeltaStatus, 'cumulative_baseline');
    assert.equal(cache.get('A840410000000002'), '2026-10-08T10:00:00.000Z');
    const first = await db.transaction((t) => R.ingestS2120Uplink(t, uplink(1, 10.5), { nowMs, markerCache }));
    assert.equal(first.status, 'accepted');
    assert.ok(Number.isInteger(first.observationId) && Number.isInteger(first.deviceDataId), 'ids come from last_insert_rowid()');
    assert.deepEqual(first.zoneDays, [{ zoneId: 1, date: '2026-10-08' }]);
    const again = await db.transaction((t) => R.ingestS2120Uplink(t, uplink(1, 10.5), { nowMs, markerCache }));
    assert.equal(again.outcome, 'duplicate');
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(check.prepare('SELECT device_data_id FROM rain_observations WHERE id = ?').get(first.observationId).device_data_id, first.deviceDataId);
      assert.equal(check.prepare("SELECT rain_received_mm FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'").get().rain_received_mm, 0.5);
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputeZoneDay through the osi-db-helper transaction facade (lsn50-zone-agg-fn shape)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-rain-facade-'));
  try {
    const file = path.join(dir, 'farming.db');
    const native = new DatabaseSync(file);
    native.exec(fs.readFileSync(SEED, 'utf8'));
    native.exec(`INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
      INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z', 1, 'z-1', 'Europe/Zurich', 'local');
      INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, rain_gauge_enabled, created_at, updated_at)
        VALUES ('A840410000000003', 'Counter', 'DRAGINO_LSN50', 1, 1, 1, '2026-01-01', '2026-01-01');
      INSERT INTO device_data (deveui, recorded_at, rain_count_cumulative, rain_mm_delta, rain_delta_status, counter_interval_seconds)
        VALUES ('A840410000000003', '2026-10-08T09:50:00.000Z', 10, NULL, 'first_sample', NULL),
               ('A840410000000003', '2026-10-08T10:00:00.000Z', 12, 0.4, 'ok', 600);`);
    native.close();
    const osiDb = loadOsiDbHelper();
    const db = new osiDb.Database(file);
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const out = await db.transaction(async (t) => {
      await R.recomputeInstrumentDay(t, 'A840410000000003', '2026-10-08', 'Europe/Zurich', { nowMs });
      return R.recomputeZoneDay(t, 1, '2026-10-08', { trigger: 'accepted', amountMm: 0.4, flowLitersDelta: 3, nowMs });
    });
    assert.equal(out.written, 'inserted');
    const again = await db.transaction((t) => R.recomputeZoneDay(t, 1, '2026-10-08', { trigger: 'reassessed', nowMs }));
    assert.equal(again.written, false, 'nothing projected changed');
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual({ ...check.prepare("SELECT rainfall_mm, rain_received_mm, flow_liters, rain_source, rain_coverage, rain_selected_deveui, rain_policy_version, sync_version FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'").get() },
        { rainfall_mm: null, rain_received_mm: 0.4, flow_liters: 3, rain_source: 'local_gauge', rain_coverage: 'partial',
          rain_selected_deveui: 'A840410000000003', rain_policy_version: 1, sync_version: 0 });
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
