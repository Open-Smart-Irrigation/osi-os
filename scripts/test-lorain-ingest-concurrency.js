#!/usr/bin/env node
'use strict';
// LoRain ingestion under the real osi-db-helper over a temp file database:
// concurrent duplicate deliveries, parallel distinct uplinks, a failure inside
// the transaction, and a restart (a fresh helper instance, i.e. new process
// memory and a new connection). The unique index, not memory, is the guarantee.
// The sqlite3 binding is replaced by a node:sqlite adapter, as in
// scripts/test-osi-db-helper-read-snapshot.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const NODE_RED = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const helperPath = path.join(NODE_RED, 'osi-db-helper/index.js');
const R = require(path.join(NODE_RED, 'osi-rain/index.js'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-lorain-ingest-'));
const dbPath = path.join(tempRoot, 'farming.db');
const EUI = 'A840410000000001';
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
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

function seedFile() {
  const native = new DatabaseSync(dbPath);
  native.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  native.exec(`
    INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z One', 1, 'z-1', 'UTC', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
      VALUES ('${EUI}', 'Gauge', 'AQUASCOPE_LORAIN', 1, 1, '2026-01-01', '2026-01-01');`);
  native.close();
}

function uplink(n, tips = 1) {
  const time = new Date(Date.parse('2026-10-08T00:00:00.000Z') + n * 900000).toISOString();
  const bytes = Buffer.from('06030005060100b80681' + tips.toString(16).padStart(4, '0') + '1221000a', 'hex');
  return { deveui: EUI, eventId: '00000000-0000-4000-8000-0000000001' + String(n).padStart(2, '0'), devAddr: '01000001', fCnt: 100 + n,
    time, fPort: 2, data: bytes.toString('base64'), object: { rain_tips_delta: tips, rainlevel: tips, rain_mm_delta: tips * 0.5 } };
}

const ingest = (db, u) => db.transaction((t) => R.ingestLoRainUplink(t, u, { nowMs: NOW }));
function snapshot(sql) {
  const native = new DatabaseSync(dbPath, { readOnly: true });
  try { return native.prepare(sql).all().map((r) => ({ ...r })); } finally { native.close(); }
}

seedFile();
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('the same uplink delivered twice at once is accepted once', async () => {
  const db = new (loadHelper().Database)(dbPath);
  const results = await Promise.all([ingest(db, uplink(0)), ingest(db, uplink(0))]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ['accepted', 'duplicate']);
  assert.deepEqual(snapshot('SELECT COUNT(*) AS n FROM rain_observations'), [{ n: 1 }]);
  assert.deepEqual(snapshot('SELECT COUNT(*) AS n FROM device_data'), [{ n: 1 }]);
});

test('20 distinct uplinks in parallel: 20 observations, zone total = their sum', async () => {
  const db = new (loadHelper().Database)(dbPath);
  const batch = [];
  for (let n = 1; n <= 20; n += 1) batch.push(ingest(db, uplink(n)));
  const results = await Promise.all(batch);
  assert.ok(results.every((r) => r.outcome === 'accepted'));
  assert.deepEqual(snapshot('SELECT COUNT(*) AS n FROM rain_observations'), [{ n: 21 }]);
  assert.deepEqual(snapshot("SELECT COUNT(*) AS n FROM rain_observations WHERE status = 'accepted'"), [{ n: 21 }]);
  assert.deepEqual(snapshot("SELECT rain_received_mm FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'"), [{ rain_received_mm: 10.5 }]);
});

test('a failure inside the transaction leaves nothing behind; the retry counts once', async () => {
  const db = new (loadHelper().Database)(dbPath);
  const before = snapshot('SELECT (SELECT COUNT(*) FROM rain_observations) AS o, (SELECT COUNT(*) FROM device_data) AS d');
  await assert.rejects(db.transaction(async (t) => {
    await R.ingestLoRainUplink(t, uplink(30), { nowMs: NOW });
    throw new Error('crash before commit');
  }), /crash before commit/);
  assert.deepEqual(snapshot('SELECT (SELECT COUNT(*) FROM rain_observations) AS o, (SELECT COUNT(*) FROM device_data) AS d'), before);
  const retry = await ingest(db, uplink(30));
  assert.equal(retry.outcome, 'accepted');
  assert.deepEqual(snapshot("SELECT rain_received_mm FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'"), [{ rain_received_mm: 11 }]);
});

test('after a restart the first uplink is still a duplicate (durable identity)', async () => {
  const openedBefore = opened;
  const db = new (loadHelper().Database)(dbPath);
  const again = await ingest(db, uplink(0));
  assert.equal(opened, openedBefore + 1, 'a new connection was opened');
  assert.equal(again.outcome, 'duplicate');
  const retransmission = await ingest(db, { ...uplink(0), eventId: '00000000-0000-4000-8000-000000000199' });
  assert.equal(retransmission.outcome, 'duplicate', 'same session, fCnt and payload within the replay window');
  assert.deepEqual(snapshot('SELECT COUNT(*) AS n FROM rain_observations'), [{ n: 22 }]);
  assert.deepEqual(snapshot("SELECT rain_received_mm FROM zone_daily_environment WHERE zone_id = 1 AND date = '2026-10-08'"), [{ rain_received_mm: 11 }]);
});
