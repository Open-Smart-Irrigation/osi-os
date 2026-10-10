#!/usr/bin/env node
'use strict';
// LSN50 MOD9 rain counter under concurrent uplinks (review finding 4, owner
// decision D7: a regression test with the same serialization as the S2120
// writer, no rewrite). Drives the shipped "Apply Config" (counter read and
// derivation) and "LSN50 Normalize + Write" (device_data insert) bodies through
// the real osi-db-helper over a temp file database: cumulative tip counts 100,
// then 101 and 102 in flight together must store 2 x 0.2 mm, never 3 x 0.2 mm.
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
const flows = JSON.parse(fs.readFileSync(path.join(SHARE, 'flows.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-lsn50-counter-'));
const EUI = 'A840410000000001';
const T0 = Date.parse('2026-10-08T10:00:00.000Z');
const MODULES = {
  dendro: require(path.join(NODE_RED, 'osi-dendro-helper')),
  chameleon: require(path.join(NODE_RED, 'osi-chameleon-helper')),
  'lsn50-normalize': require(path.join(NODE_RED, 'osi-lsn50-normalize')),
  'device-writer': require(path.join(NODE_RED, 'osi-device-writer')),
  rain: require(path.join(NODE_RED, 'osi-rain')),
};
const MANIFEST = fs.readFileSync(path.join(NODE_RED, 'edge-channels.json'), 'utf8');

function adapter() {
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
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, device_mode, rain_gauge_enabled, created_at, updated_at)
      VALUES ('${EUI}', 'Rain node', 'DRAGINO_LSN50', 1, 1, 9, 1, '2026-01-01', '2026-01-01');`);
  native.close();
  return dbPath;
}

// Nodes by name: "Apply Config" (lsn50-apply-config) and "LSN50 Normalize + Write".
function body(name) {
  const matches = flows.filter((n) => n.type === 'function' && n.z === 'lsn50-tab' && n.name === name);
  assert.equal(matches.length, 1, 'one LSN50 function node named ' + name);
  return matches[0];
}

// MOD9 frame: battery, three temperatures (absent), rain count, flow count.
function mod9Payload(rainCount, flowCount = 0) {
  const buf = Buffer.alloc(17);
  buf.writeUInt16BE(3300, 0);
  buf.writeUInt16BE(0x7fff, 2);
  buf.writeUInt16BE(0x7fff, 4);
  buf.writeUInt16BE(0x7fff, 7);
  buf.writeUInt32BE(rainCount, 9);
  buf.writeUInt32BE(flowCount, 13);
  return buf.toString('base64');
}

// One runtime: the real helper, the two shipped node bodies with their libs.
function runtime(dbPath) {
  const osiDb = loadHelper();
  new osiDb.Database(dbPath); // opens the shared connection on the temp file
  const errors = [];
  const flowStore = new Map();
  const node = { status() {}, warn() {}, error(message) { errors.push(String(message)); } };
  const flowApi = { get: (k) => flowStore.get(k), set: (k, v) => flowStore.set(k, v) };
  const globalApi = { get: (k) => (k === 'fs' ? { readFileSync: () => MANIFEST } : undefined) };
  const osiLib = { require: (name) => (MODULES[name] ? { ok: true, value: MODULES[name] } : { ok: false, error: name }) };
  const libs = { osiDb, osiLib, dendro: MODULES.dendro, chameleon: MODULES.chameleon };
  const compile = (name) => {
    const n = body(name);
    const names = (n.libs || []).map((l) => l.var);
    const fn = new AsyncFunction('msg', 'node', 'flow', 'global', ...names, n.func);
    return (msg) => fn(msg, node, flowApi, globalApi, ...names.map((v) => libs[v]));
  };
  const apply = compile('Apply Config');
  const write = compile('LSN50 Normalize + Write');
  async function deliver(rainCount, offsetSeconds) {
    const msg = {
      payload: [{ dendro_enabled: 0, temp_enabled: 0, device_mode: 9, chameleon_enabled: 0, dendro_force_legacy: 0, dendro_invert_direction: 0 }],
      formattedData: { devEui: EUI, timestamp: new Date(T0 + offsetSeconds * 1000).toISOString(), observedModeCode: 9 },
      _rawPayload: mod9Payload(rainCount),
    };
    const applied = await apply(msg);
    return write(applied);
  }
  return { deliver, errors };
}

function snapshot(dbPath, sql) {
  const native = new DatabaseSync(dbPath, { readOnly: true });
  try { return native.prepare(sql).all().map((r) => ({ ...r })); } finally { native.close(); }
}

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

for (const order of ['101 first', '102 first']) {
  test(`MOD9 rain counter: 100, then 101 and 102 in flight together (${order}) store 2 x 0.2 mm`, async () => {
    const dbPath = seedFile();
    const rt = runtime(dbPath);
    await rt.deliver(100, 0);
    const pair = [[101, 600], [102, 610]];
    if (order === '102 first') pair.reverse();
    await Promise.all(pair.map(([count, offset]) => rt.deliver(count, offset)));
    assert.deepEqual(rt.errors, []);
    const stored = snapshot(dbPath, 'SELECT recorded_at, rain_count_cumulative, rain_mm_delta, rain_delta_status FROM device_data ORDER BY recorded_at');
    assert.equal(stored.length, 3, 'three device_data rows');
    const total = stored.reduce((sum, r) => sum + (r.rain_delta_status === 'ok' ? Number(r.rain_mm_delta) : 0), 0);
    assert.equal(Math.round(total * 10) / 10, 0.4, 'accepted rain_mm_delta total is 2 tips x 0.2 mm, never 3 tips: ' + JSON.stringify(stored));
    const linked = snapshot(dbPath,
      "SELECT dd.id AS device_data_id, dd.rain_count_cumulative, ro.id AS observation_id, ro.zone_id, ro.timezone, ro.config_json "
      + "FROM device_data dd LEFT JOIN rain_observations ro ON ro.device_data_id = dd.id AND ro.instrument_type = 'DRAGINO_LSN50' "
      + 'ORDER BY dd.recorded_at');
    assert.equal(linked.length, stored.length, 'each committed counter row is returned for snapshot verification');
    assert.equal(linked.filter((row) => row.observation_id !== null).length, stored.length,
      'each committed counter row has a linked rain observation');
    assert.equal(new Set(linked.map((row) => row.device_data_id)).size, stored.length,
      'each committed device_data row appears once in the snapshot join');
    assert.equal(new Set(linked.map((row) => row.observation_id)).size, stored.length,
      'each counter row has exactly one distinct rain observation');
    for (const row of linked) {
      assert.equal(row.zone_id, 1, 'rain observation snapshots the assigned irrigation zone');
      assert.equal(row.timezone, 'UTC', 'rain observation snapshots the zone timezone');
      const config = JSON.parse(row.config_json);
      assert.equal(config.frame.rain_count_cumulative, row.rain_count_cumulative);
      assert.equal(config.rain_gauge_enabled, true);
      assert.deepEqual(config.zones, [1]);
      assert.deepEqual(config.zone_snapshots.map((zone) => zone.zone_id), [1]);
    }
  });
}
