#!/usr/bin/env node
'use strict';

// WATERMARK LSN50 (profile 3, FPort 11) flow gate. Runs the shipped
// function-node source from the canonical flows.json through
// scripts/lib/flow-node-harness.js:
//   lsn50-decode-fn        -- FPort 11 dispatch before timestamp parsing and
//                             the stock raw fallback; FPort 2 unchanged
//   lsn50-config-query-fn  -- drops WATERMARK messages
//   watermark-ingest-fn    -- osi-watermark-helper ingestProfile3 through the
//                             real osi-db-helper facade and osi-device-writer
//   d0b2b1c1a937e16d       -- scheduler SWT query: phase 1 interlock keeps
//                             WATERMARK observations out of irrigation
//   format-devices +       -- GET /api/devices: latest_data.watermark only when
//   merge-device-data         the device's latest observation is WATERMARK
//                             (case (l): frozen literal objects for six families)
//   8809bb5239dfb3d4       -- Build Telemetry (cloud MQTT mirror): drops FPort 11
//                             before the raw decoder; stock FPort 2 frozen golden
// The bcm2709 mirror is byte-identical (scripts/verify-profile-parity.js).
//
// Structure: small helpers, then CASES (a list of { name, run }). Later tasks
// append their cases to that list.
//
// Run: node scripts/test-watermark-ingest-flow.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, facadeDb, loadNode } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const FLOWS_REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const SEED_SQL = path.join(ROOT, 'database/seed-blank.sql');
const EDGE_MANIFEST = path.join(NR, 'edge-channels.json');
const DB_HELPER_PATH = path.join(NR, 'osi-db-helper', 'index.js');
const CODEC_PATH = path.join(NR, 'codecs/dragino_lsn50_decoder.js');
const BASE_REF = process.env.OSI_FLOWS_SIZE_BASE_REF || 'origin/main';

const writer = require(path.join(NR, 'osi-device-writer'));
const watermarkHelper = require(path.join(NR, 'osi-watermark-helper'));

const DEVEUI = 'A84041A171000001';
const LSN50_DEVICE_INFO = Object.freeze({
  deviceProfileName: 'OSI Dragino LSN50',
  deviceProfileId: 'profile-lsn50',
  devEui: DEVEUI.toLowerCase(),
});
const LSN50_ENV = Object.freeze({ CHIRPSTACK_PROFILE_LSN50: 'profile-lsn50' });

// ---------------------------------------------------------------- helpers --

function headNode(id) {
  return loadNode(id);
}

function baseNode(id) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', ROOT, 'show', BASE_REF + ':' + FLOWS_REL], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error('base ref unusable, failing closed: ' + BASE_REF + ':' + FLOWS_REL + ' (' + (e.stderr || e.message) + ')');
  }
  const node = JSON.parse(raw).find((n) => n.id === id);
  if (!node) throw new Error('node ' + id + ' missing at ' + BASE_REF);
  return node;
}

// uplink-dedup stubbed to "not a duplicate", identical for every run.
const NOT_DUPLICATE = Object.freeze({ isDuplicateUplink: () => false, warnOncePerWindow: () => {} });

function runDecode(node, payload, options = {}) {
  return executeFunction(node, {
    msg: { payload },
    env: LSN50_ENV,
    osiLibModules: { 'uplink-dedup': NOT_DUPLICATE },
    libOverrides: options.libOverrides || {},
  });
}

// A dendro helper that fails the test if the stock raw decode path runs.
function dendroSpy() {
  const calls = [];
  return {
    calls,
    helper: {
      decodeRawAdcPayload: (...args) => { calls.push(args); return null; },
      lsn50ModeLabel: () => null,
      toFiniteNumber: (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
    },
  };
}

// The ChirpStack-side codec, exactly as scripts/verify-lsn50-chameleon-codec.js
// loads it.
function codecObject(fPort, bytes) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODEC_PATH, 'utf8'), sandbox, { filename: CODEC_PATH });
  return JSON.parse(JSON.stringify(sandbox.decodeUplink({ fPort, bytes }).data));
}

const word = (v) => [(v >> 8) & 255, v & 255];
// 27-byte profile 3 frame (same layout as osi-watermark-helper/store.test.js).
function profile3Bytes(p1 = [800, 3291], p2 = [71, 4058], { soil = 1988, source = 2 } = {}) {
  return Buffer.from([0xA2, 3, ...word(3300), ...word(soil & 0xffff), ...word(2146), source, 0x20,
    ...word(p1[0]), ...word(p1[0]), ...word(p1[1]), ...word(p1[1]), 0x20,
    ...word(p2[0]), ...word(p2[0]), ...word(p2[1]), ...word(p2[1])]);
}

// node:sqlite-backed sqlite3 adapter (the osi-device-writer
// facade-contract.test.js pattern), bound to one pre-seeded in-memory
// DatabaseSync so the real osi-db-helper singleton opens exactly that DB
// whatever path the node passes ('/data/db/farming.db').
function sqlite3Adapter(native) {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
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

// A fresh copy of the real osi-db-helper (its shared connection is a module
// singleton) whose `require('sqlite3')` resolves to the adapter above.
function realOsiDb(native) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) return sqlite3Adapter(native);
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally {
    Module._load = original;
  }
}

// seed-blank.sql + one user + one DRAGINO_LSN50 device (store.test.js freshDb()).
function freshDb() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(SEED_SQL, 'utf8'));
  const now = new Date().toISOString();
  native.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'phil', 'x', ?)").run(now);
  native.prepare(
    "INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, 'Watermark 1+2', 'DRAGINO_LSN50', 1, ?, ?)"
  ).run(DEVEUI, now, now);
  writer.resetColumnCache();
  return native;
}

// global.get('fs') for the ingest node: the gateway manifest path resolves to
// the repo's edge-channels.json.
const manifestFs = Object.freeze({
  readFileSync: (p, enc) => {
    if (p === '/srv/node-red/edge-channels.json') return fs.readFileSync(EDGE_MANIFEST, enc);
    throw new Error('unexpected read in test: ' + p);
  },
});

function runIngest(msg, native) {
  let opened = 0;
  const osiDb = native
    ? realOsiDb(native)
    : { Database: function Database() { opened += 1; throw new Error('ingest opened the DB for a non-WATERMARK message'); } };
  return executeFunction(headNode('watermark-ingest-fn'), {
    msg,
    globals: { fs: manifestFs },
    osiLibModules: { 'watermark-helper': watermarkHelper, 'device-writer': writer },
    libOverrides: { osiDb },
  }).then((out) => Object.assign(out, { opened }));
}

function rows(native, sql, ...params) {
  return native.prepare(sql).all(...params).map((r) => ({ ...r }));
}

// ----------------------------------------------------------------- frames --
// Golden FPort 2 frames, copied from scripts/verify-lsn50-chameleon-codec.js.
const FPORT2_FRAMES = Object.freeze({
  'stock MOD3': [0x03, 0xf2, 0x07, 0xe4, 0x0b, 0xd6, 0x08, 0x12, 0x34, 0x00, 0x00, 0x21],
  'Chameleon V1': [
    0x03, 0xf2, 0x07, 0xe4, 0x0b, 0xd6, 0x08, 0x21, 0x01, 0x00, 0x07, 0xc3,
    0x00, 0x00, 0x04, 0x4c, 0x00, 0x00, 0x27, 0x74, 0x00, 0x01, 0x8b, 0x50,
    0x00, 0x00, 0x04, 0xb0, 0x00, 0x00, 0x27, 0xd8, 0x00, 0x01, 0x8f, 0x38,
    0x28, 0x6d, 0x6a, 0xdb, 0x0f, 0x00, 0x00, 0xf1,
  ],
  'Chameleon V2': [
    0x03, 0xf2, 0x07, 0xe4, 0x0b, 0xd6, 0x08, 0x21, 0x02, 0x00, 0x07, 0xc3,
    0x00, 0x00, 0x04, 0x4c, 0x00, 0x00, 0x27, 0x74, 0x00, 0x01, 0x8b, 0x50,
    0x28, 0x6d, 0x6a, 0xdb, 0x0f, 0x00, 0x00, 0xf1,
  ],
});

// Literal golden `formattedData` for each FPORT2_FRAMES fixture, captured
// once from a passing HEAD run (deterministic given the fixed `time` above).
// Case (b) below asserts HEAD deepEquals these directly, so the guarantee
// that FPort 2 is untouched survives after this branch merges and the
// `BASE_REF` comparison in the same case becomes a tautology.
const FPORT2_GOLDEN_FORMATTED_DATA = Object.freeze({
  'stock MOD3': {
    timestamp: '2026-09-25T10:00:00.000Z', devEui: DEVEUI, tempC1: 202, batV: 3.3,
    adcV: 1.01, adcCh1V: 2.02, adcCh4V: 3.03, positionMm: null, positionUm: null,
    dendroValid: null, deltaMm: null, dendroRatio: null, dendroModeUsed: null,
    dendroStemChangeUm: null, dendroCalibrationMissing: false, temp2: null, temp3: null,
    rainCountCumulative: null, rainTipsDelta: null, rainMmDelta: null,
    flowCountCumulative: null, flowPulsesDelta: null, flowLitersDelta: null,
    detectedMode: 1, configuredMode: 1, observedModeCode: 3, observedModeLabel: 'MOD3',
    observedModeObservedAt: '2026-09-25T10:00:00.000Z', modeCodeToStore: 3, modeLabelToStore: 'MOD3',
  },
  'Chameleon V1': {
    timestamp: '2026-09-25T10:00:00.000Z', devEui: DEVEUI, tempC1: 202, batV: 3.3,
    adcV: 1.01, adcCh1V: 2.02, adcCh4V: 3.03, positionMm: null, positionUm: null,
    dendroValid: null, deltaMm: null, dendroRatio: null, dendroModeUsed: null,
    dendroStemChangeUm: null, dendroCalibrationMissing: false, temp2: null, temp3: null,
    rainCountCumulative: null, rainTipsDelta: null, rainMmDelta: null,
    flowCountCumulative: null, flowPulsesDelta: null, flowLitersDelta: null,
    detectedMode: 1, configuredMode: 1, observedModeCode: 3, observedModeLabel: 'MOD3',
    observedModeObservedAt: '2026-09-25T10:00:00.000Z', modeCodeToStore: 3, modeLabelToStore: 'MOD3',
    isChameleon: true, chameleonPayloadVersion: 1, chameleonStatusFlags: 0, chameleonCompPending: 0,
    chameleonDataInvalid: null, chameleonI2cMissing: 0, chameleonTimeout: 0, chameleonTempFault: 0,
    chameleonIdFault: 0, chameleonCh1Open: 0, chameleonCh2Open: 0, chameleonCh3Open: 0,
    chameleonTempC: 19.87, chameleonR1OhmComp: 1100, chameleonR2OhmComp: 10100, chameleonR3OhmComp: 101200,
    chameleonR1OhmRaw: 1200, chameleonR2OhmRaw: 10200, chameleonR3OhmRaw: 102200,
    chameleonArrayId: '286D6ADB0F0000F1',
    rawPayloadB64: 'A/IH5AvWCCEBAAfDAAAETAAAJ3QAAYtQAAAEsAAAJ9gAAY84KG1q2w8AAPE=',
    fPort: 2, fCnt: 41,
  },
  'Chameleon V2': {
    timestamp: '2026-09-25T10:00:00.000Z', devEui: DEVEUI, tempC1: 202, batV: 3.3,
    adcV: 1.01, adcCh1V: 2.02, adcCh4V: 3.03, positionMm: null, positionUm: null,
    dendroValid: null, deltaMm: null, dendroRatio: null, dendroModeUsed: null,
    dendroStemChangeUm: null, dendroCalibrationMissing: false, temp2: null, temp3: null,
    rainCountCumulative: null, rainTipsDelta: null, rainMmDelta: null,
    flowCountCumulative: null, flowPulsesDelta: null, flowLitersDelta: null,
    detectedMode: 1, configuredMode: 1, observedModeCode: 3, observedModeLabel: 'MOD3',
    observedModeObservedAt: '2026-09-25T10:00:00.000Z', modeCodeToStore: 3, modeLabelToStore: 'MOD3',
    isChameleon: true, chameleonPayloadVersion: 2, chameleonStatusFlags: 0, chameleonCompPending: 0,
    chameleonDataInvalid: 0, chameleonI2cMissing: null, chameleonTimeout: null, chameleonTempFault: 0,
    chameleonIdFault: 0, chameleonCh1Open: 0, chameleonCh2Open: 0, chameleonCh3Open: 0,
    chameleonTempC: 19.87, chameleonR1OhmComp: 1100, chameleonR2OhmComp: 10100, chameleonR3OhmComp: 101200,
    chameleonR1OhmRaw: null, chameleonR2OhmRaw: null, chameleonR3OhmRaw: null,
    chameleonArrayId: '286D6ADB0F0000F1',
    rawPayloadB64: 'A/IH5AvWCCECAAfDAAAETAAAJ3QAAYtQKG1q2w8AAPE=',
    fPort: 2, fCnt: 41,
  },
});

function fport2Uplink(bytes) {
  return {
    deviceInfo: { ...LSN50_DEVICE_INFO },
    deduplicationId: 'dedup-fport2',
    fPort: 2,
    fCnt: 41,
    time: '2026-09-25T10:00:00Z',
    data: Buffer.from(bytes).toString('base64'),
    object: codecObject(2, bytes),
  };
}

// ------------------------------------------------------------------ cases --

const CASES = [
  {
    name: 'wiring: decode fans out to config query and watermark-ingest-fn; ingest publishes one contact message',
    async run() {
      assert.deepEqual(headNode('lsn50-decode-fn').wires, [['lsn50-config-query-fn', 'watermark-ingest-fn']]);
      const ingest = headNode('watermark-ingest-fn');
      assert.equal(ingest.type, 'function');
      assert.equal(ingest.z, 'lsn50-tab');
      assert.equal(ingest.outputs, 1);
      assert.deepEqual(ingest.wires, [['9b38464d56b05ae0']]);
    },
  },
  {
    name: '(a) FPort 11 decode yields exactly the WATERMARK dispatch and never runs the stock raw decode',
    async run() {
      const b64 = profile3Bytes().toString('base64');
      const spy = dendroSpy();
      const out = await runDecode(headNode('lsn50-decode-fn'), {
        deviceInfo: { ...LSN50_DEVICE_INFO },
        deduplicationId: 'dedup-a',
        fPort: 11,
        fCnt: 7,
        time: '2026-09-25T10:00:00Z',
        data: b64,
        object: codecObject(11, [...profile3Bytes()]),
      }, { libOverrides: { dendro: spy.helper } });
      assert.deepEqual(out.errors, []);
      assert.ok(out.result, 'decode returned null for an FPort 11 uplink');
      assert.deepEqual(out.result.formattedData, {
        isWatermark: true,
        devEui: DEVEUI,
        timestamp: '2026-09-25T10:00:00Z',
        rawPayloadB64: b64,
        fCnt: 7,
      });
      assert.equal(spy.calls.length, 0, 'dendro.decodeRawAdcPayload ran for an FPort 11 uplink');
    },
  },
  {
    name: '(b) FPort 2 stock + Chameleon V1/V2: formattedData identical to ' + BASE_REF + ', nothing reaches watermark-ingest-fn',
    async run() {
      const head = headNode('lsn50-decode-fn');
      const base = baseNode('lsn50-decode-fn');
      for (const [label, bytes] of Object.entries(FPORT2_FRAMES)) {
        const headOut = await runDecode(head, fport2Uplink(bytes));
        const baseOut = await runDecode(base, fport2Uplink(bytes));
        assert.deepEqual(headOut.errors, [], label + ': head decode errors');
        assert.deepEqual(baseOut.errors, [], label + ': base decode errors');
        assert.ok(baseOut.result && baseOut.result.formattedData, label + ': base produced no formattedData');
        assert.deepEqual(headOut.result.formattedData, baseOut.result.formattedData, label + ': formattedData drifted from ' + BASE_REF);
        // Frozen golden, independent of BASE_REF: once this branch merges,
        // BASE_REF *is* HEAD and the comparison above stops proving anything.
        assert.deepEqual(headOut.result.formattedData, FPORT2_GOLDEN_FORMATTED_DATA[label], label + ': formattedData drifted from the frozen golden');
        assert.equal(headOut.result.formattedData.isWatermark, undefined, label + ': FPort 2 marked as WATERMARK');
        const ingest = await runIngest(headOut.result, null);
        assert.equal(ingest.result, null, label + ': watermark-ingest-fn acted on an FPort 2 message');
        assert.equal(ingest.opened, 0, label + ': watermark-ingest-fn opened the DB for an FPort 2 message');
      }
      const chameleonV1 = (await runDecode(head, fport2Uplink(FPORT2_FRAMES['Chameleon V1']))).result.formattedData;
      assert.equal(chameleonV1.isChameleon, true, 'fixture sanity: Chameleon V1 decoded as Chameleon');
    },
  },
  {
    name: '(c) lsn50-config-query-fn drops a WATERMARK message and still queries for a stock one',
    async run() {
      const node = headNode('lsn50-config-query-fn');
      const dropped = await executeFunction(node, { msg: { formattedData: { isWatermark: true, devEui: DEVEUI } } });
      assert.equal(dropped.result, null);
      assert.deepEqual(dropped.errors, []);
      const kept = await executeFunction(node, { msg: { formattedData: { devEui: DEVEUI } } });
      assert.ok(kept.result && /FROM devices/.test(kept.result.topic), 'stock message lost its config query');
    },
  },
  {
    name: '(d) watermark-ingest-fn: null for non-WATERMARK; one device_data + one linked watermark_readings row for WATERMARK',
    async run() {
      const native = freshDb();
      const skip = await runIngest({ formattedData: { devEui: DEVEUI, timestamp: '2026-09-25T10:00:00Z' } }, native);
      assert.equal(skip.result, null);
      assert.equal(rows(native, 'SELECT COUNT(*) AS n FROM device_data')[0].n, 0);

      const recordedAt = new Date(Date.now() - 3600e3).toISOString();
      const out = await runIngest({
        formattedData: { isWatermark: true, devEui: DEVEUI, timestamp: recordedAt, rawPayloadB64: profile3Bytes().toString('base64'), fCnt: 7 },
      }, native);
      assert.equal(out.result, null);
      assert.deepEqual(out.errors, []);
      assert.deepEqual(out.warnings, []);
      const dd = rows(native, 'SELECT id, recorded_at, ext_temperature_c, bat_v FROM device_data WHERE deveui = ?', DEVEUI);
      const wr = rows(native, 'SELECT device_data_id, recorded_at, frame_status, f_cnt FROM watermark_readings WHERE deveui = ?', DEVEUI);
      assert.equal(dd.length, 1, 'expected one device_data row');
      assert.equal(wr.length, 1, 'expected one watermark_readings row');
      assert.equal(wr[0].device_data_id, dd[0].id, 'watermark_readings.device_data_id must equal device_data.id');
      assert.equal(dd[0].recorded_at, recordedAt);
      assert.equal(wr[0].recorded_at, recordedAt);
      assert.equal(wr[0].frame_status, 'accepted');
      assert.equal(wr[0].f_cnt, 7);
      assert.equal(dd[0].ext_temperature_c, 19.88);
      assert.equal(dd[0].bat_v, null);
      native.close();
    },
  },
  {
    name: '(e) FPort 11 with an unparseable time: decode + ingest store both rows at the same clamped, valid recorded_at',
    async run() {
      const native = freshDb();
      const spy = dendroSpy();
      const before = Date.now();
      const decoded = await runDecode(headNode('lsn50-decode-fn'), {
        deviceInfo: { ...LSN50_DEVICE_INFO },
        deduplicationId: 'dedup-e',
        fPort: 11,
        fCnt: 8,
        time: 'not-a-date',
        data: profile3Bytes().toString('base64'),
      }, { libOverrides: { dendro: spy.helper } });
      assert.deepEqual(decoded.errors, [], 'decode threw on the unparseable time');
      assert.ok(decoded.result && decoded.result.formattedData, 'decode dropped the frame');
      assert.equal(decoded.result.formattedData.timestamp, 'not-a-date', 'decode must pass the raw time; the helper clamps');

      const out = await runIngest(decoded.result, native);
      const after = Date.now();
      assert.deepEqual(out.errors, []);
      const dd = rows(native, 'SELECT id, recorded_at FROM device_data WHERE deveui = ?', DEVEUI);
      const wr = rows(native, 'SELECT device_data_id, recorded_at FROM watermark_readings WHERE deveui = ?', DEVEUI);
      assert.equal(dd.length, 1, 'expected one device_data row');
      assert.equal(wr.length, 1, 'expected one watermark_readings row');
      assert.equal(wr[0].device_data_id, dd[0].id);
      assert.equal(dd[0].recorded_at, wr[0].recorded_at, 'both rows must carry the same recorded_at');
      const t = Date.parse(dd[0].recorded_at);
      assert.ok(Number.isFinite(t) && t >= before - 1000 && t <= after + 1000, 'recorded_at is not the clamped now: ' + dd[0].recorded_at);
      assert.equal(new Date(t).toISOString(), dd[0].recorded_at, 'recorded_at is not canonical ISO');
      native.close();
    },
  },
];

// ------------------------------------------------------- scheduler cases --
// Task 6: the phase 1 interlock in the scheduler query node. WATERMARK
// observations never drive irrigation, whatever the device flags say.

const SCHEDULER_QUERY_ID = 'd0b2b1c1a937e16d';
const INTERLOCK_LINE = '    AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)';

// seed-blank.sql + one zone holding the DRAGINO_LSN50 with chameleon_enabled = 1,
// and two device_data rows in the last hour: A (swt_1 = 60, WATERMARK, linked
// from watermark_readings.device_data_id) and B (swt_1 = 30, Chameleon, no
// WATERMARK row). A's watermark_readings row is written after A with an
// earlier recorded_at, the shape a calibration backfill leaves.
function schedulerDb() {
  const native = freshDb();
  const zoneId = Number(native.prepare(
    "INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z WM', 1, 'z-wm', 'UTC', 'local')"
  ).run().lastInsertRowid);
  native.prepare('UPDATE devices SET irrigation_zone_id = ?, chameleon_enabled = 1 WHERE deveui = ?').run(zoneId, DEVEUI);
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60e3).toISOString();
  const insertDd = native.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, ?)');
  const rowA = Number(insertDd.run(DEVEUI, at(40), 60).lastInsertRowid);
  const rowB = Number(insertDd.run(DEVEUI, at(20), 30).lastInsertRowid);
  native.prepare(
    "INSERT INTO watermark_readings (deveui, recorded_at, device_data_id, payload_hex, frame_status, conversion_version) VALUES (?, ?, ?, 'a203', 'accepted', 'wm-lsn50-p3-v1')"
  ).run(DEVEUI, at(40), rowA);
  return { native, zoneId, rowA, rowB };
}

async function schedulerTopic(node, zone) {
  const out = await executeFunction(node, { msg: { payload: zone } });
  assert.deepEqual(out.errors, []);
  assert.ok(out.result && typeof out.result.topic === 'string', 'scheduler query node built no topic');
  return out.result.topic;
}

for (const metric of ['SWT_1', 'SWT_AVG']) {
  CASES.push({
    name: '(f) scheduler ' + metric + ': a WATERMARK observation never counts, the Chameleon row on the same chameleon_enabled device still does',
    async run() {
      const { native, zoneId } = schedulerDb();
      const topic = await schedulerTopic(headNode(SCHEDULER_QUERY_ID), { zone_id: zoneId, trigger_metric: metric });
      const [row] = rows(native, topic);
      assert.equal(row.n_points, 1, metric + ': n_points');
      assert.equal(row.mean_kpa, 30, metric + ': mean_kpa');
      native.close();
    },
  });
}

CASES.push({
  name: '(g) scheduler query: the interlock line is the only change vs ' + BASE_REF + ' for every metric, DENDRO included',
  async run() {
    const head = headNode(SCHEDULER_QUERY_ID);
    const base = baseNode(SCHEDULER_QUERY_ID);
    const iso = /'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'/g;
    for (const metric of ['SWT_1', 'SWT_2', 'SWT_3', 'SWT_AVG', 'SWT_WM1', 'SWT_WM2', 'SWT_WM3', 'DENDRO']) {
      const zone = { zone_id: 7, trigger_metric: metric };
      const headTopic = (await schedulerTopic(head, zone)).replace(iso, "'<cutoff>'");
      const baseTopic = (await schedulerTopic(base, zone)).replace(iso, "'<cutoff>'");
      const lines = headTopic.split('\n');
      // Literal, independent of BASE_REF: INTERLOCK_LINE is a fixed string
      // constant (not derived from the base node), so this count still means
      // something once this branch merges and BASE_REF becomes HEAD.
      const interlock = lines.filter((l) => l === INTERLOCK_LINE).length;
      assert.equal(interlock, metric === 'DENDRO' ? 0 : 1, metric + ': interlock line count');
      // Filter both sides so the case still holds once BASE_REF carries the interlock itself.
      // Once this branch merges, BASE_REF *is* HEAD and this half of the
      // assertion becomes a freeze on the query text rather than a diff
      // against a known-good prior state — the literal interlock count above
      // is what keeps catching a real regression from that point on.
      const without = (topic) => topic.split('\n').filter((l) => l !== INTERLOCK_LINE).join('\n');
      assert.equal(without(headTopic), without(baseTopic), metric + ': query drifted beyond the interlock line');
    }
  },
});

// ----------------------------------------------------- device list cases --
// Task 8: GET /api/devices (format-devices -> SQL -> merge-device-data)
// carries latest_data.watermark only when the device's LATEST device_data row
// is a WATERMARK observation (Review Focus 4).

const DEV_A = DEVEUI; // latest observation is WATERMARK
const DEV_B = 'A84041A171000043'; // older stock row, newer frame_rejected raw row
const DEV_C = 'A84041A171000044'; // WATERMARK, then a newer Chameleon observation (board swap)
const DEV_D = 'A84041A171000045'; // stock LSN50 rows only, never WATERMARK
const DEV_E = 'A84041A171000046'; // registered, no observation at all

async function deviceListDb() {
  const native = freshDb();
  const now = new Date().toISOString();
  const insertDevice = native.prepare(
    "INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, ?, 'DRAGINO_LSN50', 1, ?, ?)"
  );
  for (const [eui, name] of [[DEV_B, 'B'], [DEV_C, 'C'], [DEV_D, 'D'], [DEV_E, 'E']]) insertDevice.run(eui, name, now, now);
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60e3).toISOString();
  const insertDd = native.prepare('INSERT INTO device_data (deveui, recorded_at, swt_1, swt_2, swt_3, ext_temperature_c, bat_v) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ingest = async (eui, minutesAgo, bytes) => {
    const out = await runIngest({
      formattedData: { isWatermark: true, devEui: eui, timestamp: at(minutesAgo), rawPayloadB64: Buffer.from(bytes).toString('base64'), fCnt: 3 },
    }, native);
    assert.deepEqual(out.errors, [], eui + ': ingest errors');
  };

  // A is calibrated (the osi-watermark-helper store.test.js values), so its
  // channel 2 (71/4058 counts, a probe in water) reads 'saturated'.
  await watermarkHelper.saveCalibration(facadeDb(native), {
    deveui: DEV_A,
    userId: 1,
    body: {
      pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
      pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
      expected_sync_version: 0,
    },
  });
  await ingest(DEV_A, 90, profile3Bytes([800, 3291], [4058, 4058]));
  await ingest(DEV_A, 30, profile3Bytes());

  insertDd.run(DEV_B, at(120), null, null, null, 18.5, 3.61);
  // 5 of the 27 profile 3 bytes: parseProfile3 rejects it with reason 'length'.
  await ingest(DEV_B, 30, profile3Bytes().subarray(0, 5));

  await ingest(DEV_C, 120, profile3Bytes());
  insertDd.run(DEV_C, at(30), 22.5, 41.25, 60, null, 3.58);
  native.prepare(
    "INSERT INTO chameleon_readings (deveui, recorded_at, payload_version, status_flags, temp_c, r1_ohm_comp, r2_ohm_comp, r3_ohm_comp, array_id) VALUES (?, ?, 2, 0, 19.4, 1100, 2400, 5200, 'arr-c')"
  ).run(DEV_C, at(30));

  insertDd.run(DEV_D, at(200), 12, 14, null, 17.25, 3.6);
  insertDd.run(DEV_D, at(20), 13, 15, null, 17.5, 3.59);

  // Fixture sanity: the shapes the three cases rely on.
  const wrB = rows(native, 'SELECT frame_status, reject_reason, device_data_id FROM watermark_readings WHERE deveui = ?', DEV_B);
  assert.deepEqual(wrB, [{ frame_status: 'frame_rejected', reject_reason: 'length', device_data_id: null }], 'fixture: B holds one frame_rejected raw row');
  assert.equal(rows(native, 'SELECT COUNT(*) AS n FROM watermark_readings WHERE deveui = ? AND device_data_id IS NOT NULL', DEV_C)[0].n, 1, 'fixture: C holds one linked WATERMARK row');
  return native;
}

// format-devices -> its SQL (msg.topic) against the DB -> merge-device-data,
// exactly as the Get Devices route chains them.
async function deviceList(native, formatNode, mergeNode) {
  const deviceRows = rows(native, 'SELECT * FROM devices ORDER BY deveui');
  const formatted = await executeFunction(formatNode, { msg: { payload: deviceRows } });
  assert.deepEqual(formatted.errors, [], 'format-devices errors');
  const latest = rows(native, formatted.result.topic);
  const merged = await executeFunction(mergeNode, {
    msg: { devices_to_format: formatted.result.devices_to_format, payload: latest },
    osiLibModules: { 'sdi12-commissioning': { projectDeployment: () => null } },
    libOverrides: { osiDb: { Database: function Database() { throw new Error('merge-device-data opened the DB without an S2120'); } } },
  });
  assert.deepEqual(merged.errors, [], 'merge-device-data errors');
  assert.deepEqual(merged.warnings, [], 'merge-device-data warnings');
  return new Map(merged.result.payload.map((d) => [d.deveui, d]));
}

CASES.push({
  name: '(h) device list: latest_data.watermark only for a device whose latest observation is WATERMARK (A object; B rejected-only, C board swap, D stock, E empty -> null)',
  async run() {
    const native = await deviceListDb();
    const list = await deviceList(native, headNode('format-devices'), headNode('merge-device-data'));

    const a = list.get(DEV_A).latest_data.watermark;
    assert.ok(a && typeof a === 'object', 'A: watermark missing');
    const [wrA] = rows(native,
      'SELECT wr.* FROM watermark_readings wr JOIN device_data dd ON dd.id = wr.device_data_id WHERE wr.deveui = ? ORDER BY dd.recorded_at DESC LIMIT 1', DEV_A);
    assert.equal(a.recorded_at, wrA.recorded_at, 'A: watermark is not the latest observation');
    assert.equal(a.recorded_at, list.get(DEV_A).last_seen, 'A: watermark recorded_at differs from last_seen');
    assert.deepEqual(Object.keys(a), ['recorded_at', 'supply_mv', 'soil_temp_c', 'soil_temp_source', 'die_temp_c', 'channels']);
    assert.equal(a.supply_mv, wrA.supply_mv);
    assert.equal(a.soil_temp_c, wrA.soil_temp_c);
    assert.equal(a.soil_temp_source, wrA.soil_temp_source);
    assert.equal(a.die_temp_c, wrA.die_temp_c);
    assert.equal(a.channels.length, 2);
    a.channels.forEach((ch, i) => {
      const p = 'ch' + (i + 1) + '_';
      assert.deepEqual(ch, {
        status: wrA[p + 'status'], kpa: wrA[p + 'kpa'], kpa_upper_bound: wrA[p + 'kpa_upper_bound'],
        r_solved: wrA[p + 'r_solved'], r_upper_bound: wrA[p + 'r_upper_bound'], offset_mv: wrA[p + 'offset_mv'],
      }, 'A: channel ' + (i + 1));
    });
    assert.equal(a.channels[1].status, 'saturated');

    for (const eui of [DEV_B, DEV_C, DEV_D, DEV_E]) {
      assert.ok(list.has(eui), eui + ': missing from the device list');
      assert.equal(list.get(eui).latest_data.watermark, null, eui + ': watermark must be null');
    }
    assert.equal(list.get(DEV_C).latest_data.swt_1, 22.5, 'C: the newer Chameleon observation is the latest');
    native.close();
  },
});

CASES.push({
  name: '(i) device list: apart from latest_data.watermark, every device is identical to ' + BASE_REF + '\'s format-devices + merge-device-data',
  async run() {
    const native = await deviceListDb();
    const head = await deviceList(native, headNode('format-devices'), headNode('merge-device-data'));
    const base = await deviceList(native, baseNode('format-devices'), baseNode('merge-device-data'));
    assert.deepEqual([...head.keys()], [...base.keys()]);
    for (const [eui, device] of head) {
      assert.ok(Object.prototype.hasOwnProperty.call(device.latest_data, 'watermark'), eui + ': latest_data.watermark key missing');
      // Strip both sides so the case still holds once BASE_REF carries latest_data.watermark itself.
      // Once this branch merges, BASE_REF *is* HEAD and this comparison
      // becomes a freeze on the whole device-list shape rather than a diff
      // against a known-good prior state — the literal DEV_C assertions
      // below are what keeps catching a real board-swap regression, and
      // case (l) pins complete device objects for six families.
      const withoutWatermark = (d) => {
        const { watermark, ...rest } = d.latest_data;
        return { ...d, latest_data: rest };
      };
      assert.deepEqual(withoutWatermark(device), withoutWatermark(base.get(eui)), eui + ': device drifted from ' + BASE_REF + ' beyond latest_data.watermark');
    }
    // Sanity: the comparison covers real values, not a list of empty rows.
    assert.equal(head.get(DEV_D).latest_data.swt_1, 13);
    assert.equal(head.get(DEV_C).latest_data.chameleon_array_id, 'arr-c');
    // Literal, independent of BASE_REF: DEV_C is the board-swap fixture
    // (WATERMARK observation, then a newer Chameleon observation) — the
    // interlock must keep hiding the stale watermark object while the
    // Chameleon-derived swt_1 remains the latest value.
    assert.equal(head.get(DEV_C).latest_data.watermark, null, 'DEV_C: watermark must be null after the board swap');
    assert.equal(head.get(DEV_C).latest_data.swt_1, 22.5, 'DEV_C: swt_1 must be the newer Chameleon observation');
    native.close();
  },
});

// ----------------------------------------------------- telemetry cases --
// External final review: Build Telemetry (8809bb5239dfb3d4, fed by its own
// mqtt-in on application/+/device/+/event/up) mirrors every uplink to the
// cloud over MQTT and ran the stock raw decoder on FPort 11 frames (330 degC,
// 41.5 V, invented ADC). It now drops WATERMARK frames before any decoding;
// WATERMARK MQTT telemetry is phase 2 (the cloud gets device_data by sync).

const BUILD_TELEMETRY_ID = '8809bb5239dfb3d4';
const TELEMETRY_ENV = Object.freeze({ ...LSN50_ENV, DEVICE_EUI: '0016C001F1000003' });

// freshDb() with the external temperature probe enabled, so a misdecoded
// frame would surface as a temperature too, not only as battery and ADC.
function telemetryDb() {
  const native = freshDb();
  native.prepare('UPDATE devices SET temp_enabled = 1 WHERE deveui = ?').run(DEVEUI);
  return native;
}

// Literal golden MQTT payload for the FPORT2_FRAMES 'stock MOD3' uplink on
// telemetryDb(), captured once from a passing HEAD run (deterministic: fixed
// `time`, fixed DEVICE_EUI, fresh flow state).
const BUILD_TELEMETRY_STOCK_GOLDEN = Object.freeze({
  topic: 'devices/0016C001F1000003/telemetry',
  qos: 1,
  payload: {
    deviceEui: DEVEUI, deviceType: 'DRAGINO_LSN50', timestamp: '2026-09-25T10:00:00Z',
    swt_wm1: null, swt_wm2: null, light_lux: null, ambient_temperature: null, relative_humidity: null,
    ext_temperature_c: 202, bat_v: 3.3, adc_ch0v: 1.01, adc_ch1v: 2.02,
    dendro_ratio: null, dendro_mode_used: null, dendro_position_raw_mm: null, dendro_position_mm: null,
    dendro_delta_mm: null, dendro_stem_change_um: null, dendro_valid: null, dendro_saturated: 0,
    dendro_saturation_side: null, lsn50_mode_code: 3, lsn50_mode_label: 'MOD3',
    lsn50_mode_observed_at: '2026-09-25T10:00:00Z', chameleon_enabled: 0,
    chameleon_swt1_depth_cm: null, chameleon_swt2_depth_cm: null, chameleon_swt3_depth_cm: null,
  },
});

CASES.push({
  name: '(j) Build Telemetry: an FPort 11 uplink is dropped before any decoding or DB access',
  async run() {
    const spy = dendroSpy();
    let opened = 0;
    const out = await executeFunction(headNode(BUILD_TELEMETRY_ID), {
      msg: {
        payload: {
          deviceInfo: { ...LSN50_DEVICE_INFO },
          deduplicationId: 'dedup-j',
          fPort: 11,
          fCnt: 7,
          time: '2026-09-25T10:00:00Z',
          data: profile3Bytes().toString('base64'),
          object: codecObject(11, [...profile3Bytes()]),
        },
      },
      env: TELEMETRY_ENV,
      libOverrides: {
        dendro: spy.helper,
        osiDb: { Database: function Database() { opened += 1; throw new Error('Build Telemetry opened the DB for an FPort 11 uplink'); } },
      },
    });
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.result, null, 'Build Telemetry published an FPort 11 uplink');
    assert.equal(spy.calls.length, 0, 'dendro.decodeRawAdcPayload ran for an FPort 11 uplink');
    assert.equal(opened, 0);
  },
});

CASES.push({
  name: '(k) Build Telemetry: a stock FPort 2 uplink publishes the frozen golden telemetry, identical to ' + BASE_REF,
  async run() {
    const publish = async (node) => {
      const native = telemetryDb();
      const out = await executeFunction(node, {
        msg: { payload: fport2Uplink(FPORT2_FRAMES['stock MOD3']) },
        env: TELEMETRY_ENV,
        db: native,
      });
      native.close();
      assert.deepEqual(out.errors, []);
      assert.deepEqual(out.warnings, []);
      assert.ok(out.result, 'Build Telemetry dropped a stock FPort 2 uplink');
      return { topic: out.result.topic, qos: out.result.qos, payload: JSON.parse(out.result.payload) };
    };
    const head = await publish(headNode(BUILD_TELEMETRY_ID));
    // Frozen literal: still meaningful after merge, when BASE_REF is HEAD.
    assert.deepEqual(head, BUILD_TELEMETRY_STOCK_GOLDEN);
    assert.deepEqual(head, await publish(baseNode(BUILD_TELEMETRY_ID)), 'drifted from ' + BASE_REF);
  },
});

// -------------------------------------------- device list golden cases --
// External final review: case (i) compares HEAD with BASE_REF, two moving
// implementations; a mutation that nulled every device's bat_v in both passed
// it, and every fixture was an LSN50. Case (l) pins the complete GET
// /api/devices object for one device of each representative family against
// frozen literals, independent of any git ref. Every timestamp in the
// fixture is fixed, so the output is a pure function of this file.

const GOLDEN = Object.freeze({
  STOCK: 'A84041A171000050',
  CHAMELEON: 'A84041A171000051',
  WATERMARK: 'A84041A171000052',
  KIWI: '0004A30B00000001',
  SDI12: 'A84041A171000053',
  S2120: '2CF7F1C000000001',
});

async function goldenDeviceListDb() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(SEED_SQL, 'utf8'));
  writer.resetColumnCache();
  const created = '2026-09-01T08:00:00.000Z';
  native.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'phil', 'x', ?)").run(created);
  native.prepare("INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, created_at, updated_at) VALUES (4, 'North block', 1, 'zone-north', ?, ?)").run(created, created);
  const device = (eui, name, type, extra = {}) => {
    const cols = ['deveui', 'name', 'type_id', 'user_id', 'created_at', 'updated_at', 'sync_version', ...Object.keys(extra)];
    const vals = [eui, name, type, 1, created, '2026-09-02T09:00:00.000Z', 3, ...Object.values(extra)];
    native.prepare('INSERT INTO devices (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')').run(...vals);
  };
  device(GOLDEN.STOCK, 'Stock dendro', 'DRAGINO_LSN50', { irrigation_zone_id: 4, temp_enabled: 1, dendro_enabled: 1, device_mode: 3, dendro_stroke_mm: 10 });
  device(GOLDEN.CHAMELEON, 'Chameleon array', 'DRAGINO_LSN50', { chameleon_enabled: 1, chameleon_swt1_depth_cm: 20, chameleon_swt2_depth_cm: 40, chameleon_swt3_depth_cm: 60 });
  device(GOLDEN.WATERMARK, 'Watermark 1+2', 'DRAGINO_LSN50', { soil_moisture_probe_depths_json: '{"swt_1":25,"swt_2":50}', soil_moisture_probe_depths_configured: 1 });
  device(GOLDEN.KIWI, 'Kiwi row 3', 'KIWI_SENSOR', { irrigation_zone_id: 4, gateway_device_eui: '0016C001F1000003' });
  device(GOLDEN.SDI12, 'Sentek 60', 'DRAGINO_SDI12', {
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: 'identified', sdi12_identity: '013SENTEK EVS60',
    sdi12_value_count: 6, sdi12_channel_layout_json: '{"vwc":[1,2,3],"soil_temp":[4,5,6]}',
  });
  device(GOLDEN.S2120, 'Weather station', 'SENSECAP_S2120');
  native.prepare('INSERT INTO weather_station_zones (deveui, zone_id, created_at) VALUES (?, 4, ?)').run(GOLDEN.S2120, created);

  const insertDd = (eui, recordedAt, values) => {
    const cols = ['deveui', 'recorded_at', ...Object.keys(values)];
    native.prepare('INSERT INTO device_data (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')')
      .run(eui, recordedAt, ...Object.values(values));
  };
  // Stock LSN50 (MOD3 dendrometer + probe): an older row, then the latest.
  insertDd(GOLDEN.STOCK, '2026-09-24T09:00:00.000Z', { ext_temperature_c: 16.5, bat_v: 3.61, adc_ch0v: 1.2 });
  insertDd(GOLDEN.STOCK, '2026-09-24T10:00:00.000Z', {
    ext_temperature_c: 17.25, bat_v: 3.6, adc_ch0v: 1.234, adc_ch1v: 2.468, dendro_ratio: 0.5, dendro_mode_used: 'ratio',
    dendro_position_raw_mm: 5.01, dendro_position_mm: 5, dendro_valid: 1, dendro_delta_mm: -0.012, dendro_stem_change_um: -12,
    dendro_saturated: 0, lsn50_mode_code: 3, lsn50_mode_label: 'MOD3', lsn50_mode_observed_at: '2026-09-24T10:00:00.000Z',
  });
  // Chameleon LSN50: latest device_data row plus its chameleon_readings row.
  insertDd(GOLDEN.CHAMELEON, '2026-09-24T10:05:00.000Z', { swt_1: 22.5, swt_2: 41.25, swt_3: 60, ext_temperature_c: 18.5, bat_v: 3.58 });
  native.prepare(
    'INSERT INTO chameleon_readings (id, deveui, recorded_at, payload_version, status_flags, i2c_missing, timeout, temp_fault, id_fault, ' +
    'ch1_open, ch2_open, ch3_open, temp_c, r1_ohm_comp, r2_ohm_comp, r3_ohm_comp, r1_ohm_raw, r2_ohm_raw, r3_ohm_raw, array_id, ' +
    "payload_b64, calibration_status, created_at) VALUES (7, ?, '2026-09-24T10:05:00.000Z', 1, 0, 0, 0, 0, 0, 0, 0, 1, 19.4, 1100, " +
    "2400, 5200, 1200, 2500, 5300, '286D6ADB0F0000F1', 'AQID', 'ok', '2026-09-24T10:05:01.000Z')"
  ).run(GOLDEN.CHAMELEON);
  // WATERMARK LSN50: calibrated, then one profile 3 frame through the real ingest.
  await watermarkHelper.saveCalibration(facadeDb(native), {
    deveui: GOLDEN.WATERMARK,
    userId: 1,
    body: {
      pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
      pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
      expected_sync_version: 0,
    },
  });
  const ingested = await runIngest({
    formattedData: {
      isWatermark: true, devEui: GOLDEN.WATERMARK, timestamp: '2026-09-24T10:10:00.000Z',
      rawPayloadB64: profile3Bytes([800, 3291], [4058, 4058]).toString('base64'), fCnt: 12,
    },
  }, native);
  assert.deepEqual(ingested.errors, [], 'WATERMARK golden ingest errors');
  // KIWI: tension + light + climate.
  insertDd(GOLDEN.KIWI, '2026-09-24T10:15:00.000Z', {
    swt_wm1: 31.5, swt_wm2: 48, light_lux: 12000, ambient_temperature: 21.3, relative_humidity: 55.5, bat_v: 3.4,
  });
  // SDI-12 Sentek: three VWC depths and three soil temperatures.
  insertDd(GOLDEN.SDI12, '2026-09-24T10:20:00.000Z', {
    vwc_1: 21.4, vwc_2: 25.8, vwc_3: 30.1, soil_temp_1: 15.2, soil_temp_2: 14.8, soil_temp_3: 14.1, bat_v: 3.55,
  });
  // S2120 weather station.
  insertDd(GOLDEN.S2120, '2026-09-24T10:25:00.000Z', {
    ambient_temperature: 19.8, relative_humidity: 61, light_lux: 45000, uv_index: 3, wind_speed_mps: 2.4,
    wind_direction_deg: 225, wind_gust_mps: 5.1, barometric_pressure_hpa: 965.3, rain_gauge_cumulative_mm: 104.2,
    rain_mm_delta: 0.2, rain_mm_today: 1.4, bat_pct: 88,
  });
  return native;
}

// The whole Get Devices chain on the golden DB, as the GUI receives it: the
// route's device rows (the SDI-12 row carries the deployment and identify
// columns the route's own joins add), format-devices, its SQL,
// merge-device-data with the real osi-db-helper facade (S2120 zone
// enrichment) and the real sdi12-commissioning projection, then JSON over
// HTTP (undefined keys dropped).
async function goldenDeviceList(native, formatNode, mergeNode) {
  const deviceRows = rows(native, 'SELECT * FROM devices ORDER BY deveui').map((row) => (row.deveui !== GOLDEN.SDI12 ? row : {
    ...row,
    sdi12_deployment_status: 'compatible', sdi12_deployment_desired_version: 2, sdi12_deployment_desired_layout_hash: 'hash-2',
    sdi12_deployment_desired_recipe_json: '{"frames":[{"cmd":"0M!"},{"cmd":"0D0!"}]}', sdi12_deployment_queued_at: '2026-09-23T08:00:00.000Z',
    sdi12_deployment_queue_drained_at: '2026-09-23T08:10:00.000Z', sdi12_deployment_commissioning_deadline_at: '2026-09-23T09:00:00.000Z',
    sdi12_deployment_last_observed_at: '2026-09-23T08:20:00.000Z', sdi12_deployment_last_error_code: null,
    sdi12_deployment_compatible_recipe_json: '{"frames":[]}', sdi12_deployment_compatible_layout_json: '{"vwc":[1]}',
    sdi12_deployment_compatible_at: '2026-09-23T08:20:00.000Z', sdi12_deployment_updated_at: '2026-09-23T08:20:00.000Z',
    sdi12_identify_discovered_address: '0',
  }));
  const formatted = await executeFunction(formatNode, { msg: { payload: deviceRows } });
  assert.deepEqual(formatted.errors, [], 'format-devices errors');
  const latest = rows(native, formatted.result.topic);
  const merged = await executeFunction(mergeNode, {
    msg: { devices_to_format: formatted.result.devices_to_format, payload: latest },
    db: native,
  });
  assert.deepEqual(merged.errors, [], 'merge-device-data errors');
  assert.deepEqual(merged.warnings, [], 'merge-device-data warnings');
  return JSON.parse(JSON.stringify(merged.result.payload));
}

// Frozen literals for case (l). Every key merge-device-data puts in
// latest_data, at null; each device below overrides what it reported.
const LATEST_DATA_NULLS = Object.freeze({
  swt_wm1: null, swt_wm2: null, swt_1: null, swt_2: null, swt_3: null,
  vwc_1: null, vwc_2: null, vwc_3: null, vwc_4: null, vwc_5: null, vwc_6: null, vwc_7: null, vwc_8: null, vwc_9: null, vwc_10: null,
  soil_vic_1: null, soil_vic_2: null, soil_vic_3: null, soil_vic_4: null, soil_vic_5: null,
  soil_vic_6: null, soil_vic_7: null, soil_vic_8: null, soil_vic_9: null, soil_vic_10: null,
  soil_temp_1: null, soil_temp_2: null, soil_temp_3: null, soil_temp_4: null,
  soil_temp_5: null, soil_temp_6: null, soil_temp_7: null, soil_temp_8: null,
  soil_ec_1: null, soil_ec_2: null, soil_ec_3: null, soil_ec_4: null, soil_ec_5: null, soil_ec_6: null, soil_ec_7: null, soil_ec_8: null,
  light_lux: null, ambient_temperature: null, relative_humidity: null, ext_temperature_c: null,
  bat_v: null, adc_ch0v: null, adc_ch1v: null,
  dendro_ratio: null, dendro_mode_used: null, dendro_position_raw_mm: null, dendro_position_mm: null, dendro_valid: null,
  dendro_delta_mm: null, dendro_stem_change_um: null, dendro_saturated: null, dendro_saturation_side: null,
  lsn50_mode_code: null, lsn50_mode_label: null, lsn50_mode_observed_at: null,
  rain_count_cumulative: null, rain_tips_delta: null, rain_mm_delta: null, rain_mm_per_hour: null,
  rain_mm_per_10min: null, rain_mm_today: null, rain_delta_status: null,
  flow_count_cumulative: null, flow_pulses_delta: null, flow_liters_delta: null, flow_liters_per_min: null,
  flow_liters_per_10min: null, flow_liters_today: null, flow_delta_status: null, counter_interval_seconds: null,
  barometric_pressure_hpa: null, wind_speed_mps: null, wind_direction_deg: null, wind_gust_mps: null, uv_index: null,
  rain_gauge_cumulative_mm: null, bat_pct: null,
  chameleon_reading_id: null, chameleon_payload_b64: null, chameleon_payload_version: null, chameleon_status_flags: null,
  chameleon_i2c_missing: null, chameleon_timeout: null, chameleon_temp_fault: null, chameleon_id_fault: null,
  chameleon_ch1_open: null, chameleon_ch2_open: null, chameleon_ch3_open: null, chameleon_temp_c: null,
  chameleon_r1_ohm_comp: null, chameleon_r2_ohm_comp: null, chameleon_r3_ohm_comp: null,
  chameleon_r1_ohm_raw: null, chameleon_r2_ohm_raw: null, chameleon_r3_ohm_raw: null, chameleon_array_id: null,
  watermark: null,
});

// Every other device key, at its value for a golden device row that does not set it.
const DEVICE_DEFAULTS = Object.freeze({
  calibration_status: null, current_state: null, target_state: null,
  dendro_enabled: 0, temp_enabled: 0, rain_gauge_enabled: 0, flow_meter_enabled: 0, is_reference_tree: 0, device_mode: 1,
  dendro_force_legacy: 0, dendro_stroke_mm: null, dendro_ratio_at_retracted: null, dendro_ratio_at_extended: null,
  dendro_ratio_zero: null, dendro_ratio_span: null, dendro_invert_direction: 0, dendro_baseline_pending: 0,
  chameleon_enabled: 0, chameleon_swt1_depth_cm: null, chameleon_swt2_depth_cm: null, chameleon_swt3_depth_cm: null,
  sdi12_probe_profile: null, sdi12_probe_status: null, sdi12_identity: null, sdi12_value_count: null,
  sdi12_channel_layout_json: null, sdi12_layout_status: null,
  updated_at: '2026-09-02T09:00:00.000Z', irrigation_zone_id: null, irrigation_zone_uuid: null, strega_model: null,
  active_valve_actuation: null, activeValveActuation: null,
  soil_moisture_probe_depths_json: null, soil_moisture_probe_depths_configured: 0,
  gateway_device_eui: null, sync_version: 3, deleted_at: null,
});

// In the route's ORDER BY deveui order.
const GOLDEN_DEVICE_LIST = Object.freeze([
  {
    ...DEVICE_DEFAULTS,
    deveui: GOLDEN.KIWI, name: 'Kiwi row 3', type_id: 'KIWI_SENSOR', last_seen: '2026-09-24T10:15:00.000Z',
    irrigation_zone_id: 4, gateway_device_eui: '0016C001F1000003',
    latest_data: {
      ...LATEST_DATA_NULLS,
      swt_wm1: 31.5, swt_wm2: 48, swt_1: 31.5, swt_2: 48,
      light_lux: 12000, ambient_temperature: 21.3, relative_humidity: 55.5, bat_v: 3.4, dendro_saturated: 0,
    },
  },
  {
    ...DEVICE_DEFAULTS,
    deveui: GOLDEN.S2120, name: 'Weather station', type_id: 'SENSECAP_S2120', last_seen: '2026-09-24T10:25:00.000Z',
    zone_ids: [4], zone_names: ['North block'],
    latest_data: {
      ...LATEST_DATA_NULLS,
      light_lux: 45000, ambient_temperature: 19.8, relative_humidity: 61, dendro_saturated: 0,
      rain_mm_delta: 0.2, rain_mm_today: 1.4, barometric_pressure_hpa: 965.3, wind_speed_mps: 2.4,
      wind_direction_deg: 225, wind_gust_mps: 5.1, uv_index: 3, rain_gauge_cumulative_mm: 104.2, bat_pct: 88,
      // Farm day of the latest rain value: the station has no zone of its own, so its
      // weather-station zone's timezone (the seed default, UTC) dates the 10:25Z row.
      rain_day: '2026-09-24', rain_day_timezone: 'UTC', rain_day_timezone_basis: 'weather_station_zone',
    },
  },
  {
    ...DEVICE_DEFAULTS,
    deveui: GOLDEN.STOCK, name: 'Stock dendro', type_id: 'DRAGINO_LSN50', last_seen: '2026-09-24T10:00:00.000Z',
    dendro_enabled: 1, temp_enabled: 1, device_mode: 3, dendro_stroke_mm: 10, irrigation_zone_id: 4,
    latest_data: {
      ...LATEST_DATA_NULLS,
      ext_temperature_c: 17.25, bat_v: 3.6, adc_ch0v: 1.234, adc_ch1v: 2.468,
      dendro_ratio: 0.5, dendro_mode_used: 'ratio', dendro_position_raw_mm: 5.01, dendro_position_mm: 5, dendro_valid: 1,
      dendro_delta_mm: -0.012, dendro_stem_change_um: -12, dendro_saturated: 0,
      lsn50_mode_code: 3, lsn50_mode_label: 'MOD3', lsn50_mode_observed_at: '2026-09-24T10:00:00.000Z',
    },
  },
  {
    ...DEVICE_DEFAULTS,
    deveui: GOLDEN.CHAMELEON, name: 'Chameleon array', type_id: 'DRAGINO_LSN50', last_seen: '2026-09-24T10:05:00.000Z',
    calibration_status: 'ok', chameleon_enabled: 1, chameleon_swt1_depth_cm: 20, chameleon_swt2_depth_cm: 40, chameleon_swt3_depth_cm: 60,
    latest_data: {
      ...LATEST_DATA_NULLS,
      swt_1: 22.5, swt_2: 41.25, swt_3: 60, ext_temperature_c: 18.5, bat_v: 3.58, dendro_saturated: 0,
      chameleon_reading_id: 7, chameleon_payload_b64: 'AQID', chameleon_payload_version: 1, chameleon_status_flags: 0,
      chameleon_i2c_missing: 0, chameleon_timeout: 0, chameleon_temp_fault: 0, chameleon_id_fault: 0,
      chameleon_ch1_open: 0, chameleon_ch2_open: 0, chameleon_ch3_open: 1, chameleon_temp_c: 19.4,
      chameleon_r1_ohm_comp: 1100, chameleon_r2_ohm_comp: 2400, chameleon_r3_ohm_comp: 5200,
      chameleon_r1_ohm_raw: 1200, chameleon_r2_ohm_raw: 2500, chameleon_r3_ohm_raw: 5300,
      chameleon_array_id: '286D6ADB0F0000F1',
    },
  },
  {
    ...DEVICE_DEFAULTS,
    deveui: GOLDEN.WATERMARK, name: 'Watermark 1+2', type_id: 'DRAGINO_LSN50', last_seen: '2026-09-24T10:10:00.000Z',
    soil_moisture_probe_depths_json: { swt_1: 25, swt_2: 50 }, soil_moisture_probe_depths_configured: 1,
    latest_data: {
      ...LATEST_DATA_NULLS,
      // bat_v stays null for a WATERMARK observation (spec D10).
      swt_1: 56.4, ext_temperature_c: 19.88, dendro_saturated: 0,
      watermark: {
        recorded_at: '2026-09-24T10:10:00.000Z', supply_mv: 3300, soil_temp_c: 19.88, soil_temp_source: 2, die_temp_c: 21.46,
        channels: [
          { status: 'ok', kpa: 56.4, kpa_upper_bound: null, r_solved: 9977, r_upper_bound: null, offset_mv: 0.6 },
          { status: 'outside_200ss_range', kpa: null, kpa_upper_bound: null, r_solved: 42047, r_upper_bound: null, offset_mv: 3240.7 },
        ],
      },
    },
  },
  {
    ...DEVICE_DEFAULTS,
    deveui: GOLDEN.SDI12, name: 'Sentek 60', type_id: 'DRAGINO_SDI12', last_seen: '2026-09-24T10:20:00.000Z',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: 'identified', sdi12_identity: '013SENTEK EVS60',
    sdi12_value_count: 6, sdi12_channel_layout_json: { vwc: [1, 2, 3], soil_temp: [4, 5, 6] }, sdi12_layout_status: 'configured',
    sdi12_recipe_deployment: {
      desired_version: 2, desired_layout_hash: 'hash-2', status: 'compatible',
      queued_at: '2026-09-23T08:00:00.000Z', queue_drained_at: '2026-09-23T08:10:00.000Z',
      commissioning_deadline_at: '2026-09-23T09:00:00.000Z', last_observed_at: '2026-09-23T08:20:00.000Z',
      compatible_at: '2026-09-23T08:20:00.000Z', updated_at: '2026-09-23T08:20:00.000Z',
      frame_count: 2, compatible_available: true, last_error_code: null,
    },
    sdi12_discovered_address: '0',
    latest_data: {
      ...LATEST_DATA_NULLS,
      vwc_1: 21.4, vwc_2: 25.8, vwc_3: 30.1, soil_temp_1: 15.2, soil_temp_2: 14.8, soil_temp_3: 14.1,
      bat_v: 3.55, dendro_saturated: 0,
    },
  },
]);

CASES.push({
  name: '(l) device list: complete GET /api/devices objects for stock, Chameleon and WATERMARK LSN50, KIWI, SDI-12 and S2120 equal frozen literals',
  async run() {
    const native = await goldenDeviceListDb();
    const list = await goldenDeviceList(native, headNode('format-devices'), headNode('merge-device-data'));
    native.close();
    assert.deepEqual(list.map((d) => d.deveui), GOLDEN_DEVICE_LIST.map((d) => d.deveui), 'device order');
    list.forEach((device, i) => {
      assert.deepEqual(device, GOLDEN_DEVICE_LIST[i], device.type_id + ' ' + device.deveui + ': drifted from its frozen literal');
    });
  },
});

// ----------------------------------------------------------------- runner --

(async () => {
  let failed = 0;
  for (const c of CASES) {
    try {
      await c.run();
      console.log('ok - ' + c.name);
    } catch (error) {
      failed += 1;
      console.log('not ok - ' + c.name + '\n  ' + String(error && error.stack ? error.stack : error).split('\n').slice(0, 6).join('\n  '));
    }
  }
  if (failed) {
    console.log('FAIL: ' + failed + ' of ' + CASES.length + ' WATERMARK ingest flow case(s) failed');
    process.exit(1);
  }
  console.log('PASS: ' + CASES.length + ' WATERMARK ingest flow cases');
})();
