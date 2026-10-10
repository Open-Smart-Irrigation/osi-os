#!/usr/bin/env node
'use strict';
// S2120 ingestion under the real osi-db-helper over a temp file database,
// driving the shipped s2120-ingest-fn body: two distinct uplinks of one
// device started together (review finding 4, acceptance A24: 100 then 101 and
// 102 must total 2 mm, never 3), concurrent first frames on a cold marker
// cache, a concurrent duplicate delivery, a failure inside the transaction and
// a restart (a fresh helper instance: new process memory, new connection).
// The sqlite3 binding is replaced by a node:sqlite adapter, as in
// scripts/test-lorain-ingest-concurrency.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const SHARE = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share');
const NODE_RED = path.join(SHARE, 'node-red');
const helperPath = path.join(NODE_RED, 'osi-db-helper/index.js');
const R = require(path.join(NODE_RED, 'osi-rain/index.js'));
const flows = JSON.parse(fs.readFileSync(path.join(SHARE, 'flows.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-s2120-ingest-'));
const EUI = 'A840410000000001';
const T0 = Date.parse('2026-10-08T10:00:00.000Z');
let opened = 0;

function adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      opened += 1;
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
        callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
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

// A fresh module instance: its own shared connection and operation queue.
function loadHelper() {
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) return adapter();
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
  } finally {
    Module._load = original;
  }
}

let dbCount = 0;
function seedFile() {
  dbCount += 1;
  const dbPath = path.join(tempRoot, `farming-${dbCount}.db`);
  const native = new DatabaseSync(dbPath);
  native.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  native.exec(`
    INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z One', 1, 'z-1', 'UTC', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
      VALUES ('${EUI}', 'Station', 'SENSECAP_S2120', 1, 1, '2026-01-01', '2026-01-01');`);
  native.close();
  return dbPath;
}

// The shipped node body with its declared libs. Node context persists across
// messages of one "process" (one runtime instance); osiDb is the real helper,
// pointed at the temp file (the node passes the gateway path, the helper's
// shared connection is already open on the temp file).
function runtime(dbPath, { rain = R } = {}) {
  const osiDb = loadHelper();
  const db = new osiDb.Database(dbPath);
  const store = new Map();
  const errors = [];
  const fn = new AsyncFunction('msg', 'osiDb', 'osiLib', 'node', 'context',
    flows.find((n) => n.id === 's2120-ingest-fn').func);
  const osiLib = { require: (name) => (name === 'rain' ? { ok: true, value: rain } : { ok: false, error: name }) };
  const node = { status() {}, warn() {}, error(message) { errors.push(String(message)); } };
  const context = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  return { db, store, errors, deliver: (payload) => fn({ payload }, osiDb, osiLib, node, context) };
}

function uplink(n, cumulativeMm, offsetSeconds) {
  return {
    deviceInfo: { devEui: EUI }, deduplicationId: '00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0'),
    devAddr: '01000001', fCnt: 200 + n, fPort: 3, time: new Date(T0 + offsetSeconds * 1000).toISOString(),
    object: { messages: [[{ measurementId: 4113, measurementValue: 0 }, { measurementId: 4213, measurementValue: cumulativeMm }]] },
  };
}

function snapshot(dbPath, sql) {
  const native = new DatabaseSync(dbPath, { readOnly: true });
  try { return native.prepare(sql).all().map((r) => ({ ...r })); } finally { native.close(); }
}
const acceptedTotal = (dbPath) => snapshot(dbPath, "SELECT ROUND(COALESCE(SUM(amount_mm), 0), 3) AS mm FROM rain_observations WHERE status = 'accepted'")[0].mm;
const zoneDay = (dbPath) => snapshot(dbPath, "SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'");

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

for (const order of ['101 first', '102 first']) {
  test(`A24: 100, then 101 and 102 delivered together (${order}) total 2 mm, never 3`, async () => {
    const dbPath = seedFile();
    const rt = runtime(dbPath);
    await rt.deliver(uplink(1, 100.0, 0));
    const pair = [uplink(2, 101.0, 600), uplink(3, 102.0, 610)];
    if (order === '102 first') pair.reverse();
    await Promise.all(pair.map((u) => rt.deliver(u)));
    assert.deepEqual(rt.errors, []);
    assert.equal(acceptedTotal(dbPath), 2);
    assert.equal(snapshot(dbPath, "SELECT ROUND(SUM(rain_mm_delta), 3) AS mm FROM device_data WHERE rain_delta_status = 'ok'")[0].mm, 2);
    assert.deepEqual(zoneDay(dbPath), [{ rainfall_mm: 2 }]);
  });
}

test('twenty distinct uplinks in parallel: every increment once, zone day = the counter rise', async () => {
  const dbPath = seedFile();
  const rt = runtime(dbPath);
  await rt.deliver(uplink(1, 50, 0));
  const batch = [];
  for (let n = 2; n <= 21; n += 1) batch.push(rt.deliver(uplink(n, 50 + (n - 1) * 0.254, (n - 1) * 600)));
  await Promise.all(batch);
  assert.deepEqual(rt.errors, []);
  assert.equal(acceptedTotal(dbPath), 5.08);
  assert.deepEqual(zoneDay(dbPath), [{ rainfall_mm: 5.08 }]);
});

test('two first frames on a cold marker cache: exactly one counter baseline', async () => {
  const dbPath = seedFile();
  const rt = runtime(dbPath);
  await Promise.all([rt.deliver(uplink(1, 100, 0)), rt.deliver(uplink(2, 101, 600))]);
  assert.deepEqual(rt.errors, []);
  assert.deepEqual(snapshot(dbPath, 'SELECT rain_delta_status, rain_mm_delta FROM device_data ORDER BY recorded_at'),
    [{ rain_delta_status: 'cumulative_baseline', rain_mm_delta: null }, { rain_delta_status: 'ok', rain_mm_delta: 1 }]);
  assert.equal(rt.store.get('s2120CounterBaseline')[EUI], new Date(T0).toISOString());
});

test('the same uplink delivered twice at once is ingested once', async () => {
  const dbPath = seedFile();
  const rt = runtime(dbPath);
  await rt.deliver(uplink(1, 100, 0));
  await Promise.all([rt.deliver(uplink(2, 101, 600)), rt.deliver(uplink(2, 101, 600))]);
  assert.deepEqual(rt.errors, []);
  assert.deepEqual(snapshot(dbPath, 'SELECT COUNT(*) AS n FROM rain_observations'), [{ n: 2 }]);
  assert.deepEqual(snapshot(dbPath, 'SELECT COUNT(*) AS n FROM device_data'), [{ n: 2 }]);
  assert.deepEqual(zoneDay(dbPath), [{ rainfall_mm: 1 }]);
});

test('a failure inside the transaction leaves nothing behind; the retry counts once; a restart keeps the identity', async () => {
  const dbPath = seedFile();
  let crash = true;
  const crashing = { ...R, async ingestS2120Uplink(t, u, opts) {
    const result = await R.ingestS2120Uplink(t, u, opts);
    if (crash) throw new Error('crash before commit');
    return result;
  } };
  const rt = runtime(dbPath, { rain: crashing });
  await rt.deliver(uplink(1, 100, 0));
  assert.equal(rt.errors.length, 1);
  assert.match(rt.errors[0], /rolled back.*crash before commit/);
  assert.deepEqual(snapshot(dbPath, 'SELECT (SELECT COUNT(*) FROM rain_observations) AS o, (SELECT COUNT(*) FROM device_data) AS d'), [{ o: 0, d: 0 }]);
  assert.ok(!Object.prototype.hasOwnProperty.call(rt.store.get('s2120CounterBaseline') || {}, EUI), 'the rolled-back baseline is not cached');
  crash = false;
  await rt.deliver(uplink(1, 100, 0));
  await rt.deliver(uplink(2, 101, 600));
  assert.deepEqual(zoneDay(dbPath), [{ rainfall_mm: 1 }]);

  const openedBefore = opened;
  const restarted = runtime(dbPath);
  assert.equal(opened, openedBefore + 1, 'a new connection was opened');
  await restarted.deliver(uplink(2, 101, 600));
  await restarted.deliver({ ...uplink(2, 101, 600), deduplicationId: '00000000-0000-4000-8000-000000000199' });
  await restarted.deliver(uplink(3, 101.5, 1200));
  assert.deepEqual(restarted.errors, []);
  assert.deepEqual(snapshot(dbPath, 'SELECT COUNT(*) AS n FROM rain_observations'), [{ n: 3 }]);
  assert.equal(acceptedTotal(dbPath), 1.5);
  assert.deepEqual(zoneDay(dbPath), [{ rainfall_mm: 1.5 }]);
});
