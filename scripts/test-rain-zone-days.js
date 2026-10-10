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

// ---------------------------------------------------------------------------
// Projection and writers, end to end through the ingest nodes (Task 6; A5, A12, A31)
// ---------------------------------------------------------------------------
const { loadNode, executeFunction } = require('./lib/flow-node-harness');

// Node-RED runs a function body as an AsyncFunction; the shared harness uses a plain Function.
function asyncNode(id) {
  const node = loadNode(id);
  return { ...node, func: 'return (async () => {\n' + node.func + '\n})();' };
}
// osi-rain as the node loads it, with the test's pinned build (the shipped set is empty).
const PINNED_RAIN = { ...R, ingestLoRainUplink: (t, uplink, opts) => R.ingestLoRainUplink(t, uplink, { ...opts, pinnedBuilds: PINNED }) };
let nodeSeq = 0;
async function loRainNode(db, eui, { devAddr = '01000001', fCnt, time, hex, rain = PINNED_RAIN }) {
  nodeSeq += 1;
  const bytes = Buffer.from(hex, 'hex');
  const msg = { payload: {
    deviceInfo: { devEui: eui.toLowerCase(), deviceProfileName: 'Aqua-Scope LoRain', applicationId: 'app-sensors' },
    deduplicationId: '00000000-0000-4000-a000-' + String(nodeSeq).padStart(12, '0'),
    devAddr, fCnt, time, fPort: 2, data: bytes.toString('base64'), object: decodeUplink({ fPort: 2, bytes }).data,
  } };
  const out = await executeFunction(asyncNode('lorain-ingest-fn'), { msg, db, osiLibModules: { rain } });
  assert.deepEqual(out.errors, []);
  return out;
}
// A promoted chain over one farm day of `timezone`: join 2 h before the day,
// a frame every 4 h from midnight, rain at index `rainAt`, and the first frame
// after the day's end. skip: chain indexes to leave out (a lost frame).
function dayChain(dayStartIso, dayEndIso, { rainAt = 4, tips = 10, skip = [] } = {}) {
  const start = Date.parse(dayStartIso);
  const end = Date.parse(dayEndIso);
  const times = [start - 2 * 3600000];
  for (let ms = start; ms < end; ms += 4 * 3600000) times.push(ms);
  times.push(end);
  return times.map((ms, i) => ({ fCnt: i, time: new Date(ms).toISOString(), hex: i === 0 ? JOIN_HEX : rainHex(i === rainAt ? tips : 0) }))
    .filter((f) => !skip.includes(f.fCnt));
}
const zoneRow = (db, zoneId, date) => one(db, 'SELECT rainfall_mm, rain_received_mm, rain_coverage, rain_selected_deveui, rain_policy_version, '
  + 'rain_quality_reasons, rain_source, flow_liters, sync_version, computed_at FROM zone_daily_environment WHERE zone_id = ? AND date = ?', zoneId, date);
const D = { start: '2026-10-08T00:00:00.000Z', end: '2026-10-09T00:00:00.000Z' };

test('(a) a complete day projects rainfall_mm, coverage complete, the selected gauge and policy 1', async () => {
  const db = seed();
  for (const f of dayChain(D.start, D.end)) await loRainNode(db, GAUGE_A, f);
  const row = zoneRow(db, 1, '2026-10-08');
  assert.deepEqual({ ...row, computed_at: undefined, sync_version: undefined }, {
    rainfall_mm: 5, rain_received_mm: 5, rain_coverage: 'complete', rain_selected_deveui: GAUGE_A, rain_policy_version: 1,
    rain_quality_reasons: '[]', rain_source: 'aquascope_lorain', flow_liters: 0, sync_version: undefined, computed_at: undefined,
  });
  const inst = one(db, "SELECT amount_mm, received_mm, coverage, accepted_count, policy_version FROM rain_instrument_days WHERE deveui = ? AND date = '2026-10-08' AND timezone = 'UTC'", GAUGE_A);
  assert.deepEqual(inst, { amount_mm: 5, received_mm: 5, coverage: 'complete', accepted_count: 6, policy_version: 1 });
});

test('(b) a partial day projects rainfall_mm NULL and rain_received_mm', async () => {
  const db = seed();
  for (const f of dayChain(D.start, D.end, { skip: [3] })) await loRainNode(db, GAUGE_A, f);
  const row = zoneRow(db, 1, '2026-10-08');
  assert.equal(row.rainfall_mm, null);
  assert.equal(row.rain_received_mm, 5);
  assert.equal(row.rain_coverage, 'partial');
  assert.deepEqual(JSON.parse(row.rain_quality_reasons), ['frame_gap']);
});

test('without promotion every LoRain day is unknown with received_only and rainfall_mm NULL (D9)', async () => {
  const db = seed();
  for (const f of dayChain(D.start, D.end)) await loRainNode(db, GAUGE_A, { ...f, rain: R });
  const row = zoneRow(db, 1, '2026-10-08');
  assert.equal(row.rainfall_mm, null);
  assert.equal(row.rain_received_mm, 5);
  assert.equal(row.rain_coverage, 'unknown');
  assert.ok(JSON.parse(row.rain_quality_reasons).includes('build_unpinned'), 'no pinned build: received only');
});

test('(c) a late distinct observation that completes a day re-projects it and increments sync_version exactly once', async () => {
  const db = seed();
  db.exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '0016C001F1000001', '2026-01-01T00:00:00.000Z')");
  const chain = dayChain(D.start, D.end);
  const lost = chain.find((f) => f.fCnt === 3);
  for (const f of chain.filter((x) => x !== lost)) await loRainNode(db, GAUGE_A, f);
  const before = zoneRow(db, 1, '2026-10-08');
  assert.equal(before.rain_coverage, 'partial');
  const events = () => db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type = 'ZONE_ENVIRONMENT' AND aggregate_key = 'z-1|2026-10-08'").get().n;
  const eventsBefore = events();
  await loRainNode(db, GAUGE_A, lost);
  const after = zoneRow(db, 1, '2026-10-08');
  assert.equal(after.rain_coverage, 'complete');
  assert.equal(after.rainfall_mm, 5);
  assert.equal(after.sync_version, before.sync_version + 1, 'exactly one increment');
  assert.ok(after.computed_at > before.computed_at, 'a new computed_at with the projected change');
  assert.equal(events(), eventsBefore + 1, 'one outbox event for the correction');
  // Re-delivering the same observation changes nothing and emits nothing.
  const msgAgain = await loRainNode(db, GAUGE_A, { ...lost });
  assert.deepEqual(msgAgain.errors, []);
  assert.deepEqual(zoneRow(db, 1, '2026-10-08'), after);
});

test('(d) a recompute that changes nothing does not increment sync_version or touch computed_at', async () => {
  const db = seed();
  for (const f of dayChain(D.start, D.end)) await loRainNode(db, GAUGE_A, f);
  const before = zoneRow(db, 1, '2026-10-08');
  const out = await tx(db, (t) => R.recomputeZoneDay(t, 1, '2026-10-08', { trigger: 'accepted' }));
  assert.equal(out.written, false);
  assert.deepEqual(zoneRow(db, 1, '2026-10-08'), before);
});

test('(e) gateway host in UTC, zone in Europe/Zurich, 25-hour day: the farm day is the zone day', async () => {
  const db = seed();
  db.exec("UPDATE irrigation_zones SET timezone = 'Europe/Zurich' WHERE id = 1");
  // 2025-10-26 in Zurich runs from 2025-10-25T22:00Z to 2025-10-26T23:00Z (25 hours).
  for (const f of dayChain('2025-10-25T22:00:00.000Z', '2025-10-26T23:00:00.000Z', { rainAt: 6, tips: 4 })) await loRainNode(db, GAUGE_A, f);
  const row = zoneRow(db, 1, '2025-10-26');
  assert.equal(row.rain_coverage, 'complete');
  assert.equal(row.rainfall_mm, 2);
  assert.equal(one(db, "SELECT COUNT(*) AS n FROM zone_daily_environment WHERE zone_id = 1 AND date = '2025-10-25' AND rain_received_mm > 0").n, 0,
    'nothing carried over from the host day');
});

test('(f) flow_liters written by lsn50-zone-agg-fn survives a rain recomputation; the flow-only insert is labelled', async () => {
  const db = seed();
  const flowMsg = { formattedData: { detectedMode: 9, devEui: 'DENDRO1', timestamp: '2026-10-08T03:00:00.000Z',
    rainDeltaStatus: 'first_sample', rainMmDelta: null, flowDeltaStatus: 'ok', flowLitersDelta: 12 } };
  const out = await executeFunction(asyncNode('lsn50-zone-agg-fn'), { msg: flowMsg, db });
  assert.deepEqual(out.warnings, []);
  const flowOnly = zoneRow(db, 1, '2026-10-08');
  assert.equal(flowOnly.flow_liters, 12);
  assert.equal(flowOnly.rain_coverage, 'unknown', 'a flow-only insert at policy 1 carries a coverage, never NULL (legacy)');
  assert.equal(flowOnly.rain_source, 'aquascope_lorain');
  for (const f of dayChain(D.start, D.end)) await loRainNode(db, GAUGE_A, f);
  const row = zoneRow(db, 1, '2026-10-08');
  assert.equal(row.flow_liters, 12);
  assert.equal(row.rainfall_mm, 5);
});

test('(g) a pre-0072 legacy row is not modified by a recompute of another date', async () => {
  const db = seed();
  db.exec(`INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, sync_version)
    VALUES (1, '2026-10-07', 3.5, 0, 'aquascope_lorain', '2026-10-07T23:00:00.000Z', 4)`);
  const legacy = zoneRow(db, 1, '2026-10-07');
  for (const f of dayChain(D.start, D.end).slice(1)) await loRainNode(db, GAUGE_A, f);
  await tx(db, (t) => R.recomputeZoneDay(t, 1, '2026-10-08', { trigger: 'accepted' }));
  assert.deepEqual(zoneRow(db, 1, '2026-10-07'), legacy);
});

test('the day of a move: each zone counts only what it received, and neither certifies the day', async () => {
  const db = seed();
  db.exec("UPDATE devices SET irrigation_zone_id = NULL WHERE deveui = 'WX1'");
  const chain = dayChain(D.start, D.end, { rainAt: 2, tips: 4 });
  // Frames up to 08:00 under zone 1 (rain 2 mm at 04:00), then the gauge moves to zone 2.
  for (const f of chain.slice(0, 4)) await loRainNode(db, GAUGE_A, f);
  db.exec(`UPDATE devices SET irrigation_zone_id = 2 WHERE deveui = '${GAUGE_A}'`);
  const rest = chain.slice(4).map((f) => (f.fCnt === 5 ? { ...f, hex: rainHex(6) } : f));
  for (const f of rest) await loRainNode(db, GAUGE_A, f);
  const zone1 = zoneRow(db, 1, '2026-10-08');
  const zone2 = zoneRow(db, 2, '2026-10-08');
  assert.deepEqual([zone1.rainfall_mm, zone1.rain_received_mm, zone1.rain_coverage], [null, 2, 'partial']);
  assert.deepEqual([zone2.rainfall_mm, zone2.rain_received_mm, zone2.rain_coverage], [null, 3, 'partial']);
  assert.ok(JSON.parse(zone1.rain_quality_reasons).includes('zone_reassigned'));
  assert.ok(JSON.parse(zone2.rain_quality_reasons).includes('zone_reassigned'));
  const inst = one(db, "SELECT amount_mm, coverage FROM rain_instrument_days WHERE deveui = ? AND date = '2026-10-08' AND timezone = 'UTC'", GAUGE_A);
  assert.deepEqual(inst, { amount_mm: 5, coverage: 'complete' }, 'the instrument itself measured the whole day');
});

test('reassignment keeps history: day 1 of the old zone keeps its amount, the new zone gets nothing from it', async () => {
  const db = seed();
  db.exec("UPDATE devices SET irrigation_zone_id = NULL WHERE deveui = 'WX1'");
  for (const f of dayChain(D.start, D.end, { tips: 6 })) await loRainNode(db, GAUGE_A, f);
  db.exec(`UPDATE devices SET irrigation_zone_id = 2 WHERE deveui = '${GAUGE_A}'`);
  // The next day's frames arrive under zone 2.
  for (const f of dayChain('2026-10-09T00:00:00.000Z', '2026-10-10T00:00:00.000Z', { tips: 2 }).slice(2).map((f) => ({ ...f, fCnt: f.fCnt + 6 }))) {
    await loRainNode(db, GAUGE_A, f);
  }
  const old = zoneRow(db, 1, '2026-10-08');
  assert.deepEqual([old.rainfall_mm, old.rain_selected_deveui], [3, GAUGE_A]);
  await tx(db, (t) => R.recomputeZoneDay(t, 1, '2026-10-08', { trigger: 'selection' }));
  assert.equal(zoneRow(db, 1, '2026-10-08').rainfall_mm, 3, 'a recomputation of the old day keeps it in the old zone');
  assert.equal(zoneRow(db, 2, '2026-10-08'), undefined, 'zone 2 has no row for the day before the move');
  const z2 = await resolve(db, 2, '2026-10-08');
  assert.equal(z2.receivedMm, null);
  assert.equal(z2.amountMm, null);
});

test('two gauges through the nodes: an ambiguous zone stays unknown until a selection, never the sum', async () => {
  const db = seed();
  addDevice(db, GAUGE_B, 'AQUASCOPE_LORAIN', 1);
  for (const f of dayChain(D.start, D.end)) await loRainNode(db, GAUGE_A, { ...f, devAddr: '01000001' });
  for (const f of dayChain(D.start, D.end)) await loRainNode(db, GAUGE_B, { ...f, devAddr: '01000002' });
  const row = zoneRow(db, 1, '2026-10-08');
  assert.deepEqual([row.rainfall_mm, row.rain_received_mm, row.rain_coverage, row.rain_source, row.rain_selected_deveui],
    [null, null, 'unknown', 'none', null]);
  assert.deepEqual(JSON.parse(row.rain_quality_reasons), ['gauge_ambiguous']);
  db.exec(`INSERT INTO zone_rain_source(zone_id, selected_deveui, updated_at) VALUES (1, '${GAUGE_A}', '2026-10-09T08:00:00.000Z')`);
  await tx(db, (t) => R.recomputeZoneDay(t, 1, '2026-10-08', { trigger: 'selection' }));
  const chosen = zoneRow(db, 1, '2026-10-08');
  assert.deepEqual([chosen.rainfall_mm, chosen.rain_selected_deveui, chosen.rain_coverage], [5, GAUGE_A, 'complete']);
  assert.equal(chosen.sync_version, row.sync_version + 1);
});

test('A31: a valid dry LoRain report creates a zone row with 0 mm received; a silent gauge has none', async () => {
  const db = seed();
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM zone_daily_environment').n, 0);
  await loRainNode(db, GAUGE_A, { fCnt: 1, time: '2026-10-08T10:00:00.000Z', hex: rainHex(0), rain: R });
  const row = zoneRow(db, 1, '2026-10-08');
  assert.deepEqual([row.rain_received_mm, row.rain_source, row.rainfall_mm], [0, 'aquascope_lorain', null]);
});
