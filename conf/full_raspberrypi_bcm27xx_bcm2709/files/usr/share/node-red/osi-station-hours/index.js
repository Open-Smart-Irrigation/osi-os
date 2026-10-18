'use strict';
// osi-station-hours: hourly aggregates of local weather station uplinks
// (SenseCAP S2120) for the daily agronomy writer. Spec:
// docs/superpowers/specs/2026-09-26-daily-agronomy-design.md, component 3.
// hour_start is stored as hourStartIso gives it ('…:00Z'), the form of
// weather_provider_hours; device_data.recorded_at is '…:00.000Z', so every
// bound compared with it is built with Date#toISOString().
const { hourStartIso } = require('../osi-weather-provider');
const { catalogue } = require('../osi-crop-kc');

const HOUR_MS = 3600000;
const RECENT_HOURS = 48;
const LOOKBACK_HOURS = 168;
const LUX_PER_WM2 = catalogue.luxPerWm2;
// The clock guard, as runDaily's: a Pi 4 that reboots offline stamps S2120
// uplinks with a stale clock. Aggregating then would mix those samples into
// real past hours, and an hour older than 48 h is never aggregated again, so
// the damage would outlive the NTP fix.
const CLOCK_FLOOR_ISO = '2024-01-01';
const CLOCK_SLACK_HOURS = 24;

const STATIONS_SQL = "SELECT DISTINCT d.deveui FROM devices d JOIN weather_station_zones w ON w.deveui = d.deveui WHERE d.type_id = 'SENSECAP_S2120' AND d.deleted_at IS NULL ORDER BY d.deveui";
const SAMPLES_SQL = 'SELECT recorded_at, ambient_temperature, relative_humidity, wind_speed_mps, barometric_pressure_hpa, light_lux, rain_mm_delta FROM device_data WHERE deveui = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at';
const COLUMNS = ['air_temperature_c', 'air_temperature_min_c', 'air_temperature_max_c', 'relative_humidity_pct', 'wind_speed_mps', 'pressure_hpa', 'light_lux', 'global_radiation_wm2', 'rain_mm', 'sample_count'];
const UPSERT_SQL =
  'INSERT INTO weather_station_hours (deveui, hour_start, ' + COLUMNS.join(', ') + ', computed_at) VALUES (?, ?, ' + COLUMNS.map(() => '?').join(', ') + ', ?) ' +
  'ON CONFLICT(deveui, hour_start) DO UPDATE SET ' + COLUMNS.map((c) => c + ' = excluded.' + c).join(', ') + ', computed_at = excluded.computed_at ' +
  'WHERE ' + COLUMNS.map((c) => 'weather_station_hours.' + c + ' IS NOT excluded.' + c).join(' OR ') + ' ' +
  'RETURNING deveui';

function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function round(v, decimals) { if (!finite(v)) return null; const f = 10 ** decimals; return Math.round(v * f) / f; }
function values(rows, key) { return rows.map((r) => r[key]).filter(finite); }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function hourlyAggregate(rows) {
  const temps = values(rows, 'ambient_temperature');
  const rain = values(rows, 'rain_mm_delta');
  const lux = mean(values(rows, 'light_lux'));
  return {
    air_temperature_c: round(mean(temps), 2),
    air_temperature_min_c: temps.length ? round(Math.min(...temps), 2) : null,
    air_temperature_max_c: temps.length ? round(Math.max(...temps), 2) : null,
    relative_humidity_pct: round(mean(values(rows, 'relative_humidity')), 1),
    wind_speed_mps: round(mean(values(rows, 'wind_speed_mps')), 2),
    pressure_hpa: round(mean(values(rows, 'barometric_pressure_hpa')), 1),
    light_lux: round(lux, 0),
    global_radiation_wm2: lux == null ? null : round(lux / LUX_PER_WM2, 2),
    rain_mm: rain.length ? round(rain.reduce((a, b) => a + b, 0), 3) : null,
    sample_count: rows.length,
  };
}

// The window: the last 48 hours, moved back to the first hour of the last
// 7 days that has samples but no row (spec, component 3).
async function windowStartMs(db, deveui, currentHourMs) {
  const recentMs = currentHourMs - RECENT_HOURS * HOUR_MS;
  const lookbackMs = currentHourMs - LOOKBACK_HOURS * HOUR_MS;
  const sampled = await db.all('SELECT recorded_at FROM device_data WHERE deveui = ? AND recorded_at >= ? AND recorded_at < ?', [deveui, new Date(lookbackMs).toISOString(), new Date(recentMs).toISOString()]);
  if (!sampled.length) return recentMs;
  const stored = new Set((await db.all('SELECT hour_start FROM weather_station_hours WHERE deveui = ? AND hour_start >= ? AND hour_start < ?', [deveui, hourStartIso(new Date(lookbackMs)), hourStartIso(new Date(recentMs))])).map((r) => r.hour_start));
  let first = null;
  for (const row of sampled) {
    const hour = hourStartIso(row.recorded_at);
    if (hour && !stored.has(hour) && (!first || hour < first)) first = hour;
  }
  return first ? Date.parse(first) : recentMs;
}

// Per-station and clock warnings are logged when a problem starts or changes;
// instants and digits are masked, so the same problem at a later hour is the
// same problem. A recovery clears the entry and is logged.
const lastError = new Map();
function maskProblem(text) { return String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, '<time>').replace(/\d+/g, '#'); }
function warnOnChange(say, key, message) {
  const previous = lastError.get(key);
  if (previous == null || maskProblem(previous) !== maskProblem(message)) say(message);
  lastError.set(key, message);
}
function clearProblem(say, key) {
  if (lastError.has(key)) { say(key + ': recovered'); lastError.delete(key); }
}
function resetState() { lastError.clear(); }

async function aggregateStationHours({ db, nowIso, warn }) {
  const say = typeof warn === 'function' ? warn : () => {};
  const summary = { devices: 0, hours: 0, written: 0, unchanged: 0, failed: 0 };
  const nowMs = Date.parse(nowIso);
  const newest = !(String(nowIso) < CLOCK_FLOOR_ISO) && Number.isFinite(nowMs)
    ? ((await db.all('SELECT MAX(hour_start) AS newest FROM weather_station_hours', []))[0] || {}).newest
    : null;
  if (String(nowIso) < CLOCK_FLOOR_ISO || !Number.isFinite(nowMs) || (newest && Date.parse(newest) - nowMs > CLOCK_SLACK_HOURS * HOUR_MS)) {
    warnOnChange(say, 'clock', newest
      ? 'clock behind the store: newest hour ' + newest + ' is more than 24 h after ' + nowIso
      : 'clock before ' + CLOCK_FLOOR_ISO + ': ' + nowIso);
    return { ...summary, skipped: 'clock_behind_store' };
  }
  clearProblem(say, 'clock');
  const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  for (const { deveui } of await db.all(STATIONS_SQL, [])) {
    summary.devices += 1;
    try {
      const startMs = await windowStartMs(db, deveui, currentHourMs);
      const samples = await db.all(SAMPLES_SQL, [deveui, new Date(startMs).toISOString(), new Date(currentHourMs).toISOString()]);
      const byHour = new Map();
      for (const s of samples) {
        const hour = hourStartIso(s.recorded_at);
        if (!hour) continue;
        if (!byHour.has(hour)) byHour.set(hour, []);
        byHour.get(hour).push(s);
      }
      const rows = [...byHour.entries()].map(([hour, list]) => [hour, hourlyAggregate(list)]);
      // Tallied locally and added only after COMMIT, so a rolled-back station
      // reports nothing it did not keep.
      const counts = await db.transaction(async (tx) => {
        // Only `tx` inside the executor: the facade's queue is held by this transaction.
        const c = { hours: 0, written: 0, unchanged: 0 };
        for (const [hour, agg] of rows) {
          const returned = await tx.all(UPSERT_SQL, [deveui, hour, ...COLUMNS.map((col) => agg[col]), nowIso]);
          c.hours += 1;
          c.written += returned.length;
          c.unchanged += 1 - returned.length;
        }
        return c;
      });
      summary.hours += counts.hours;
      summary.written += counts.written;
      summary.unchanged += counts.unchanged;
      clearProblem(say, deveui);
    } catch (error) {
      summary.failed += 1;
      warnOnChange(say, deveui, deveui + ': ' + (error && error.message ? error.message : error));
    }
  }
  return summary;
}

module.exports = { hourlyAggregate, aggregateStationHours, resetState, maskProblem };
