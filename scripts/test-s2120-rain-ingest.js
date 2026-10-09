#!/usr/bin/env node
'use strict';

// S2120 rain ingest contract, exercised through the shipped codec and the
// shipped Node-RED function bodies against an in-memory SQLite database that
// uses the real device_data DDL from database/seed-blank.sql.
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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb } = require('./lib/scoped-access-harness');

const repoRoot = path.resolve(__dirname, '..');
const shareDir = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share');
const flows = JSON.parse(fs.readFileSync(path.join(shareDir, 'flows.json'), 'utf8'));
const seedSql = fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8');

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

function ddl(table) {
  const match = seedSql.match(new RegExp('CREATE TABLE ' + table + ' \\([\\s\\S]*?\\n\\);'));
  assert.ok(match, 'seed-blank.sql has no CREATE TABLE ' + table);
  return match[0];
}

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec([
    'CREATE TABLE devices(deveui TEXT PRIMARY KEY, type_id TEXT, irrigation_zone_id INTEGER, deleted_at TEXT);',
    'CREATE TABLE irrigation_zones(id INTEGER PRIMARY KEY, timezone TEXT, deleted_at TEXT);',
    "CREATE TABLE weather_station_zones(deveui TEXT NOT NULL, zone_id INTEGER NOT NULL, created_at TEXT, PRIMARY KEY (deveui, zone_id));",
    ddl('device_data'),
    ddl('zone_daily_environment').replace(/,\s*FOREIGN KEY[^\n]*\n/, '\n'),
  ].join('\n'));
  db.prepare("INSERT INTO devices VALUES (?, 'SENSECAP_S2120', 1, NULL)").run(DEV_EUI);
  db.prepare("INSERT INTO devices VALUES (?, 'SENSECAP_S2120', 1, NULL)").run(DEV_EUI_2);
  db.prepare("INSERT INTO irrigation_zones VALUES (1, 'UTC', NULL)").run();
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

function harness(db) {
  const facade = facadeDb(db);
  const stats = { markerLookups: 0 };
  const counting = Object.assign({}, facade, {
    all(sql, ...rest) {
      if (/rain_delta_status = 'cumulative_baseline'/.test(sql)) stats.markerLookups += 1;
      return facade.all(sql, ...rest);
    },
  });
  const osiDb = { Database: function Database() { return counting; } };
  // Node context persists across messages within one Node-RED run.
  const store = new Map();
  const context = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
  const osiLib = {
    require(name) {
      if (name === 'uplink-dedup') return { ok: true, value: { isDuplicateUplink: () => false } };
      return { ok: false, error: 'unexpected module ' + name };
    },
  };
  const node = { status() {}, warn() {}, error(message) { throw new Error(String(message)); } };
  const processFn = new AsyncFunction('msg', 'osiDb', 'osiLib', 'node', 'context', nodeBody('s2120-process-fn'));
  const sqlFn = new AsyncFunction('msg', 'node', nodeBody('s2120-sql-fn'));
  const aggFn = new AsyncFunction('msg', 'osiDb', 'node', nodeBody('s2120-rain-agg-fn'));

  async function uplink(time, rawHex, devEui = DEV_EUI) {
    const msg = { payload: { deviceInfo: { devEui }, time, object: decode(rawHex) } };
    const [stored, rainOut] = await processFn(msg, osiDb, osiLib, node, context);
    assert.ok(stored && stored.formattedData, 'process node dropped the uplink');
    const sqlMsg = await sqlFn({ formattedData: stored.formattedData }, node);
    db.exec(sqlMsg.topic);
    if (rainOut) await aggFn(rainOut, osiDb, node);
    return { formatted: stored.formattedData, rainOut, row: lastRow(db, devEui) };
  }
  return { uplink, stats };
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
  assert.ok(second.rainOut, 'a valid increment reaches the zone aggregation');
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
  assert.equal(reset.rainOut, null);
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
  assert.equal(first.rainOut, null);
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
  assert.ok(second.rainOut);
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
  assert.equal(gap.rainOut, null);
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
  assert.equal(dup.rainOut, null);

  await uplink('2026-10-08T10:00:00.000Z', v2(0, 7), DEV_EUI_2);
  await uplink('2026-10-08T10:10:00.000Z', v2(1.524, 7.254), DEV_EUI_2);
  const counterDup = await uplink('2026-10-08T10:10:00.000Z', v2(3.048, 7.508), DEV_EUI_2);
  assert.equal(counterDup.formatted.rainDeltaStatus, 'duplicate_timestamp', 'counter path');
  assert.equal(counterDup.formatted.rainMmDelta, null);
  assert.equal(counterDup.rainOut, null);
});

test('an out-of-order counter uplink is skipped and does not move the baseline', async () => {
  const db = createDb();
  const { uplink } = harness(db);
  await uplink('2026-10-08T10:00:00.000Z', v2(0, 4));
  await uplink('2026-10-08T10:20:00.000Z', v2(0, 4.508));
  const late = await uplink('2026-10-08T10:10:00.000Z', v2(1.524, 4.254));
  assert.equal(late.formatted.rainDeltaStatus, 'out_of_order');
  assert.equal(late.formatted.rainMmDelta, null);
  assert.equal(late.rainOut, null);
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
  assert.ok(dry.rainOut, 'a measured zero is emitted, not dropped');
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
