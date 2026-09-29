'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ad = require('./index');
const et0 = require('./et0');

const REPO = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');
const TZ = 'Europe/Zurich';
const NOW = '2026-09-26T06:00:00Z'; // local 08:00 on 26 Sep; the latest completed day is 2026-09-25
const OM = 'open_meteo:46.80:6.95';
const MS = 'meteoswiss:46.80:6.95';

test.beforeEach(() => ad.resetState());

// Inside transaction() only the scope may be used; outer calls throw, the way the
// facade would hang (Global Constraints).
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

function seedZone(db, { id = 1, lat = 46.8, lon = 6.95, tz = TZ, weatherSource = 'auto', crop = 'maize', stage = 'mid_season', gatewayEui = null } = {}) {
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-01T00:00:00Z') ON CONFLICT DO NOTHING").run();
  db.raw.prepare('INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, weather_source, crop_type, phenological_stage, gateway_device_eui, zone_uuid) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Z' + id, lat, lon, tz, weatherSource, crop, stage, gatewayEui, '00000000-0000-4000-8000-' + String(id).padStart(12, '0'));
}
function seedGateway(db, eui, altitudeM) {
  db.raw.prepare("INSERT INTO gateway_locations (gateway_device_eui, latitude, longitude, altitude_m, updated_at) VALUES (?, 46.8, 6.95, ?, '2026-09-01T00:00:00Z')").run(eui, altitudeM);
}
function seedStation(db, deveui, zoneId) {
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, ?, 'SENSECAP_S2120', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')").run(deveui, 'S2120 ' + deveui.slice(-4));
  db.raw.prepare('INSERT INTO weather_station_zones (deveui, zone_id) VALUES (?, ?)').run(deveui, zoneId);
}
function seedProviderDay(db, key, date, { et0Mm = 0.2, stationId = null, skip = () => false } = {}) {
  const provider = key.split(':')[0];
  db.raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone) VALUES (?, ?, 46.8, 6.95, ?) ON CONFLICT DO NOTHING").run(key, provider, TZ);
  const insert = db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, et0_mm, station_id, fetched_at) VALUES (?, ?, ?, ?, '2026-09-26T05:00:00Z')");
  ad.localDayWindow(date, TZ).hourStarts.forEach((h, i) => { if (!skip(h, i)) insert.run(key, h, typeof et0Mm === 'function' ? et0Mm(h, i) : et0Mm, typeof stationId === 'function' ? stationId(h, i) : stationId); });
}
// A clear day: 12 lit hours at 500 W/m² (21.6 MJ/m²), mean 17 °C (min 12, max 22), 70 %, 1.5 m/s, 955 hPa, 4 uplinks an hour.
function stationHour(i) {
  const lit = i >= 6 && i < 18;
  return { air_temperature_c: 17, air_temperature_min_c: 12, air_temperature_max_c: 22, relative_humidity_pct: 70, wind_speed_mps: 1.5, global_radiation_wm2: lit ? 500 : 0, pressure_hpa: 955, sample_count: 4 };
}
function seedStationDay(db, deveui, date, { row = stationHour, skip = () => false } = {}) {
  const insert = db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-26T05:00:00Z')");
  ad.localDayWindow(date, TZ).hourStarts.forEach((h, i) => {
    if (skip(h, i)) return;
    const r = row(i);
    insert.run(deveui, h, r.air_temperature_c, r.air_temperature_min_c, r.air_temperature_max_c, r.relative_humidity_pct, r.wind_speed_mps, r.global_radiation_wm2, r.pressure_hpa, r.sample_count);
  });
}
function days(from, to) { const out = []; for (let d = from; d <= to; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) out.push(d); return out; }
function rows(db, zoneId = 1) { return db.raw.prepare('SELECT * FROM zone_daily_agronomy WHERE zone_id = ? ORDER BY date').all(zoneId).map((r) => ({ ...r })); }
function row(db, date, zoneId = 1) { return rows(db, zoneId).find((r) => r.date === date); }
const run = (db, nowIso = NOW, extra = {}) => ad.runDaily({ db, nowIso, deploymentDefault: 'open_meteo', warn: () => {}, ...extra });
// The station tier's expected value: the hourly sum over stationHour's day (contract v2, A7).
function stationDayEt0(date, elevationM) {
  const hours = ad.localDayWindow(date, TZ).hourStarts.map((h, i) => ({ hourStartUtc: h, tMeanC: stationHour(i).air_temperature_c, rhPct: 70, windSpeedMs: 1.5, solarRadMjM2h: stationHour(i).global_radiation_wm2 * 0.0036 }));
  return et0.fao56Et0HourlyDay({ hours, windHeightM: 2, elevationM, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 268, priorRsRso: null }).et0Mm;
}

test('localDayWindow: DST days, Kampala, invalid timezone', () => {
  assert.equal(ad.localDayWindow('2026-03-29', TZ).hourStarts.length, 23);
  assert.equal(ad.localDayWindow('2026-10-25', TZ).hourStarts.length, 25);
  const k = ad.localDayWindow('2026-09-25', 'Africa/Kampala');
  assert.equal(k.hourStarts[0], '2026-09-24T21:00:00Z');
  assert.equal(k.hourStarts.length, 24);
  assert.equal(k.fallback, false);
  const m = ad.localDayWindow('2026-09-25', 'Mars/Olympus');
  assert.equal(m.fallback, true);
  assert.equal(m.hourStarts[0], '2026-09-25T00:00:00Z');
});

test('completedLocalDays: the latest completed day follows the zone clock', () => {
  assert.deepEqual(ad.completedLocalDays('2026-09-26T00:10:00Z', TZ, 7), days('2026-09-19', '2026-09-25'));
  assert.equal(ad.completedLocalDays('2026-09-25T21:50:00Z', TZ, 7).at(-1), '2026-09-24');
});

test('E-M6: the per-zone existingRows read is bounded to the last 92 days, not every stored row', async () => {
  const db = scratchDb();
  seedZone(db, { stage: 'development' });
  // The table never loses a row (retraction instead of delete): a row this
  // old must not be pulled back by the read the writer takes before deciding
  // which days need work -- it is outside daysNeedingWork's own 92-day floor
  // regardless, so an unbounded scan just re-reads years of rows for nothing.
  db.raw.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, computed_at, sync_version) VALUES (1, '2020-01-01', 3.5, '2020-01-01T00:00:00Z', 1)").run();
  seedProviderDay(db, OM, '2026-09-25');
  const calls = [];
  const originalAll = db.all;
  db.all = (sql, params) => { calls.push({ sql, params }); return originalAll(sql, params); };
  try {
    await run(db);
  } finally {
    db.all = originalAll;
  }
  const existingReads = calls.filter((c) => /SELECT date, et0_mm FROM zone_daily_agronomy/.test(c.sql));
  assert.equal(existingReads.length, 1);
  assert.match(existingReads[0].sql, /date >= \? AND date < \?/);
  assert.deepEqual(existingReads[0].params, [1, '2026-06-26', '2026-09-26'], '92 days before the local today 2026-09-26, per daysNeedingWork\'s own floor');
});

test('sumDailyEt0: all hours, one missing, two stations, a null station, the day clamp at 0', () => {
  const hs = ad.localDayWindow('2026-09-25', TZ).hourStarts;
  const full = hs.map((h) => ({ hour_start: h, et0_mm: 0.2, station_id: 'PAY' }));
  assert.deepEqual({ ...ad.sumDailyEt0(full, hs), stationIds: [...ad.sumDailyEt0(full, hs).stationIds] }, { et0Mm: 4.8, hoursPresent: 24, expectedHours: 24, stationIds: ['PAY'] });
  const gap = full.map((r, i) => (i === 5 ? { ...r, et0_mm: null } : r));
  assert.equal(ad.sumDailyEt0(gap, hs).et0Mm, null);
  assert.equal(ad.sumDailyEt0(gap, hs).hoursPresent, 23);
  assert.equal(ad.sumDailyEt0(full.map((r, i) => (i > 12 ? { ...r, station_id: 'GRE' } : r)), hs).stationIds.size, 2);
  assert.ok(ad.sumDailyEt0(full.map((r, i) => (i === 3 ? { ...r, station_id: null } : r)), hs).stationIds.has(null));
  assert.equal(ad.sumDailyEt0(hs.map((h) => ({ hour_start: h, et0_mm: -0.01, station_id: 'PAY' })), hs).et0Mm, 0);
});

test('stationDayInputs: null lux in 23 hours, lux 0 all day, a full day', () => {
  const hs = ad.localDayWindow('2026-09-25', TZ).hourStarts;
  const mk = (f) => hs.map((h, i) => ({ hour_start: h, ...stationHour(i), ...f(i) }));
  const oneLux = ad.stationDayInputs(mk((i) => ({ global_radiation_wm2: i === 12 ? 500 : null })), hs);
  assert.equal(oneLux.complete, false);
  assert.equal(oneLux.tempComplete, true);
  const dark = ad.stationDayInputs(mk(() => ({ global_radiation_wm2: 0 })), hs);
  assert.equal(dark.complete, false);
  assert.equal(dark.radiationZero, true);
  const full = ad.stationDayInputs(mk(() => ({})), hs);
  assert.equal(full.complete, true);
  assert.deepEqual([full.tMinC, full.tMaxC, full.meanRhPct, full.windSpeedMs, Math.round(full.solarRadMjM2 * 100) / 100, full.meanPressureKpa], [12, 22, 70, 1.5, 21.6, 95.5]);
});

test('provider tier: 8 full days give 8 rows (gap rule), snapshot and ETc; a second run writes nothing', async () => {
  const db = scratchDb();
  seedZone(db);
  for (const d of days('2026-09-18', '2026-09-25')) seedProviderDay(db, OM, d);
  const first = await run(db);
  assert.equal(first.written, 8);
  const r = row(db, '2026-09-25');
  assert.deepEqual([r.et0_mm, r.et0_source, r.et0_tier, r.et0_station_id, r.location_key, r.kc, r.kc_source, r.crop_type, r.phenological_stage, r.etc_mm, r.hours_present, r.expected_hours, r.null_reason],
    [4.8, 'open_meteo_hourly_sum', 'provider_hourly_sum', null, OM, 1.2, 'fao56_crop', 'maize', 'mid_season', 5.76, 24, 24, null]);
  assert.equal(rows(db).length, 8);
  const computedAt = r.computed_at;
  const second = await run(db, '2026-09-26T06:30:00Z');
  assert.equal(second.written, 0);
  assert.equal(second.unchanged, 7, 'the older day holds a value, so only the 7 latest days are revisited');
  assert.equal(row(db, '2026-09-25').computed_at, computedAt);
});

test('station tier wins over the provider; station deveui, 2 m wind, gateway altitude, else pressure elevation', async () => {
  const db = scratchDb();
  seedZone(db, { gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedProviderDay(db, OM, '2026-09-25');
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25');
  await run(db);
  const r = row(db, '2026-09-25');
  assert.deepEqual([r.et0_tier, r.et0_source, r.et0_station_id, r.location_key], ['station_fao56', 'fao56_hourly', 'S2120AAAA00000001', null]);
  assert.equal(r.et0_mm, stationDayEt0('2026-09-25', 490));
  db.raw.prepare('DELETE FROM gateway_locations').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_mm, stationDayEt0('2026-09-25', et0.elevationFromPressure(95.5)));
});

test('lux 0 all day fails tier 1: the provider takes the day, and without a provider Hargreaves does', async () => {
  const db = scratchDb();
  seedZone(db);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { row: (i) => ({ ...stationHour(i), global_radiation_wm2: 0 }) });
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_tier, 'provider_hourly_sum');
  db.raw.prepare('DELETE FROM weather_provider_hours').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  const r = row(db, '2026-09-25');
  assert.equal(r.et0_tier, 'hargreaves_station');
  assert.equal(r.et0_mm, et0.hargreavesEt0({ tMinC: 12, tMaxC: 22, latDeg: 46.8, dayOfYear: 268 }));
});

test('a station hour with samples but null lux: tier 1 rejects, Hargreaves accepts', async () => {
  const db = scratchDb();
  seedZone(db, { weatherSource: 'local' });
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { row: (i) => ({ ...stationHour(i), global_radiation_wm2: i === 9 ? null : stationHour(i).global_radiation_wm2 }) });
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_tier, 'hargreaves_station');
});

test('a 60-minute uplink station with one empty hour: both station tiers reject; provider, else partial_day 23/24', async () => {
  const db = scratchDb();
  seedZone(db);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { skip: (h, i) => i === 14 });
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_tier, 'provider_hourly_sum');
  db.raw.prepare('DELETE FROM weather_provider_hours').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  const r = row(db, '2026-09-25');
  assert.deepEqual([r.et0_mm, r.null_reason, r.hours_present, r.expected_hours], [null, 'partial_day', 23, 24]);
});

test('frozen snapshot: a stage change keeps stored rows; a day that becomes valid later gets the new Kc', async () => {
  const db = scratchDb();
  seedZone(db);
  seedProviderDay(db, OM, '2026-09-24');
  seedProviderDay(db, OM, '2026-09-25', { skip: (h, i) => i === 3 });
  await run(db);
  assert.equal(row(db, '2026-09-24').kc, 1.2);
  assert.equal(row(db, '2026-09-25').kc, null);
  db.raw.prepare("UPDATE irrigation_zones SET phenological_stage = 'late_season' WHERE id = 1").run();
  db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, et0_mm, fetched_at) VALUES (?, ?, 0.2, '2026-09-26T06:00:00Z')").run(OM, ad.localDayWindow('2026-09-25', TZ).hourStarts[3]);
  await run(db, '2026-09-26T07:00:00Z');
  assert.deepEqual([row(db, '2026-09-24').kc, row(db, '2026-09-24').phenological_stage, row(db, '2026-09-24').etc_mm], [1.2, 'mid_season', 5.76]);
  assert.deepEqual([row(db, '2026-09-25').kc, row(db, '2026-09-25').phenological_stage, row(db, '2026-09-25').etc_mm], [0.35, 'late_season', 1.68]);
});

test('null reasons: no_source, partial_day, pending, mixed_station, unknown_station, no_location', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1 });
  seedZone(db, { id: 2, weatherSource: 'meteoswiss' });
  seedZone(db, { id: 3, weatherSource: 'meteoswiss' });
  seedZone(db, { id: 4, lat: null, lon: null });
  seedProviderDay(db, OM, '2026-09-24', { skip: (h, i) => i === 3 });
  seedProviderDay(db, MS, '2026-09-24', { stationId: (h, i) => (i < 12 ? 'PAY' : 'GRE') });
  await run(db);
  assert.equal(row(db, '2026-09-23', 1).null_reason, 'no_source');
  assert.equal(row(db, '2026-09-24', 1).null_reason, 'partial_day');
  assert.equal(row(db, '2026-09-24', 2).null_reason, 'mixed_station');
  assert.equal(row(db, '2026-09-24', 4).null_reason, 'no_location');
  assert.equal(rows(db, 4).length, 7);
  db.raw.prepare('DELETE FROM weather_provider_hours').run();
  seedProviderDay(db, MS, '2026-09-24', { stationId: (h, i) => (i === 7 ? null : 'PAY') });
  await run(db);
  assert.equal(row(db, '2026-09-24', 2).null_reason, 'unknown_station');
  seedProviderDay(db, OM, '2026-09-25', { skip: (h, i) => i === 23 });
  await run(db, '2026-09-26T00:30:00Z'); // the local day ended at 22:00Z, 2.5 h ago
  assert.equal(row(db, '2026-09-25', 1).null_reason, 'pending');
});

test('gap days: an older day without a row is written when hours exist; nothing before the oldest hour', async () => {
  const db = scratchDb();
  seedZone(db);
  for (const d of days('2026-09-15', '2026-09-25')) seedProviderDay(db, OM, d);
  await run(db);
  assert.equal(rows(db).length, 11);
  db.raw.prepare("DELETE FROM zone_daily_agronomy WHERE date = '2026-09-16'").run();
  const again = await run(db, '2026-09-26T06:30:00Z');
  assert.equal(again.written, 1);
  assert.equal(row(db, '2026-09-16').et0_mm, 4.8);
  assert.equal(row(db, '2026-09-14'), undefined);
});

test('clock: a run 25 h behind the newest stored hour is skipped; rows dated today or later are retracted', async () => {
  const db = scratchDb();
  seedZone(db);
  seedProviderDay(db, OM, '2026-09-25');
  const behind = await run(db, '2026-09-24T20:00:00Z');
  assert.equal(behind.skipped, 'clock_behind_store');
  assert.equal(rows(db).length, 0);
  const insert = db.raw.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, computed_at) VALUES (1, ?, 3, '2026-09-30T00:00:00Z')");
  insert.run('2026-09-26');
  insert.run('2026-09-30');
  const summary = await run(db);
  assert.equal(summary.retracted, 2);
  assert.deepEqual(rows(db).filter((r) => r.date >= '2026-09-26').map((r) => [r.date, r.et0_mm, r.null_reason]), [['2026-09-26', null, 'retracted'], ['2026-09-30', null, 'retracted']]);
});

test('MeteoSwiss negative hourly values: the day is clamped at 0, the hours stay as delivered', async () => {
  const db = scratchDb();
  seedZone(db, { weatherSource: 'meteoswiss' });
  seedProviderDay(db, MS, '2026-09-25', { et0Mm: -0.01, stationId: 'PAY' });
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_mm, 0);
  assert.equal(row(db, '2026-09-25').et0_station_id, 'PAY');
  assert.equal(db.raw.prepare('SELECT MIN(et0_mm) AS m FROM weather_provider_hours').get().m, -0.01);
});

test('warn on change only; tzFallback lists a zone with an invalid timezone', async () => {
  const db = scratchDb();
  seedZone(db, { tz: 'Mars/Olympus' });
  const warnings = [];
  const first = await run(db, NOW, { warn: (m) => warnings.push(m) });
  assert.deepEqual(first.tzFallback, [1]);
  const count = warnings.length;
  assert.ok(count >= 1);
  await run(db, '2026-09-26T06:30:00Z', { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, count);
});

test('in-flight guard: a second concurrent run returns skipped', async () => {
  const db = scratchDb();
  seedZone(db);
  const [a, b] = await Promise.all([run(db), run(db)]);
  assert.equal(b.skipped, 'in_flight');
  assert.equal(a.skipped, undefined);
});

// Additions beyond the brief (Task 7 implementer): the Task 6 review's input
// filter, the two-station choice and the per-zone failure path.
test('stationDayInputs: a negative radiation hour is invalid for tier 1, the temperature tier keeps it', () => {
  const hs = ad.localDayWindow('2026-09-25', TZ).hourStarts;
  const neg = ad.stationDayInputs(hs.map((h, i) => ({ hour_start: h, ...stationHour(i), global_radiation_wm2: i === 2 ? -5 : stationHour(i).global_radiation_wm2 })), hs);
  assert.equal(neg.complete, false);
  assert.equal(neg.hoursPresent, 23);
  assert.equal(neg.tempComplete, true);
  assert.equal(ad.stationDayInputs([], hs).complete, false);
});

test('two stations: the complete one wins over a lower deveui with a missing hour or a dark light sensor', async () => {
  const db = scratchDb();
  seedZone(db, { weatherSource: 'local' });
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStation(db, 'S2120AAAA00000002', 1);
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-24', { skip: (h, i) => i === 4 });
  seedStationDay(db, 'S2120AAAA00000002', '2026-09-24');
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { row: (i) => ({ ...stationHour(i), global_radiation_wm2: 0 }) });
  seedStationDay(db, 'S2120AAAA00000002', '2026-09-25');
  await run(db);
  for (const date of ['2026-09-24', '2026-09-25']) {
    const r = row(db, date);
    assert.deepEqual([r.et0_tier, r.et0_station_id, r.hours_present], ['station_fao56', 'S2120AAAA00000002', 24], date);
  }
});

test('a zone whose transaction fails does not stop the others and warns once per distinct failure', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1 });
  seedZone(db, { id: 2 });
  seedProviderDay(db, OM, '2026-09-25');
  let calls = 0;
  const flaky = { ...db, transaction: (fn) => { calls += 1; return calls % 2 === 1 ? Promise.reject(new Error('disk I/O error')) : db.transaction(fn); } };
  const warnings = [];
  const first = await run(flaky, NOW, { warn: (m) => warnings.push(m) });
  assert.equal(first.zones, 1);
  assert.equal(row(db, '2026-09-25', 2).et0_mm, 4.8);
  assert.equal(row(db, '2026-09-25', 1), undefined);
  assert.equal(warnings.filter((m) => /zone 1 failed/.test(m)).length, 1);
  calls = 0;
  await run(flaky, '2026-09-26T06:30:00Z', { warn: (m) => warnings.push(m) });
  assert.equal(warnings.filter((m) => /zone 1 failed/.test(m)).length, 1, 'the same failure is not repeated');
});

test('a transaction that fails after its retraction rolls back and the summary counts nothing for that zone', async () => {
  const db = scratchDb();
  seedZone(db);
  seedProviderDay(db, OM, '2026-09-25');
  db.raw.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, computed_at) VALUES (1, '2026-09-27', 3, '2026-09-27T00:00:00Z')").run();
  const failing = { ...db, transaction: (fn) => db.transaction((scope) => fn({ ...scope, all: async (sql, params) => { if (/^INSERT/.test(sql)) throw new Error('disk full'); return scope.all(sql, params); } })) };
  const summary = await run(failing);
  assert.deepEqual([summary.zones, summary.retracted, summary.written, summary.unchanged], [0, 0, 0, 0]);
  assert.deepEqual(rows(db).map((r) => [r.date, r.et0_mm, r.null_reason]), [['2026-09-27', 3, null]], 'the rollback kept the row the retraction had nulled');
});

test('daysNeedingWork: at most 92 days back, a valued day is skipped, no oldest hour means the 7 latest only', () => {
  const latestDays = ad.completedLocalDays(NOW, TZ, 7);
  const all = ad.daysNeedingWork({ latestDays, existingRows: [{ date: '2026-08-01', et0_mm: 4 }, { date: '2026-08-02', et0_mm: null }], oldestHour: '2026-01-01T00:00:00Z', timezone: TZ, nowIso: NOW });
  assert.equal(all[0], '2026-06-26', '92 days before 2026-09-26');
  assert.equal(all.length, 92 - 1);
  assert.ok(!all.includes('2026-08-01'));
  assert.ok(all.includes('2026-08-02'));
  assert.deepEqual(all.slice(-7), latestDays);
  assert.deepEqual(ad.daysNeedingWork({ latestDays, existingRows: [], oldestHour: null, timezone: TZ, nowIso: NOW }), latestDays);
});

test('radiation plausibility: a covered sensor at 20 lux all day and a sensor dead from noon fall to tier 2/3; the healthy day stays tier 1', async () => {
  const db = scratchDb();
  seedZone(db);
  seedStation(db, 'S2120AAAA00000001', 1);
  // 20 lux is 20 / 120 = 0.17 W/m²: 0.01 MJ/m² for the day, where Ra is 24.2
  // (before this check the day was accepted at ET0 1.14 mm).
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-25', { row: (i) => ({ ...stationHour(i), global_radiation_wm2: 20 / 120 }) });
  // Dead from local noon: 6 lit hours (10.8 MJ/m², above 0.06 × Ra), then 0 in daylight hours.
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-24', { row: (i) => ({ ...stationHour(i), global_radiation_wm2: i >= 6 && i < 12 ? 500 : 0 }) });
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-23');
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_tier, 'provider_hourly_sum');
  assert.equal(row(db, '2026-09-24').et0_tier, 'hargreaves_station');
  assert.equal(row(db, '2026-09-23').et0_tier, 'station_fao56');
  const hs = ad.localDayWindow('2026-09-25', TZ).hourStarts;
  const sun = { latDeg: 46.8, lonDeg: 6.95, dayOfYear: 268 };
  const covered = ad.stationDayInputs(hs.map((h, i) => ({ hour_start: h, ...stationHour(i), global_radiation_wm2: 20 / 120 })), hs, sun);
  assert.deepEqual([covered.complete, covered.radiationImplausible, covered.tempComplete], [false, true, true]);
  // Without latitude and longitude only the all-zero rule applies.
  assert.equal(ad.stationDayInputs(hs.map((h, i) => ({ hour_start: h, ...stationHour(i), global_radiation_wm2: 20 / 120 })), hs).complete, true);
  assert.equal(ad.stationDayInputs(hs.map((h, i) => ({ hour_start: h, ...stationHour(i) })), hs, sun).complete, true);
  // A Zürich fog day on 21 December: 0.9 MJ/m² over the eight lit hours
  // (31 W/m² each), Ra 9.3 MJ/m² (0.06 × Ra = 0.56), no lit hour at 0.
  const winter = { latDeg: 47.4, lonDeg: 8.5, dayOfYear: 355 };
  const winterHours = ad.localDayWindow('2026-12-21', TZ).hourStarts;
  const fog = ad.stationDayInputs(winterHours.map((h, i) => ({ hour_start: h, ...stationHour(i), global_radiation_wm2: i >= 8 && i < 16 ? 31 : 0 })), winterHours, winter);
  assert.deepEqual([fog.complete, fog.radiationImplausible], [true, false]);
  // The same December day at 20 lux (0.01 MJ/m²) is still a covered sensor.
  const winterCovered = ad.stationDayInputs(winterHours.map((h, i) => ({ hour_start: h, ...stationHour(i), global_radiation_wm2: 20 / 120 })), winterHours, winter);
  assert.equal(winterCovered.radiationImplausible, true);
});

test('a provider reason on a zone with a station reports the provider tier\'s hours', async () => {
  const db = scratchDb();
  seedZone(db, { weatherSource: 'meteoswiss' });
  seedStation(db, 'S2120AAAA00000001', 1);
  // 10 station hours: both station tiers fail with 10/24.
  seedStationDay(db, 'S2120AAAA00000001', '2026-09-24', { skip: (h, i) => i >= 10 });
  seedProviderDay(db, MS, '2026-09-24', { stationId: (h, i) => (i < 12 ? 'PAY' : 'GRE') });
  await run(db);
  const r = row(db, '2026-09-24');
  assert.deepEqual([r.null_reason, r.hours_present, r.expected_hours], ['mixed_station', 24, 24]);
});

test('missing agronomy tables: an error summary and one warning, not a rejection every tick', async () => {
  const db = scratchDb();
  db.raw.exec('DROP TABLE zone_daily_agronomy');
  const warnings = [];
  const first = await run(db, NOW, { warn: (m) => warnings.push(m) });
  const second = await run(db, NOW, { warn: (m) => warnings.push(m) });
  assert.equal(first.error, 'agronomy tables missing (deploy the schema migration)');
  assert.equal(second.error, first.error);
  assert.deepEqual(warnings, ['agronomy tables missing (deploy the schema migration)']);
});

test('a failure before the zone loop is warned once per problem; digits and instants are masked; a recovery logs', async () => {
  const db = scratchDb();
  seedZone(db);
  const warnings = [];
  let fail = (n) => `database is locked (attempt ${n} at 2026-09-26T06:0${n}:00.000Z)`;
  const flaky = { ...db, all: async (sql, params) => { if (fail && /MIN\(o\)/.test(sql)) throw new Error(fail(flaky.n = (flaky.n || 0) + 1)); return db.all(sql, params); } };
  const go = () => ad.runDaily({ db: flaky, nowIso: NOW, deploymentDefault: 'open_meteo', warn: (m) => warnings.push(m) });
  assert.match((await go()).error, /^run failed: database is locked/);
  await go();
  assert.equal(warnings.length, 1);
  fail = () => 'no such column: iz.crop_type';
  await go();
  assert.equal(warnings.length, 2);
  fail = null;
  const ok = await go();
  assert.equal(ok.error, undefined);
  assert.equal(warnings[2], 'recovered');
  assert.equal(ad.maskProblem('zone 12 failed at 2026-09-26T06:00:00Z'), ad.maskProblem('zone 3 failed at 2026-09-27T01:00:00Z'));
});

test('localDayWindow: a run-owned memo returns the same window for the same tz and date; a new run has its own', () => {
  const memo = new Map();
  const a = ad.localDayWindow('2026-09-25', TZ, memo);
  assert.equal(ad.localDayWindow('2026-09-25', TZ, memo), a);
  assert.notEqual(ad.localDayWindow('2026-09-25', 'Africa/Kampala', memo), a);
  assert.equal(memo.size, 2);
  const nextRun = new Map();
  const b = ad.localDayWindow('2026-09-25', TZ, nextRun);
  assert.notEqual(b, a);
  assert.deepEqual(b, a);
  assert.notEqual(ad.localDayWindow('2026-09-25', TZ), ad.localDayWindow('2026-09-25', TZ), 'no memo, no cache');
});

test('latestNull counts the zones whose latest completed day has no ET0, not the nulls of the backfill', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1 });
  seedZone(db, { id: 2 });
  for (const d of days('2026-09-15', '2026-09-25')) seedProviderDay(db, OM, d, { skip: (h, i) => d === '2026-09-18' && i === 4 });
  const summary = await run(db);
  assert.ok(summary.nulls.length >= 2, 'the partial day of both zones is in nulls');
  assert.equal(summary.latestNull, 0);
  db.raw.prepare("DELETE FROM weather_provider_hours WHERE hour_start >= '2026-09-24T22:00:00Z'").run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  assert.equal((await run(db)).latestNull, 2);
});

// Contract v2 (spec 2026-09-27-daily-agronomy-parity B4): the Kc curve fields
// freeze with the rest of the snapshot.
test('a dated development zone: rows carry the curve Kc, the start date, FAO\'s day in the stage and the overrun flag', async () => {
  const db = scratchDb();
  seedZone(db, { stage: 'development' });
  db.raw.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-09-05' WHERE id = 1").run();
  for (const d of days('2026-09-19', '2026-09-25')) seedProviderDay(db, OM, d);
  await run(db);
  const r = row(db, '2026-09-25');
  // maize 0.30 -> 1.20 over 40 days; 2026-09-25 is day 21: 0.30 + 21/40 * 0.90 = 0.7725 -> 0.77.
  assert.deepEqual([r.kc, r.kc_source, r.phenological_stage, r.stage_started_on, r.kc_stage_day, r.stage_overrun, r.etc_mm],
    [0.77, 'fao56_curve', 'development', '2026-09-05', 21, 0, 3.7]);
  assert.equal(row(db, '2026-09-19').kc, 0.64, 'each day takes its own place on the ramp: day 15 is 0.30 + 15/40 * 0.90');
  assert.equal(row(db, '2026-09-19').kc_stage_day, 15);
});

test('a stage left past its length is flagged; a stage without a start date stores nulls for the curve fields', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, stage: 'initial' });
  seedZone(db, { id: 2, stage: 'development' });
  db.raw.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-08-01' WHERE id = 1").run();
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  const overrun = row(db, '2026-09-25', 1);
  assert.deepEqual([overrun.kc, overrun.kc_source, overrun.kc_stage_day, overrun.stage_overrun], [0.3, 'fao56_crop', 56, 1], 'maize initial is 30 days long');
  const undated = row(db, '2026-09-25', 2);
  assert.deepEqual([undated.kc, undated.kc_source, undated.stage_started_on, undated.kc_stage_day, undated.stage_overrun], [1.2, 'fao56_crop', null, null, null]);
});

test('a start date entered after a row froze does not reach that row; a day computed later takes it', async () => {
  const db = scratchDb();
  seedZone(db, { stage: 'development' });
  seedProviderDay(db, OM, '2026-09-24');
  seedProviderDay(db, OM, '2026-09-25', { skip: (h, i) => i === 3 });
  await run(db);
  assert.deepEqual([row(db, '2026-09-24').kc, row(db, '2026-09-24').stage_started_on], [1.2, null]);
  db.raw.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-09-05' WHERE id = 1").run();
  db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, et0_mm, fetched_at) VALUES (?, ?, 0.2, '2026-09-26T06:00:00Z')").run(OM, ad.localDayWindow('2026-09-25', TZ).hourStarts[3]);
  await run(db, '2026-09-26T07:00:00Z');
  assert.deepEqual([row(db, '2026-09-24').kc, row(db, '2026-09-24').stage_started_on, row(db, '2026-09-24').kc_stage_day], [1.2, null, null]);
  assert.deepEqual([row(db, '2026-09-25').kc, row(db, '2026-09-25').stage_started_on, row(db, '2026-09-25').kc_stage_day], [0.77, '2026-09-05', 21]);
});

// Contract v2 station tier: the day is the sum of hourly FAO-56 ET0 (spec
// 2026-09-27-daily-agronomy-parity A7, A9, B4). The synthetic Payerne day of
// et0-vectors.json, stored as station hours with six uplinks each.
const HOURLY_DAY = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contracts/agronomy/et0-vectors.json'), 'utf8')).fao56HourlyDays[0];
function seedSyntheticStationDay(db, deveui, { shiftDays = 0, row = (r) => r } = {}) {
  const insert = db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 955, ?, '2026-07-20T05:00:00Z')");
  HOURLY_DAY.input.hours.forEach((h, i) => {
    const r = row({ hour_start: new Date(Date.parse(h.hourStartUtc) + shiftDays * 86400000).toISOString().replace('.000Z', 'Z'), air_temperature_c: h.tMeanC, relative_humidity_pct: h.rhPct, wind_speed_mps: h.windSpeedMs, global_radiation_wm2: h.solarRadMjM2h / 0.0036, sample_count: 6 }, i);
    insert.run(deveui, r.hour_start, r.air_temperature_c, r.air_temperature_c == null ? null : r.air_temperature_c - 1, r.air_temperature_c == null ? null : r.air_temperature_c + 1, r.relative_humidity_pct, r.wind_speed_mps, r.global_radiation_wm2, r.sample_count);
  });
}
const JULY_NOW = '2026-07-20T06:00:00Z'; // local 08:00 on 20 July; the latest completed day is 2026-07-19

test('station tier: the synthetic Payerne day sums its hours to 4.85 mm with source fao56_hourly', async () => {
  const db = scratchDb();
  seedZone(db, { gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedSyntheticStationDay(db, 'S2120AAAA00000001');
  await run(db, JULY_NOW);
  const r = row(db, '2026-07-19');
  assert.deepEqual([r.et0_mm, r.et0_tier, r.et0_source, r.et0_station_id, r.hours_present, r.expected_hours], [4.85, 'station_fao56', 'fao56_hourly', 'S2120AAAA00000001', 24, 24]);
  assert.equal(r.et0_mm, HOURLY_DAY.et0Mm);
});

test('station tier: the previous evening\'s carry hour sets the ratio of the day\'s first night hours', async () => {
  const db = scratchDb();
  seedZone(db, { gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedSyntheticStationDay(db, 'S2120AAAA00000001', { shiftDays: -1 });
  seedSyntheticStationDay(db, 'S2120AAAA00000001');
  await run(db, JULY_NOW);
  const previousCarry = HOURLY_DAY.input.hours
    .map((h) => ({ ...h, hourStartUtc: new Date(Date.parse(h.hourStartUtc) - 86400000).toISOString() }))
    .map((h) => et0.fao56HourlyTerms({ ...h, windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 199 }))
    .filter((t) => t.carryCandidate);
  assert.equal(previousCarry.length, 1);
  const expected = et0.fao56Et0HourlyDay({ ...HOURLY_DAY.input, priorRsRso: previousCarry[0].rsRso }).et0Mm;
  assert.equal(expected, 4.79);
  assert.equal(row(db, '2026-07-19').et0_mm, expected);
});

// Queue E3 Task 1 review: the prior window for the night rule's carried ratio
// is now derived from localDayWindow(addDays(date,-1), tz, memo), not a flat
// 24 UTC hours ending at the same instant. The reviewer's own probes found no
// numeric difference on any of 8 site-days tried (including a 23-hour and a
// 25-hour Zurich day and a 120 W longitude), so these are regression guards
// for the pipeline continuing to run end to end across these calendars, not
// tests that discriminate the old formula from the new one.
// A wider lit window than stationHour's (6h-20h, not 6h-18h): late March
// daylight at 46.8N after the spring-forward runs past 18:00 local, so
// stationHour's own pattern trips the (unrelated, pre-existing) radiation
// plausibility check on these dates. Same shape otherwise.
function wideLitHour(i) {
  const lit = i >= 6 && i < 20;
  return { air_temperature_c: 17, air_temperature_min_c: 12, air_temperature_max_c: 22, relative_humidity_pct: 70, wind_speed_mps: 1.5, global_radiation_wm2: lit ? 500 : 0, pressure_hpa: 955, sample_count: 4 };
}
// seedStationDay hardcodes the file's own TZ (Europe/Zurich) to build hour_start
// values; a zone in a different timezone needs its own hour boundaries.
function seedStationDayTz(db, deveui, date, timezone, row = wideLitHour) {
  const insert = db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-26T05:00:00Z')");
  ad.localDayWindow(date, timezone).hourStarts.forEach((h, i) => {
    const r = row(i);
    insert.run(deveui, h, r.air_temperature_c, r.air_temperature_min_c, r.air_temperature_max_c, r.relative_humidity_pct, r.wind_speed_mps, r.global_radiation_wm2, r.pressure_hpa, r.sample_count);
  });
}

test('station tier: the day after a 23-hour DST transition day still runs the hourly path end to end', async () => {
  const db = scratchDb();
  seedZone(db, { gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  // 2026-03-29 is the Europe/Zurich spring-forward day: 23 local hours (see
  // "localDayWindow: DST days" above). The prior window for 2026-03-30 is
  // this day's own 23 hours, not a flat 24 hours before 2026-03-30's first hour.
  seedStationDay(db, 'S2120AAAA00000001', '2026-03-28', { row: wideLitHour });
  seedStationDay(db, 'S2120AAAA00000001', '2026-03-29', { row: wideLitHour });
  seedStationDay(db, 'S2120AAAA00000001', '2026-03-30', { row: wideLitHour });
  await run(db, '2026-03-31T06:00:00Z');
  const transition = row(db, '2026-03-29');
  const after = row(db, '2026-03-30');
  assert.deepEqual([transition.et0_tier, transition.hours_present, transition.expected_hours], ['station_fao56', 23, 23]);
  assert.deepEqual([after.et0_tier, after.hours_present, after.expected_hours], ['station_fao56', 24, 24]);
  assert.equal(after.et0_mm, 3.75);
});

test('station tier: a west-longitude zone (America/Los_Angeles) still runs the hourly path end to end', async () => {
  const db = scratchDb();
  const LA = 'America/Los_Angeles';
  seedZone(db, { lat: 37, lon: -122, tz: LA, gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedStationDayTz(db, 'S2120AAAA00000001', '2026-06-14', LA);
  seedStationDayTz(db, 'S2120AAAA00000001', '2026-06-15', LA);
  await run(db, '2026-06-16T20:00:00Z');
  const r = row(db, '2026-06-15');
  assert.deepEqual([r.et0_tier, r.hours_present, r.expected_hours], ['station_fao56', 24, 24]);
  assert.equal(r.et0_mm, 4.01);
});

test('station tier: an hour without its mean temperature or with two uplinks fails the tier; the provider takes the day', async () => {
  for (const [label, broken] of [['no mean temperature', { air_temperature_c: null }], ['two uplinks', { sample_count: 2 }]]) {
    const db = scratchDb();
    seedZone(db, { gatewayEui: 'GW1' });
    seedGateway(db, 'GW1', 490);
    seedStation(db, 'S2120AAAA00000001', 1);
    seedSyntheticStationDay(db, 'S2120AAAA00000001', { row: (r, i) => (i === 12 ? { ...r, ...broken } : r) });
    seedProviderDay(db, OM, '2026-07-19');
    await run(db, JULY_NOW);
    const r = row(db, '2026-07-19');
    assert.deepEqual([r.et0_tier, r.et0_source], ['provider_hourly_sum', 'open_meteo_hourly_sum'], label);
  }
});

test('resolveDay: without a longitude the hourly tier cannot run and the provider tier takes the day', () => {
  const hourStarts = ad.localDayWindow('2026-07-19', TZ).hourStarts;
  const stationRows = HOURLY_DAY.input.hours.map((h) => ({ hour_start: h.hourStartUtc, air_temperature_c: h.tMeanC, air_temperature_min_c: h.tMeanC - 1, air_temperature_max_c: h.tMeanC + 1, relative_humidity_pct: h.rhPct, wind_speed_mps: h.windSpeedMs, global_radiation_wm2: h.solarRadMjM2h / 0.0036, pressure_hpa: 955, sample_count: 6 }));
  const providerRows = hourStarts.map((h) => ({ hour_start: h, et0_mm: 0.2, station_id: null }));
  const args = { date: '2026-07-19', hourStarts, latitude: 46.8, provider: 'open_meteo', locationKey: OM, stations: ['S2120AAAA00000001'], stationHours: new Map([['S2120AAAA00000001', stationRows]]), stationPriorHours: new Map(), providerRows, gatewayAltitudeM: 490, nowMs: Date.parse(JULY_NOW) };
  assert.deepEqual([ad.resolveDay({ ...args, longitude: 6.95 }).et0Source, ad.resolveDay({ ...args, longitude: 6.95 }).et0Mm], ['fao56_hourly', 4.85]);
  const noLongitude = ad.resolveDay({ ...args, longitude: null });
  assert.deepEqual([noLongitude.et0Tier, noLongitude.et0Mm], ['provider_hourly_sum', 4.8]);
});

// Contract v2 record sync (spec 2026-09-27-daily-agronomy-parity B3, B4): rows
// carry a version that starts at 1 and grows by 1 per real change.
test('versions: an insert is version 1, a changed day adds 1, an unchanged run adds nothing', async () => {
  const db = scratchDb();
  seedZone(db);
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  assert.equal(row(db, '2026-09-25').sync_version, 1);
  assert.equal(row(db, '2026-09-24').sync_version, 1, 'a no_source row is a row too');
  await run(db, '2026-09-26T06:30:00Z');
  assert.equal(row(db, '2026-09-25').sync_version, 1);
  db.raw.prepare("UPDATE weather_provider_hours SET et0_mm = 0.25 WHERE hour_start = ?").run(ad.localDayWindow('2026-09-25', TZ).hourStarts[12]);
  await run(db, '2026-09-26T07:00:00Z');
  assert.deepEqual([row(db, '2026-09-25').et0_mm, row(db, '2026-09-25').sync_version], [4.85, 2]);
});

test('retraction: a clock-ahead row is retracted once, keeps growing its version, and is overwritten with the next version', async () => {
  const db = scratchDb();
  seedZone(db);
  db.raw.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, kc, kc_source, crop_type, phenological_stage, etc_mm, computed_at, sync_version) VALUES (1, '2026-09-27', 3, 1.2, 'fao56_crop', 'maize', 'mid_season', 3.6, '2026-09-28T00:00:00Z', 4)").run();
  const first = await run(db);
  assert.equal(first.retracted, 1);
  const retracted = row(db, '2026-09-27');
  assert.deepEqual([retracted.et0_mm, retracted.kc, retracted.etc_mm, retracted.crop_type, retracted.null_reason, retracted.sync_version, retracted.computed_at], [null, null, null, null, 'retracted', 5, NOW]);
  const second = await run(db, '2026-09-26T06:30:00Z');
  assert.equal(second.retracted, 0);
  assert.equal(row(db, '2026-09-27').sync_version, 5, 'a second run does not bump a retracted row');
  seedProviderDay(db, OM, '2026-09-27');
  await run(db, '2026-09-28T06:00:00Z');
  const recomputed = row(db, '2026-09-27');
  assert.deepEqual([recomputed.et0_mm, recomputed.kc, recomputed.null_reason, recomputed.sync_version], [4.8, 1.2, null, 6]);
});
