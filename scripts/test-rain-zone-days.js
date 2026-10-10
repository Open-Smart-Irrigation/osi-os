'use strict';
// Zone-day rain projection (docs/contracts/rainfall/zone-day-projection.md):
// one selected gauge per zone (owner decision D1), per-instrument days with
// coverage, and the zone_daily_environment projection written by the ingest
// writers. Run: TZ=UTC node --test scripts/test-rain-zone-days.js
// (the results must not depend on the host timezone).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { facadeDb, seedTestDb } = require('./lib/flow-node-harness');

const ROOT = path.resolve(__dirname, '..');
const NODE_RED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const R = require(path.join(NODE_RED, 'osi-rain/index.js'));
const CODEC = path.join(NODE_RED, 'codecs/aquascope_lorain_decoder.js');

const GAUGE_A = 'A840410000000001';
const GAUGE_B = 'A840410000000002';
const STATION = 'A840410000000003';
const LOCAL = 'A840410000000004';
// The test pins the build the frames below report (FPort 2, build 241015), so
// the gauges are promoted (D9); the shipped pinned set is empty.
const PINNED = [{ fPort: 2, buildDate: '241015' }];
const NOW = Date.parse('2026-10-10T03:00:00.000Z');

function decoder() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODEC, 'utf8'), sandbox, { filename: CODEC });
  return sandbox.decodeUplink;
}
const decodeUplink = decoder();

function seed() {
  const db = seedTestDb();
  db.exec(`INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES
    ('${GAUGE_A}','Gauge A','AQUASCOPE_LORAIN',2,1,'2026-01-01','2026-01-01');`);
  return db;
}
function addDevice(db, eui, type, zoneId, extra = '') {
  db.exec(`INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at${extra ? ',rain_gauge_enabled' : ''})
    VALUES ('${eui}','${type}','${type}',2,${zoneId === null ? 'NULL' : zoneId},'2026-01-01','2026-01-01'${extra ? ',' + extra : ''});`);
}
const tx = (db, fn) => facadeDb(db).transaction(fn);
const rows = (db, sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const one = (db, sql, ...params) => { const r = db.prepare(sql).get(...params); return r ? { ...r } : r; };

let eventSeq = 0;
// One LoRain frame through the module writer. hex: payload bytes.
async function loRain(db, eui, { devAddr, fCnt, time, hex, pinned = PINNED }) {
  eventSeq += 1;
  const bytes = Buffer.from(hex, 'hex');
  const object = decodeUplink({ fPort: 2, bytes }).data;
  return tx(db, (t) => R.ingestLoRainUplink(t, {
    deveui: eui, eventId: '00000000-0000-4000-8000-' + String(eventSeq).padStart(12, '0'), devAddr, fCnt, time, fPort: 2,
    data: bytes.toString('base64'), object,
  }, { nowMs: NOW, pinnedBuilds: pinned }));
}
// Join frame: build date 241015, hardware, configuration reply 900 s / 16 wakes, zero rain.
const JOIN_HEX = '0a0003ad7703050001040403840402001006030000060100b8068100001221000a';
const rainHex = (tips) => '06030000060100b8068100' + tips.toString(16).padStart(2, '0') + '1221000a';
// A promoted gauge over one UTC day: join the evening before, heartbeats every
// 4 h, rain at noon, and the frame after midnight that closes the day.
async function promotedDay(db, eui, { day = '2026-10-08', noonTips = 10, devAddr = '01000001', pinned = PINNED } = {}) {
  const prev = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const next = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const times = [prev + 'T20:00:00.000Z', day + 'T00:00:00.000Z', day + 'T04:00:00.000Z', day + 'T08:00:00.000Z',
    day + 'T12:00:00.000Z', day + 'T16:00:00.000Z', day + 'T20:00:00.000Z', next + 'T00:00:00.000Z'];
  const out = [];
  for (let i = 0; i < times.length; i += 1) {
    const hex = i === 0 ? JOIN_HEX : rainHex(i === 4 ? noonTips : 0);
    out.push(await loRain(db, eui, { devAddr, fCnt: i, time: times[i], hex, pinned }));
  }
  return out;
}
let s2120Seq = 0;
async function s2120(db, eui, time, cumulativeMm) {
  s2120Seq += 1;
  return tx(db, (t) => R.ingestS2120Uplink(t, {
    deveui: eui, eventId: '00000000-0000-4000-9000-' + String(s2120Seq).padStart(12, '0'), devAddr: '02000001', fCnt: s2120Seq, time, fPort: 3,
    object: { messages: [[{ measurementId: 4213, measurementValue: cumulativeMm }, { measurementId: 4097, measurementValue: 12 }]] },
  }, { nowMs: NOW, markerCache: new Map() }));
}
const resolve = (db, zoneId, day) => tx(db, (t) => R.resolveZoneRain(t, zoneId, day, { nowMs: NOW }));
const select = (db, zoneId, day) => tx(db, (t) => R.selectZoneGauge(t, zoneId, day));

// ---------------------------------------------------------------------------
// Gauge selection (Task 4; A14, A25)
// ---------------------------------------------------------------------------

test('single gauge is selected automatically', async () => {
  const db = seed();
  const sel = await select(db, 1, '2026-10-08');
  assert.deepEqual({ state: sel.state, deveui: sel.deveui, basis: sel.basis, candidates: sel.candidates },
    { state: 'selected', deveui: GAUGE_A, basis: 'only_candidate', candidates: [GAUGE_A] });
  await promotedDay(db, GAUGE_A);
  const rain = await resolve(db, 1, '2026-10-08');
  assert.deepEqual(rain, { amountMm: 5, receivedMm: 5, coverage: 'complete', source: 'aquascope_lorain', deveui: GAUGE_A, reasons: [], policyVersion: 1 });
});

test('a zone without a rain gauge has no selection and unknown rain', async () => {
  const db = seed();
  db.exec("INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES ('Z Three', 2, 'z-3', 'UTC', 'local')");
  const sel = await select(db, 3, '2026-10-08');
  assert.equal(sel.state, 'none');
  assert.deepEqual(await resolve(db, 3, '2026-10-08'),
    { amountMm: null, receivedMm: null, coverage: 'unknown', source: 'none', deveui: null, reasons: ['no_gauge'], policyVersion: 1 });
});

test('two gauges in a zone are never added: ambiguous until the operator selects one', async () => {
  const db = seed();
  addDevice(db, GAUGE_B, 'AQUASCOPE_LORAIN', 1);
  await promotedDay(db, GAUGE_A, { devAddr: '01000001' });
  await promotedDay(db, GAUGE_B, { devAddr: '01000002' });
  const sel = await select(db, 1, '2026-10-08');
  assert.equal(sel.state, 'ambiguous');
  assert.equal(sel.deveui, null);
  assert.deepEqual(sel.candidates, [GAUGE_A, GAUGE_B]);
  assert.equal(sel.suggestedDeveui, GAUGE_A, 'journal v1 order: direct, LoRain, DevEUI');
  assert.deepEqual(await resolve(db, 1, '2026-10-08'),
    { amountMm: null, receivedMm: null, coverage: 'unknown', source: 'none', deveui: null, reasons: ['gauge_ambiguous'], policyVersion: 1 });
  db.exec(`INSERT INTO zone_rain_source(zone_id, selected_deveui, updated_at) VALUES (1, '${GAUGE_B}', '2026-10-09T08:00:00.000Z')`);
  const chosen = await select(db, 1, '2026-10-08');
  assert.deepEqual({ state: chosen.state, deveui: chosen.deveui, basis: chosen.basis }, { state: 'selected', deveui: GAUGE_B, basis: 'explicit' });
  const rain = await resolve(db, 1, '2026-10-08');
  assert.equal(rain.amountMm, 5, 'one gauge, never 10');
  assert.equal(rain.deveui, GAUGE_B);
});

test('an explicit selection that is no longer a candidate falls back to the candidates', async () => {
  const db = seed();
  db.exec(`INSERT INTO zone_rain_source(zone_id, selected_deveui, updated_at) VALUES (1, '${GAUGE_B}', '2026-10-09T08:00:00.000Z')`);
  const sel = await select(db, 1, '2026-10-08');
  assert.deepEqual({ state: sel.state, deveui: sel.deveui, basis: sel.basis }, { state: 'selected', deveui: GAUGE_A, basis: 'only_candidate' });
  addDevice(db, GAUGE_B, 'AQUASCOPE_LORAIN', 1);
  db.exec(`UPDATE devices SET deleted_at='2026-10-09T09:00:00.000Z' WHERE deveui='${GAUGE_B}'`);
  assert.equal((await select(db, 1, '2026-10-08')).deveui, GAUGE_A, 'a deleted device is not a candidate');
});

test('candidates: LoRain, S2120, rain_gauge_enabled devices and weather-station gauges; not other devices', async () => {
  const db = seed();
  addDevice(db, LOCAL, 'DRAGINO_LSN50', 1, '1');
  db.exec(`INSERT INTO weather_station_zones(deveui, zone_id) VALUES ('WX1', 1)`);
  const sel = await select(db, 1, null);
  assert.equal(sel.state, 'ambiguous');
  assert.deepEqual(sel.candidates, [GAUGE_A, LOCAL, 'WX1'], 'DENDRO1 and VALVE1 (zone 1, no rain gauge) are not candidates');
  assert.equal(sel.suggestedDeveui, GAUGE_A);
});

test('mixed type zone does not overwrite by arrival order', async () => {
  const db = seed();
  addDevice(db, STATION, 'SENSECAP_S2120', 2);
  db.exec(`INSERT INTO weather_station_zones(deveui, zone_id) VALUES ('${STATION}', 1)`);
  await promotedDay(db, GAUGE_A);
  await s2120(db, STATION, '2026-10-07T21:00:00.000Z', 100);
  await s2120(db, STATION, '2026-10-08T21:00:00.000Z', 103);
  const ambiguous = await resolve(db, 1, '2026-10-08');
  assert.equal(ambiguous.coverage, 'unknown');
  assert.deepEqual(ambiguous.reasons, ['gauge_ambiguous']);
  const sel = await select(db, 1, '2026-10-08');
  assert.equal(sel.suggestedDeveui, GAUGE_A, 'LoRain before S2120');
  db.exec(`INSERT INTO zone_rain_source(zone_id, selected_deveui, updated_at) VALUES (1, '${GAUGE_A}', '2026-10-09T08:00:00.000Z')`);
  const before = await resolve(db, 1, '2026-10-08');
  assert.equal(before.source, 'aquascope_lorain');
  assert.equal(before.amountMm, 5);
  await s2120(db, STATION, '2026-10-08T21:30:00.000Z', 109);
  assert.deepEqual(await resolve(db, 1, '2026-10-08'), before, 'a later S2120 report does not change the LoRain-selected day');
});

test('a gauge moved to another zone stays a candidate of its earlier days in the old zone', async () => {
  const db = seed();
  db.exec("UPDATE devices SET irrigation_zone_id=NULL WHERE deveui='WX1'");
  await promotedDay(db, GAUGE_A, { noonTips: 6 });
  db.exec(`UPDATE devices SET irrigation_zone_id=2 WHERE deveui='${GAUGE_A}'`);
  const old = await select(db, 1, '2026-10-08');
  assert.deepEqual({ state: old.state, deveui: old.deveui }, { state: 'selected', deveui: GAUGE_A });
  assert.equal((await resolve(db, 1, '2026-10-08')).amountMm, 3, 'day 1 of zone 1 keeps its 3 mm');
  const moved = await resolve(db, 2, '2026-10-08');
  assert.equal(moved.amountMm, null);
  assert.equal(moved.receivedMm, null, 'nothing from the gauge reaches zone 2 for the day before the move');
  assert.ok(moved.reasons.includes('zone_reassigned'));
  assert.equal((await select(db, 1, null)).state, 'none', 'without a day the zone has no current gauge');
});
