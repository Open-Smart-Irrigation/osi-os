#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const rain = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rain');

const HEADER = ['deveui', 'instrument_type', 'zone_id', 'date', 'timezone', 'old_host_day_mm', 'old_zone_row_mm', 'old_rain_source', 'new_received_mm', 'new_coverage', 'new_selected_deveui', 'delta_mm', 'reasons'];
const LIVE_ROOT = '/data';
const SOURCE_BY_TYPE = { AQUASCOPE_LORAIN: 'aquascope_lorain', SENSECAP_S2120: 'sensecap_s2120' };

function usage() {
  return 'usage: node scripts/rain-history-diff.js --db PATH --from YYYY-MM-DD --to YYYY-MM-DD --out DIR [--host-timezone IANA] [--provenance PATH]';
}
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!['--db', '--from', '--to', '--out', '--host-timezone', '--provenance'].includes(arg)) throw new Error('unknown argument: ' + arg);
    if (opts[arg] !== undefined || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error('missing or duplicate value for ' + arg);
    opts[arg] = argv[++i];
  }
  for (const key of ['--db', '--from', '--to', '--out']) if (!opts[key]) throw new Error('required option missing: ' + key);
  return { dbPath: opts['--db'], from: opts['--from'], to: opts['--to'], outDir: opts['--out'], hostTimezone: opts['--host-timezone'] || null, provenancePath: opts['--provenance'] || null };
}
function validDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(name + ' must be YYYY-MM-DD');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(name + ' is not a calendar date');
  return value;
}
function validZone(zone, label) {
  if (typeof zone !== 'string' || !zone.trim()) throw new Error(label + ' must be an IANA timezone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); } catch { throw new Error(label + ' is not a valid IANA timezone'); }
  if (zone !== 'UTC' && zone !== 'Etc/UTC' && !zone.includes('/')) throw new Error(label + ' must be an IANA timezone, not an abbreviation');
  return zone;
}
function validInstant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(label + ' must be a UTC ISO instant');
  const parsed = new Date(value);
  if (parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(label + ' must be a real UTC calendar date and clock time');
  return parsed.toISOString();
}
function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function realpathForNewPath(input) {
  const absolute = path.resolve(input);
  let parent = absolute;
  const remainder = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error('cannot resolve output path');
    remainder.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...remainder);
}
function checkedDatabasePath(input) {
  let real;
  try { real = fs.realpathSync(input); } catch (error) { throw new Error('database does not exist or cannot be resolved: ' + error.message); }
  if (!fs.statSync(real).isFile()) throw new Error('database path is not a regular file');
  if (isUnder(real, LIVE_ROOT)) throw new Error('refusing database path under /data');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = real + suffix;
    if (fs.existsSync(sidecar)) throw new Error('refusing database with SQLite sidecar: ' + path.basename(sidecar));
  }
  return real;
}
function validateOutputTargets(dbPath, outDir) {
  const resolved = realpathForNewPath(outDir);
  if (isUnder(resolved, LIVE_ROOT)) throw new Error('refusing output path under /data');
  if (resolved === dbPath || isUnder(dbPath, resolved)) throw new Error('output directory aliases the input database');
  const files = ['rain-diff-days.csv', 'rain-diff-summary.md'].map((name) => path.join(resolved, name));
  for (const file of files) {
    if (fs.existsSync(file)) {
      const target = fs.realpathSync(file);
      if (target === dbPath) throw new Error('output file aliases the input database');
      throw new Error('refusing to overwrite existing output: ' + path.basename(file));
    }
  }
  return { dir: resolved, files };
}
function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}
function columns(db, tableSet, name) {
  if (!tableSet.has(name)) return new Set();
  return new Set(db.prepare('PRAGMA table_info(' + quoteIdent(name) + ')').all().map((row) => row.name));
}
function quoteIdent(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }
function selectExpressions(cols, alias, requested) {
  return requested.map((name) => cols.has(name) ? alias + '.' + quoteIdent(name) + ' AS ' + quoteIdent(name) : 'NULL AS ' + quoteIdent(name)).join(', ');
}
function queryBounds(from, to) {
  const start = Date.parse(from + 'T00:00:00.000Z') - 2 * 86400000;
  const end = Date.parse(to + 'T00:00:00.000Z') + 4 * 86400000;
  return [new Date(start).toISOString(), new Date(end).toISOString()];
}
function loadProvenance(file, explicitHostZone) {
  if (!file) {
    if (explicitHostZone) validZone(explicitHostZone, '--host-timezone');
    return { hostTimezone: explicitHostZone, hostTimezoneSource: explicitHostZone ? 'explicit_argument' : 'unknown', intervals: [] };
  }
  let parsed;
  try {
    const provenanceReal = fs.realpathSync(file);
    if (isUnder(provenanceReal, LIVE_ROOT)) throw new Error('refusing provenance path under /data');
    parsed = JSON.parse(fs.readFileSync(provenanceReal, 'utf8'));
  } catch (error) { throw new Error('cannot read provenance JSON: ' + error.message); }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.intervals)) throw new Error('provenance must be version 1 with an intervals array');
  const hostTimezone = validZone(parsed.hostTimezone, 'provenance hostTimezone');
  if (explicitHostZone && validZone(explicitHostZone, '--host-timezone') !== hostTimezone) throw new Error('--host-timezone conflicts with provenance hostTimezone');
  const intervals = parsed.intervals.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('provenance interval ' + index + ' is invalid');
    const deveui = String(item.deveui || '').toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(deveui)) throw new Error('provenance interval ' + index + ' has invalid deveui');
    if (item.zoneId == null || !Number.isInteger(Number(item.zoneId)) || Number(item.zoneId) <= 0) throw new Error('provenance interval ' + index + ' has invalid zoneId');
    const timezone = validZone(item.timezone, 'provenance interval ' + index + ' timezone');
    const from = validInstant(item.from, 'provenance interval ' + index + ' from');
    const to = validInstant(item.to, 'provenance interval ' + index + ' to');
    if (Date.parse(from) >= Date.parse(to)) throw new Error('provenance interval ' + index + ' has empty or reversed bounds');
    if (typeof item.selected !== 'boolean') throw new Error('provenance interval ' + index + ' selected must be boolean');
    if (typeof item.sourceRef !== 'string' || !item.sourceRef.trim()) throw new Error('provenance interval ' + index + ' requires sourceRef');
    return { deveui, zoneId: Number(item.zoneId), timezone, from, to, selected: item.selected, sourceRef: item.sourceRef };
  }).sort((a, b) => a.deveui.localeCompare(b.deveui) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (let i = 0; i < intervals.length; i += 1) for (let j = i + 1; j < intervals.length && intervals[j].from < intervals[i].to; j += 1) {
    const a = intervals[i]; const b = intervals[j];
    if (a.deveui === b.deveui) throw new Error('overlapping historical assignment intervals for ' + a.deveui);
    if (a.zoneId === b.zoneId && a.selected && b.selected && Math.max(Date.parse(a.from), Date.parse(b.from)) < Math.min(Date.parse(a.to), Date.parse(b.to))) throw new Error('conflicting selected gauges for zone ' + a.zoneId);
  }
  return { hostTimezone, hostTimezoneSource: 'provenance', intervals };
}
function dateInZone(ms, zone) {
  return rain.zoneDayWindow(new Date(ms).toISOString(), zone).date;
}
function dateBounds(day, zone) {
  const window = rain.zoneDateWindow(day, zone);
  return { start: Date.parse(window.startIso), end: Date.parse(window.endIso) };
}
function finiteNonnegative(value) {
  const n = value == null || value === '' ? null : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function round3(value) { return value == null ? null : Math.round((value + Number.EPSILON) * 1000) / 1000; }
function asNumber(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value); }
function hostDay(value, zone) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? dateInZone(ms, zone) : null;
}
const TEXT_COLUMNS = new Set(['deveui', 'instrument_type', 'timezone', 'old_rain_source', 'new_selected_deveui', 'reasons']);
function safeCell(value, isText = true) {
  if (value == null) return '';
  let text = String(value);
  if (isText && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function csv(rows) { return [HEADER.join(','), ...rows.map((row) => HEADER.map((key) => safeCell(row[key], TEXT_COLUMNS.has(key))).join(','))].join('\n') + '\n'; }
function escapeMarkdown(value) { return String(value).replace(/[|\r\n]/g, ' '); }

function readEvidence(db, options, provenance) {
  const names = tableNames(db);
  const deviceCols = columns(db, names, 'devices');
  const dataCols = columns(db, names, 'device_data');
  const envCols = columns(db, names, 'zone_daily_environment');
  const devices = names.has('devices') ? db.prepare('SELECT ' + selectExpressions(deviceCols, 'd', ['deveui', 'type_id', 'irrigation_zone_id', 'name', 'rain_mm_per_tip', 'rain_gauge_enabled']) + ' FROM devices d').all().map((row) => ({ ...row, deveui: String(row.deveui || '').toUpperCase() })) : [];
  const range = queryBounds(options.from, options.to);
  const data = names.has('device_data') && dataCols.has('recorded_at')
    ? db.prepare('SELECT ' + selectExpressions(dataCols, 'x', ['id', 'deveui', 'recorded_at', 'rain_mm_today', 'rain_mm_delta', 'rain_delta_status', 'rain_tips_delta', 'flow_liters_delta', 'rain_mm_per_hour']) + ' FROM device_data x WHERE date(recorded_at) >= date(?) AND date(recorded_at) <= date(?) ORDER BY recorded_at, id').all(range[0], range[1]).map((row) => ({ ...row, deveui: String(row.deveui || '').toUpperCase() }))
    : [];
  const env = names.has('zone_daily_environment') && envCols.has('date') ? db.prepare('SELECT ' + selectExpressions(envCols, 'e', ['zone_id', 'date', 'rainfall_mm', 'rain_source', 'rain_selected_deveui', 'rain_coverage']) + ' FROM zone_daily_environment e WHERE date >= ? AND date <= ? ORDER BY date, zone_id').all(options.from, options.to) : [];
  const instrumentDayCols = columns(db, names, 'rain_instrument_days');
  const instrumentDays = names.has('rain_instrument_days') && instrumentDayCols.has('deveui') && instrumentDayCols.has('date') && instrumentDayCols.has('timezone')
    ? db.prepare('SELECT ' + selectExpressions(instrumentDayCols, 'r', ['deveui', 'date', 'timezone', 'coverage']) + ' FROM rain_instrument_days r WHERE date >= ? AND date <= ?').all(range[0].slice(0, 10), range[1].slice(0, 10)).map((row) => ({ ...row, deveui: String(row.deveui || '').toUpperCase() }))
    : [];
  const observationCols = columns(db, names, 'rain_observations');
  const observations = names.has('rain_observations') && observationCols.has('deveui') && observationCols.has('received_at')
    ? db.prepare('SELECT ' + selectExpressions(observationCols, 'o', ['id', 'device_data_id', 'deveui', 'instrument_type', 'received_at', 'zone_id', 'timezone', 'status', 'amount_mm', 'config_json']) + ' FROM rain_observations o WHERE date(received_at) >= date(?) AND date(received_at) <= date(?) ORDER BY received_at, id').all(range[0], range[1]).map((row) => ({ ...row, deveui: String(row.deveui || '').toUpperCase() }))
    : [];
  const linkedObservationData = names.has('device_data') && dataCols.has('id') && dataCols.has('deveui')
    && names.has('rain_observations') && observationCols.has('device_data_id') && observationCols.has('received_at')
    ? db.prepare('SELECT x.id, x.deveui FROM device_data x WHERE x.id IN (SELECT o.device_data_id FROM rain_observations o WHERE o.device_data_id IS NOT NULL AND date(o.received_at) >= date(?) AND date(o.received_at) <= date(?))').all(range[0], range[1]).map((row) => ({ ...row, deveui: String(row.deveui || '').toUpperCase() }))
    : [];
  return { devices, data, env, observations, linkedObservationData, instrumentDays, tableNames: names, envColumns: envCols };
}
function possibleRainGauge(device) {
  if (!device) return null;
  const type = String(device.type_id || '').toUpperCase();
  if (Object.hasOwn(SOURCE_BY_TYPE, type)) return true;
  if (device.rain_gauge_enabled === 1 || device.rain_gauge_enabled === true || Number(device.rain_mm_per_tip) > 0) return true;
  if (['KIWI_SENSOR', 'STREGA_VALVE', 'TEKTELIC_CLOVER', 'DRAGINO_SDI12', 'MCLIMATE_TVALVE'].includes(type)) return false;
  // DRAGINO_LSN50 and unknown types can act as local gauges. Current disabled
  // state cannot rule out historical eligibility, so keep the result unknown.
  return null;
}
function assignmentCoversDay(intervals, bounds) {
  let coveredUntil = bounds.start;
  for (const interval of intervals.slice().sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    const start = Date.parse(interval.from);
    const end = Date.parse(interval.to);
    if (end <= coveredUntil) continue;
    if (start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, end);
    if (coveredUntil >= bounds.end) return true;
  }
  return false;
}
function lsn50SnapshotEligible(observation, row) {
  if (!observation || observation.instrument_type !== 'DRAGINO_LSN50' || observation.status !== 'accepted') return false;
  const observationMs = Date.parse(observation.received_at);
  const rowMs = Date.parse(row.recorded_at);
  if (!Number.isFinite(observationMs) || !Number.isFinite(rowMs) || observationMs !== rowMs) return false;
  const observedAmount = finiteNonnegative(observation.amount_mm);
  const rowAmount = finiteNonnegative(row.rain_mm_delta);
  if (observedAmount == null || rowAmount == null || Math.abs(observedAmount - rowAmount) > 0.001 || row.rain_delta_status !== 'ok') return false;
  let config;
  try { config = JSON.parse(observation.config_json); } catch { return false; }
  if (!config || config.rain_gauge_enabled !== true || !Array.isArray(config.zones) || !Array.isArray(config.zone_snapshots)) return false;
  const zones = config.zones.map(Number);
  const snapshots = config.zone_snapshots;
  if (zones.some((zone) => !Number.isSafeInteger(zone) || zone <= 0) || new Set(zones).size !== zones.length) return false;
  const snapshotZones = snapshots.map((snapshot) => Number(snapshot && snapshot.zone_id));
  if (snapshotZones.some((zone) => !Number.isSafeInteger(zone) || zone <= 0) || new Set(snapshotZones).size !== snapshotZones.length) return false;
  if (zones.length !== snapshotZones.length || zones.some((zone) => !snapshotZones.includes(zone))) return false;
  const directZone = Number(observation.zone_id);
  if (!Number.isSafeInteger(directZone) || directZone <= 0 || !zones.includes(directZone)) return false;
  const directTimezone = String(observation.timezone || '');
  const snapshot = snapshots.find((item) => Number(item.zone_id) === directZone);
  if (!snapshot || String(snapshot.timezone || '') !== directTimezone) return false;
  try { validZone(directTimezone, 'LSN50 observation timezone'); } catch { return false; }
  return true;
}
function soleEligibleGaugeForDay(provenance, devices, data, observations, zoneId, date, deveui, bounds) {
  const sourcesByDevice = new Map();
  const addSource = (eui, source) => {
    if (!eui) return;
    if (!sourcesByDevice.has(eui)) sourcesByDevice.set(eui, []);
    if (source) sourcesByDevice.get(eui).push(source);
  };
  for (const device of devices) addSource(device.deveui, device);
  // Device-data identity can outlive the current devices row. Without a
  // retained type or full-day assignment elsewhere, it remains a possible
  // historical gauge rather than evidence that no competitor existed.
  for (const row of data) addSource(row.deveui, null);
  // rain_observations has no devices foreign key and its device_data_id may be
  // NULL after deletion. Its snapshotted type therefore remains independent
  // historical evidence of a gauge even when both other links are absent.
  for (const observation of observations) addSource(observation.deveui, { type_id: observation.instrument_type });
  const intervalsByDevice = new Map();
  for (const interval of provenance.intervals) {
    if (!intervalsByDevice.has(interval.deveui)) intervalsByDevice.set(interval.deveui, []);
    intervalsByDevice.get(interval.deveui).push(interval);
  }
  const candidates = new Set();
  const allDevices = new Set([...sourcesByDevice.keys(), ...intervalsByDevice.keys()]);
  for (const candidateEui of allDevices) {
    const sources = sourcesByDevice.get(candidateEui) || [];
    if (sources.length && sources.every((source) => possibleRainGauge(source) === false)) continue;
    const intervals = intervalsByDevice.get(candidateEui) || [];
    const overlapsZoneDay = intervals.some((interval) => interval.zoneId === zoneId && Date.parse(interval.from) < bounds.end && Date.parse(interval.to) > bounds.start);
    const observationShowsZoneDay = observations.some((observation) => {
      if (observation.deveui !== candidateEui || observation.zone_id == null || Number(observation.zone_id) !== zoneId || !observation.timezone || !observation.received_at) return false;
      const ms = Date.parse(observation.received_at);
      if (!Number.isFinite(ms)) return true;
      try { validZone(String(observation.timezone), 'retained observation timezone'); return dateInZone(ms, String(observation.timezone)) === date; }
      catch { return true; }
    });
    if (overlapsZoneDay || observationShowsZoneDay || !assignmentCoversDay(intervals, bounds)) candidates.add(candidateEui);
  }
  return candidates.size === 1 && candidates.has(deveui);
}
function validateObservationProvenance(evidence, provenance) {
  const linkedById = new Map(evidence.linkedObservationData.map((row) => [String(row.id), row]));
  const intervalsByDevice = new Map();
  for (const interval of provenance.intervals) {
    if (!intervalsByDevice.has(interval.deveui)) intervalsByDevice.set(interval.deveui, []);
    intervalsByDevice.get(interval.deveui).push(interval);
  }
  for (const observation of evidence.observations) {
    const linked = observation.device_data_id == null ? null : linkedById.get(String(observation.device_data_id));
    if (linked && linked.deveui && linked.deveui !== observation.deveui) throw new Error('retained observation identity conflicts with linked device_data row ' + observation.device_data_id);
    const receivedAt = Date.parse(observation.received_at);
    if (!Number.isFinite(receivedAt)) continue;
    for (const interval of intervalsByDevice.get(observation.deveui) || []) {
      if (Date.parse(interval.from) > receivedAt || receivedAt >= Date.parse(interval.to)) continue;
      const zoneConflict = observation.zone_id != null && Number(observation.zone_id) !== interval.zoneId;
      const timezoneConflict = observation.timezone != null && String(observation.timezone) !== interval.timezone;
      if (zoneConflict || timezoneConflict) throw new Error('provenance conflicts with retained observation snapshot' + (observation.id == null ? '' : ' ' + observation.id));
    }
  }
}
function deriveRows(evidence, options, provenance) {
  const deviceById = new Map(evidence.devices.map((d) => [d.deveui, d]));
  const zoneRows = new Map();
  for (const item of evidence.env) {
    const key = Number(item.zone_id) + '|' + item.date;
    zoneRows.set(key, item);
  }
  const recordsByDeviceDate = new Map();
  const observationsByDataId = new Map();
  const observationsByDeviceTime = new Map();
  const unresolvedLsnTimestampKeys = new Set();
  for (const observation of evidence.observations) {
    if (observation.device_data_id != null) {
      const key = String(observation.device_data_id);
      if (!observationsByDataId.has(key)) observationsByDataId.set(key, []);
      observationsByDataId.get(key).push(observation);
    }
    const key = observation.deveui + '|' + String(observation.received_at);
    if (!observationsByDeviceTime.has(key)) observationsByDeviceTime.set(key, []);
    observationsByDeviceTime.get(key).push(observation);
  }
  for (const row of evidence.data) {
    if (!row.recorded_at) continue;
    const ms = Date.parse(row.recorded_at);
    if (!Number.isFinite(ms)) continue;
    let day = null; let zoneId = null; let timezone = null; let basis = 'historical_attribution_unknown'; let selectedInterval = null; let sourceRef = null; let timezoneIssue = false;
    const matching = provenance.intervals.filter((i) => i.deveui === row.deveui && Date.parse(i.from) <= ms && ms < Date.parse(i.to));
    const linkedObservations = observationsByDataId.get(String(row.id)) || [];
    const timestampObservations = observationsByDeviceTime.get(row.deveui + '|' + String(row.recorded_at)) || [];
    const timestampObservation = timestampObservations.at(-1) || null;
    const candidateTypes = [...linkedObservations.map((observation) => observation.instrument_type), ...timestampObservations.map((observation) => observation.instrument_type), (deviceById.get(row.deveui) || {}).type_id]
      .map((type) => String(type || '').toUpperCase());
    const requiresLsnSnapshot = candidateTypes.includes('DRAGINO_LSN50');
    const linkedObservation = linkedObservations.length === 1 ? linkedObservations[0] : null;
    const lsnLinkAmbiguous = requiresLsnSnapshot && linkedObservations.length !== 1;
    const retainedObservation = requiresLsnSnapshot ? linkedObservation : linkedObservations.at(-1) || timestampObservation;
    // Timestamp equality can expose an ambiguous duplicate, but cannot authorize
    // the unlinked row or the linked row sharing its timestamp.
    if (requiresLsnSnapshot && (lsnLinkAmbiguous || (linkedObservations.length === 0 && timestampObservations.some((observation) => observation.instrument_type === 'DRAGINO_LSN50')))) {
      unresolvedLsnTimestampKeys.add(row.deveui + '|' + String(row.recorded_at));
    }
    if (matching.length === 1) { selectedInterval = matching[0]; zoneId = selectedInterval.zoneId; timezone = selectedInterval.timezone; day = dateInZone(ms, timezone); basis = 'provenance'; sourceRef = selectedInterval.sourceRef; }
    else if (matching.length > 1) { basis = 'historical_attribution_unknown'; }
    else {
      const observation = retainedObservation;
      if (observation && observation.zone_id != null && observation.timezone) {
        const tz = String(observation.timezone);
        if (tz === 'UTC' || tz === 'Etc/UTC' || tz.includes('/')) {
          try { validZone(tz, 'retained observation timezone'); zoneId = Number(observation.zone_id); timezone = tz; day = dateInZone(ms, timezone); basis = 'observation_snapshot'; sourceRef = 'rain_observations:' + observation.id; }
          catch { basis = 'historical_attribution_unknown'; }
        } else { timezoneIssue = true; }
      }
      if (!day) {
        const device = deviceById.get(row.deveui);
        zoneId = device && device.irrigation_zone_id != null ? Number(device.irrigation_zone_id) : null;
        day = new Date(ms).toISOString().slice(0, 10);
        basis = zoneId == null ? 'historical_attribution_unknown' : 'current_assignment_only';
      }
    }
    if (!day || day < options.from || day > options.to) continue;
    const key = [row.deveui, zoneId == null ? '' : zoneId, day, timezone || ''].join('|');
    const lsnSnapshotEligible = requiresLsnSnapshot && lsn50SnapshotEligible(retainedObservation, row);
    if (!recordsByDeviceDate.has(key)) recordsByDeviceDate.set(key, { deveui: row.deveui, zoneId, date: day, timezone, basis, sourceRef, rows: [], selectedInterval, hasObservationIdentity: basis === 'observation_snapshot', timezoneIssue, lsnSnapshotUnverifiable: false, evidenceRefs: sourceRef ? [sourceRef] : [] });
    const record = recordsByDeviceDate.get(key);
    record.rows.push({ ...row, retainedObservation, requiresLsnSnapshot, lsnSnapshotEligible });
    if (requiresLsnSnapshot && (!lsnSnapshotEligible || lsnLinkAmbiguous)) record.lsnSnapshotUnverifiable = true;
    record.timezoneIssue = record.timezoneIssue || timezoneIssue;
    if (sourceRef && !record.evidenceRefs.includes(sourceRef)) record.evidenceRefs.push(sourceRef);
    if (basis === 'observation_snapshot') record.hasObservationIdentity = true;
  }
  for (const record of recordsByDeviceDate.values()) {
    if (record.rows.some((row) => unresolvedLsnTimestampKeys.has(row.deveui + '|' + String(row.recorded_at)))) record.lsnSnapshotUnverifiable = true;
  }
  for (const interval of provenance.intervals) {
    const start = Math.max(Date.parse(interval.from), Date.parse(options.from + 'T00:00:00.000Z') - 26 * 3600000);
    const end = Math.min(Date.parse(interval.to), Date.parse(options.to + 'T00:00:00.000Z') + 50 * 3600000);
    for (let ms = start; ms < end; ms += 6 * 3600000) {
      const day = dateInZone(ms, interval.timezone);
      if (day < options.from || day > options.to) continue;
      const key = [interval.deveui, interval.zoneId, day, interval.timezone].join('|');
      if (!recordsByDeviceDate.has(key)) recordsByDeviceDate.set(key, { deveui: interval.deveui, zoneId: interval.zoneId, date: day, timezone: interval.timezone, basis: 'provenance', sourceRef: interval.sourceRef, rows: [], selectedInterval: interval, hasObservationIdentity: false, evidenceRefs: [interval.sourceRef] });
      else {
        const record = recordsByDeviceDate.get(key);
        if (record.selectedInterval && record.selectedInterval.sourceRef !== interval.sourceRef) record.basis = 'assignment_changed_within_day';
        if (!record.evidenceRefs.includes(interval.sourceRef)) record.evidenceRefs.push(interval.sourceRef);
      }
    }
  }
  // Preserve old zone rows with no device attribution as one context row.
  for (const item of evidence.env) {
    const hasDevice = [...recordsByDeviceDate.values()].some((entry) => entry.zoneId === Number(item.zone_id) && entry.date === item.date);
    if (!hasDevice) recordsByDeviceDate.set('unknown|' + item.zone_id + '|' + item.date, { deveui: '', zoneId: Number(item.zone_id), date: item.date, timezone: null, basis: 'historical_attribution_unknown', sourceRef: null, rows: [], selectedInterval: null, hasObservationIdentity: false, evidenceRefs: [] });
  }

  const rows = [];
  for (const record of recordsByDeviceDate.values()) {
    const device = deviceById.get(record.deveui) || {};
    const reasons = new Set();
    const bounds = record.date && record.timezone ? dateBounds(record.date, record.timezone) : null;
    const matchingIntervals = bounds ? provenance.intervals.filter((i) => i.zoneId === record.zoneId && i.selected && Date.parse(i.from) <= bounds.start && Date.parse(i.to) >= bounds.end) : [];
    const selected = new Set(matchingIntervals.map((i) => i.deveui));
    const selectedDeveui = selected.size === 1 ? [...selected][0] : null;
    const zone = record.zoneId == null ? null : zoneRows.get(record.zoneId + '|' + record.date) || null;
    const oldZone = zone ? asNumber(zone.rainfall_mm) : null;
    const instrumentDay = evidence.instrumentDays.find((item) => item.deveui === record.deveui && item.date === record.date && item.timezone === record.timezone) || null;
    const retainedSelected = zone && zone.rain_selected_deveui != null ? String(zone.rain_selected_deveui).toUpperCase() : null;
    const selectedGauge = selectedDeveui || retainedSelected;
    let acceptedCount = 0;
    let excludedCount = 0;
    for (const item of record.rows) {
      const amount = finiteNonnegative(item.rain_mm_delta);
      if (amount != null && item.rain_delta_status === 'ok' && (!item.requiresLsnSnapshot || item.lsnSnapshotEligible)) acceptedCount += 1;
      else if (item.rain_mm_delta != null || item.rain_delta_status != null || item.rain_tips_delta != null) excludedCount += 1;
    }
    let fullDay = false;
    if (record.basis === 'provenance' && record.timezone && record.selectedInterval) {
      const bounds = dateBounds(record.date, record.timezone);
      fullDay = Date.parse(record.selectedInterval.from) <= bounds.start && Date.parse(record.selectedInterval.to) >= bounds.end;
    }
    let received = null;
    if (((record.basis === 'provenance' && fullDay) || record.basis === 'observation_snapshot') && record.rows.length && !record.lsnSnapshotUnverifiable) {
      const window = rain.zoneDateWindow(record.date, record.timezone);
      const frames = record.rows.filter((item) => finiteNonnegative(item.rain_mm_delta) != null && item.rain_delta_status === 'ok').map((item) => ({
        receivedAt: item.recorded_at, amountMm: Number(item.rain_mm_delta), status: 'accepted', intervalBasis: 'unknown', measuredStart: null, measuredEnd: null,
      }));
      // The shared assessor can report received evidence from these legacy frames;
      // unknown identity/interval bounds keep its water-balance amount uncertified.
      received = round3(rain.assessInstrumentDay({ kind: 'cumulative', frames, window, cutoffIso: null }).receivedMm);
    }
    if (record.basis === 'current_assignment_only') reasons.add('current_assignment_only');
    if (record.lsnSnapshotUnverifiable) reasons.add('snapshot_ineligible');
    if (record.basis === 'historical_attribution_unknown' || record.basis === 'assignment_changed_within_day') reasons.add(record.basis);
    if (!record.rows.length || acceptedCount === 0) reasons.add('no_accepted_rain_rows');
    if (excludedCount) reasons.add('excluded_or_unknown_status_rows');
    if (record.rows.length && !record.hasObservationIdentity) reasons.add('no_observation_identity');
    if (record.timezoneIssue) reasons.add('timezone_abbreviation');
    if (selected.size > 1) reasons.add('gauge_ambiguous');
    if (record.rows.length && record.rows.every((r) => finiteNonnegative(r.rain_mm_delta) === 0) && record.rows.some((r) => r.flow_liters_delta != null)) reasons.add('flow_only_zero');
    if (!zone && record.rows.length === 0) reasons.add('dry_row_missing');
    if (zone && record.rows.length > 1 && new Set(record.rows.map((r) => r.deveui)).size > 1) reasons.add('gauge_addition_suspected');
    const hostValue = options.hostTimezone ? lastHostValueForRows(evidence.data, record.rows, record.deveui, options.hostTimezone) : null;
    const hostBoundary = options.hostTimezone && record.timezone && record.rows.some((r) => hostDay(r.recorded_at, options.hostTimezone) !== dateInZone(Date.parse(r.recorded_at), record.timezone));
    if (hostBoundary) reasons.add('timezone_boundary');
    if (hostBoundary && hostValue != null && oldZone != null && received != null && Math.abs(oldZone - hostValue) <= 0.001 && Math.abs(received - oldZone) > 0.001) reasons.add('host_day_carryover_suspected');
    if (!record.rows.some((r) => r.rain_mm_delta != null) && record.rows.some((r) => r.rain_mm_per_hour != null)) reasons.add('legacy_rate');
    if (!zone) reasons.add('dry_row_missing');
    const oldSelected = retainedSelected;
    const selectedProof = (record.basis === 'provenance' && fullDay && record.selectedInterval && record.selectedInterval.selected && selectedDeveui === record.deveui && selected.size === 1)
      || (record.basis === 'observation_snapshot' && record.hasObservationIdentity && retainedSelected === record.deveui);
    const oldSource = zone && zone.rain_source != null ? String(zone.rain_source).toLowerCase() : '';
    const instrumentType = String(device.type_id || '').toUpperCase();
    const expectedSource = SOURCE_BY_TYPE[instrumentType] || null;
    const exactStoredGauge = oldSelected === record.deveui && zone && zone.rain_coverage === 'complete' && instrumentDay && instrumentDay.coverage === 'complete';
    const markerlessLegacyRow = !evidence.envColumns.has('rain_selected_deveui') && !evidence.envColumns.has('rain_coverage');
    const legacySource = oldSource === 'local_gauge' && markerlessLegacyRow;
    const soleLegacyGauge = markerlessLegacyRow && bounds && fullDay && soleEligibleGaugeForDay(provenance, evidence.devices, evidence.data, evidence.observations, record.zoneId, record.date, record.deveui, bounds);
    const sourceMatches = Boolean((expectedSource && oldSource === expectedSource) || soleLegacyGauge || (oldSource === 'local_gauge' && instrumentType === 'DRAGINO_LSN50' && exactStoredGauge));
    const legacyComparable = record.basis === 'provenance' && fullDay && record.selectedInterval && record.selectedInterval.selected
      && selectedProof && markerlessLegacyRow && sourceMatches && soleLegacyGauge
      && (!zone || zone.rain_coverage == null || zone.rain_coverage === 'complete')
      && (!instrumentDay || instrumentDay.coverage == null || instrumentDay.coverage === 'complete');
    const retainedComparable = sourceMatches && oldSelected === record.deveui && zone && zone.rain_coverage === 'complete' && instrumentDay && instrumentDay.coverage === 'complete';
    const proof = selectedProof && record.timezone && zone && oldZone != null && (legacyComparable || retainedComparable) && acceptedCount > 0 && !record.lsnSnapshotUnverifiable;
    const delta = proof ? round3(received - oldZone) : null;
    if (proof && delta === 0) reasons.add('unchanged');
    if (zone && !proof) reasons.add('comparison_unverifiable');
    if (zone && record.basis === 'provenance' && oldSource && !sourceMatches && !legacySource) reasons.add('old_source_mismatch');
    if (zone && markerlessLegacyRow && !soleLegacyGauge) reasons.add('old_gauge_basis_ambiguous');
    const oldHost = options.hostTimezone && ((record.basis === 'provenance' && fullDay) || record.basis === 'observation_snapshot') ? hostValue : null;
    if (record.date && record.timezone && !fullDay) reasons.add('assignment_period_unproven');
    rows.push({ deveui: record.deveui || null, instrument_type: device.type_id || null, zone_id: record.zoneId, date: record.date, timezone: record.timezone, old_host_day_mm: oldHost, old_zone_row_mm: oldZone, old_rain_source: zone ? zone.rain_source : null, new_received_mm: received, new_coverage: record.rows.length ? 'received_only' : null, new_selected_deveui: selectedGauge, delta_mm: delta, reasons: [...reasons].sort().join(';'), evidenceRefs: record.evidenceRefs });
  }
  const byDeviceDay = new Map();
  for (const row of rows) {
    if (!row.deveui || !row.date) continue;
    const key = row.deveui + '|' + row.date;
    if (!byDeviceDay.has(key)) byDeviceDay.set(key, []);
    byDeviceDay.get(key).push(row);
  }
  for (const group of byDeviceDay.values()) {
    if (new Set(group.map((row) => String(row.zone_id || '') + '|' + String(row.timezone || ''))).size > 1) for (const row of group) {
      row.delta_mm = null;
      row.new_received_mm = null;
      row.new_selected_deveui = null;
      const flags = new Set(String(row.reasons || '').split(';').filter(Boolean));
      flags.add('assignment_changed_within_day');
      row.reasons = [...flags].sort().join(';');
    }
  }
  const byZoneDay = new Map();
  for (const row of rows) {
    if (row.zone_id == null || !row.date || !row.deveui) continue;
    const key = row.zone_id + '|' + row.date;
    if (!byZoneDay.has(key)) byZoneDay.set(key, []);
    byZoneDay.get(key).push(row);
  }
  for (const group of byZoneDay.values()) {
    const gauges = new Set(group.map((row) => row.deveui));
    const selected = new Set(group.map((row) => row.new_selected_deveui).filter(Boolean));
    if (gauges.size > 1 && selected.size !== 1) for (const row of group) {
      const flags = new Set(String(row.reasons || '').split(';').filter(Boolean));
      flags.add('gauge_addition_suspected');
      row.reasons = [...flags].sort().join(';');
    }
  }
  return rows.sort((a, b) => String(a.deveui || '').localeCompare(String(b.deveui || '')) || String(a.date || '').localeCompare(String(b.date || '')) || String(a.zone_id || '').localeCompare(String(b.zone_id || '')));
}
function lastHostValueForRows(data, deviceRows, deveui, timezone) {
  if (!deveui || !deviceRows.length) return null;
  const latest = deviceRows.slice().sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)) || Number(a.id || 0) - Number(b.id || 0)).at(-1);
  const day = hostDay(latest.recorded_at, timezone);
  const rows = data.filter((row) => row.deveui === deveui && row.rain_mm_today != null && hostDay(row.recorded_at, timezone) === day);
  rows.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)) || Number(a.id || 0) - Number(b.id || 0));
  return rows.length ? asNumber(rows[rows.length - 1].rain_mm_today) : null;
}
function summary(rows, provenance) {
  const reasons = new Map();
  let comparable = 0;
  const deltas = [];
  for (const row of rows) {
    for (const reason of String(row.reasons || '').split(';').filter(Boolean)) reasons.set(reason, (reasons.get(reason) || 0) + 1);
    if (row.delta_mm != null) { comparable += 1; deltas.push(row); }
  }
  deltas.sort((a, b) => Math.abs(b.delta_mm) - Math.abs(a.delta_mm) || String(a.deveui).localeCompare(String(b.deveui)));
  const out = [
    '# Rain history difference summary', '',
    `Rows: ${rows.length}`, `Comparable numeric differences: ${comparable}`,
    `Days with nonzero numeric differences: ${new Set(rows.filter((row) => row.delta_mm != null && row.delta_mm !== 0).map((row) => row.zone_id + '|' + row.date)).size}`,
    `Unverifiable rows: ${rows.length - comparable}`,
    `Unverifiable farm days: ${new Set(rows.filter((row) => row.delta_mm == null).map((row) => row.zone_id + '|' + row.date)).size}`,
    `Original host timezone: ${provenance.hostTimezone || 'unknown'} (${provenance.hostTimezoneSource})`,
    'Quantity rules: accepted finite nonnegative rain_mm_delta with rain_delta_status=ok is summed per device and proven farm day; accepted rows with an explicit zero remain 0. DRAGINO_LSN50 rows additionally require a matching accepted rain_observations amount and a captured enabled, zone, and timezone snapshot; missing or unresolved snapshots leave the day amount unreported. rain_mm_today is contextual only. No rain_tips_delta conversion is applied because retained per-device calibration and original ingestion conversion are not established by this tool.',
    `Historical evidence references: ${[...new Set(rows.flatMap((row) => row.evidenceRefs || []))].sort().map(escapeMarkdown).join(', ') || 'none retained'}.`,
    'Rows without retained observation identity are received_only and carry no deduplication claim. A numeric delta requires a proven historical assignment, matching old rain source and gauge basis, retained zone row, and matching farm-day period. Complete stored coverage markers are required on post-migration rows; a marker-less legacy comparison requires full-day provenance showing a sole eligible gauge. Neither quantity is certified.',
    'Reason counts:', '',
  ];
  for (const [reason, count] of [...reasons].sort((a, b) => a[0].localeCompare(b[0]))) out.push(`- ${reason}: ${count}`);
  out.push('', 'Largest comparable numeric deltas:', '');
  if (!deltas.length) out.push('- None established.');
  else for (const row of deltas.slice(0, 10)) out.push(`- ${escapeMarkdown(row.deveui)} ${row.date} zone ${row.zone_id}: ${row.delta_mm} mm`);
  const daily = rows.filter((row) => row.delta_mm != null && row.old_zone_row_mm != null && row.new_received_mm != null)
    .filter((row) => (row.old_zone_row_mm < 5 && row.new_received_mm >= 5) || (row.old_zone_row_mm >= 5 && row.new_received_mm < 5));
  out.push('', 'Hypothetical advice-threshold candidates (not proof of actual past advice):', '');
  if (daily.length) for (const row of daily) out.push(`- Hypothetical daily crossing of 5 mm on ${row.date}, zone ${row.zone_id}: old ${row.old_zone_row_mm} mm; received ${row.new_received_mm} mm (${row.new_received_mm >= 5 ? 'upward' : 'downward'}). Received-only values are not certified.`);
  else out.push('- No comparable single-day crossing of 5 mm established.');
  const buckets = new Map();
  for (const row of rows) {
    if (row.zone_id == null || !row.date || !row.timezone) continue;
    const key = [row.zone_id, row.timezone].join('|');
    if (!buckets.has(key)) buckets.set(key, new Map());
    const days = buckets.get(key);
    if (!days.has(row.date)) days.set(row.date, []);
    days.get(row.date).push(row);
  }
  const rollingCandidates = [];
  let rollingWindowCount = 0;
  for (const [zoneKey, days] of buckets) {
    const orderedDates = [...days.keys()].sort();
    if (orderedDates.length < 7) continue;
    const first = Date.parse(orderedDates[0] + 'T00:00:00Z');
    const last = Date.parse(orderedDates.at(-1) + 'T00:00:00Z');
    for (let start = first; start + 6 * 86400000 <= last; start += 86400000) {
      rollingWindowCount += 1;
      const windowDates = Array.from({ length: 7 }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10));
      const windowRows = windowDates.map((day) => days.get(day));
      if (windowRows.some((group) => !group || group.length !== 1 || group[0].delta_mm == null || group[0].old_zone_row_mm == null || group[0].new_received_mm == null)) continue;
      const period = windowRows.map((group) => group[0]);
      if (new Set(period.map((row) => row.new_selected_deveui)).size !== 1 || new Set(period.map((row) => row.old_rain_source)).size !== 1) continue;
      const oldTotal = round3(period.reduce((sum, row) => sum + row.old_zone_row_mm, 0));
      const newTotal = round3(period.reduce((sum, row) => sum + row.new_received_mm, 0));
      if ((oldTotal < 20 && newTotal >= 20) || (oldTotal >= 20 && newTotal < 20)) rollingCandidates.push({ zoneKey, from: windowDates[0], to: windowDates[6], oldTotal, newTotal });
    }
  }
  if (rollingCandidates.length) for (const candidate of rollingCandidates) out.push(`- Hypothetical seven-day crossing of 20 mm for ${candidate.from} through ${candidate.to}, zone/timezone ${candidate.zoneKey}: old ${candidate.oldTotal} mm; received ${candidate.newTotal} mm (${candidate.newTotal >= 20 ? 'upward' : 'downward'}). Received-only totals are not certified.`);
  else out.push(`- Seven-day threshold assessment unverifiable: ${rollingWindowCount ? 'no seven-day window had seven comparable, unambiguous farm days with matching gauge/source/period' : 'missing or ambiguous farm day(s) leave no complete seven-day window'}. Received-only legacy values never establish a certified rolling total.`);
  out.push('');
  return out.join('\n');
}
function run(options) {
  const from = validDay(options.from, '--from');
  const to = validDay(options.to, '--to');
  if (from > to) throw new Error('--from must be on or before --to');
  if (options.hostTimezone) validZone(options.hostTimezone, '--host-timezone');
  const dbPath = checkedDatabasePath(options.dbPath);
  const provenance = loadProvenance(options.provenancePath, options.hostTimezone);
  const targets = validateOutputTargets(dbPath, options.outDir);
  let db;
  let rows;
  try {
    db = new DatabaseSync(pathToFileURL(dbPath).href + '?mode=ro&immutable=1', { readOnly: true });
    const effectiveOptions = { ...options, from, to, hostTimezone: provenance.hostTimezone };
    const evidence = readEvidence(db, effectiveOptions, provenance);
    validateObservationProvenance(evidence, provenance);
    // Pure day and coverage functions receive only in-memory frames; this tool never calls recompute APIs.
    rows = deriveRows(evidence, effectiveOptions, provenance);
  } finally {
    if (db) db.close();
  }
  fs.mkdirSync(targets.dir, { recursive: true });
  const csvPath = targets.files[0]; const summaryPath = targets.files[1];
  for (const target of targets.files) if (fs.existsSync(target) && fs.realpathSync(target) === dbPath) throw new Error('output target aliases the input database');
  const created = [];
  const temporary = targets.files.map((file) => file + '.tmp-' + process.pid + '-' + crypto.randomUUID());
  try {
    for (let index = 0; index < temporary.length; index += 1) {
      const fd = fs.openSync(temporary[index], 'wx', 0o600);
      created.push(temporary[index]);
      fs.closeSync(fd);
      fs.writeFileSync(temporary[index], index === 0 ? csv(rows) : summary(rows, provenance));
    }
    for (let index = 0; index < temporary.length; index += 1) {
      try { fs.linkSync(temporary[index], targets.files[index]); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('refusing to overwrite existing output: ' + path.basename(targets.files[index]));
        throw error;
      }
      created.push(targets.files[index]);
      fs.unlinkSync(temporary[index]);
      created.splice(created.indexOf(temporary[index]), 1);
    }
  } catch (error) {
    for (const file of created) { try { fs.unlinkSync(file); } catch {} }
    throw error;
  }
  return { rows: rows.length, comparable: rows.filter((r) => r.delta_mm != null).length, outDir: targets.dir };
}
function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage() + '\n'); return; }
    const result = run(options);
    process.stdout.write(`Wrote ${result.rows} rows (${result.comparable} comparable) to ${result.outDir}\n`);
  } catch (error) {
    process.stderr.write('rain-history-diff: ' + error.message + '\n' + usage() + '\n');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { parseArgs, validDay, validZone, loadProvenance, checkedDatabasePath, run, deriveRows };
