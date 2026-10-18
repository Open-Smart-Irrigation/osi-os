#!/usr/bin/env node
'use strict';

// Read-only assessment of stored SenseCAP S2120 rain history.
//
// Before the S2120 rain contract fix, ingest differenced measurement 4113
// (rain INTENSITY, mm/h) as if it were a rain counter and stored the 4113
// value in device_data.rain_gauge_cumulative_mm. The cumulative rainfall
// (measurement 4213, firmware v2.0+) was never read. Stored increments from
// that time are not validated measurements.
//
// For each S2120 device and day this script compares the stored increments
// (sum of device_data.rain_mm_delta) with what differencing 4213 gives:
// - rows written under the fixed contract (from the device's
//   cumulative_baseline row on) carry 4213 in rain_gauge_cumulative_mm;
// - older rows carry 4113 there, so their day is verifiable only from
//   retained raw uplinks (--uplinks, ChirpStack uplink events as JSON lines,
//   each with deviceInfo.devEui, time and the base64 `data` or the decoded
//   `object`). Raw `data` is decoded with the shipped S2120 codec.
// A day whose every rain row (and the rain row before it) has a 4213 point
// is compared; any other day is reported as unverifiable with the reason.
// For pre-fix rows the script also reports an intensity estimate: the sum of
// 4113 / 6 over intervals of 600 s +/- 60 s (the vendor ten-minute window).
// It is an estimate, not a measurement, and says how many intervals it
// covers.
//
// The script opens the database read-only, refuses the live gateway path,
// and writes nothing. Run it on a consistent copy (sqlite3 ".backup", or the
// .db file together with its -wal file):
//   node scripts/assess-s2120-rain-history.js <copy-of-farming.db> \
//     [--uplinks <events.jsonl>] [--tz <IANA zone>] [--json]

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIVE_DB_PATH = '/data/db/farming.db';
const CODEC_PATH = path.resolve(
  __dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js'
);
const COUNTER_BASELINE = 'cumulative_baseline';
const LEGACY_WINDOW_S = 600;
const LEGACY_TOLERANCE_S = 60;
const MATCH_TOLERANCE_MM = 0.001;
const USAGE = 'usage: node scripts/assess-s2120-rain-history.js <copy-of-farming.db> [--uplinks <events.jsonl>] [--tz <IANA zone>] [--json]';

function round3(value) {
  return value == null ? null : Math.round(value * 1000) / 1000;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOf(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function dayFormatter(timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => {
    const parts = {};
    for (const part of format.formatToParts(new Date(iso))) parts[part.type] = part.value;
    return parts.year + '-' + parts.month + '-' + parts.day;
  };
}

function loadCodec() {
  const scope = { Buffer, console: { log() {} } };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(CODEC_PATH, 'utf8'), scope, { filename: CODEC_PATH });
  return scope;
}

function measurementsOf(decoded) {
  const out = {};
  const sources = [decoded && decoded.messages, decoded && decoded.data && decoded.data.messages].filter(Array.isArray);
  for (const source of sources) {
    for (const group of source) {
      for (const m of Array.isArray(group) ? group : [group]) {
        if (m && m.measurementId != null) out[String(m.measurementId)] = m.measurementValue;
      }
    }
  }
  return out;
}

// Raw uplinks: returns Map devEui -> [{ time, cumulative, intensity }].
function readUplinks(uplinksPath, deviceSet) {
  const byDevice = new Map();
  if (!uplinksPath) return { byDevice, lines: 0, skipped: 0 };
  const codec = loadCodec();
  let lines = 0;
  let skipped = 0;
  for (const line of fs.readFileSync(uplinksPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      skipped += 1;
      continue;
    }
    const devEui = String((event.deviceInfo && event.deviceInfo.devEui) || '').toUpperCase();
    const time = isoOf(event.time);
    if (!devEui || !time || !deviceSet.has(devEui)) {
      skipped += 1;
      continue;
    }
    let measurements = {};
    if (typeof event.data === 'string' && event.data) {
      measurements = measurementsOf(codec.decodeUplink({ bytes: [...Buffer.from(event.data, 'base64')] }).data);
    } else if (event.object) {
      measurements = measurementsOf(event.object);
    }
    const point = { time, cumulative: finiteOrNull(measurements['4213']), intensity: finiteOrNull(measurements['4113']) };
    if (point.cumulative == null && point.intensity == null) {
      skipped += 1;
      continue;
    }
    if (!byDevice.has(devEui)) byDevice.set(devEui, []);
    byDevice.get(devEui).push(point);
  }
  return { byDevice, lines, skipped };
}

function s2120Devices(db) {
  const rows = db.prepare(
    "SELECT DISTINCT upper(deveui) AS deveui FROM devices WHERE type_id = 'SENSECAP_S2120' " +
    'UNION SELECT DISTINCT upper(deveui) FROM weather_station_zones ORDER BY 1'
  ).all();
  return rows.map((row) => row.deveui);
}

function rainRows(db, devEui) {
  return db.prepare(
    'SELECT recorded_at, rain_gauge_cumulative_mm, rain_mm_per_hour, rain_mm_delta, rain_delta_status ' +
    'FROM device_data WHERE upper(deveui) = ? ' +
    'AND (rain_gauge_cumulative_mm IS NOT NULL OR rain_mm_per_hour IS NOT NULL OR rain_mm_delta IS NOT NULL) ' +
    'ORDER BY recorded_at, id'
  ).all(devEui).map((row) => ({ ...row, recorded_at: isoOf(row.recorded_at) || row.recorded_at }));
}

// Difference a 4213 series the way the fixed ingest does: a lower value is a
// reset and the new baseline; the increment belongs to the later sample. An
// increment that spans a stored rain row without a 4213 point cannot be
// placed in time, so it is kept apart as unattributed.
function differenceSeries(points, uncoveredTimes) {
  const increments = new Map();
  const gaps = uncoveredTimes || [];
  let resets = 0;
  let unattributed = 0;
  let g = 0;
  for (let i = 1; i < points.length; i += 1) {
    const delta = points[i].cumulative - points[i - 1].cumulative;
    while (g < gaps.length && gaps[g] <= points[i - 1].time) g += 1;
    if (delta < 0) {
      resets += 1;
      continue;
    }
    if (g < gaps.length && gaps[g] < points[i].time) {
      unattributed = round3(unattributed + delta);
      continue;
    }
    increments.set(points[i].time, round3(delta));
  }
  return { increments, resets, unattributed };
}

function assessDevice(devEui, rows, rawPoints, dayOf) {
  const markerIndex = rows.findIndex((row) => row.rain_delta_status === COUNTER_BASELINE);
  const isContractRow = (index) => markerIndex >= 0 && index >= markerIndex;

  // 4213 reference points by timestamp: contract rows, then raw uplinks.
  const reference = new Map();
  rows.forEach((row, index) => {
    if (isContractRow(index) && row.rain_gauge_cumulative_mm != null) {
      reference.set(row.recorded_at, Number(row.rain_gauge_cumulative_mm));
    }
  });
  let rawWith4213 = 0;
  let rawWithout4213 = 0;
  for (const point of rawPoints || []) {
    if (point.cumulative == null) {
      rawWithout4213 += 1;
      continue;
    }
    rawWith4213 += 1;
    reference.set(point.time, point.cumulative);
  }
  const rawTimes = new Set((rawPoints || []).map((point) => point.time));
  const series = [...reference.entries()]
    .map(([time, cumulative]) => ({ time, cumulative }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const uncoveredTimes = rows.map((row) => row.recorded_at).filter((time) => !reference.has(time));
  const { increments, resets, unattributed } = differenceSeries(series, uncoveredTimes);

  const days = new Map();
  rows.forEach((row, index) => {
    const day = dayOf(row.recorded_at);
    if (!days.has(day)) days.set(day, { day, indexes: [] });
    days.get(day).indexes.push(index);
  });

  const out = [];
  for (const entry of days.values()) {
    const dayRows = entry.indexes.map((index) => rows[index]);
    const preFix = entry.indexes.filter((index) => !isContractRow(index));
    const era = preFix.length === 0 ? 'post_fix' : preFix.length === entry.indexes.length ? 'pre_fix' : 'mixed';
    const stored = round3(dayRows.reduce((sum, row) => sum + (row.rain_mm_delta == null ? 0 : Number(row.rain_mm_delta)), 0));

    // The first increment of a day needs the 4213 point of the rain row before
    // it, except at the counter baseline, which starts the 4213 series.
    const needed = entry.indexes.slice();
    if (entry.indexes[0] > 0 && entry.indexes[0] !== markerIndex) needed.unshift(entry.indexes[0] - 1);
    const covered = needed.every((index) => reference.has(rows[index].recorded_at));
    let referenceMm = null;
    let verdict = 'unverifiable';
    let reason = null;
    if (covered) {
      // Every 4213 point dated this day, including retained uplinks with no stored row.
      referenceMm = round3(series
        .filter((point) => dayOf(point.time) === entry.day)
        .reduce((sum, point) => sum + (increments.get(point.time) || 0), 0));
      verdict = Math.abs(referenceMm - stored) <= MATCH_TOLERANCE_MM ? 'match' : 'mismatch';
      reason = preFix.length ? 'retained_payloads' : 'contract_rows';
    } else {
      const preFixWithRaw = preFix.filter((index) => rawTimes.has(rows[index].recorded_at));
      const preFixWith4213 = preFixWithRaw.filter((index) => reference.has(rows[index].recorded_at));
      if (!preFix.length) reason = 'no_4213';
      else if (!preFixWithRaw.length) reason = 'no_retained_payloads';
      else if (!preFixWith4213.length) reason = 'no_4213_in_payloads';
      else reason = 'partial_payloads';
    }

    // Pre-fix intensity estimate: old ingest stored 4113 in rain_gauge_cumulative_mm.
    let estimate = null;
    let tiled = 0;
    let intervals = 0;
    for (const index of preFix) {
      if (index === 0) continue;
      intervals += 1;
      const seconds = (new Date(rows[index].recorded_at) - new Date(rows[index - 1].recorded_at)) / 1000;
      const intensity = finiteOrNull(rows[index].rain_gauge_cumulative_mm);
      if (intensity == null || Math.abs(seconds - LEGACY_WINDOW_S) > LEGACY_TOLERANCE_S) continue;
      tiled += 1;
      estimate = round3((estimate || 0) + (intensity * LEGACY_WINDOW_S) / 3600);
    }

    out.push({
      devEui,
      day: entry.day,
      era,
      rows: dayRows.length,
      storedIncrementMm: stored,
      reference4213Mm: referenceMm,
      differenceMm: referenceMm == null ? null : round3(referenceMm - stored),
      verdict,
      reason,
      intensityEstimateMm: preFix.length ? estimate : null,
      intensityEstimateIntervals: preFix.length ? tiled + '/' + intervals : null,
    });
  }
  return { days: out, resets, unattributed, rawWith4213, rawWithout4213, hasCounterBaseline: markerIndex >= 0 };
}

function assess(options) {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.resolve(options.dbPath);
  if (dbPath === LIVE_DB_PATH) throw new Error('refusing the live gateway database; run on a copy');
  let real = dbPath;
  try {
    real = fs.realpathSync(dbPath);
  } catch (error) {
    throw new Error('cannot open ' + dbPath + ': ' + error.message);
  }
  if (real === LIVE_DB_PATH) throw new Error('refusing the live gateway database; run on a copy');
  const timeZone = options.timeZone || 'UTC';
  const dayOf = dayFormatter(timeZone);
  const db = new DatabaseSync(real, { readOnly: true });
  try {
    const devices = s2120Devices(db);
    const uplinks = readUplinks(options.uplinksPath, new Set(devices));
    const report = { generatedAt: new Date().toISOString(), timeZone, uplinkLines: uplinks.lines, uplinkLinesSkipped: uplinks.skipped, devices: [] };
    for (const devEui of devices) {
      const result = assessDevice(devEui, rainRows(db, devEui), uplinks.byDevice.get(devEui), dayOf);
      const count = (verdict) => result.days.filter((day) => day.verdict === verdict).length;
      report.devices.push({
        devEui,
        hasCounterBaseline: result.hasCounterBaseline,
        retainedPayloadsWith4213: result.rawWith4213,
        retainedPayloadsWithout4213: result.rawWithout4213,
        counterResets: result.resets,
        unattributedIncrementMm: result.unattributed,
        days: result.days,
        summary: { days: result.days.length, match: count('match'), mismatch: count('mismatch'), unverifiable: count('unverifiable') },
      });
    }
    return report;
  } finally {
    db.close();
  }
}

function formatText(report) {
  const fmt = (value) => (value == null ? '-' : String(value));
  const lines = [
    'S2120 rain history assessment (read-only), days in ' + report.timeZone,
    'Stored = sum of device_data.rain_mm_delta; reference = 4213 differenced. Intensity estimate = 4113 / 6 over 600 s +/- 60 s intervals (estimate, not a measurement).',
  ];
  if (report.uplinkLines) lines.push('Retained uplinks read: ' + report.uplinkLines + ' (' + report.uplinkLinesSkipped + ' skipped)');
  if (!report.devices.length) lines.push('No SENSECAP_S2120 device in this database.');
  for (const device of report.devices) {
    lines.push('');
    lines.push('Device ' + device.devEui + ': ' + device.summary.days + ' days, ' + device.summary.match + ' match, ' +
      device.summary.mismatch + ' mismatch, ' + device.summary.unverifiable + ' unverifiable; counter baseline ' +
      (device.hasCounterBaseline ? 'present' : 'absent') + '; retained payloads with 4213: ' + device.retainedPayloadsWith4213 +
      ', without: ' + device.retainedPayloadsWithout4213 + '; counter resets: ' + device.counterResets +
      '; 4213 rise across unverifiable rows (not placed on a day): ' + device.unattributedIncrementMm + ' mm');
    lines.push(['day', 'era', 'rows', 'stored_mm', 'reference_4213_mm', 'difference_mm', 'verdict', 'reason', 'intensity_estimate_mm', 'estimate_intervals'].join('\t'));
    for (const day of device.days) {
      lines.push([day.day, day.era, day.rows, day.storedIncrementMm, day.reference4213Mm, day.differenceMm, day.verdict, day.reason,
        day.intensityEstimateMm, day.intensityEstimateIntervals].map(fmt).join('\t'));
    }
  }
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const options = { dbPath: null, uplinksPath: null, timeZone: 'UTC', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--uplinks') options.uplinksPath = argv[++i];
    else if (arg === '--tz') options.timeZone = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') return null;
    else if (!options.dbPath && !arg.startsWith('--')) options.dbPath = arg;
    else throw new Error('unknown argument: ' + arg);
  }
  if (!options.dbPath) throw new Error('missing database copy path');
  return options;
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + '\n' + USAGE + '\n');
    process.exit(2);
  }
  if (!options) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  try {
    const report = assess(options);
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatText(report));
  } catch (error) {
    process.stderr.write('assess-s2120-rain-history: ' + error.message + '\n');
    process.exit(1);
  }
}

module.exports = { assess, formatText, differenceSeries, parseArgs };
