#!/usr/bin/env node
'use strict';

// End-to-end contact contract: run the shipped function node against the real
// profile-3 helper, writer, calibration store, and SQLite schema. The cloud
// message is a contact-only projection; frame/calibration outcomes stay local.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const SEED_SQL = path.join(ROOT, 'database/seed-blank.sql');
const DB_HELPER_PATH = path.join(NR, 'osi-db-helper/index.js');
const MANIFEST = path.join(NR, 'edge-channels.json');
const writer = require(path.join(NR, 'osi-device-writer'));
const watermark = require(path.join(NR, 'osi-watermark-helper'));
const node = loadNode('watermark-ingest-fn');

const DEVICE = 'A84041A171000001';
const GATEWAY = '0016C001F1000003';
const CAL = {
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
};
const forbidden = new Set([
  'rawPayloadB64', 'payload_hex', 'fCnt', 'supply_mv', 'status_byte', 'soil_temp_c',
  'die_temp_c', 'channels', 'statuses', 'calibration_status', 'reject_reason',
  'conversion_version', 'calibration_sync_version',
]);

function sqlite3Adapter(native) {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') callback = mode;
      this.native = native;
      queueMicrotask(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); }
      catch (error) { callback.call(this, error); }
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
      } catch (error) { callback.call(this, error); }
    }
    exec(sql, callback) {
      try { this.native.exec(sql); callback.call(this, null); }
      catch (error) { callback.call(this, error); }
    }
    close(callback) { if (callback) callback.call(this, null); }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function realOsiDb(native) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) return sqlite3Adapter(native);
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally { Module._load = original; }
}

function freshDb() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(SEED_SQL, 'utf8'));
  const now = new Date().toISOString();
  native.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'contact-test', 'x', ?)").run(now);
  native.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, 'Contact fixture', 'DRAGINO_LSN50', 1, ?, ?)").run(DEVICE, now, now);
  writer.resetColumnCache();
  return native;
}

const word = (v) => [(v >> 8) & 255, v & 255];
function frameB64(p1 = [800, 3291], p2 = [71, 4058], { flags1 = 0x20, flags2 = 0x20, source = 2 } = {}) {
  return Buffer.from([0xA2, 3, ...word(3300), ...word(1988), ...word(2146), source, flags1,
    ...word(p1[0]), ...word(p1[0]), ...word(p1[1]), ...word(p1[1]), flags2,
    ...word(p2[0]), ...word(p2[0]), ...word(p2[1]), ...word(p2[1])]).toString('base64');
}

const manifestFs = Object.freeze({
  readFileSync(file, encoding) {
    if (file === '/srv/node-red/edge-channels.json') return fs.readFileSync(MANIFEST, encoding);
    throw new Error('unexpected manifest read: ' + file);
  },
});

async function runReal(native, payloadB64, label) {
  const result = await executeFunction(node, {
    msg: { formattedData: {
      isWatermark: true, devEui: DEVICE, timestamp: '2026-09-25T10:00:00Z',
      rawPayloadB64: payloadB64, fCnt: 7,
    } },
    env: { DEVICE_EUI: GATEWAY },
    globals: { fs: manifestFs },
    osiLibModules: { 'watermark-helper': watermark, 'device-writer': writer },
    libOverrides: { osiDb: realOsiDb(native) },
  });
  assert.deepEqual(result.errors, [], label + ': flow errors');
  assert.ok(result.result, label + ': no contact message');
  assert.equal(result.result.topic, 'devices/' + GATEWAY + '/telemetry');
  assert.equal(result.result.qos, 1);
  const payload = JSON.parse(result.result.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['deviceEui', 'deviceType', 'fPort', 'gatewayDeviceEui', 'timestamp'].sort(), label + ': contact shape');
  assert.deepEqual(payload, {
    deviceEui: DEVICE, gatewayDeviceEui: GATEWAY, deviceType: 'DRAGINO_LSN50', fPort: 11,
    timestamp: '2026-09-25T10:00:00.000Z',
  }, label + ': canonical contact');
  for (const key of Object.keys(payload)) assert.equal(forbidden.has(key), false, label + ': forbidden key ' + key);
}

async function runFallbackRejected(formattedData, label) {
  const result = await executeFunction(node, {
    msg: { formattedData }, env: { DEVICE_EUI: GATEWAY }, globals: { fs: manifestFs },
    osiLibModules: {
      'watermark-helper': { ingestProfile3: async () => ({ accepted: false, reason: 'frame_rejected' }) },
      'device-writer': { clampRecordedAt: (value) => ({ recordedAt: value }), writeDeviceData: async () => ({ inserted: false }) },
    },
    libOverrides: { osiDb: { Database: function Database() {
      return { get: async () => null, all: async () => [], run: async () => undefined, close(callback) { if (callback) callback(); } };
    } } },
  });
  assert.deepEqual(result.errors, [], label + ': flow errors');
  assert.equal(result.result, null, label + ': malformed attribution published contact');
}

(async () => {
  let native = freshDb();
  await runReal(native, frameB64(), 'accepted without calibration');
  let row = native.prepare('SELECT frame_status, ch1_status, ch2_status FROM watermark_readings').get();
  assert.deepEqual({ ...row }, { frame_status: 'accepted', ch1_status: 'calibration_required', ch2_status: 'calibration_required' });
  assert.equal(native.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 1);
  native.close();

  native = freshDb();
  const db = {
    get: async (sql, p) => native.prepare(sql).get(...(p || [])),
    all: async (sql, p) => native.prepare(sql).all(...(p || [])),
    run: async (sql, p) => { native.prepare(sql).run(...(p || [])); },
    transaction: async (fn) => fn({
      get: async (sql, p) => native.prepare(sql).get(...(p || [])),
      all: async (sql, p) => native.prepare(sql).all(...(p || [])),
      run: async (sql, p) => { native.prepare(sql).run(...(p || [])); },
    }),
  };
  await watermark.saveCalibration(db, { deveui: DEVICE, userId: 1, body: { ...CAL, expected_sync_version: 0 } });
  await runReal(native, frameB64(), 'accepted with calibration');
  row = native.prepare('SELECT frame_status, ch1_status, conversion_version FROM watermark_readings').get();
  assert.equal(row.frame_status, 'accepted');
  assert.equal(row.conversion_version, 'wm-lsn50-p3-v1');
  assert.equal(native.prepare('SELECT swt_1 FROM device_data').get().swt_1, 56.4);
  native.close();

  native = freshDb();
  await runReal(native, frameB64(undefined, undefined, { flags1: 0x21 }), 'accepted invalid channel');
  row = native.prepare('SELECT frame_status, ch1_status FROM watermark_readings').get();
  assert.deepEqual({ ...row }, { frame_status: 'accepted', ch1_status: 'invalid_sample' });
  native.close();

  native = freshDb();
  await runReal(native, Buffer.from(frameB64()).subarray(0, 5).toString('base64'), 'rejected frame');
  row = native.prepare('SELECT frame_status, reject_reason FROM watermark_readings').get();
  assert.deepEqual({ ...row }, { frame_status: 'frame_rejected', reject_reason: 'length' });
  assert.equal(native.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 0);
  native.close();

  await runFallbackRejected({ isWatermark: true, devEui: { raw: DEVICE }, timestamp: '2026-09-25T10:00:00Z' }, 'fallback child object');
  await runFallbackRejected({ isWatermark: true, devEui: DEVICE, timestamp: { raw: '2026-09-25T10:00:00Z' } }, 'fallback timestamp object');
  await runFallbackRejected({ isWatermark: true, devEui: DEVICE, timestamp: 'September 25, 2026 10:00 UTC' }, 'fallback non-ISO timestamp');
  console.log('PASS: WATERMARK contact payload uses real profile-3 outcomes and minimal attribution');
})().catch((error) => { console.error('FAIL: ' + error.stack); process.exitCode = 1; });
