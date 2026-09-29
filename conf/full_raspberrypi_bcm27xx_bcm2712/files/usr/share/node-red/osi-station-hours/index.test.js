'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sh = require('./index');

const REPO = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');

// Same shape the flow node passes; inside transaction() only the scope may be
// used (the facade would deadlock on the outer db), so the outer calls throw.
function scratchDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  let inTx = false;
  const scope = {
    all: async (sql, params) => raw.prepare(sql).all(...(params || [])),
    run: async (sql, params) => { raw.prepare(sql).run(...(params || [])); },
  };
  const guard = () => { if (inTx) throw new Error('outer db used inside transaction()'); };
  return {
    raw,
    all: async (sql, params) => { guard(); return scope.all(sql, params); },
    run: async (sql, params) => { guard(); return scope.run(sql, params); },
    transaction: async (fn) => {
      raw.exec('BEGIN IMMEDIATE');
      inTx = true;
      try { const result = await fn(scope); raw.exec('COMMIT'); return result; } catch (error) { raw.exec('ROLLBACK'); throw error; } finally { inTx = false; }
    },
  };
}

function seedZone(db, id) {
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z') ON CONFLICT DO NOTHING").run();
  db.raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, zone_uuid) VALUES (?, 1, ?, 46.8, 6.95, 'Europe/Zurich', ?)").run(id, 'Z' + id, '00000000-0000-4000-8000-' + String(id).padStart(12, '0'));
}

// devices: deveui, name, type_id, created_at and updated_at are NOT NULL (seed-blank.sql, CREATE TABLE devices).
function seedStation(db, deveui, zoneId) {
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, ?, 'SENSECAP_S2120', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')").run(deveui, 'S2120 ' + deveui.slice(-4));
  if (zoneId != null) db.raw.prepare('INSERT INTO weather_station_zones (deveui, zone_id) VALUES (?, ?)').run(deveui, zoneId);
}

function sample(db, deveui, recordedAt, t, lux) {
  db.raw.prepare('INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity, wind_speed_mps, barometric_pressure_hpa, light_lux, rain_mm_delta) VALUES (?, ?, ?, 50, 1, 960, ?, 0)').run(deveui, recordedAt, t, lux);
}

function hours(db) {
  return db.raw.prepare('SELECT hour_start, air_temperature_c, sample_count FROM weather_station_hours ORDER BY hour_start').all().map((r) => ({ ...r }));
}

test('hourlyAggregate: means, min/max, sums, counts; a field with no sample is null', () => {
  const rows = [
    { ambient_temperature: 20, relative_humidity: 60, wind_speed_mps: 1.0, barometric_pressure_hpa: 960, light_lux: 12000, rain_mm_delta: 0.2 },
    { ambient_temperature: 22, relative_humidity: 50, wind_speed_mps: 2.0, barometric_pressure_hpa: 962, light_lux: null, rain_mm_delta: null },
    { ambient_temperature: null, relative_humidity: 55, wind_speed_mps: null, barometric_pressure_hpa: null, light_lux: 24000, rain_mm_delta: 0.3 },
  ];
  assert.deepEqual(sh.hourlyAggregate(rows), {
    air_temperature_c: 21, air_temperature_min_c: 20, air_temperature_max_c: 22,
    relative_humidity_pct: 55, wind_speed_mps: 1.5, pressure_hpa: 961,
    light_lux: 18000, global_radiation_wm2: 150, rain_mm: 0.5, sample_count: 3,
  });
  assert.equal(sh.hourlyAggregate([{ ambient_temperature: 20 }]).light_lux, null);
  assert.equal(sh.hourlyAggregate([{ ambient_temperature: 20 }]).global_radiation_wm2, null);
});

test('aggregateStationHours writes one row per assigned station and completed UTC hour, idempotently', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  for (const [ts, t, lux] of [['2026-09-25T13:05:00.000Z', 20, 10000], ['2026-09-25T13:35:00.000Z', 22, 30000], ['2026-09-25T14:10:00.000Z', 23, 40000], ['2026-09-25T15:05:00.000Z', 24, 50000]]) sample(db, 'S2120AAAA00000001', ts, t, lux);
  const first = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(first, { devices: 1, hours: 2, written: 2, unchanged: 0, failed: 0 }); // 15:00 is in progress
  assert.deepEqual(hours(db), [{ hour_start: '2026-09-25T13:00:00Z', air_temperature_c: 21, sample_count: 2 }, { hour_start: '2026-09-25T14:00:00Z', air_temperature_c: 23, sample_count: 1 }]);
  const computedAt = db.raw.prepare("SELECT computed_at FROM weather_station_hours WHERE hour_start = '2026-09-25T13:00:00Z'").get().computed_at;
  const second = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:25:00Z', warn: () => {} });
  assert.deepEqual(second, { devices: 1, hours: 2, written: 0, unchanged: 2, failed: 0 });
  assert.equal(db.raw.prepare("SELECT computed_at FROM weather_station_hours WHERE hour_start = '2026-09-25T13:00:00Z'").get().computed_at, computedAt);
});

test('aggregateStationHours ignores stations assigned to no zone and hours with no sample', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStation(db, 'S2120BBBB00000002', null);
  sample(db, 'S2120AAAA00000001', '2026-09-25T13:05:00.000Z', 20, 1000);
  sample(db, 'S2120AAAA00000001', '2026-09-25T15:05:00.000Z', 22, 1000);
  sample(db, 'S2120BBBB00000002', '2026-09-25T13:05:00.000Z', 20, 1000);
  const summary = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T16:20:00Z', warn: () => {} });
  assert.deepEqual(summary, { devices: 1, hours: 2, written: 2, unchanged: 0, failed: 0 });
  assert.deepEqual(hours(db).map((r) => r.hour_start), ['2026-09-25T13:00:00Z', '2026-09-25T15:00:00Z']);
});

test('a sample exactly on the hour belongs to that hour (bounds in the .000Z form of recorded_at)', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  sample(db, 'S2120AAAA00000001', '2026-09-25T13:00:00.000Z', 20, 1000);
  sample(db, 'S2120AAAA00000001', '2026-09-25T14:00:00.000Z', 30, 1000);
  await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(hours(db), [{ hour_start: '2026-09-25T13:00:00Z', air_temperature_c: 20, sample_count: 1 }, { hour_start: '2026-09-25T14:00:00Z', air_temperature_c: 30, sample_count: 1 }]);
});

test('a station on a 60-minute uplink leaves an hour without a row when jitter skips it', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  for (const ts of ['2026-09-25T12:58:00.000Z', '2026-09-25T14:02:00.000Z', '2026-09-25T14:58:00.000Z']) sample(db, 'S2120AAAA00000001', ts, 20, 1000);
  const summary = await sh.aggregateStationHours({ db, nowIso: '2026-09-25T16:10:00Z', warn: () => {} });
  assert.equal(summary.hours, 2);
  assert.deepEqual(hours(db).map((r) => [r.hour_start, r.sample_count]), [['2026-09-25T12:00:00Z', 1], ['2026-09-25T14:00:00Z', 2]]);
});

test('an unaggregated hour older than 48 h but within 7 days is picked up; older samples are not', async () => {
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  sample(db, 'S2120AAAA00000001', '2026-09-23T03:10:00.000Z', 18, 0);   // 60 h before now
  sample(db, 'S2120AAAA00000001', '2026-09-16T03:10:00.000Z', 18, 0);   // 228 h before now
  await sh.aggregateStationHours({ db, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(hours(db).map((r) => r.hour_start), ['2026-09-23T03:00:00Z']);
});

test('clock guard: a 1970 clock and a clock 25 h behind the newest stored hour skip with one warning; 1 h behind aggregates', async () => {
  sh.resetState();
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  sample(db, 'S2120AAAA00000001', '2026-09-25T13:05:00.000Z', 20, 1000);
  const warnings = [];
  const run = (nowIso) => sh.aggregateStationHours({ db, nowIso, warn: (m) => warnings.push(m) });
  const epoch = await run('1970-01-01T00:02:00.000Z');
  assert.equal(epoch.skipped, 'clock_behind_store');
  await run('1970-01-01T00:07:00.000Z');
  assert.equal(warnings.length, 1, 'the same problem a few minutes later is not warned again');
  assert.equal(hours(db).length, 0);
  assert.equal((await run('2026-09-25T15:20:00Z')).written, 1);
  assert.equal(warnings.at(-1), 'clock: recovered');
  db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, sample_count, computed_at) VALUES ('S2120AAAA00000001', '2026-09-26T16:00:00Z', 1, '2026-09-26T16:10:00Z')").run();
  const behind = await run('2026-09-25T15:20:00Z'); // 24 h 40 min before the newest stored hour
  assert.deepEqual([behind.skipped, behind.written], ['clock_behind_store', 0]);
  assert.match(warnings.at(-1), /^clock behind the store/);
  const close = await run('2026-09-26T15:20:00Z'); // 40 min behind
  assert.equal(close.skipped, undefined);
});

test('per-station warnings are logged once per problem (digits and instants masked); a recovery logs and re-arms', async () => {
  sh.resetState();
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  sample(db, 'S2120AAAA00000001', '2026-09-25T13:05:00.000Z', 20, 1000);
  const warnings = [];
  let failure = (n) => `database is locked after ${n} ms at 2026-09-25T15:2${n}:00Z`;
  let n = 0;
  const flaky = { ...db, transaction: async (fn) => { if (failure) throw new Error(failure(n += 1)); return db.transaction(fn); } };
  const run = () => sh.aggregateStationHours({ db: flaky, nowIso: '2026-09-25T15:20:00Z', warn: (m) => warnings.push(m) });
  assert.equal((await run()).failed, 1);
  await run();
  assert.equal(warnings.length, 1);
  failure = () => 'disk I/O error';
  await run();
  assert.equal(warnings.length, 2);
  failure = null;
  const ok = await run();
  assert.deepEqual([ok.failed, ok.written, warnings.at(-1)], [0, 1, 'S2120AAAA00000001: recovered']);
  failure = () => 'disk I/O error';
  await run();
  assert.equal(warnings.length, 4, 'after a recovery the same problem logs again');
});

test('a rolled-back station adds nothing to the summary', async () => {
  sh.resetState();
  const db = scratchDb();
  seedZone(db, 1);
  seedStation(db, 'S2120AAAA00000001', 1);
  sample(db, 'S2120AAAA00000001', '2026-09-25T13:05:00.000Z', 20, 1000);
  sample(db, 'S2120AAAA00000001', '2026-09-25T14:05:00.000Z', 20, 1000);
  // The second upsert fails inside the transaction: the first one is rolled back.
  const failing = { ...db, transaction: (fn) => db.transaction(async (tx) => { let calls = 0; return fn({ ...tx, all: async (sql, p) => { calls += 1; if (calls === 2) throw new Error('boom'); return tx.all(sql, p); } }); }) };
  const summary = await sh.aggregateStationHours({ db: failing, nowIso: '2026-09-25T15:20:00Z', warn: () => {} });
  assert.deepEqual(summary, { devices: 1, hours: 0, written: 0, unchanged: 0, failed: 1 });
  assert.equal(hours(db).length, 0);
});
