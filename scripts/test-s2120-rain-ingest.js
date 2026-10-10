#!/usr/bin/env node
'use strict';

// S2120 rain ingest contract, exercised through the shipped codec and the
// shipped Node-RED function body (s2120-ingest-fn, the one S2120 writer) with
// osi-rain against an in-memory SQLite database built from
// database/seed-blank.sql.
//
// Vendor contract (SenseCAP S2120 user guide, sections 10.2, 10.3.1 and 13.3):
// - measurement 4113 (frame 02 before firmware v2.0, frame 4B from v2.0) is
//   rainfall INTENSITY in mm/h, resolution 0.001. The device derives it as
//   six times the rainfall of the past ten minutes.
// - measurement 4213 (frame 4C, firmware v2.0 and later) is CUMULATIVE
//   rainfall in mm.
//
// Ingest must difference 4213 as a counter, keep 4113 as a stored rate, and
// integrate 4113 into an amount only under the documented cadence policy.
// Identity, replay and atomicity (rain correctness programme): every uplink
// claims a rain_observations identity, and the counter read, the device_data
// row and the zone day are one transaction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb } = require('./lib/flow-node-harness');

const repoRoot = path.resolve(__dirname, '..');
const shareDir = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share');
const flows = JSON.parse(fs.readFileSync(path.join(shareDir, 'flows.json'), 'utf8'));
const seedSql = fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8');
const R = require(path.join(shareDir, 'node-red/osi-rain/index.js'));

const DEV_EUI = 'A840410000000001';
const DEV_EUI_2 = 'A840410000000002';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadCodec() {
  const scope = { Buffer, console: { log() {} } };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(shareDir, 'node-red/codecs/sensecap_s2120_decoder.js'), 'utf8'), scope);
  return scope;
}
const codec = loadCodec();

function nodeBody(id) {
  const node = flows.find((entry) => entry.id === id);
  assert.ok(node, 'missing flow node ' + id);
  return node.func;
}

function createDb({ timezone = 'UTC' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(seedSql);
  db.exec(`
    INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('owner', 'h', '2026-01-01', 'u-owner');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z One', 1, 'z-1', '${timezone}', 'local');
    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z Two', 1, 'z-2', 'UTC', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
      VALUES ('${DEV_EUI}', 'Station 1', 'SENSECAP_S2120', 1, 1, '2026-01-01', '2026-01-01'),
             ('${DEV_EUI_2}', 'Station 2', 'SENSECAP_S2120', 1, 1, '2026-01-01', '2026-01-01');`);
  return db;
}

function hex(value, width) {
  return Math.round(value).toString(16).toUpperCase().padStart(width, '0');
}

// Frame 4B (v2.0+) or 02 (before v2.0): wind direction, rain intensity
// (mm/h x 1000), barometric pressure (Pa / 10).
function intensityFrame(frameId, intensityMmH) {
  return frameId + '0156' + hex(intensityMmH * 1000, 8) + '2703';
}

// Frame 4C (v2.0+): peak wind gust, cumulative rainfall (mm x 1000).
function cumulativeFrame(cumulativeMm) {
  return '4C000B' + hex(cumulativeMm * 1000, 8);
}

function decode(rawHex) {
  return codec.decodeUplink({ fPort: 5, bytes: [...Buffer.from(rawHex, 'hex')] }).data;
}

// Every delivered uplink gets its own ChirpStack deduplicationId, also across
// harness restarts.
let eventSeq = 0;

// Node-RED runs the body as an AsyncFunction with its declared libs. osiDb is
// the harness facade over the shared DatabaseSync (transaction = BEGIN
// IMMEDIATE ... COMMIT/ROLLBACK); node context persists across messages within
// one harness (one Node-RED run).
function harness(db, { failOn = null } = {}) {
  const facade = facadeDb(db);
  const stats = { markerLookups: 0 };
  const counted = (scope) => Object.assign({}, scope, {
    get(sql, ...rest) {
      if (/rain_delta_status = 'cumulative_baseline'/.test(sql)) stats.markerLookups += 1;
      return scope.get(sql, ...rest);
    },
    all(sql, ...rest) {
      if (/rain_delta_status = 'cumulative_baseline'/.test(sql)) stats.markerLookups += 1;
      return scope.all(sql, ...rest);
    },
    run(sql, ...rest) {
      if (failOn && failOn.active && failOn.pattern.test(sql)) return Promise.reject(new Error('injected failure'));
      return scope.run(sql, ...rest);
    },
  });
  const database = Object.assign({}, facade, { transaction: (fn) => facade.transaction((t) => fn(counted(t))) });
  const osiDb = { Database: function Database() { return database; } };
  const store = new Map();
  const context = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
  const osiLib = { require: (name) => (name === 'rain' ? { ok: true, value: R } : { ok: false, error: 'unexpected module ' + name }) };
  const errors = [];
  const node = { status() {}, warn() {}, error(message) { errors.push(String(message)); } };
  const ingestFn = new AsyncFunction('msg', 'osiDb', 'osiLib', 'node', 'context', nodeBody('s2120-ingest-fn'));

  async function deliver(payload) {
    const before = errors.length;
    await ingestFn({ payload }, osiDb, osiLib, node, context);
    return errors.slice(before);
  }
  async function uplink(time, rawHex, devEui = DEV_EUI, extra = {}) {
    eventSeq += 1;
    const payload = {
      deviceInfo: { devEui }, deduplicationId: '00000000-0000-4000-8000-' + String(eventSeq).padStart(12, '0'),
      time, fPort: 3, data: Buffer.from(rawHex, 'hex').toString('base64'), object: decode(rawHex), ...extra,
    };
    const errs = await deliver(payload);
    assert.deepEqual(errs, [], 'the ingest node reported no error');
    const row = db.prepare('SELECT * FROM device_data WHERE deveui = ? ORDER BY id DESC LIMIT 1').get(devEui);
    const obs = row ? db.prepare('SELECT * FROM rain_observations WHERE device_data_id = ?').get(row.id) : null;
    return {
      row, obs, payload, accepted: !!obs && obs.status === 'accepted',
      formatted: { rainDeltaStatus: row.rain_delta_status, rainMmDelta: row.rain_mm_delta },
    };
  }
  return { uplink, deliver, stats, errors, context, store };
}

function lastRow(db, devEui = DEV_EUI) {
  return db.prepare('SELECT * FROM device_data WHERE deveui = ? ORDER BY recorded_at DESC, id DESC LIMIT 1').get(devEui);
}

const v2 = (intensity, cumulative) => intensityFrame('4B', intensity) + cumulativeFrame(cumulative);
const legacy = (intensity) => intensityFrame('02', intensity);

test('codec emits 4113 as intensity and 4213 as cumulative rainfall (vendor example)', () => {
  // User guide 10.3.1, v2.0 example: 0x000000FE -> 0.254 mm/h, 0x000006F2 -> 1.778 mm.
  const decoded = decode('4B0156000000FE27034C000B000006F2');
  const byId = {};
  for (const group of decoded.messages) for (const m of group) byId[String(m.measurementId)] = m.measurementValue;
  assert.equal(byId['4113'], 0.254);
  assert.equal(byId['4213'], 1.778);
});

test('review reproduction: steady 4113 with rising 4213 stores the 0.254 mm increment', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  const first = await uplink('2026-10-08T10:00:00.000Z', v2(0.254, 1.778));
  assert.equal(first.row.rain_gauge_cumulative_mm, 1.778, '4213 is the stored cumulative value');
  assert.equal(first.row.rain_mm_delta, null, 'the first counter sample has no increment');
  assert.equal(first.row.rain_delta_status, 'cumulative_baseline', 'the first 4213 row of a device is its counter baseline');
  const second = await uplink('2026-10-08T10:10:00.000Z', v2(0.254, 2.032));
  assert.equal(second.row.rain_delta_status, 'ok');
  assert.equal(second.row.rain_mm_delta, 0.254, 'increment kept to the millimetre thousandth');
  assert.equal(second.row.rain_gauge_cumulative_mm, 2.032);
  assert.equal(second.row.rain_mm_per_hour, 0.254, 'reported intensity is stored as the rain rate');
  assert.equal(second.row.rain_mm_per_10min, 0.254);
  assert.equal(second.row.counter_interval_seconds, 600);
  assert.equal(second.row.rain_mm_today, 0.254);
  assert.ok(second.accepted, 'a valid increment is a counted observation');
});

test('a drop in intensity is not a counter reset', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(6, 3));
  const next = await uplink('2026-10-08T10:10:00.000Z', v2(0.5, 3.254));
  assert.equal(next.row.rain_delta_status, 'ok');
  assert.equal(next.row.rain_mm_delta, 0.254);
  assert.equal(next.row.rain_mm_per_hour, 0.5);
});

test('a falling 4213 is a counter reset and becomes the new baseline', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(0, 5));
  const reset = await uplink('2026-10-08T10:10:00.000Z', v2(0, 0.254));
  assert.equal(reset.row.rain_delta_status, 'counter_reset');
  assert.equal(reset.row.rain_mm_delta, null);
  assert.equal(reset.accepted, false, 'not counted');
  const after = await uplink('2026-10-08T10:20:00.000Z', v2(1.524, 0.508));
  assert.equal(after.row.rain_delta_status, 'ok');
  assert.equal(after.row.rain_mm_delta, 0.254);
});

test('upgrade: rows written under the old interpretation are never a counter baseline', async () => {
  const db = createDb();
  // Rows as the previous node wrote them: 4113 intensity stored as "cumulative".
  const insert = db.prepare(
    'INSERT INTO device_data (deveui, recorded_at, rain_gauge_cumulative_mm, rain_mm_delta, rain_delta_status) VALUES (?, ?, ?, ?, ?)'
  );
  insert.run(DEV_EUI, '2026-10-08T09:40:00.000Z', 0, null, 'first_sample');
  insert.run(DEV_EUI, '2026-10-08T09:50:00.000Z', 0.254, 0.3, 'ok');
  const { uplink } = harness(db);
  const first = await uplink('2026-10-08T10:00:00.000Z', v2(0.254, 150));
  assert.equal(first.row.rain_mm_delta, null, 'no 149.7 mm phantom increment against an intensity row');
  assert.notEqual(first.row.rain_delta_status, 'ok');
  assert.equal(first.accepted, false, 'not counted');
  const second = await uplink('2026-10-08T10:10:00.000Z', v2(0.254, 150.254));
  assert.equal(second.row.rain_delta_status, 'ok');
  assert.equal(second.row.rain_mm_delta, 0.254);
});

test('increments keep three decimals through the daily total and the zone total', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(1.524, 10));
  await uplink('2026-10-08T10:10:00.000Z', v2(1.524, 10.254));
  await uplink('2026-10-08T10:20:00.000Z', v2(1.524, 10.508));
  const third = await uplink('2026-10-08T10:30:00.000Z', v2(1.524, 10.762));
  assert.equal(third.row.rain_mm_delta, 0.254);
  assert.equal(third.row.rain_mm_today, 0.762);
  const zone = db.prepare('SELECT rainfall_mm, rain_source FROM zone_daily_environment WHERE zone_id = 1').get();
  assert.ok(Math.abs(zone.rainfall_mm - 0.762) < 1e-9, 'zone total ' + zone.rainfall_mm + ' keeps the thousandths');
  assert.equal(zone.rain_source, 'sensecap_s2120');
});

test('legacy firmware, 10-minute cadence: intensity / 6 is the interval amount', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  const first = await uplink('2026-10-08T10:00:00.000Z', legacy(0));
  assert.equal(first.row.rain_delta_status, 'first_sample', 'cadence is unknown until a previous uplink exists');
  assert.equal(first.row.rain_mm_delta, null);
  assert.equal(first.row.rain_gauge_cumulative_mm, null, 'a rate is never stored as a counter');
  assert.equal(first.row.rain_mm_per_hour, 0);
  const second = await uplink('2026-10-08T10:10:00.000Z', legacy(1.524));
  assert.equal(second.row.rain_delta_status, 'ok');
  assert.equal(second.row.rain_mm_delta, 0.254);
  assert.equal(second.row.rain_mm_per_10min, 0.254);
  assert.equal(second.row.rain_mm_per_hour, 1.524);
  assert.equal(second.row.rain_gauge_cumulative_mm, null);
  assert.equal(second.row.counter_interval_seconds, 600);
  assert.ok(second.accepted);
});

test('legacy firmware, small timing jitter within the tolerance still integrates', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', legacy(0));
  const next = await uplink('2026-10-08T10:10:40.000Z', legacy(3.048));
  assert.equal(next.row.rain_delta_status, 'ok');
  assert.equal(next.row.rain_mm_delta, 0.508);
});

test('legacy firmware, lost uplink: the amount stays unknown', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', legacy(0));
  const gap = await uplink('2026-10-08T10:20:00.000Z', legacy(1.524));
  assert.equal(gap.row.rain_delta_status, 'intensity_only');
  assert.equal(gap.row.rain_mm_delta, null, 'ten observed minutes do not cover a twenty-minute interval');
  assert.equal(gap.row.rain_mm_per_hour, 1.524, 'the intensity itself is still stored');
  assert.equal(gap.accepted, false, 'not counted');
});

test('legacy firmware, 5-minute cadence: overlapping windows are not integrated', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', legacy(0));
  const short = await uplink('2026-10-08T10:05:00.000Z', legacy(1.524));
  assert.equal(short.row.rain_delta_status, 'intensity_only');
  assert.equal(short.row.rain_mm_delta, null);
});

test('a counter device never integrates an intensity-only uplink', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(0, 20));
  const partial = await uplink('2026-10-08T10:10:00.000Z', intensityFrame('4B', 1.524));
  assert.equal(partial.row.rain_delta_status, 'intensity_only');
  assert.equal(partial.row.rain_mm_delta, null, 'the counter accounts for this rain on the next 4213 uplink');
  const next = await uplink('2026-10-08T10:20:00.000Z', v2(1.524, 20.508));
  assert.equal(next.row.rain_delta_status, 'ok');
  assert.equal(next.row.rain_mm_delta, 0.508, 'counted once, across both intervals');
  assert.equal(next.row.counter_interval_seconds, 1200);
  assert.equal(next.row.rain_mm_today, 0.508);
});

test('a duplicate timestamp is skipped for counter and legacy uplinks', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', legacy(0));
  const dup = await uplink('2026-10-08T10:00:00.000Z', legacy(1.524));
  assert.equal(dup.formatted.rainDeltaStatus, 'duplicate_timestamp', 'legacy path');
  assert.equal(dup.formatted.rainMmDelta, null);
  assert.equal(dup.accepted, false, 'not counted');

  await uplink('2026-10-08T10:00:00.000Z', v2(0, 7), DEV_EUI_2);
  await uplink('2026-10-08T10:10:00.000Z', v2(1.524, 7.254), DEV_EUI_2);
  const counterDup = await uplink('2026-10-08T10:10:00.000Z', v2(3.048, 7.508), DEV_EUI_2);
  assert.equal(counterDup.formatted.rainDeltaStatus, 'duplicate_timestamp', 'counter path');
  assert.equal(counterDup.formatted.rainMmDelta, null);
  assert.equal(counterDup.accepted, false, 'not counted');
});

test('an out-of-order counter uplink is skipped and does not move the baseline', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(0, 4));
  await uplink('2026-10-08T10:20:00.000Z', v2(0, 4.508));
  const late = await uplink('2026-10-08T10:10:00.000Z', v2(1.524, 4.254));
  assert.equal(late.formatted.rainDeltaStatus, 'out_of_order');
  assert.equal(late.formatted.rainMmDelta, null);
  assert.equal(late.accepted, false, 'not counted');
  const next = await uplink('2026-10-08T10:30:00.000Z', v2(1.524, 4.762));
  assert.equal(next.row.rain_delta_status, 'ok');
  assert.equal(next.row.rain_mm_delta, 0.254, 'differenced against 4.508 at 10:20, not the late 4.254 row');
  assert.equal(next.row.counter_interval_seconds, 600);
});

test('upgrade of a legacy device: the interval to an older row still sets the cadence', async () => {
  const db = createDb();
  db.prepare(
    'INSERT INTO device_data (deveui, recorded_at, rain_gauge_cumulative_mm, rain_mm_delta, rain_delta_status) VALUES (?, ?, ?, ?, ?)'
  ).run(DEV_EUI, '2026-10-08T09:50:00.000Z', 0, 0, 'ok');
  const { uplink } = harness(db);
  const next = await uplink('2026-10-08T10:00:00.000Z', legacy(3.048));
  assert.equal(next.row.rain_delta_status, 'ok');
  assert.equal(next.row.rain_mm_delta, 0.508, 'amount comes from the intensity, never from the older stored value');
  assert.equal(next.row.rain_gauge_cumulative_mm, null);
});

test('legacy tolerance boundary: 660 s integrates, 661 s does not', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', legacy(0));
  const edge = await uplink('2026-10-08T10:11:00.000Z', legacy(1.524));
  assert.equal(edge.row.rain_delta_status, 'ok');
  assert.equal(edge.row.rain_mm_delta, 0.254);
  const beyond = await uplink('2026-10-08T10:22:01.000Z', legacy(1.524));
  assert.equal(beyond.row.rain_delta_status, 'intensity_only');
  assert.equal(beyond.row.rain_mm_delta, null);
});

test('a dry counter interval is a valid zero and reaches the zone aggregation', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(0, 12));
  const dry = await uplink('2026-10-08T10:10:00.000Z', v2(0, 12));
  assert.equal(dry.row.rain_delta_status, 'ok');
  assert.equal(dry.row.rain_mm_delta, 0);
  assert.ok(dry.accepted, 'a measured zero is counted, not dropped');
  const zone = db.prepare('SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id = 1').get();
  assert.equal(zone.rainfall_mm, 0);
});

test('intensity-only uplinks before the first 4213 are not counted again by the counter', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', intensityFrame('4B', 0));
  const integrated = await uplink('2026-10-08T10:10:00.000Z', intensityFrame('4B', 1.524));
  assert.equal(integrated.row.rain_mm_delta, 0.254);
  const baseline = await uplink('2026-10-08T10:20:00.000Z', v2(1.524, 30));
  assert.equal(baseline.row.rain_delta_status, 'cumulative_baseline');
  assert.equal(baseline.row.rain_mm_delta, null);
  const next = await uplink('2026-10-08T10:30:00.000Z', v2(1.524, 30.254));
  assert.equal(next.row.rain_mm_delta, 0.254);
  assert.equal(next.row.rain_mm_today, 0.508, 'one integrated interval plus one counter interval');
});

test('a deleted counter baseline row starts a new baseline after a restart, never a phantom increment', async () => {
  const db = createDb();
  const first = harness(db);
  await first.uplink('2026-10-08T10:00:00.000Z', v2(0, 40));
  await first.uplink('2026-10-08T10:10:00.000Z', v2(0, 40.254));
  db.prepare("DELETE FROM device_data WHERE rain_delta_status = 'cumulative_baseline'").run();
  const restarted = harness(db);
  const next = await restarted.uplink('2026-10-08T10:20:00.000Z', v2(0, 40.508));
  assert.equal(next.row.rain_delta_status, 'cumulative_baseline');
  assert.equal(next.row.rain_mm_delta, null);
});

test('the counter-baseline lookup runs once per device, not once per uplink', async () => {
  const db = createDb();
  const { uplink, stats } = harness(db);
  for (let i = 0; i < 4; i += 1) {
    const time = new Date(Date.parse('2026-10-08T10:00:00.000Z') + i * 600000).toISOString();
    await uplink(time, v2(1.524, 50 + i * 0.254), DEV_EUI);
    await uplink(time, legacy(1.524), DEV_EUI_2);
  }
  assert.equal(stats.markerLookups, 2, 'one lookup per device: the counter device and the legacy device');
  const last = lastRow(db, DEV_EUI);
  assert.equal(last.rain_mm_delta, 0.254);
  assert.equal(lastRow(db, DEV_EUI_2).rain_mm_delta, 0.254);
});

test('a cached baseline whose rows are gone is looked up again', async () => {
  const db = createDb();
  const { uplink, stats } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(0, 60));
  await uplink('2026-10-08T10:10:00.000Z', v2(0, 60.254));
  // The device is removed and added again: its rows cascade away, the node context stays.
  db.prepare('DELETE FROM device_data WHERE deveui = ?').run(DEV_EUI);
  const before = stats.markerLookups;
  const fresh = await uplink('2026-10-08T10:20:00.000Z', v2(0, 3));
  assert.equal(fresh.row.rain_delta_status, 'cumulative_baseline', 'no phantom increment against a vanished baseline');
  assert.equal(fresh.row.rain_mm_delta, null);
  assert.equal(stats.markerLookups, before + 1);
  const next = await uplink('2026-10-08T10:30:00.000Z', v2(0, 3.254));
  assert.equal(next.row.rain_mm_delta, 0.254);
  assert.equal(stats.markerLookups, before + 1, 'the new baseline is cached again');
});

// ---------------------------------------------------------------------------
// Identity, replay and atomicity (one writer, one transaction per uplink).
// Mirrors the LoRain writer's cases in scripts/test-lorain-ingest.js.
// ---------------------------------------------------------------------------

const count = (db, sql) => db.prepare(sql).get().n;
const rows = (db, sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const T0 = '2026-10-08T10:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();

function link(db) {
  db.exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '0016C001F1000001', '2026-01-01T00:00:00.000Z');");
}

test('duplicate delivery counts once (one observation, one device_data row, one outbox insertion)', async () => {
  const db = createDb();
  link(db);
  const h = harness(db);
  await h.uplink(at(0), v2(0, 100));
  const wet = await h.uplink(at(10), v2(6, 101));
  assert.deepEqual(await h.deliver(wet.payload), []);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 2);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE op='DEVICE_DATA_APPENDED'"), 2);
  assert.deepEqual(rows(db, 'SELECT rainfall_mm, rain_source FROM zone_daily_environment'), [{ rainfall_mm: 1, rain_source: 'sensecap_s2120' }]);
});

test('a confirmed-uplink retransmission (new deduplicationId, same devAddr, fCnt and payload) is a duplicate', async () => {
  const db = createDb();
  const h = harness(db);
  await h.uplink(at(0), v2(0, 100), DEV_EUI, { devAddr: '01000001', fCnt: 41 });
  const wet = await h.uplink(at(10), v2(6, 101), DEV_EUI, { devAddr: '01000001', fCnt: 42 });
  assert.deepEqual(await h.deliver({ ...wet.payload, deduplicationId: '00000000-0000-4000-8000-0000000009ff', time: at(10.1) }), []);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 2);
  assert.equal(db.prepare('SELECT rainfall_mm FROM zone_daily_environment').get().rainfall_mm, 1);
});

test('identity conflict is quarantined, not overwritten', async () => {
  const db = createDb();
  const h = harness(db);
  await h.uplink(at(0), v2(0, 100));
  const wet = await h.uplink(at(10), v2(6, 101));
  const raw = v2(6, 150);
  assert.deepEqual(await h.deliver({ ...wet.payload, data: Buffer.from(raw, 'hex').toString('base64'), object: decode(raw) }), []);
  assert.deepEqual(rows(db, 'SELECT deveui, channel, reason FROM ingest_quarantine'),
    [{ deveui: DEV_EUI, channel: 'rain_observation', reason: 'identity_conflict' }]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 2);
  assert.deepEqual(rows(db, 'SELECT amount_mm FROM rain_observations ORDER BY id'), [{ amount_mm: null }, { amount_mm: 1 }]);
});

test('failure between identity claim and persistence rolls back; the retry counts once; the marker cache is forgotten', async () => {
  const db = createDb();
  link(db);
  const failOn = { active: true, pattern: /^\s*INSERT INTO device_data/i };
  const h = harness(db, { failOn });
  const payload = (minutes, mm, n) => ({ deviceInfo: { devEui: DEV_EUI }, deduplicationId: '00000000-0000-4000-8000-0000000a000' + n,
    time: at(minutes), fPort: 3, data: Buffer.from(v2(0, mm), 'hex').toString('base64'), object: decode(v2(0, mm)) });
  const failedBaseline = await h.deliver(payload(0, 100, 1));
  assert.equal(failedBaseline.length, 1);
  assert.match(failedBaseline[0], /rolled back.*injected failure/);
  for (const table of ['rain_observations', 'device_data', 'zone_daily_environment', 'sync_outbox']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} empty after the rollback`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(h.store.get('s2120CounterBaseline') || {}, DEV_EUI),
    'the rolled-back baseline is not cached');
  failOn.active = false;
  assert.deepEqual(await h.deliver(payload(0, 100, 1)), []);
  assert.equal(lastRow(db).rain_delta_status, 'cumulative_baseline');
  failOn.active = true;
  assert.equal((await h.deliver(payload(10, 101, 2))).length, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM zone_daily_environment'), 0);
  failOn.active = false;
  assert.deepEqual(await h.deliver(payload(10, 101, 2)), []);
  assert.deepEqual(await h.deliver(payload(10, 101, 2)), [], 'a second delivery after the retry is a duplicate');
  assert.deepEqual(rows(db, 'SELECT rain_mm_delta, rain_delta_status FROM device_data ORDER BY id'),
    [{ rain_mm_delta: null, rain_delta_status: 'cumulative_baseline' }, { rain_mm_delta: 1, rain_delta_status: 'ok' }]);
  assert.equal(db.prepare('SELECT rainfall_mm FROM zone_daily_environment').get().rainfall_mm, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE op='DEVICE_DATA_APPENDED'"), 2);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='ZONE_ENVIRONMENT'"), 1);
});

test('missing deduplicationId is ambiguous identity: never counted and never a counter predecessor', async () => {
  const db = createDb();
  const h = harness(db);
  await h.uplink(at(0), v2(0, 100));
  const ambiguous = await h.uplink(at(10), v2(6, 101), DEV_EUI, { deduplicationId: undefined });
  assert.equal(ambiguous.obs.status, 'ambiguous_identity');
  assert.equal(ambiguous.obs.event_id, null);
  assert.equal(ambiguous.row.rain_delta_status, 'ambiguous_identity');
  assert.equal(ambiguous.row.rain_mm_delta, null);
  assert.equal(ambiguous.row.rain_gauge_cumulative_mm, 101, 'the reading itself is kept');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM zone_daily_environment'), 0);
  const next = await h.uplink(at(20), v2(6, 102));
  assert.equal(next.row.rain_mm_delta, 2, 'differenced against the last identified counter row, so no rain is lost');
  assert.equal(next.row.counter_interval_seconds, 1200);
  assert.equal(db.prepare('SELECT rainfall_mm FROM zone_daily_environment').get().rainfall_mm, 2);
});

test('a device of another type is ignored', async () => {
  const db = createDb();
  db.exec(`UPDATE devices SET type_id = 'DRAGINO_LSN50' WHERE deveui = '${DEV_EUI}'`);
  const h = harness(db);
  assert.deepEqual(await h.deliver({ deviceInfo: { devEui: DEV_EUI }, deduplicationId: 'ev-other', time: at(0), object: decode(v2(0, 1)) }), []);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM rain_observations'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM device_data'), 0);
});

test('a late counter frame is kept with late_counter_frame and its own difference, never counted; the next row is not rewritten', async () => {
  const db = createDb();
  const h = harness(db);
  await h.uplink(at(0), v2(0, 100));
  const after = await h.uplink(at(20), v2(6, 102));
  assert.equal(after.row.rain_mm_delta, 2);
  const late = await h.uplink(at(10), v2(6, 101));
  assert.equal(late.obs.status, 'not_additive');
  assert.equal(late.obs.frame_kind, 'counter');
  assert.equal(late.obs.amount_mm, null);
  assert.deepEqual(JSON.parse(late.obs.quality_reasons), ['late_counter_frame', 'out_of_order']);
  assert.deepEqual(JSON.parse(late.obs.config_json).counter, { previousAt: at(0), previousMm: 100, differenceMm: 1 });
  assert.equal(late.row.rain_delta_status, 'out_of_order');
  assert.equal(late.row.rain_mm_delta, null);
  assert.equal(db.prepare('SELECT rain_mm_delta FROM device_data WHERE id = ?').get(after.row.id).rain_mm_delta, 2, 'not rewritten');
  assert.equal(db.prepare('SELECT rainfall_mm FROM zone_daily_environment').get().rainfall_mm, 2);
});

test('observation rows: counter increments are protocol-verified intervals, legacy windows reception gaps, weather frames status rows', async () => {
  const db = createDb();
  const h = harness(db);
  const base = await h.uplink(at(0), v2(0, 100));
  assert.equal(base.obs.instrument_type, 'SENSECAP_S2120');
  assert.equal(base.obs.status, 'not_additive');
  assert.deepEqual(JSON.parse(base.obs.quality_reasons), ['cumulative_baseline']);
  const inc = await h.uplink(at(10), v2(6, 100.254));
  assert.deepEqual({ status: inc.obs.status, frame_kind: inc.obs.frame_kind, amount_mm: inc.obs.amount_mm, interval_basis: inc.obs.interval_basis,
    measured_start: inc.obs.measured_start, measured_end: inc.obs.measured_end, quality_reasons: inc.obs.quality_reasons, zone_id: inc.obs.zone_id,
    timezone: inc.obs.timezone, event_id: inc.obs.event_id },
  { status: 'accepted', frame_kind: 'counter', amount_mm: 0.254, interval_basis: 'protocol_verified', measured_start: at(0), measured_end: at(10),
    quality_reasons: '[]', zone_id: 1, timezone: 'UTC', event_id: inc.payload.deduplicationId });
  await h.uplink(at(0), legacy(0), DEV_EUI_2);
  const window = await h.uplink(at(10), legacy(1.524), DEV_EUI_2);
  assert.deepEqual({ status: window.obs.status, frame_kind: window.obs.frame_kind, amount_mm: window.obs.amount_mm, interval_basis: window.obs.interval_basis,
    measured_start: window.obs.measured_start, quality_reasons: window.obs.quality_reasons },
  { status: 'accepted', frame_kind: 'ordinary', amount_mm: 0.254, interval_basis: 'reception_gap', measured_start: at(0), quality_reasons: '["legacy_intensity_window"]' });
  const weather = await h.uplink(at(11), '4A' + '00EA' + '3C' + '0000' + '0000' + '0000' + '0000', DEV_EUI_2);
  assert.equal(weather.obs.frame_kind, 'status');
  assert.equal(weather.obs.status, 'not_additive');
  assert.equal(weather.row.rain_delta_status, 'no_rain_sensor');
  assert.equal(weather.row.rain_mm_today, null);
});

test('zone day: weather-station zones first; a zero never takes over another source\'s day, a positive increment does', async () => {
  const db = createDb();
  db.exec(`INSERT INTO weather_station_zones (deveui, zone_id, created_at) VALUES ('${DEV_EUI}', 2, '2026-01-01');
    INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at)
      VALUES (2, '2026-10-08', 5, 0, 'aquascope_lorain', '2026-10-08T09:00:00.000Z');`);
  const h = harness(db);
  await h.uplink(at(0), v2(0, 100));
  const dry = await h.uplink(at(10), v2(0, 100));
  assert.equal(dry.row.rain_delta_status, 'ok');
  assert.deepEqual(rows(db, 'SELECT zone_id, rainfall_mm, rain_source FROM zone_daily_environment ORDER BY zone_id'),
    [{ zone_id: 2, rainfall_mm: 5, rain_source: 'aquascope_lorain' }], 'the device zone is not written while a station zone exists');
  assert.equal(dry.obs.zone_id, 2, 'the observation snapshots the zone it reports to');
  await h.uplink(at(20), v2(1.524, 100.254));
  assert.deepEqual(rows(db, 'SELECT zone_id, rainfall_mm, rain_source FROM zone_daily_environment ORDER BY zone_id'),
    [{ zone_id: 2, rainfall_mm: 0.254, rain_source: 'sensecap_s2120' }]);
});

test('the farm day is the zone timezone, never the gateway host day', async () => {
  const db = createDb({ timezone: 'Europe/Zurich' });
  const h = harness(db);
  await h.uplink('2026-10-08T21:40:00.000Z', v2(0, 100));
  const late = await h.uplink('2026-10-08T21:50:00.000Z', v2(3, 100.5));
  assert.equal(late.row.rain_mm_today, 0.5);
  const midnight = await h.uplink('2026-10-08T22:10:00.000Z', v2(3, 101));
  assert.equal(midnight.row.rain_mm_today, 0.5, '00:10 in Zurich starts a new farm day');
  assert.deepEqual(rows(db, 'SELECT date, rainfall_mm FROM zone_daily_environment ORDER BY date'),
    [{ date: '2026-10-08', rainfall_mm: 0.5 }, { date: '2026-10-09', rainfall_mm: 0.5 }]);
  assert.equal(midnight.obs.timezone, 'Europe/Zurich');
});
