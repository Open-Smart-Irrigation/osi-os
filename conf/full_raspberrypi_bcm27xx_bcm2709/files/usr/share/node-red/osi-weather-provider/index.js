'use strict';
// osi-weather-provider: provider weather (Open-Meteo, MeteoSwiss) stored per
// farm location and completed UTC hour. Spec:
// docs/superpowers/specs/2026-09-25-weather-provider-store-design.md
// Every function that touches the network takes its HTTP functions from a
// `deps` argument so the tests run on recorded fixtures.

const PROVIDERS = Object.freeze(['open_meteo', 'meteoswiss']);

const HOUR_MS = 3600000;
const REREAD_HOURS = 3;
// A tick looks this far back for an hour the store is missing (spec "Fetch
// job"): a gap left while a provider file lagged is read again for a week.
const GAP_LOOKBACK_HOURS = 168;
const OPEN_METEO_BACKFILL_HOURS = 92 * 24;

function trimLower(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function resolveProvider(zoneWeatherSource, deploymentDefault) {
  const zone = trimLower(zoneWeatherSource);
  if (zone === 'local') return null;
  if (PROVIDERS.includes(zone)) return zone;
  const fallback = trimLower(deploymentDefault);
  return PROVIDERS.includes(fallback) ? fallback : 'open_meteo';
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fixed2(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  const text = (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

function locationKey(provider, latitude, longitude) {
  // Number(null) and Number('') are 0; a missing coordinate must not become
  // a key at 0.00.
  if (toFiniteNumber(latitude) == null || toFiniteNumber(longitude) == null) {
    throw new Error('locationKey requires finite coordinates');
  }
  return provider + ':' + fixed2(latitude) + ':' + fixed2(longitude);
}

// A date-time string without a zone suffix (Open-Meteo's `2026-09-25T10:00`)
// is UTC here; `new Date()` alone would read it in the process's local zone.
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function hourStartIso(value) {
  // new Date(null) is the epoch: a missing value is null, not 1970.
  if (value == null || value === '') return null;
  const input = typeof value === 'string' && NAIVE_ISO.test(value) ? value + 'Z' : value;
  const date = input instanceof Date ? input : new Date(input);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function addHours(iso, hours) {
  return hourStartIso(new Date(new Date(iso).getTime() + hours * HOUR_MS));
}

// The first hour in fromUtc..toUtc (exclusive) that is not in the given
// hour_start values, or null when every hour is present.
function firstMissingHour(existingHourStarts, fromUtc, toUtc) {
  const present = existingHourStarts instanceof Set ? existingHourStarts : new Set(existingHourStarts || []);
  const from = hourStartIso(fromUtc);
  const to = hourStartIso(toUtc);
  if (!from || !to) return null;
  for (let hour = from; hour < to; hour = addHours(hour, 1)) {
    if (!present.has(hour)) return hour;
  }
  return null;
}

function fetchWindow({ provider, newestStoredHour, nowIso }) {
  const toUtc = hourStartIso(nowIso);
  if (!toUtc) throw new Error('fetchWindow: nowIso is not a date');
  const newest = newestStoredHour ? hourStartIso(newestStoredHour) : null;
  if (newest) {
    // Rows stamped after the clock (the clock was set back after they were
    // written) do not move the window past now: it re-reads from toUtc - 3 h
    // and overwrites them as real time reaches them.
    const reference = newest < toUtc ? newest : toUtc;
    return { fromUtc: addHours(reference, -REREAD_HOURS), toUtc, firstFetch: false };
  }
  if (provider === 'meteoswiss') {
    const year = new Date(toUtc).getUTCFullYear();
    return { fromUtc: year + '-01-01T00:00:00Z', toUtc, firstFetch: true };
  }
  return { fromUtc: addHours(toUtc, -OPEN_METEO_BACKFILL_HOURS), toUtc, firstFetch: true };
}

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,et0_fao_evapotranspiration';

function round2(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}

// past_hours/forecast_hours=1 ends the response at the server's current hour
// (stamp T = the hour T-1h..T just completed), whatever the gateway clock
// says; past_days/forecast_days ran to the end of the day and would hand a
// gateway whose clock runs ahead forecast hours to store as observations.
function buildOpenMeteoUrl(location, pastHours) {
  return OPEN_METEO_BASE +
    '?latitude=' + encodeURIComponent(location.latitude) +
    '&longitude=' + encodeURIComponent(location.longitude) +
    '&hourly=' + OPEN_METEO_HOURLY +
    '&timezone=UTC' +
    '&past_hours=' + Number(pastHours) +
    '&forecast_hours=1';
}

function inWindow(hourStart, fromUtc, toUtc) {
  return !!hourStart && hourStart >= fromUtc && hourStart < toUtc;
}

const MEASUREMENT_KEYS = ['air_temperature_c', 'relative_humidity_pct', 'rain_mm', 'wind_speed_mps', 'global_radiation_wm2', 'et0_mm'];

function allNull(row) {
  return MEASUREMENT_KEYS.every((key) => row[key] == null);
}

// Open-Meteo stamp T: precipitation, radiation and ET0 are the preceding
// hour's sum/mean (T-1h..T); temperature, humidity and wind are instantaneous
// at T. Stored as hour_start = T-1h so both providers describe the same hour.
function normalizeOpenMeteo(payload, fromUtc, toUtc) {
  const hourly = payload && payload.hourly;
  const times = Array.isArray(hourly && hourly.time) ? hourly.time : [];
  const pick = (key, index) => toFiniteNumber(Array.isArray(hourly[key]) ? hourly[key][index] : null);
  const rows = [];
  for (let i = 0; i < times.length; i += 1) {
    const stamp = hourStartIso(times[i]);
    const hourStart = stamp ? addHours(stamp, -1) : null;
    if (!inWindow(hourStart, fromUtc, toUtc)) continue;
    const windKmh = pick('wind_speed_10m', i);
    const row = {
      hour_start: hourStart,
      air_temperature_c: pick('temperature_2m', i),
      relative_humidity_pct: pick('relative_humidity_2m', i),
      rain_mm: pick('precipitation', i),
      wind_speed_mps: windKmh == null ? null : round2(windKmh / 3.6),
      global_radiation_wm2: pick('shortwave_radiation', i),
      et0_mm: pick('et0_fao_evapotranspiration', i),
    };
    // An hour with no value at all is an absent hour (Open-Meteo returns
    // nulls for hours older than about 60 days), not a row of nulls.
    if (allNull(row)) continue;
    rows.push(row);
  }
  return rows;
}

// Enough past hours to cover the window (so an outage gap is refilled) with a
// day of margin for a gateway clock that differs from the server's, at least
// 48 and never more than the 92-day backfill.
function openMeteoPastHours(window) {
  if (window.firstFetch) return OPEN_METEO_BACKFILL_HOURS;
  const spanMs = new Date(window.toUtc).getTime() - new Date(window.fromUtc).getTime();
  const hours = Math.ceil(spanMs / HOUR_MS) + 24;
  return Math.min(OPEN_METEO_BACKFILL_HOURS, Math.max(48, hours));
}

async function fetchOpenMeteoHours(location, window, deps) {
  const payload = await deps.requestJson(buildOpenMeteoUrl(location, openMeteoPastHours(window)));
  return { rows: normalizeOpenMeteo(payload, window.fromUtc, window.toUtc) };
}

const METEOSWISS_BASE = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/';
const METEOSWISS_MAX_KM = 15;
const METEOSWISS_MAX_CANDIDATES = 3;
const METEOSWISS_RAIN_EVIDENCE_DAYS = 14;
const CSV_DECODER = new TextDecoder('windows-1252');

function decodeCsv(buffer) {
  // A UTF-8 byte-order mark (EF BB BF) decodes as three mojibake characters
  // under Windows-1252 and is never stripped downstream; drop it here so
  // parseCsv's U+FEFF strip (for a BOM that survived decoding intact) still
  // applies to whatever is left.
  const body = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  return CSV_DECODER.decode(body);
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) { cells.push(current); current = ''; }
    else current += ch;
  }
  cells.push(current);
  return cells;
}

function parseCsv(text) {
  return String(text || '').replace(/^﻿/, '').split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map(splitCsvLine);
}

function optionalColumnIndex(header, name) {
  return header.findIndex((cell) => cell.trim().toLowerCase() === name);
}

function columnIndex(header, name) {
  const index = optionalColumnIndex(header, name);
  if (index < 0) throw new Error('MeteoSwiss column ' + name + ' missing');
  return index;
}

// A missing column (index -1) or an empty cell is null, never 0.
function cellNumber(row, index) {
  return toFiniteNumber(index >= 0 && index < row.length ? row[index].trim() : null);
}

function withinSwissCoverage(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= 45.5 && latitude <= 48.0 && longitude >= 5.8 && longitude <= 10.6;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  // Same radius as the cloud's MeteoSwissStationRainService.haversineKm, so
  // both sides pick the same station for the same coordinates.
  return 6371.0 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Station ids go into a URL path; MeteoSwiss uses three-letter codes.
const STATION_ID = /^[A-Za-z0-9]{2,8}$/;

function parseStations(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0];
  const id = columnIndex(header, 'station_abbr');
  const name = columnIndex(header, 'station_name');
  const lat = columnIndex(header, 'station_coordinates_wgs84_lat');
  const lon = columnIndex(header, 'station_coordinates_wgs84_lon');
  const stations = [];
  for (const row of rows.slice(1)) {
    const latitude = cellNumber(row, lat);
    const longitude = cellNumber(row, lon);
    const stationId = (row[id] || '').trim();
    if (!STATION_ID.test(stationId) || latitude == null || longitude == null) continue;
    stations.push({ id: stationId, name: (row[name] || '').trim() || null, latitude, longitude });
  }
  return stations;
}

function nearestStations(stations, latitude, longitude, options) {
  const maxKm = options && options.maxKm != null ? options.maxKm : METEOSWISS_MAX_KM;
  const limit = options && options.limit != null ? options.limit : METEOSWISS_MAX_CANDIDATES;
  return stations
    .map((station) => ({ ...station, distanceKm: Math.round(haversineKm(latitude, longitude, station.latitude, station.longitude) * 10) / 10 }))
    .filter((station) => station.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

// 'dd.MM.yyyy HH:mm' in UTC -> ISO instant, or null.
function parseSwissTimestamp(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]))).toISOString();
}

function parseDailyRain(text) {
  const rows = parseCsv(text);
  const daily = new Map();
  if (!rows.length) return daily;
  const header = rows[0];
  const ts = columnIndex(header, 'reference_timestamp');
  const rain = columnIndex(header, 'rka150d0');
  for (const row of rows.slice(1)) {
    const start = parseSwissTimestamp(row[ts]);
    const value = cellNumber(row, rain);
    if (start && value != null) daily.set(start.slice(0, 10), round2(value));
  }
  return daily;
}

function measuresRain(daily, todayIso, days) {
  const horizon = days == null ? METEOSWISS_RAIN_EVIDENCE_DAYS : days;
  const oldest = new Date(new Date(todayIso.slice(0, 10) + 'T00:00:00Z').getTime() - horizon * 24 * HOUR_MS).toISOString().slice(0, 10);
  for (const date of daily.keys()) if (date >= oldest) return true;
  return false;
}

function normalizeMeteoSwiss(text, fromUtc, toUtc) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0];
  const ts = columnIndex(header, 'reference_timestamp');
  // Measurement columns are looked up by name; a station file lacking one
  // yields null for that field rather than failing the whole fetch.
  const col = {
    air_temperature_c: optionalColumnIndex(header, 'tre200h0'),   // air temperature 2 m, hourly mean, °C
    relative_humidity_pct: optionalColumnIndex(header, 'ure200h0'), // relative humidity 2 m, hourly mean, %
    rain_mm: optionalColumnIndex(header, 'rre150h0'),             // precipitation, hourly total, mm
    wind_speed_mps: optionalColumnIndex(header, 'fkl010h0'),      // wind speed scalar, hourly mean, m/s
    global_radiation_wm2: optionalColumnIndex(header, 'gre000h0'), // global radiation, hourly mean, W/m²
    et0_mm: optionalColumnIndex(header, 'erefaoh0'),              // FAO reference evaporation, hourly total, mm
  };
  const out = [];
  for (const row of rows.slice(1)) {
    const end = parseSwissTimestamp(row[ts]);
    if (!end) continue;
    const hourStart = addHours(hourStartIso(end), -1);
    if (!inWindow(hourStart, fromUtc, toUtc)) continue;
    const hour = {
      hour_start: hourStart,
      air_temperature_c: cellNumber(row, col.air_temperature_c),
      relative_humidity_pct: cellNumber(row, col.relative_humidity_pct),
      rain_mm: cellNumber(row, col.rain_mm),
      wind_speed_mps: cellNumber(row, col.wind_speed_mps),
      global_radiation_wm2: cellNumber(row, col.global_radiation_wm2),
      et0_mm: cellNumber(row, col.et0_mm),
    };
    // A row with every value empty is an absent hour, as in
    // normalizeOpenMeteo: stored, it would count as the newest hour and
    // overwrite good values on the 3 h re-read.
    if (allNull(hour)) continue;
    out.push(hour);
  }
  return out;
}

function mergeRows(...lists) {
  const byHour = new Map();
  for (const list of lists) for (const row of list || []) byHour.set(row.hour_start, row);
  return [...byHour.values()].sort((a, b) => (a.hour_start < b.hour_start ? -1 : a.hour_start > b.hour_start ? 1 : 0));
}

function meteoSwissUrl(kind, stationId) {
  if (kind === 'stations') return METEOSWISS_BASE + 'ogd-smn_meta_stations.csv';
  if (typeof stationId !== 'string' || !STATION_ID.test(stationId)) throw new Error('invalid MeteoSwiss station id');
  const id = stationId.toLowerCase();
  return METEOSWISS_BASE + id + '/ogd-smn_' + id + '_' + kind + '.csv';
}

async function resolveMeteoSwissStation(location, nowIso, deps, options) {
  if (!withinSwissCoverage(location.latitude, location.longitude)) {
    throw new Error('outside MeteoSwiss coverage');
  }
  const stations = parseStations(decodeCsv(await deps.requestBuffer(meteoSwissUrl('stations'))));
  const excluded = new Set((options && options.excludeIds) || []);
  const near = nearestStations(stations, location.latitude, location.longitude);
  // An excluded station (one that just went silent) is tried last rather
  // than dropped: when it is the only candidate in range, or no other one
  // has rain data, it is still better than leaving the location without a
  // station.
  const ordered = near.filter((s) => !excluded.has(s.id)).concat(near.filter((s) => excluded.has(s.id)));
  for (const candidate of ordered) {
    const daily = parseDailyRain(decodeCsv(await deps.requestBuffer(meteoSwissUrl('d_recent', candidate.id))));
    if (measuresRain(daily, nowIso)) return candidate;
  }
  throw new Error('no MeteoSwiss station with rain data within ' + METEOSWISS_MAX_KM + ' km');
}

// h_recent (1 January .. yesterday, about 1 MB and growing through the year)
// is rebuilt once a day, so re-reading it every 30 minutes only costs
// bandwidth. One read per station per 2 hours is enough to pick up the daily
// rebuild. The state lives in this process: osi-lib loads the module once per
// Node-RED process, and a restart only means one extra read.
const METEOSWISS_RECENT_MIN_INTERVAL_HOURS = 2;
const recentReadAt = new Map(); // station id -> ISO time of the last h_recent read

function recentThrottled(stationId, nowIso) {
  const last = recentReadAt.get(stationId);
  if (!last) return false;
  const elapsed = Date.parse(nowIso) - Date.parse(last);
  // A clock that went backwards (elapsed < 0) does not hold the file back.
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < METEOSWISS_RECENT_MIN_INTERVAL_HOURS * HOUR_MS;
}

async function fetchMeteoSwissHours(location, window, deps, nowIso) {
  const now = nowIso || window.toUtc;
  const station = location.station_id
    ? { id: location.station_id, name: location.station_name || null, distanceKm: location.station_distance_km == null ? null : location.station_distance_km }
    : await resolveMeteoSwissStation(location, now, deps, { excludeIds: location.exclude_station_ids });
  // h_now holds the current UTC day (its first row, stamped 00:00, is
  // yesterday's last hour). Anything earlier is in h_recent, which is read
  // only on a first fetch or when the window has an hour before today that
  // h_now did not deliver.
  const todayStart = window.toUtc.slice(0, 10) + 'T00:00:00Z';
  const hNowRows = normalizeMeteoSwiss(decodeCsv(await deps.requestBuffer(meteoSwissUrl('h_now', station.id))), window.fromUtc, window.toUtc);
  const result = { rows: hNowRows, station };
  const needRecent = window.firstFetch || firstMissingHour(hNowRows.map((row) => row.hour_start), window.fromUtc, todayStart) !== null;
  if (!needRecent) return result;
  // A first fetch happens once per location and must not be cut to today:
  // the throttle only holds back the gap re-reads.
  if (!window.firstFetch && recentThrottled(station.id, now)) {
    result.recentSkipped = true;
    return result;
  }
  // Recorded before the request: a download that fails half-way cost the
  // bandwidth too, and the next tick still stores h_now.
  recentReadAt.set(station.id, now);
  const recentRows = normalizeMeteoSwiss(decodeCsv(await deps.requestBuffer(meteoSwissUrl('h_recent', station.id))), window.fromUtc, window.toUtc);
  result.rows = mergeRows(recentRows, hNowRows); // h_now wins on a shared hour
  return result;
}

// A station that went silent is passed over for a day when the location
// resolves a station again, so the next tick does not pick it straight back.
const METEOSWISS_SILENT_EXCLUDE_HOURS = 24;
const silentExclusions = new Map(); // location key -> { stationId, until (ISO) }

function excludedStationIds(key, nowIso) {
  const entry = silentExclusions.get(key);
  if (!entry) return [];
  if (!(Date.parse(nowIso) < Date.parse(entry.until))) {
    silentExclusions.delete(key);
    return [];
  }
  return [entry.stationId];
}

// Clears the module state of both MeteoSwiss rules (h_recent throttle,
// silent-station exclusions); for tests.
function resetMeteoSwissThrottle() {
  recentReadAt.clear();
  silentExclusions.clear();
}

function httpDeps({ http, https, timeoutMs, deadlineMs }) {
  const timeout = Math.max(1000, Number(timeoutMs || 15000) || 15000);
  // The idle timeout above (req.setTimeout) resets on every byte received, so
  // a server that trickles data forever never trips it; a body cut off
  // mid-response never fires 'end' at all. This overall deadline is the only
  // thing bounding total request time, and it is what keeps a hung tick from
  // leaking the flow node's DB handle (runTick is awaited, db.close() runs in
  // a finally).
  const explicitDeadline = deadlineMs == null ? NaN : Number(deadlineMs);
  const deadline = Number.isFinite(explicitDeadline) && explicitDeadline > 0 ? explicitDeadline : Math.max(timeout, 60000);
  function request(urlString) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        fn(value);
      };
      const lib = urlString.startsWith('https:') ? https : http;
      const req = lib.request(urlString, { method: 'GET', headers: { 'User-Agent': 'osi-os weather-provider' } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const status = Number(res.statusCode || 0);
          const body = Buffer.concat(chunks);
          if (status < 200 || status >= 300) return done(reject, new Error('HTTP ' + status + ' from ' + urlString));
          done(resolve, body);
        });
        res.on('error', (error) => done(reject, error));
        res.on('aborted', () => done(reject, new Error('response aborted: ' + urlString)));
      });
      req.on('error', (error) => done(reject, error));
      req.setTimeout(timeout, () => req.destroy(new Error('timeout after ' + timeout + ' ms: ' + urlString)));
      const deadlineTimer = setTimeout(() => req.destroy(new Error('deadline after ' + deadline + ' ms: ' + urlString)), deadline);
      req.end();
    });
  }
  return {
    requestBuffer: request,
    requestJson: async (url) => JSON.parse((await request(url)).toString('utf8')),
  };
}

function fetchHours(provider, location, window, deps, nowIso) {
  if (provider === 'meteoswiss') return fetchMeteoSwissHours(location, window, deps, nowIso);
  return fetchOpenMeteoHours(location, window, deps);
}

const ZONE_SQL =
  'SELECT iz.id, iz.latitude, iz.longitude, iz.timezone, iz.weather_source, iz.crop_type, iz.phenological_stage, iz.gateway_device_eui, ' +
  'gl.latitude AS gateway_latitude, gl.longitude AS gateway_longitude ' +
  'FROM irrigation_zones iz ' +
  'LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui ' +
  'WHERE iz.deleted_at IS NULL ' +
  'ORDER BY iz.id';

const UPSERT_LOCATION_SQL =
  'INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone) VALUES (?, ?, ?, ?, ?) ' +
  'ON CONFLICT(location_key) DO UPDATE SET timezone = excluded.timezone';

const UPSERT_HOUR_SQL =
  'INSERT INTO weather_provider_hours (location_key, hour_start, air_temperature_c, relative_humidity_pct, rain_mm, wind_speed_mps, global_radiation_wm2, et0_mm, fetched_at, station_id) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(location_key, hour_start) DO UPDATE SET ' +
  'air_temperature_c = excluded.air_temperature_c, relative_humidity_pct = excluded.relative_humidity_pct, rain_mm = excluded.rain_mm, ' +
  'wind_speed_mps = excluded.wind_speed_mps, global_radiation_wm2 = excluded.global_radiation_wm2, et0_mm = excluded.et0_mm, fetched_at = excluded.fetched_at, ' +
  'station_id = excluded.station_id';

const METEOSWISS_SILENT_AFTER_HOURS = 3;

function zoneCoordinates(zone) {
  const lat = toFiniteNumber(zone.latitude);
  const lon = toFiniteNumber(zone.longitude);
  if (lat != null && lon != null) return { latitude: lat, longitude: lon };
  const glat = toFiniteNumber(zone.gateway_latitude);
  const glon = toFiniteNumber(zone.gateway_longitude);
  if (glat != null && glon != null) return { latitude: glat, longitude: glon };
  return null;
}

// Every live zone with coordinates (zone, else gateway), one entry per zone
// (not deduplicated by location), ordered by zone id. A 'local' zone carries
// no provider or location key -- runTick skips it, and the daily-agronomy
// writer (osi-agronomy-daily) still needs the zone's own row. Used by runTick for its
// per-location fetch grouping and, unfiltered, by that writer.
async function zoneLocations(db, deploymentDefault) {
  const zones = await db.all(ZONE_SQL, []);
  const out = [];
  for (const zone of zones) {
    const coords = zoneCoordinates(zone);
    if (!coords) continue;
    const provider = resolveProvider(zone.weather_source, deploymentDefault);
    const timezone = String(zone.timezone || 'UTC').trim() || 'UTC';
    out.push({
      zone: { id: zone.id, timezone, crop_type: zone.crop_type == null ? null : zone.crop_type, phenological_stage: zone.phenological_stage == null ? null : zone.phenological_stage, gateway_device_eui: zone.gateway_device_eui || null },
      provider,
      locationKey: provider ? locationKey(provider, coords.latitude, coords.longitude) : null,
      latitude: Number(fixed2(coords.latitude)),
      longitude: Number(fixed2(coords.longitude)),
      timezone,
    });
  }
  return out;
}

async function tablesPresent(db) {
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('weather_locations', 'weather_provider_hours')", []);
  return rows.length === 2;
}

// Two messages about the same problem at different hours (a later toUtc, a
// later newest hour) are one problem for the warning log.
function sameProblem(previous, message) {
  if (previous == null) return false;
  const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
  return String(previous).replace(ISO_INSTANT, '<time>') === String(message).replace(ISO_INSTANT, '<time>');
}

async function runTickOnce({ db, nowIso, deploymentDefault, deps, warn }) {
  const say = typeof warn === 'function' ? warn : () => {};
  const summary = { zones: 0, locations: 0, stored: 0, failed: 0 };
  if (!(await tablesPresent(db))) {
    summary.error = 'weather tables missing (deploy the schema migration)';
    say(summary.error);
    return summary;
  }
  const locations = new Map();
  for (const entry of await zoneLocations(db, deploymentDefault)) {
    if (!entry.provider) continue;
    summary.zones += 1;
    if (!locations.has(entry.locationKey)) {
      // Requests use the key's rounded coordinates, so every zone of a key
      // asks for the same grid point whichever zone comes first; the lowest
      // zone id supplies the timezone.
      locations.set(entry.locationKey, { key: entry.locationKey, provider: entry.provider, latitude: entry.latitude, longitude: entry.longitude, timezone: entry.timezone });
    }
  }
  for (const location of locations.values()) {
    summary.locations += 1;
    await db.run(UPSERT_LOCATION_SQL, [location.key, location.provider, location.latitude, location.longitude, location.timezone]);
    const stored = (await db.all('SELECT station_id, station_name, station_distance_km, station_resolved_at, last_error FROM weather_locations WHERE location_key = ?', [location.key]))[0] || {};
    // A failure is logged when it starts or changes, not on every tick of
    // an outage; the end of one is logged as `recovered`.
    const report = (message) => {
      if (!sameProblem(stored.last_error, message)) say(location.key + ': ' + message);
    };
    const bounds = (await db.all('SELECT MIN(hour_start) AS oldest, MAX(hour_start) AS newest FROM weather_provider_hours WHERE location_key = ?', [location.key]))[0] || {};
    const window = fetchWindow({ provider: location.provider, newestStoredHour: bounds.newest, nowIso });
    const newestStored = hourStartIso(bounds.newest);
    if (newestStored && newestStored > addHours(window.toUtc, 24)) {
      // The store holds hours more than a day after this clock: the clock is
      // wrong, not the store. Write nothing until it is right again.
      const message = 'clock behind the store: newest hour ' + newestStored + ' is after ' + window.toUtc;
      summary.failed += 1;
      report(message);
      await db.run('UPDATE weather_locations SET last_fetch_at = ?, last_error = ? WHERE location_key = ?', [nowIso, message, location.key]);
      continue;
    }
    if (!window.firstFetch) {
      // A hole in the last week (a provider file that had not caught up yet
      // when the hour was first due) moves the window back to it, so it is
      // read again instead of lying behind `newest` for good. Hours before
      // the first stored hour were never in scope and are not a hole.
      const weekAgo = addHours(window.toUtc, -GAP_LOOKBACK_HOURS);
      const oldest = hourStartIso(bounds.oldest);
      const lookbackStart = oldest && oldest > weekAgo ? oldest : weekAgo;
      const have = await db.all('SELECT hour_start FROM weather_provider_hours WHERE location_key = ? AND hour_start >= ? AND hour_start < ?' + (location.provider === 'meteoswiss' ? ' AND station_id IS NOT NULL' : ''), [location.key, lookbackStart, window.toUtc]);
      const gap = firstMissingHour(have.map((row) => row.hour_start), lookbackStart, window.toUtc);
      if (gap && gap < window.fromUtc) window.fromUtc = gap;
    }
    // A station is resolved once and re-resolved when that resolution is older
    // than a day (spec "Data model"), so a decommissioned station is replaced.
    // A resolution dated after now (written under a clock that ran ahead)
    // cannot be trusted to be recent either.
    const resolvedMs = stored.station_resolved_at ? Date.parse(stored.station_resolved_at) : NaN;
    const ageMs = Date.parse(nowIso) - resolvedMs;
    const stationStale = !stored.station_id || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * HOUR_MS;
    const cachedStation = stationStale ? {} : stored;
    try {
      const request = {
        ...location,
        station_id: cachedStation.station_id || null,
        station_name: cachedStation.station_name || null,
        station_distance_km: cachedStation.station_distance_km,
        exclude_station_ids: excludedStationIds(location.key, nowIso),
      };
      const result = await fetchHours(location.provider, request, window, deps, nowIso);
      let newestFetched = null;
      for (const row of result.rows) {
        if (row.hour_start >= window.toUtc) continue;
        await db.run(UPSERT_HOUR_SQL, [location.key, row.hour_start, row.air_temperature_c, row.relative_humidity_pct, row.rain_mm, row.wind_speed_mps, row.global_radiation_wm2, row.et0_mm, nowIso, location.provider === 'meteoswiss' && result.station ? result.station.id : null]);
        summary.stored += 1;
        if (!newestFetched || row.hour_start > newestFetched) newestFetched = row.hour_start;
      }
      const station = result.station || null;
      // A station that stopped publishing still answers HTTP 200 with old rows.
      // Its newest completed hour more than 3 h behind the clock is a silent
      // station: keep what it sent, say so, and forget it so the next tick
      // resolves a station again.
      const silentBefore = addHours(window.toUtc, -METEOSWISS_SILENT_AFTER_HOURS);
      const silent = location.provider === 'meteoswiss' && (!newestFetched || newestFetched < silentBefore);
      if (silent) {
        const message = 'station ' + (station ? station.id : '?') + ' silent since ' + (newestFetched || 'the start of the window');
        report(message);
        if (station) {
          silentExclusions.set(location.key, { stationId: station.id, until: new Date(Date.parse(nowIso) + METEOSWISS_SILENT_EXCLUDE_HOURS * HOUR_MS).toISOString() });
        }
        await db.run(
          'UPDATE weather_locations SET last_fetch_at = ?, last_success_at = ?, last_error = ?, station_id = NULL, station_resolved_at = NULL WHERE location_key = ?',
          [nowIso, nowIso, message, location.key]
        );
      } else {
        if (stored.last_error) say(location.key + ': recovered');
        if (station && stationStale) {
          await db.run(
            'UPDATE weather_locations SET last_fetch_at = ?, last_success_at = ?, last_error = NULL, station_id = ?, station_name = ?, station_distance_km = ?, station_resolved_at = ? WHERE location_key = ?',
            [nowIso, nowIso, station.id, station.name || null, station.distanceKm == null ? null : station.distanceKm, nowIso, location.key]
          );
        } else {
          await db.run('UPDATE weather_locations SET last_fetch_at = ?, last_success_at = ?, last_error = NULL WHERE location_key = ?', [nowIso, nowIso, location.key]);
        }
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error).slice(0, 500);
      summary.failed += 1;
      report(message);
      await db.run('UPDATE weather_locations SET last_fetch_at = ?, last_error = ? WHERE location_key = ?', [nowIso, message, location.key]);
    }
  }
  return summary;
}

// The flow's inject fires every 30 minutes whether or not the last tick has
// finished (a first MeteoSwiss fetch over LTE can take minutes). A second
// tick while one runs returns at once without touching the database, so two
// ticks never write the same location at the same time.
let inFlight = null;

async function runTick(args) {
  if (inFlight) return { zones: 0, locations: 0, stored: 0, failed: 0, skipped: 'in_flight' };
  inFlight = runTickOnce(args);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  PROVIDERS,
  resolveProvider,
  locationKey,
  hourStartIso,
  addHours,
  firstMissingHour,
  fetchWindow,
  buildOpenMeteoUrl,
  openMeteoPastHours,
  normalizeOpenMeteo,
  fetchOpenMeteoHours,
  decodeCsv,
  splitCsvLine,
  parseCsv,
  withinSwissCoverage,
  haversineKm,
  parseStations,
  nearestStations,
  parseDailyRain,
  measuresRain,
  normalizeMeteoSwiss,
  mergeRows,
  meteoSwissUrl,
  resolveMeteoSwissStation,
  fetchMeteoSwissHours,
  resetMeteoSwissThrottle,
  httpDeps,
  fetchHours,
  zoneLocations,
  runTick,
};
