'use strict';
// osi-agronomy-daily: one row per zone and completed local day in
// zone_daily_agronomy (spec docs/superpowers/specs/2026-09-26-daily-agronomy-design.md,
// component 4): ET0 from three tiers, Kc frozen per row, explicit null reasons.
const { zoneLocations, hourStartIso } = require('../osi-weather-provider');
const { resolveKc, catalogue } = require('../osi-crop-kc');
const et0 = require('./et0');

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const LATEST_DAYS = 7;
const MAX_DAYS = 92;
const PENDING_HOURS = 3;
const CLOCK_SLACK_HOURS = 24;
// FAO-56 eq. 21: a day's measured radiation below this share of Ra is not
// a measurement (a covered or failing light sensor), and an hour whose
// extraterrestrial radiation (eq. 28) exceeds 1 MJ/m² cannot read 0. The
// share is 0.06, not the 0.15 first ruled: a Swiss fog day in December
// measures 0.8–1.5 MJ/m² against an Ra of 9–10.5, and stays a measurement.
const MIN_RS_SHARE_OF_RA = 0.06;
const DAYLIGHT_RA_MJ = 1;
const TABLES = ['zone_daily_agronomy', 'weather_station_hours', 'weather_provider_hours'];
const TABLES_MISSING = 'agronomy tables missing (deploy the schema migration)';

const formatters = new Map();
function formatterFor(timezone) {
  const key = String(timezone || 'UTC');
  if (!formatters.has(key)) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' };
    let entry;
    try { entry = { fmt: new Intl.DateTimeFormat('en-US', { ...options, timeZone: key }), fallback: false }; }
    catch (_) { entry = { fmt: new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }), fallback: true }; }
    formatters.set(key, entry);
  }
  return formatters.get(key);
}
// formatToParts only: the Node build has English locale data only, and
// format() strings are not stable across builds.
function localDateOf(ms, fmt) {
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return p.year + '-' + p.month + '-' + p.day;
}
function addDays(dateIso, n) { return new Date(Date.parse(dateIso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }
function todayLocal(nowIso, timezone) { return localDateOf(Date.parse(nowIso), formatterFor(timezone).fmt); }
function dayOfYear(dateIso) { return Math.round((Date.parse(dateIso + 'T00:00:00Z') - Date.parse(dateIso.slice(0, 4) + '-01-01T00:00:00Z')) / DAY_MS) + 1; }
function round2(v) { return Math.round(v * 100) / 100; }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

// `memo` is a Map owned by one run (runDailyOnce): a 92-day backfill asks for
// the same local day once per zone, and the window depends only on tz and date.
function localDayWindow(dateLocal, timezone, memo) {
  const key = String(timezone || 'UTC') + '|' + dateLocal;
  if (memo && memo.has(key)) return memo.get(key);
  const { fmt, fallback } = formatterFor(timezone);
  const base = Date.parse(dateLocal + 'T00:00:00Z');
  const hourStarts = [];
  for (let ms = base - DAY_MS; ms < base + 2 * DAY_MS; ms += HOUR_MS) {
    if (localDateOf(ms, fmt) === dateLocal) hourStarts.push(hourStartIso(new Date(ms)));
  }
  const window = { hourStarts, fallback };
  if (memo) memo.set(key, window);
  return window;
}

function completedLocalDays(nowIso, timezone, count = LATEST_DAYS) {
  const today = todayLocal(nowIso, timezone);
  const days = [];
  for (let i = count; i >= 1; i -= 1) days.push(addDays(today, -i));
  return days;
}

function daysNeedingWork({ latestDays, existingRows, oldestHour, timezone, nowIso }) {
  if (!oldestHour) return latestDays.slice();
  const today = todayLocal(nowIso, timezone);
  const oldestDay = todayLocal(oldestHour, timezone);
  const floor = [addDays(today, -MAX_DAYS), oldestDay].sort()[1];
  const byDate = new Map(existingRows.map((r) => [r.date, r]));
  const older = [];
  for (let d = floor; d < latestDays[0]; d = addDays(d, 1)) {
    const stored = byDate.get(d);
    if (!stored || stored.et0_mm == null) older.push(d);
  }
  return [...older, ...latestDays];
}

function sumDailyEt0(rows, hourStarts) {
  const byHour = new Map(rows.map((r) => [r.hour_start, r]));
  let sum = 0;
  let present = 0;
  const stationIds = new Set();
  for (const h of hourStarts) {
    const r = byHour.get(h);
    if (!r || r.et0_mm == null) continue;
    present += 1;
    sum += r.et0_mm;
    stationIds.add(r.station_id == null ? null : r.station_id);
  }
  const complete = present === hourStarts.length;
  return { et0Mm: complete ? Math.max(0, round2(sum)) : null, hoursPresent: present, expectedHours: hourStarts.length, stationIds };
}

// Tier 1 sums hourly FAO-56 ET0 (contract v2, spec
// 2026-09-27-daily-agronomy-parity A7 and B4): an hour counts when its mean
// temperature, humidity, wind and radiation are present, the radiation is not
// negative (luxToWm2 passes negative lux through), and at least three uplinks
// fed it (ruling R8). The hourly path needs no minimum or maximum temperature.
const MANDATORY = ['air_temperature_c', 'relative_humidity_pct', 'wind_speed_mps', 'global_radiation_wm2'];
const MIN_SAMPLES_PER_HOUR = 3;
const WM2_TO_MJ_PER_HOUR = 0.0036;
function fullHour(r) {
  return MANDATORY.every((k) => r[k] != null) && Number.isFinite(r.global_radiation_wm2) && r.global_radiation_wm2 >= 0
    && Number(r.sample_count) >= MIN_SAMPLES_PER_HOUR;
}
function hourInput(r) {
  return { hourStartUtc: r.hour_start, tMeanC: r.air_temperature_c, rhPct: r.relative_humidity_pct, windSpeedMs: r.wind_speed_mps, solarRadMjM2h: r.global_radiation_wm2 * WM2_TO_MJ_PER_HOUR };
}
// Radiation plausibility needs the zone's latitude, longitude and the day of
// year (`sun`); without them only the all-zero check applies.
function radiationImplausible(full, solar, sun) {
  if (!sun || !Number.isFinite(sun.latDeg) || !Number.isInteger(sun.dayOfYear)) return false;
  if (solar < MIN_RS_SHARE_OF_RA * et0.extraterrestrialRadiation(sun.latDeg, sun.dayOfYear)) return true;
  if (!Number.isFinite(sun.lonDeg)) return false;
  return full.some((r) => r.global_radiation_wm2 === 0 && et0.hourlyExtraterrestrialRadiation(sun.latDeg, sun.dayOfYear, r.hour_start, sun.lonDeg) > DAYLIGHT_RA_MJ);
}
function stationDayInputs(rows, hourStarts, sun) {
  const byHour = new Map((rows || []).map((r) => [r.hour_start, r]));
  const hours = hourStarts.map((h) => byHour.get(h) || null);
  const present = hours.filter(Boolean);
  const full = present.filter(fullHour);
  const temp = present.filter((r) => r.air_temperature_min_c != null && r.air_temperature_max_c != null);
  const pressures = present.map((r) => r.pressure_hpa).filter((v) => v != null);
  const tempComplete = temp.length === hourStarts.length;
  const out = {
    complete: false, tempComplete, radiationZero: false, radiationImplausible: false,
    tMinC: tempComplete ? Math.min(...temp.map((r) => r.air_temperature_min_c)) : null,
    tMaxC: tempComplete ? Math.max(...temp.map((r) => r.air_temperature_max_c)) : null,
    meanRhPct: null, windSpeedMs: null, solarRadMjM2: null,
    meanPressureKpa: pressures.length ? round2(mean(pressures)) / 10 : null,
    hoursPresent: full.length, tempHoursPresent: temp.length, anyHours: present.length, expectedHours: hourStarts.length,
  };
  if (full.length !== hourStarts.length) return out;
  const solar = et0.wm2HoursToMjPerDay(full.map((r) => r.global_radiation_wm2));
  // A dead or covered light sensor reports 0 all day: that is not a measurement.
  if (!(solar > 0)) return { ...out, radiationZero: true };
  // A day that fails the plausibility check falls to the next tier; if every
  // tier fails, the row's null_reason is partial_day (the hours exist, the
  // radiation in them does not hold up).
  if (radiationImplausible(full, solar, sun)) return { ...out, radiationImplausible: true };
  return { ...out, complete: true, meanRhPct: mean(full.map((r) => r.relative_humidity_pct)), windSpeedMs: mean(full.map((r) => r.wind_speed_mps)), solarRadMjM2: solar, hours: full.map(hourInput) };
}

// FAO-56 ch. 4 night rule: the day's leading night hours take the Rs/Rso of
// the latest complete hour 2-3 h before sunset in the 24 hours before the
// day's first hour (the previous evening), else 0.5 (fao56Et0HourlyDay).
function priorRsRsoFor(priorRows, { latDeg, lonDeg, dayOfYear, elevationM }) {
  let prior = null;
  for (const r of priorRows || []) {
    if (!fullHour(r)) continue;
    const terms = et0.fao56HourlyTerms({ ...hourInput(r), windHeightM: catalogue.stationWindHeightM, elevationM, latDeg, lonDeg, dayOfYear });
    if (terms && terms.carryCandidate) prior = terms.rsRso;
  }
  return prior;
}

// The station with the most complete hours; a station whose day passes the
// tier ranks first (a dark light sensor has 24 complete hours and still fails
// tier 1). Stations are ordered by deveui; a tie keeps the lower deveui.
function pickStation(stations, stationHours, hourStarts, key, passKey, sun) {
  let best = null;
  for (const deveui of stations) {
    const inputs = stationDayInputs(stationHours.get(deveui) || [], hourStarts, sun);
    const rank = [inputs[passKey] ? 1 : 0, inputs[key]];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { deveui, inputs, rank };
  }
  return best;
}

function resolveDay({ date, hourStarts, latitude, longitude, provider, locationKey, stations, stationHours, stationPriorHours, providerRows, gatewayAltitudeM, nowMs }) {
  const base = { et0Mm: null, et0Source: null, et0Tier: null, et0StationId: null, locationKey: null, hoursPresent: 0, expectedHours: hourStarts.length, nullReason: null };
  if (latitude == null) return { ...base, nullReason: 'no_location' };
  const doy = dayOfYear(date);
  const recent = nowMs - (Date.parse(hourStarts[hourStarts.length - 1]) + HOUR_MS) < PENDING_HOURS * HOUR_MS;
  let anyHours = false;
  let lastPresent = 0;
  let providerReason = null;
  let providerPresent = 0;
  const sun = { latDeg: latitude, lonDeg: longitude == null ? NaN : Number(longitude), dayOfYear: doy };
  if (stations.length) {
    const best = pickStation(stations, stationHours, hourStarts, 'hoursPresent', 'complete', sun);
    anyHours = anyHours || best.inputs.anyHours > 0;
    lastPresent = best.inputs.hoursPresent;
    // Hourly Ra needs the longitude: without one the provider tier runs.
    if (best.inputs.complete && Number.isFinite(sun.lonDeg)) {
      const elevationM = gatewayAltitudeM != null && Number.isFinite(Number(gatewayAltitudeM)) ? Number(gatewayAltitudeM) : et0.elevationFromPressure(best.inputs.meanPressureKpa);
      const priorRsRso = priorRsRsoFor((stationPriorHours && stationPriorHours.get(best.deveui)) || [], { latDeg: latitude, lonDeg: sun.lonDeg, dayOfYear: dayOfYear(addDays(date, -1)), elevationM });
      const day = et0.fao56Et0HourlyDay({ hours: best.inputs.hours, windHeightM: catalogue.stationWindHeightM, elevationM, latDeg: latitude, lonDeg: sun.lonDeg, dayOfYear: doy, priorRsRso });
      if (day) return { ...base, et0Mm: day.et0Mm, et0Source: 'fao56_hourly', et0Tier: 'station_fao56', et0StationId: best.deveui, hoursPresent: best.inputs.hoursPresent };
    }
  }
  if (provider && locationKey) {
    const sum = sumDailyEt0(providerRows, hourStarts);
    anyHours = anyHours || sum.hoursPresent > 0;
    lastPresent = sum.hoursPresent;
    providerPresent = sum.hoursPresent;
    if (sum.et0Mm != null) {
      if (provider === 'meteoswiss' && sum.stationIds.has(null)) providerReason = 'unknown_station';
      else if (provider === 'meteoswiss' && sum.stationIds.size > 1) providerReason = 'mixed_station';
      else return { ...base, et0Mm: sum.et0Mm, et0Source: provider + '_hourly_sum', et0Tier: 'provider_hourly_sum', et0StationId: provider === 'meteoswiss' ? [...sum.stationIds][0] : null, locationKey, hoursPresent: sum.hoursPresent };
    }
  }
  if (stations.length) {
    const best = pickStation(stations, stationHours, hourStarts, 'tempHoursPresent', 'tempComplete');
    lastPresent = best.inputs.tempHoursPresent;
    if (best.inputs.tempComplete) {
      const value = et0.hargreavesEt0({ tMinC: best.inputs.tMinC, tMaxC: best.inputs.tMaxC, latDeg: latitude, dayOfYear: doy });
      if (value != null) return { ...base, et0Mm: value, et0Source: 'hargreaves_station', et0Tier: 'hargreaves_station', et0StationId: best.deveui, hoursPresent: best.inputs.tempHoursPresent };
    }
  }
  // A provider reason names the provider tier, so the counts are that tier's,
  // not the temperature tier's that ran after it.
  if (providerReason) return { ...base, hoursPresent: providerPresent, nullReason: providerReason };
  const nullReason = recent ? 'pending' : (anyHours ? 'partial_day' : 'no_source');
  return { ...base, hoursPresent: lastPresent, nullReason };
}

// The Kc snapshot of a row: crop, stage, stage start date and the curve's day
// in the stage freeze together the first time the row gets a value (contract v2,
// spec 2026-09-27-daily-agronomy-parity B4; backfilled days alike, ruling R10).
function snapshotFor(zone, computed, stored, date) {
  if (stored && stored.kc != null) {
    return { kc: stored.kc, kcSource: stored.kc_source, cropType: stored.crop_type, stage: stored.phenological_stage, stageStartedOn: stored.stage_started_on, kcStageDay: stored.kc_stage_day, stageOverrun: stored.stage_overrun };
  }
  if (computed.et0Mm == null) return { kc: null, kcSource: null, cropType: null, stage: null, stageStartedOn: null, kcStageDay: null, stageOverrun: null };
  const stageStartedOn = zone.stage_started_on == null ? null : (String(zone.stage_started_on).trim() || null);
  const r = resolveKc({ cropType: zone.crop_type, phenologicalStage: zone.phenological_stage, stageStartedOn, date });
  const crop = zone.crop_type == null ? null : (String(zone.crop_type).trim() || null);
  return { kc: r.kc, kcSource: r.kcSource, cropType: crop, stage: r.stage, stageStartedOn, kcStageDay: r.kcStageDay, stageOverrun: r.stageOverrun == null ? null : (r.stageOverrun ? 1 : 0) };
}

const ROW_COLUMNS = ['et0_mm', 'et0_source', 'et0_tier', 'et0_station_id', 'location_key', 'hours_present', 'expected_hours', 'null_reason', 'kc', 'kc_source', 'crop_type', 'phenological_stage', 'stage_started_on', 'kc_stage_day', 'stage_overrun', 'etc_mm'];
// A row is inserted at sync_version 1 and every real change adds 1 (the 0015
// rule); the WHERE keeps an unchanged day from bumping or emitting. A row is
// never deleted, so its version only grows (migration 0067's triggers emit
// ZONE_AGRONOMY_UPSERTED on each insert and version change).
const UPSERT_SQL =
  'INSERT INTO zone_daily_agronomy (zone_id, date, ' + ROW_COLUMNS.join(', ') + ', computed_at, sync_version) VALUES (?, ?, ' + ROW_COLUMNS.map(() => '?').join(', ') + ', ?, 1) ' +
  'ON CONFLICT(zone_id, date) DO UPDATE SET ' + ROW_COLUMNS.map((c) => c + ' = excluded.' + c).join(', ') + ', computed_at = excluded.computed_at, sync_version = zone_daily_agronomy.sync_version + 1 ' +
  'WHERE ' + ROW_COLUMNS.map((c) => 'zone_daily_agronomy.' + c + ' IS NOT excluded.' + c).join(' OR ') + ' ' +
  'RETURNING zone_id';
// Rows a clock that ran ahead wrote for today or later: values nulled once,
// next version, never deleted. A later computation of the date overwrites the
// row with a fresh snapshot (its kc is null) and the next version.
const RETRACT_SQL =
  'UPDATE zone_daily_agronomy SET et0_mm = NULL, et0_source = NULL, et0_tier = NULL, et0_station_id = NULL, location_key = NULL, ' +
  'hours_present = NULL, expected_hours = NULL, kc = NULL, kc_source = NULL, kc_stage_day = NULL, stage_overrun = NULL, ' +
  "crop_type = NULL, phenological_stage = NULL, stage_started_on = NULL, etc_mm = NULL, null_reason = 'retracted', " +
  'computed_at = ?, sync_version = sync_version + 1 ' +
  "WHERE zone_id = ? AND date >= ? AND null_reason IS NOT 'retracted' RETURNING date";

function rowParams(zone, date, computed, stored, nowIso) {
  const snap = snapshotFor(zone, computed, stored, date);
  const etc = computed.et0Mm != null && snap.kc != null ? round2(computed.et0Mm * snap.kc) : null;
  return [zone.id, date, computed.et0Mm, computed.et0Source, computed.et0Tier, computed.et0StationId, computed.locationKey, computed.hoursPresent, computed.expectedHours, computed.nullReason, snap.kc, snap.kcSource, snap.cropType, snap.stage, snap.stageStartedOn, snap.kcStageDay, snap.stageOverrun, etc, nowIso];
}

let inFlight = null;
const lastReason = new Map();
function resetState() { inFlight = null; lastReason.clear(); formatters.clear(); }

// One problem at different times or counts is one problem for the log:
// instants and digits are masked before two messages are compared.
function maskProblem(text) { return String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, '<time>').replace(/\d+/g, '#'); }
function sameProblem(previous, message) { return previous != null && maskProblem(previous) === maskProblem(message); }
function warnOnChange(say, key, message) {
  if (!sameProblem(lastReason.get(key), message)) say(message);
  lastReason.set(key, message);
}

async function tablesPresent(db) {
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" + TABLES.map(() => '?').join(', ') + ')', TABLES);
  return rows.length === TABLES.length;
}

async function runDailyOnce({ db, nowIso, deploymentDefault, warn }) {
  const say = typeof warn === 'function' ? warn : () => {};
  const nowMs = Date.parse(nowIso);
  const summary = { zones: 0, days: 0, written: 0, unchanged: 0, retracted: 0, nulls: [], latestNull: 0, tzFallback: [] };
  const memo = new Map();
  let bounds; let zones; let located; const stationsByZone = new Map();
  try {
    if (!(await tablesPresent(db))) {
      warnOnChange(say, 'run', TABLES_MISSING);
      return { ...summary, error: TABLES_MISSING };
    }
    ({ bounds, zones, located } = await loadRun(db, deploymentDefault, stationsByZone));
  } catch (error) {
    // Before the zone loop (a missing column before the migration, a locked
    // file): warned when it starts or changes, not every tick.
    const message = 'run failed: ' + (error && error.message ? error.message : error);
    warnOnChange(say, 'run', message);
    return { ...summary, error: message };
  }
  if (lastReason.has('run')) { say('recovered'); lastReason.delete('run'); }
  return runZones({ db, nowIso, nowMs, say, summary, memo, bounds, zones, located, stationsByZone });
}

async function loadRun(db, deploymentDefault, stationsByZone) {
  const bounds = (await db.all('SELECT MIN(o) AS oldest, MAX(n) AS newest FROM (SELECT MIN(hour_start) AS o, MAX(hour_start) AS n FROM weather_provider_hours UNION ALL SELECT MIN(hour_start), MAX(hour_start) FROM weather_station_hours)', []))[0] || {};
  const zones = await db.all('SELECT iz.id, iz.timezone, iz.crop_type, iz.phenological_stage, iz.stage_started_on, gl.altitude_m FROM irrigation_zones iz LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui WHERE iz.deleted_at IS NULL ORDER BY iz.id', []);
  const located = new Map((await zoneLocations(db, deploymentDefault)).map((e) => [e.zone.id, e]));
  for (const a of await db.all("SELECT w.zone_id, w.deveui FROM weather_station_zones w JOIN devices d ON d.deveui = w.deveui WHERE d.type_id = 'SENSECAP_S2120' AND d.deleted_at IS NULL ORDER BY w.zone_id, w.deveui", [])) {
    if (!stationsByZone.has(a.zone_id)) stationsByZone.set(a.zone_id, []);
    stationsByZone.get(a.zone_id).push(a.deveui);
  }
  return { bounds, zones, located };
}

async function runZones({ db, nowIso, nowMs, say, summary, memo, bounds, zones, located, stationsByZone }) {
  if (bounds.newest && Date.parse(bounds.newest) - nowMs > CLOCK_SLACK_HOURS * HOUR_MS) {
    warnOnChange(say, 'clock', 'clock behind the store: newest hour ' + bounds.newest + ' is more than 24 h after ' + nowIso);
    return { ...summary, skipped: 'clock_behind_store' };
  }
  lastReason.delete('clock');
  // Hours are read once per (location key, station set, timezone) group, over a
  // span that covers the 92-day bound.
  const spanStart = hourStartIso(new Date(nowMs - (MAX_DAYS + 2) * DAY_MS));
  const spanEnd = hourStartIso(new Date(nowMs));
  const hourCache = new Map();
  async function hoursFor(entry, stations, tz) {
    const key = [entry ? entry.locationKey : '', stations.join(','), tz].join('|');
    if (!hourCache.has(key)) {
      const providerRows = entry && entry.locationKey
        ? await db.all('SELECT hour_start, et0_mm, station_id FROM weather_provider_hours WHERE location_key = ? AND hour_start >= ? AND hour_start < ?', [entry.locationKey, spanStart, spanEnd])
        : [];
      const stationHours = new Map(stations.map((deveui) => [deveui, new Map()]));
      if (stations.length) {
        const list = await db.all('SELECT deveui, hour_start, air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count FROM weather_station_hours WHERE deveui IN (' + stations.map(() => '?').join(', ') + ') AND hour_start >= ? AND hour_start < ?', [...stations, spanStart, spanEnd]);
        for (const r of list) stationHours.get(r.deveui).set(r.hour_start, r);
      }
      hourCache.set(key, { providerByHour: new Map(providerRows.map((r) => [r.hour_start, r])), stationHours });
    }
    return hourCache.get(key);
  }
  // One day's rows out of the indexed hours, so a 92-day backfill does not
  // rescan every stored hour for each day.
  function dayRows(byHour, hourStarts) {
    const out = [];
    for (const h of hourStarts) { const r = byHour.get(h); if (r) out.push(r); }
    return out;
  }
  const NO_HOURS = { providerByHour: new Map(), stationHours: new Map() };
  for (const zone of zones) {
    try {
      const entry = located.get(zone.id) || null;
      const tz = entry ? entry.timezone : (String(zone.timezone || 'UTC').trim() || 'UTC');
      if (formatterFor(tz).fallback) summary.tzFallback.push(zone.id);
      const today = todayLocal(nowIso, tz);
      const latestDays = completedLocalDays(nowIso, tz, LATEST_DAYS);
      const stations = stationsByZone.get(zone.id) || [];
      // Bounded to the same MAX_DAYS window daysNeedingWork ever looks at (E-M6):
      // the table never loses a row (retraction instead of delete) and grows by
      // 365 rows per zone per year, so an unbounded scan re-reads years of rows
      // this call can never use.
      const existingRows = await db.all(
        'SELECT date, et0_mm FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? AND date < ?',
        [zone.id, addDays(today, -MAX_DAYS), today]
      );
      const days = entry ? daysNeedingWork({ latestDays, existingRows, oldestHour: bounds.oldest, timezone: tz, nowIso }) : latestDays;
      // A zone without coordinates is no_location on every day: no hours needed.
      const hours = entry ? await hoursFor(entry, stations, tz) : NO_HOURS;
      const decided = days.map((date) => {
        const { hourStarts } = localDayWindow(date, tz, memo);
        const stationHours = new Map(stations.map((deveui) => [deveui, dayRows(hours.stationHours.get(deveui) || new Map(), hourStarts)]));
        // The previous LOCAL day's hours, for the night rule's carried ratio (the
        // previous evening) -- not a flat 24 UTC hours before this day's first
        // hour (queue E3 Task 1 review). A flat 24 hours happens to still reach
        // the prior evening on every DST/longitude case probed, but deriving it
        // from the zone's own calendar day is the defensive form and costs
        // nothing extra: localDayWindow memoizes per (timezone, date).
        const priorStarts = localDayWindow(addDays(date, -1), tz, memo).hourStarts;
        const stationPriorHours = new Map(stations.map((deveui) => [deveui, dayRows(hours.stationHours.get(deveui) || new Map(), priorStarts)]));
        return { date, computed: resolveDay({ date, hourStarts, latitude: entry ? entry.latitude : null, longitude: entry ? entry.longitude : null, provider: entry ? entry.provider : null, locationKey: entry ? entry.locationKey : null, stations, stationHours, stationPriorHours, providerRows: dayRows(hours.providerByHour, hourStarts), gatewayAltitudeM: zone.altitude_m, nowMs }) };
      });
      // Counted through the transaction and added only after COMMIT, so a
      // rolled-back zone reports nothing it did not keep.
      const counts = await db.transaction(async (tx) => {
        // Only `tx` inside the executor: the facade runs every call through one
        // queue and this transaction holds it; a call on `db` here never returns.
        const c = { retracted: 0, written: 0, unchanged: 0 };
        c.retracted = (await tx.all(RETRACT_SQL, [nowIso, zone.id, today])).length;
        const stored = new Map((await tx.all('SELECT date, kc, kc_source, crop_type, phenological_stage, stage_started_on, kc_stage_day, stage_overrun FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? AND date <= ?', [zone.id, days[0], days[days.length - 1]])).map((r) => [r.date, r]));
        for (const { date, computed } of decided) {
          const returned = await tx.all(UPSERT_SQL, rowParams(zone, date, computed, stored.get(date), nowIso));
          c.written += returned.length;
          c.unchanged += 1 - returned.length;
        }
        return c;
      });
      summary.retracted += counts.retracted;
      summary.written += counts.written;
      summary.unchanged += counts.unchanged;
      summary.zones += 1;
      summary.days += days.length;
      for (const { date, computed } of decided) {
        if (computed.et0Mm == null) summary.nulls.push({ zoneId: zone.id, date, reason: computed.nullReason, present: computed.hoursPresent, expected: computed.expectedHours });
      }
      const latest = decided[decided.length - 1].computed;
      if (latest.et0Mm == null) summary.latestNull += 1;
      const reason = (latest.nullReason || 'ok') + (formatterFor(tz).fallback ? '+tz_fallback' : '');
      if (lastReason.get(zone.id) !== reason) {
        if (reason !== 'ok' || lastReason.has(zone.id)) say('zone ' + zone.id + ': ' + (reason === 'ok' ? 'recovered' : reason + ' (' + latest.hoursPresent + '/' + latest.expectedHours + ' hours)'));
        lastReason.set(zone.id, reason);
      }
    } catch (error) {
      // Warned on change only, like the null reasons: a failing disk must not
      // flood the log every tick.
      const reason = 'failed: ' + (error && error.message ? error.message : error);
      if (!sameProblem(lastReason.get(zone.id), reason)) say('zone ' + zone.id + ' ' + reason);
      lastReason.set(zone.id, reason);
    }
  }
  return summary;
}

async function runDaily(args) {
  if (inFlight) return { zones: 0, days: 0, written: 0, unchanged: 0, retracted: 0, nulls: [], latestNull: 0, tzFallback: [], skipped: 'in_flight' };
  inFlight = runDailyOnce(args);
  try { return await inFlight; } finally { inFlight = null; }
}

module.exports = { localDayWindow, completedLocalDays, daysNeedingWork, sumDailyEt0, stationDayInputs, resolveDay, runDaily, resetState, maskProblem };
