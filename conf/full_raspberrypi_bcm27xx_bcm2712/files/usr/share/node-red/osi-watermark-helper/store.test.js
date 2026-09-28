'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const NR = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(NR, '../../../../../..');
const SEED_SQL = path.join(REPO_ROOT, 'database', 'seed-blank.sql');
const MIGRATION_SQL = path.join(REPO_ROOT, 'database/migrations/ordered/0061__watermark_lsn50.sql');
const writer = require(path.join(NR, 'osi-device-writer'));
const manifest = JSON.parse(fs.readFileSync(path.join(NR, 'edge-channels.json'), 'utf8'));
const wm = require('.');

const DEVEUI = 'A84041A171000001';
const USER_ID = 1;
const CAL = {
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27
};

// osi-db-helper facade shape over node:sqlite: get/all/run promise-returning,
// run() resolves undefined, transaction() gives a scope with the same methods.
function facade(native) {
  const scope = {
    get: async (sql, p) => native.prepare(sql).get(...(p || [])),
    all: async (sql, p) => native.prepare(sql).all(...(p || [])),
    run: async (sql, p) => { native.prepare(sql).run(...(p || [])); return undefined; }
  };
  return Object.assign({}, scope, {
    async transaction(fn) {
      native.exec('BEGIN IMMEDIATE');
      try { const r = await fn(scope); native.exec('COMMIT'); return r; }
      catch (e) { native.exec('ROLLBACK'); throw e; }
    }
  });
}

function freshDb() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(SEED_SQL, 'utf8'));
  if (!native.prepare("SELECT name FROM sqlite_master WHERE name = 'watermark_readings'").get()) {
    native.exec(fs.readFileSync(MIGRATION_SQL, 'utf8'));
  }
  const now = new Date().toISOString();
  native.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, 'phil', 'x', ?)").run(USER_ID, now);
  native.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, 'Watermark 1+2', 'DRAGINO_LSN50', ?, ?, ?)").run(DEVEUI, USER_ID, now, now);
  writer.resetColumnCache();
  return { native, db: facade(native) };
}

const w = (v) => [(v >> 8) & 255, v & 255];
function frameB64(p1, p2, { soil = 1988, source = 2 } = {}) {
  return Buffer.from([0xA2, 3, ...w(3300), ...w(soil & 0xffff), ...w(2146), source, 0x20,
    ...w(p1[0]), ...w(p1[0]), ...w(p1[1]), ...w(p1[1]), 0x20,
    ...w(p2[0]), ...w(p2[0]), ...w(p2[1]), ...w(p2[1])]).toString('base64');
}
const deps = {
  clampRecordedAt: writer.clampRecordedAt,
  writeDeviceData: (tx, nr) => writer.writeDeviceData(tx, manifest, nr, { deveui: DEVEUI }, {})
};
function ingestAt(db, iso, payloadB64) {
  return wm.ingestProfile3(db, { deveui: DEVEUI, recordedAt: iso, payloadB64, fCnt: 7 }, deps);
}
const T1 = new Date(Date.now() - 3600e3).toISOString();
const T2 = new Date(Date.now() - 1800e3).toISOString();

describe('ingestProfile3', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('writes device_data and a raw row; kPa waits for calibration', async () => {
    const res = await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    assert.equal(res.accepted, true);
    const dd = ctx.native.prepare('SELECT swt_1, swt_2, ext_temperature_c, bat_v FROM device_data WHERE deveui = ?').get(DEVEUI);
    assert.deepEqual({ ...dd }, { swt_1: null, swt_2: null, ext_temperature_c: 19.88, bat_v: null });
    const wr = ctx.native.prepare('SELECT frame_status, ch1_status, ch2_status, supply_mv, recorded_at FROM watermark_readings').get();
    assert.deepEqual({ ...wr }, { frame_status: 'accepted', ch1_status: 'calibration_required', ch2_status: 'calibration_required', supply_mv: 3300, recorded_at: T1 });
  });

  it('converts with a live calibration', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await ingestAt(ctx.db, T2, frameB64([800, 3291], [71, 4058]));
    const dd = ctx.native.prepare('SELECT swt_1, swt_2 FROM device_data WHERE deveui = ?').get(DEVEUI);
    assert.deepEqual({ ...dd }, { swt_1: 56.4, swt_2: 0 });
    const wr = ctx.native.prepare('SELECT ch1_r_solved, ch2_status, calibration_sync_version, conversion_version FROM watermark_readings').get();
    assert.deepEqual({ ...wr }, { ch1_r_solved: 9977, ch2_status: 'saturated', calibration_sync_version: 1, conversion_version: 'wm-lsn50-p3-v1' });
  });

  it('keeps a rejected frame as raw only', async () => {
    const bad = Buffer.from(frameB64([800, 3291], [71, 4058]), 'base64'); bad[1] = 2;
    const res = await ingestAt(ctx.db, T1, bad.toString('base64'));
    assert.deepEqual([res.accepted, res.reason], [false, 'profile']);
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 0);
    assert.equal(ctx.native.prepare("SELECT frame_status FROM watermark_readings").get().frame_status, 'frame_rejected');
  });

  it('no kPa from the firmware constant temperature', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058], { soil: 1250, source: 1 }));
    const dd = ctx.native.prepare('SELECT swt_1, ext_temperature_c FROM device_data').get();
    assert.deepEqual({ ...dd }, { swt_1: null, ext_temperature_c: null });
    assert.equal(ctx.native.prepare('SELECT ch1_status FROM watermark_readings').get().ch1_status, 'temperature_missing');
  });

  it('clamps a garbage timestamp identically in both rows', async () => {
    const res = await ingestAt(ctx.db, 'not-a-date', frameB64([800, 3291], [71, 4058]));
    const dd = ctx.native.prepare('SELECT recorded_at FROM device_data').get().recorded_at;
    const wr = ctx.native.prepare('SELECT recorded_at FROM watermark_readings').get().recorded_at;
    assert.equal(dd, wr);
    assert.equal(res.recordedAt, dd);
  });

  it('skips a DevEUI with no devices row cleanly; calibration refuses it', async () => {
    const res = await wm.ingestProfile3(ctx.db, { deveui: 'A840410000000001', recordedAt: T1, payloadB64: frameB64([800, 3291], [71, 4058]) }, {
      clampRecordedAt: writer.clampRecordedAt,
      writeDeviceData: (tx, nr) => writer.writeDeviceData(tx, manifest, nr, { deveui: 'A840410000000001' }, {})
    });
    assert.deepEqual([res.accepted, res.reason], [false, 'unknown_device']);
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 0);
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM watermark_readings').get().n, 0);
    await assert.rejects(
      wm.saveCalibration(ctx.db, { deveui: 'A840410000000001', userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } }),
      (e) => e.statusCode === 404
    );
  });

  it('rejects a malformed DevEUI in the store', async () => {
    await assert.rejects(wm.getCalibration(ctx.db, { deveui: 'xyz', userId: USER_ID }), (e) => e.statusCode === 400);
  });
});

describe('review fixes (external review 2026-09-26)', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('records the exact device_data id of each observation', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    const dd = ctx.native.prepare('SELECT id FROM device_data').get();
    const wr = ctx.native.prepare('SELECT device_data_id FROM watermark_readings').get();
    assert.equal(wr.device_data_id, dd.id);
  });

  it('backfill updates by row id, not by timestamp', async () => {
    ctx.native.prepare('INSERT INTO device_data (deveui, recorded_at) VALUES (?, ?)').run(DEVEUI, T1);
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [4093, 2]));
    await ingestAt(ctx.db, T1, frameB64([108, 3987], [4093, 2]));
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    const rows = ctx.native.prepare('SELECT swt_1 FROM device_data WHERE deveui = ? ORDER BY id').all(DEVEUI).map((r) => r.swt_1);
    assert.deepEqual(rows, [null, 56.4, 9.7]);
  });

  it('scoped mode trusts the guard: an assigned non-owner can write', async () => {
    const saved = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: 2, scoped: true, body: { ...CAL, expected_sync_version: 0 } });
    assert.equal(saved.sync_version, 1);
    const got = await wm.getCalibration(ctx.db, { deveui: DEVEUI, scoped: true });
    assert.equal(got.sync_version, 1);
  });

  it('legacy mode needs the owner and an authenticated user', async () => {
    await assert.rejects(wm.getCalibration(ctx.db, { deveui: DEVEUI, userId: 2 }), (e) => e.statusCode === 404);
    await assert.rejects(wm.getCalibration(ctx.db, { deveui: DEVEUI }), (e) => e.statusCode === 401);
  });
});

describe('calibration store', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('first save backfills waiting readings only', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [276, 4095]));
    const saved = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    assert.deepEqual([saved.sync_version, saved.backfilled], [1, 1]);
    const dd = ctx.native.prepare('SELECT swt_1, swt_2 FROM device_data').get();
    assert.deepEqual({ ...dd }, { swt_1: 56.4, swt_2: null });
    const wr = ctx.native.prepare('SELECT ch1_status, ch2_status, ch2_r_upper_bound, ch2_kpa_upper_bound FROM watermark_readings').get();
    assert.deepEqual({ ...wr }, { ch1_status: 'ok', ch2_status: 'wet_offset_clipped', ch2_r_upper_bound: 1439, ch2_kpa_upper_bound: 11.7 });
  });

  it('recalibration never rewrites converted readings', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    const second = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, pullup_1_ohm: 50000, expected_sync_version: 1 } });
    assert.equal(second.backfilled, 0);
    assert.equal(ctx.native.prepare('SELECT swt_1 FROM device_data').get().swt_1, 56.4);
  });

  it('rejects a stale version with 409 and keeps the newer row', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await assert.rejects(
      wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, pullup_1_ohm: 30000, expected_sync_version: 0 } }),
      (e) => e.statusCode === 409 && e.code === 'stale_sync_version' && e.currentSyncVersion === 1
    );
    assert.equal(ctx.native.prepare('SELECT pullup_1_ohm FROM watermark_calibrations').get().pullup_1_ohm, 41670);
  });

  it('refuses out-of-range values and foreign devices', async () => {
    await assert.rejects(wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, series_rev_2_ohm: 501, expected_sync_version: 0 } }),
      (e) => e.statusCode === 400 && e.field === 'series_rev_2_ohm');
    await assert.rejects(wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: 2, body: { ...CAL, expected_sync_version: 0 } }),
      (e) => e.statusCode === 404);
  });

  it('delete writes a tombstone; later frames wait for calibration again', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    const del = await wm.deleteCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, expectedSyncVersion: '1' });
    assert.equal(del.sync_version, 2);
    const got = await wm.getCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID });
    assert.deepEqual([got.sync_version, got.calibration], [2, null]);
    await ingestAt(ctx.db, T2, frameB64([800, 3291], [71, 4058]));
    assert.equal(ctx.native.prepare('SELECT ch1_status FROM watermark_readings').get().ch1_status, 'calibration_required');
    const again = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 2 } });
    assert.deepEqual([again.sync_version, again.backfilled], [3, 1]);
  });

  it('dry run previews the latest frame and saves nothing', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    const res = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, dry_run: true } });
    assert.equal(res.preview.channels[0].r_solved, 9977);
    assert.equal(res.preview.channels[1].status, 'saturated');
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM watermark_calibrations').get().n, 0);
    assert.equal(ctx.native.prepare('SELECT swt_1 FROM device_data').get().swt_1, null);
  });
});

describe('calibration metadata (external final review 2026-09-26)', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });
  const META = { measured_at: '2026-09-20T08:30:00.000Z', method: 'bench_resistor_sweep', worst_residual_pct: 0.6, notes: 'bench 2026-09-20' };
  const save = (body) => wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body });
  const metaOf = (res) => {
    const c = res.calibration;
    return { measured_at: c.measured_at, method: c.method, worst_residual_pct: c.worst_residual_pct, notes: c.notes };
  };

  it('a coefficients-only save keeps the stored metadata', async () => {
    await save({ ...CAL, ...META, expected_sync_version: 0 });
    // The GUI section submits coefficients and the version only.
    const second = await save({ ...CAL, pullup_1_ohm: 41700, expected_sync_version: 1 });
    assert.equal(second.sync_version, 2);
    assert.equal(second.calibration.pullup_1_ohm, 41700);
    assert.deepEqual(metaOf(second), META);
    const got = await wm.getCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID });
    assert.deepEqual(metaOf(got), META);
  });

  it('an explicit null or empty string clears one field and leaves the others', async () => {
    await save({ ...CAL, ...META, expected_sync_version: 0 });
    const cleared = await save({ ...CAL, notes: null, method: '', expected_sync_version: 1 });
    assert.deepEqual(metaOf(cleared), { ...META, notes: null, method: null });
    const residualCleared = await save({ ...CAL, worst_residual_pct: null, measured_at: '', expected_sync_version: 2 });
    assert.deepEqual(metaOf(residualCleared), { measured_at: null, method: null, worst_residual_pct: null, notes: null });
  });

  it('a provided value replaces the stored one and is still validated', async () => {
    await save({ ...CAL, ...META, expected_sync_version: 0 });
    const replaced = await save({ ...CAL, notes: 'resoldered R3', expected_sync_version: 1 });
    assert.deepEqual(metaOf(replaced), { ...META, notes: 'resoldered R3' });
    await assert.rejects(save({ ...CAL, worst_residual_pct: 101, expected_sync_version: 2 }),
      (e) => e.statusCode === 400 && e.field === 'worst_residual_pct');
    await assert.rejects(save({ ...CAL, measured_at: 'yesterday-ish', expected_sync_version: 2 }),
      (e) => e.statusCode === 400 && e.field === 'measured_at');
    assert.equal(ctx.native.prepare('SELECT sync_version FROM watermark_calibrations').get().sync_version, 2);
  });

  it('omitted metadata is null on a first save and after a delete', async () => {
    const first = await save({ ...CAL, expected_sync_version: 0 });
    assert.deepEqual(metaOf(first), { measured_at: null, method: null, worst_residual_pct: null, notes: null });
    await save({ ...CAL, ...META, expected_sync_version: 1 });
    await wm.deleteCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, expectedSyncVersion: 2 });
    const afterDelete = await save({ ...CAL, expected_sync_version: 3 });
    assert.deepEqual(metaOf(afterDelete), { measured_at: null, method: null, worst_residual_pct: null, notes: null });
  });
});

describe('bounded backfill (Fable final review Minor 4)', () => {
  const Module = require('node:module');
  const DB_HELPER_PATH = path.join(NR, 'osi-db-helper', 'index.js');

  // node:sqlite-backed sqlite3 adapter, so the real osi-db-helper (with its
  // shared operation queue) runs against one in-memory DatabaseSync
  // (the scripts/test-watermark-ingest-flow.js pattern).
  function sqlite3Adapter(native) {
    class Database {
      constructor(filename, mode, callback) {
        if (typeof mode === 'function') { callback = mode; mode = undefined; }
        queueMicrotask(() => callback && callback.call(this, null));
      }
      all(sql, params, callback) {
        if (typeof params === 'function') { callback = params; params = []; }
        try { callback.call(this, null, native.prepare(sql).all(...(params || []))); }
        catch (error) { callback.call(this, error); }
      }
      run(sql, params, callback) {
        if (typeof params === 'function') { callback = params; params = []; }
        try {
          const result = native.prepare(sql).run(...(params || []));
          callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
        } catch (error) { callback.call(this, error); }
      }
      exec(sql, callback) {
        try { native.exec(sql); callback.call(this, null); }
        catch (error) { callback.call(this, error); }
      }
      close(callback) { if (callback) callback.call(this, null); }
    }
    return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
  }

  function realDb(native) {
    const original = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) return sqlite3Adapter(native);
      return original.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[require.resolve(DB_HELPER_PATH)];
      return new (require(DB_HELPER_PATH).Database)('/data/db/farming.db');
    } finally {
      Module._load = original;
    }
  }

  const WAITING = 1200;
  // 1200 uncalibrated readings, one minute apart, oldest first.
  async function seedWaiting(ctx) {
    const start = Date.now() - (WAITING + 60) * 60e3;
    for (let i = 0; i < WAITING; i += 1) {
      await ingestAt(ctx.db, new Date(start + i * 60e3).toISOString(), frameB64([800, 3291], [71, 4058]));
    }
    const waiting = ctx.native.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status = 'calibration_required'").get().n;
    assert.equal(waiting, WAITING, 'fixture: every reading waits for a calibration');
  }

  it('converts more than one batch of waiting readings, all of them', async () => {
    assert.equal(wm.BACKFILL_BATCH_SIZE, 500);
    const ctx = freshDb();
    await seedWaiting(ctx);
    const db = realDb(ctx.native);
    const saved = await wm.saveCalibration(db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    assert.equal(saved.backfilled, WAITING);
    assert.equal(ctx.native.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status = 'calibration_required' OR ch2_status = 'calibration_required'").get().n, 0);
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM device_data WHERE swt_1 = 56.4').get().n, WAITING);
    assert.equal(ctx.native.prepare('SELECT COUNT(DISTINCT calibration_sync_version) AS n FROM watermark_readings').get().n, 1);
  });

  it('lets an uplink queued during the backfill run between batches', async () => {
    const ctx = freshDb();
    await seedWaiting(ctx);
    const db = realDb(ctx.native);
    const order = [];
    const save = wm.saveCalibration(db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } })
      .then((res) => { order.push('save'); return res; });
    // Queued behind the first batch, i.e. while the save is in progress. A
    // single-transaction backfill would run it only after the whole save.
    const uplink = ingestAt(db, new Date().toISOString(), frameB64([800, 3291], [71, 4058]))
      .then((res) => { order.push('uplink'); return res; });
    const [saved, ingested] = await Promise.all([save, uplink]);
    assert.deepEqual(order, ['uplink', 'save']);
    // It ran after the calibration committed, so it was converted on arrival.
    assert.deepEqual(ingested.statuses, ['ok', 'saturated']);
    assert.equal(saved.backfilled, WAITING);
    assert.equal(ctx.native.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status = 'calibration_required'").get().n, 0);
  });

  it('a failed later batch keeps the saved calibration, reports backfill_incomplete, and leaves its readings waiting', async () => {
    const ctx = freshDb();
    await seedWaiting(ctx);
    const db = realDb(ctx.native);
    let calls = 0;
    const flaky = {
      get: (...a) => db.get(...a),
      all: (...a) => db.all(...a),
      run: (...a) => db.run(...a),
      transaction(fn) {
        calls += 1;
        return calls === 3 ? Promise.reject(new Error('disk I/O error')) : db.transaction(fn);
      },
    };
    const saved = await wm.saveCalibration(flaky, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    assert.equal(saved.sync_version, 1);
    assert.equal(saved.backfilled, 2 * wm.BACKFILL_BATCH_SIZE);
    assert.equal(saved.backfill_incomplete, true);
    assert.equal(ctx.native.prepare('SELECT sync_version FROM watermark_calibrations').get().sync_version, 1);
    const waiting = ctx.native.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status = 'calibration_required'").get().n;
    assert.equal(waiting, WAITING - 2 * wm.BACKFILL_BATCH_SIZE);
    const complete = await wm.saveCalibration(db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 1 } });
    assert.equal(complete.backfilled, WAITING - 2 * wm.BACKFILL_BATCH_SIZE);
    assert.equal(complete.backfill_incomplete, undefined);
  });

  it('a batch that finds the calibration deleted stops; the rest waits for the next save', async () => {
    const ctx = freshDb();
    await seedWaiting(ctx);
    const db = realDb(ctx.native);
    const save = wm.saveCalibration(db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    // Queued behind the first batch: deletes the calibration mid-backfill.
    const del = wm.deleteCalibration(db, { deveui: DEVEUI, userId: USER_ID, expectedSyncVersion: 1 });
    const [saved] = await Promise.all([save, del]);
    assert.equal(saved.backfilled, wm.BACKFILL_BATCH_SIZE);
    const waiting = ctx.native.prepare("SELECT COUNT(*) AS n FROM watermark_readings WHERE ch1_status = 'calibration_required'").get().n;
    assert.equal(waiting, WAITING - wm.BACKFILL_BATCH_SIZE);
    const again = await wm.saveCalibration(db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 2 } });
    assert.equal(again.backfilled, WAITING - wm.BACKFILL_BATCH_SIZE);
  });
});
