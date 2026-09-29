#!/usr/bin/env node
'use strict';
// scripts/calibrate-lux-radiation.js <path-to-farming.db>
//
// Read-only check of the docs/contracts/agronomy/ constant `luxPerWm2`
// (currently 120) against a real weather station's own uplinks. For every
// station with rows in `weather_station_hours`, finds the zone(s) it is
// assigned to (`weather_station_zones`) and each zone's provider location
// (Open-Meteo or MeteoSwiss, whichever the store holds), resolved the same way
// `osi-weather-provider`'s `zoneLocations` resolves a zone's coordinates (the
// zone's own latitude/longitude, else its gateway's, rounded to the location
// key's two decimal places). It then joins the station's hourly `light_lux`
// with the provider's hourly `global_radiation_wm2` on equal `hour_start`
// -- the provider stamps are already shifted to `hour_start` in the store,
// so equal `hour_start` compares the same hour and no offset is applied here.
// The station's radiation is recomputed as `light_lux / luxPerWm2` with the
// contract's current constant, not read from the stored
// `global_radiation_wm2`, which carries whatever constant was current when
// the hour was aggregated.
//
// Prints which reference the provider location is: a MeteoSwiss station
// measures global radiation; Open-Meteo models it, and at Payerne the model
// read 0.75 to 0.91 of the station's measurement on 24-25 September 2026, so
// an Open-Meteo location inside MeteoSwiss coverage prints the advice to
// calibrate against a zone whose weather_source is meteoswiss.
//
// Prints, per matched UTC calendar day with at least 22 matched hours, the
// two summed radiations in MJ/m^2 (the stored value is a mean W/m^2 over the
// hour, so MJ/m^2 = wm2 * 3600 s / 1e6), the median station/provider ratio
// over the last 7 complete days, and the `luxPerWm2` that would make that
// median 1.0. The most recent matched day is always excluded from that
// window: it may still be accumulating hours, the same reason the daily
// agronomy writer never scores "today".
//
// This script never writes. It opens the given file with node:sqlite's
// `readOnly: true`, and refuses `/data/db/farming.db` and any path under
// `/data/` outright, so it cannot be pointed at a live or provisioned
// gateway's database by mistake -- copy the database off the gateway first
// (scripts/download-farming-db.sh) and run this against the copy.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { zoneLocations, withinSwissCoverage } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider');
const { catalogue } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc');

const MJ_PER_WM2_HOUR = 0.0036; // 1 W/m^2 held for 3600 s = 3600 J/m^2 = 0.0036 MJ/m^2
// A day with fewer matched hours is left out: a missing daylight hour moves
// the day's sum by several percent.
const MIN_MATCHED_HOURS = 22;
const OPEN_METEO_REFERENCE = 'Open-Meteo model (modelled; at Payerne 0.75 to 0.91 of the station measurement on 24–25 Sept 2026)';
const SWISS_ADVICE = 'This location is inside MeteoSwiss coverage: calibrate against a zone whose weather_source is meteoswiss, which measures global radiation.';

const HELP = `Usage: node scripts/calibrate-lux-radiation.js <path-to-farming.db>

Read-only. For every weather station with rows in weather_station_hours,
compares its hourly radiation (light_lux / luxPerWm2, recomputed with the
current constant) against the provider hours (Open-Meteo or MeteoSwiss) of
the zone(s) it is assigned to, matched on equal hour_start. Names the
reference (a MeteoSwiss station measures radiation, Open-Meteo models it),
skips days with fewer than 22 matched hours, and prints per-UTC-day sums in
MJ/m^2, the median station/provider ratio over the last 7 complete days, and
the luxPerWm2 value that would make that median 1.0.

Never writes. Refuses /data/db/farming.db and any path under /data/ -- copy
the database off the gateway first (scripts/download-farming-db.sh) and run
this against the copy, never the live file.

Options:
  -h, --help    show this help and exit
`;

function isLivePath(inputPath) {
  const resolved = path.resolve(inputPath);
  return resolved === '/data' || resolved.startsWith('/data/');
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(value, decimals) {
  if (value == null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// A minimal async wrapper so `zoneLocations` (written against the flow
// facade's `db.all`) works against a plain node:sqlite handle.
function asyncDb(raw) {
  return { all: async (sql, params) => raw.prepare(sql).all(...(params || [])) };
}

const STATIONS_SQL = 'SELECT DISTINCT deveui FROM weather_station_hours ORDER BY deveui';
const STATION_ZONES_SQL = 'SELECT zone_id FROM weather_station_zones WHERE deveui = ? ORDER BY zone_id';
const LOCATIONS_SQL = 'SELECT location_key, provider, latitude, longitude, station_id FROM weather_locations';
const MATCHED_HOURS_SQL =
  'SELECT wsh.hour_start AS hour_start, wsh.light_lux AS station_lux, wph.global_radiation_wm2 AS provider_wm2 ' +
  'FROM weather_station_hours wsh ' +
  'JOIN weather_provider_hours wph ON wph.location_key = ? AND wph.hour_start = wsh.hour_start ' +
  'WHERE wsh.deveui = ? AND wsh.light_lux IS NOT NULL AND wph.global_radiation_wm2 IS NOT NULL ' +
  'ORDER BY wsh.hour_start';

// The reference a provider location stands for, and the advice to print.
function describeReference(location) {
  if (location.provider === 'meteoswiss') {
    return { reference: 'MeteoSwiss station ' + (location.station_id || 'unknown') + ' (measured global radiation)', advice: null };
  }
  return { reference: OPEN_METEO_REFERENCE, advice: withinSwissCoverage(location.latitude, location.longitude) ? SWISS_ADVICE : null };
}

// One result per (station, provider location) pair actually used by one of
// the station's assigned zones -- almost always one pair, but a station
// serving zones at different coordinates or with different weather sources
// gets one row per location.
async function stationRadiationRatios(raw) {
  const db = asyncDb(raw);
  const stored = new Map((await db.all(LOCATIONS_SQL, [])).map((row) => [row.location_key, row]));
  // The gateway's deployment default is a UCI setting this copy does not
  // carry, so a zone on 'auto' is resolved under both defaults and every key
  // the store actually holds is used.
  const locationKeysByZoneId = new Map();
  for (const deploymentDefault of ['open_meteo', 'meteoswiss']) {
    for (const entry of await zoneLocations(db, deploymentDefault)) {
      if (!entry.locationKey || !stored.has(entry.locationKey)) continue;
      if (!locationKeysByZoneId.has(entry.zone.id)) locationKeysByZoneId.set(entry.zone.id, new Set());
      locationKeysByZoneId.get(entry.zone.id).add(entry.locationKey);
    }
  }
  const results = [];
  for (const { deveui } of await db.all(STATIONS_SQL, [])) {
    const locationKeys = new Set();
    for (const { zone_id: zoneId } of await db.all(STATION_ZONES_SQL, [deveui])) {
      for (const key of locationKeysByZoneId.get(zoneId) || []) locationKeys.add(key);
    }
    for (const locationKey of [...locationKeys].sort()) {
      const location = stored.get(locationKey);
      const rows = await db.all(MATCHED_HOURS_SQL, [locationKey, deveui]);
      const byDay = new Map();
      for (const row of rows) {
        const day = row.hour_start.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, { stationMj: 0, providerMj: 0, hours: 0 });
        const entry = byDay.get(day);
        entry.stationMj += (row.station_lux / catalogue.luxPerWm2) * MJ_PER_WM2_HOUR;
        entry.providerMj += row.provider_wm2 * MJ_PER_WM2_HOUR;
        entry.hours += 1;
      }
      const sortedDays = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      // Drop the most recent matched day (may still be accumulating hours),
      // then the days with fewer than 22 matched hours, then take at most the
      // 7 days before it.
      const skippedDays = sortedDays.slice(0, -1).filter(([, d]) => d.hours < MIN_MATCHED_HOURS).map(([date, d]) => ({ date, hours: d.hours }));
      const complete = sortedDays.slice(0, -1).filter(([, d]) => d.hours >= MIN_MATCHED_HOURS).slice(-7);
      const ratios = complete.filter(([, d]) => d.providerMj > 0).map(([, d]) => d.stationMj / d.providerMj);
      const medianRatio = median(ratios);
      results.push({
        deveui,
        locationKey,
        provider: location.provider,
        ...describeReference(location),
        skippedDays,
        days: complete.map(([date, d]) => ({
          date,
          hours: d.hours,
          stationMj: round(d.stationMj, 2),
          providerMj: round(d.providerMj, 2),
          ratio: d.providerMj > 0 ? round(d.stationMj / d.providerMj, 3) : null,
        })),
        medianRatio: round(medianRatio, 3),
        currentLuxPerWm2: catalogue.luxPerWm2,
        suggestedLuxPerWm2: medianRatio == null ? null : round(catalogue.luxPerWm2 * medianRatio, 1),
      });
    }
  }
  return results;
}

function printReport(results) {
  if (!results.length) {
    console.log('No station/provider hours matched: no assigned station has both weather_station_hours rows and a provider location (weather_provider_hours) for its zone.');
    return;
  }
  for (const result of results) {
    console.log(`Station ${result.deveui} vs ${result.locationKey}:`);
    console.log(`  reference: ${result.reference}`);
    if (result.advice) console.log(`  advice: ${result.advice}`);
    for (const day of result.skippedDays) {
      console.log(`  ${day.date}  skipped: ${day.hours} matched hours (need ${MIN_MATCHED_HOURS})`);
    }
    if (!result.days.length) {
      console.log('  no complete UTC day yet (need at least one matched day with 22 or more hours before the most recent one)');
    }
    for (const day of result.days) {
      console.log(`  ${day.date}  hours=${day.hours}  station=${day.stationMj.toFixed(2)} MJ/m^2  provider=${day.providerMj.toFixed(2)} MJ/m^2  ratio=${day.ratio == null ? 'n/a' : day.ratio.toFixed(3)}`);
    }
    const dayWord = result.days.length === 1 ? 'day' : 'days';
    console.log(`  median ratio (last ${result.days.length} ${dayWord}): ${result.medianRatio == null ? 'n/a' : result.medianRatio.toFixed(3)}`);
    console.log(`  luxPerWm2 that would make the median 1.0 (current ${result.currentLuxPerWm2}): ${result.suggestedLuxPerWm2 == null ? 'n/a' : result.suggestedLuxPerWm2}`);
  }
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    if (args.length === 0) process.exitCode = 1;
    return;
  }
  const dbPath = args[0];
  if (isLivePath(dbPath)) {
    console.error('calibrate-lux-radiation: refusing ' + dbPath + ' -- looks like a live gateway path under /data/. Copy the database off the gateway first (scripts/download-farming-db.sh) and run this against the copy.');
    process.exitCode = 1;
    return;
  }
  let raw;
  try {
    raw = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  } catch (error) {
    console.error('calibrate-lux-radiation: cannot open ' + dbPath + ': ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
    return;
  }
  try {
    printReport(await stationRadiationRatios(raw));
  } catch (error) {
    console.error('calibrate-lux-radiation: ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  } finally {
    raw.close();
  }
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error('calibrate-lux-radiation: ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  });
}

module.exports = { isLivePath, median, stationRadiationRatios, describeReference, MJ_PER_WM2_HOUR, MIN_MATCHED_HOURS };
