#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const wm = require(path.resolve(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.js'));

const LIMITS = Object.freeze({
  bandLowOhm: 2000, bandHighOhm: 15000,
  subBands: [[2000, 5000], [5000, 10000], [10000, 15000]],
  resistorRel: 0.015, resistorAbsOhm: 15, minInBand: 30, minPerSubBand: 5,
  offsetDevMv: 10, kpaTolerance: 3, unusableShare: 0.2, tempDeltaC: 1,
  refWindowMin: 30, envelopeMinReadings: 5, envelopeCandidates: [0.005, 0.01, 0.02, 0.03, 0.05, 0.08],
  neighbourIntervals: 3, offsetNeighbours: 3,
});
const EUI_RE = /^[0-9A-F]{16}$/;
const HEX_RE = /^[0-9A-Fa-f]+$/;
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const FLAGS_UNTRUSTED = 0x1b;
const FLAG_UNSETTLED = 0x04;
const REQUIRED_READING = ['deveui', 'id', 'recorded_at', 'f_cnt', 'frame_status', 'payload_hex'];
const REQUIRED_RESISTOR = ['resistor_id', 'nominal_band', 'channel', 'repeat', 'meter_ohm', 'fwd_early', 'fwd_late', 'rev_early', 'rev_late', 'supply_mv'];
const REQUIRED_REFERENCE = ['reference_id', 'recorded_at', 'reference_c'];
const BANDS = new Set(['2k2', '4k7', '10k', '15k']);

class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; this.code = 'INPUT'; }
}
function inputError(message) { return new InputError(message); }
function requiredText(value, label) { if (typeof value !== 'string' || value.trim() === '') throw inputError(`${label} is required`); return value.trim(); }
function strictFinite(value, label) { const text = typeof value === 'string' ? value.trim() : value; if (text === '' || text === null || text === undefined) throw inputError(`${label} is required`); const n = Number(text); if (!Number.isFinite(n)) throw inputError(`${label} must be finite`); return n; }
function strictPositive(value, label) { const n = strictFinite(value, label); if (!(n > 0)) throw inputError(`${label} must be positive`); return n; }
function strictInteger(value, label, allowed) { const text = typeof value === 'string' ? value.trim() : value; if (text === '' || text === null || text === undefined || !/^-?\d+$/.test(String(text))) throw inputError(`${label} must be an integer`); const n = Number(text); if (!Number.isSafeInteger(n) || (allowed && !allowed.has(n))) throw inputError(`${label} is outside the allowed set`); return n; }

function parseCsv(text, requiredColumns) {
  const rows = []; let row = []; let field = ''; let quoted = false; const all = [];
  for (let i = 0; i < String(text).length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = ''; if (row.some((v) => v !== '')) all.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) all.push(row); }
  if (!all.length) return [];
  const header = all[0].map((v) => String(v).trim());
  if (quoted) throw inputError('unterminated CSV quote');
  if (new Set(header).size !== header.length) throw inputError('duplicate CSV column');
  if (requiredColumns) for (const column of requiredColumns) if (!header.includes(column)) throw inputError(`required column missing: ${column}`);
  return all.slice(1).map((values, rowIndex) => {
    if (values.length !== header.length) throw inputError(`CSV row ${rowIndex + 2} has ${values.length} columns; expected ${header.length}`);
    return Object.fromEntries(header.map((h, i) => [h, values[i]]));
  });
}

function rows(value, required) {
  const result = Array.isArray(value) ? value : parseCsv(value || '', required);
  if (required && Array.isArray(value)) for (const row of result) for (const column of required) if (!Object.prototype.hasOwnProperty.call(row, column)) throw inputError(`required column missing: ${column}`);
  return result;
}
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function iso(value) { const text = typeof value === 'string' ? value.trim() : ''; if (!ISO_TZ_RE.test(text)) return null; const year = Number(text.slice(0, 4)); const month = Number(text.slice(5, 7)); const day = Number(text.slice(8, 10)); if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null; const t = Date.parse(text); return Number.isFinite(t) ? t : null; }
function p95(values) { if (!values.length) return null; const a = values.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)]; }
function median(values) { const a = values.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function bandOf(ohm) {
  if (!Number.isFinite(ohm) || ohm < LIMITS.bandLowOhm || ohm > LIMITS.bandHighOhm) return null;
  return LIMITS.subBands.findIndex(([lo, hi], i) => ohm >= lo && (ohm < hi || (i === 2 && ohm <= hi)));
}
function kpaAt(ohm, temp) { if (!Number.isFinite(ohm) || !Number.isFinite(temp)) return null; return wm.tensionFromResistance(ohm, temp).kpa; }

function validateMetadata(metadata, calibration, readings) {
  if (!metadata || metadata.schema_version !== 1 || !metadata.identity || !metadata.firmware || !metadata.circuit || !metadata.capture) throw inputError('run metadata is incomplete');
  requiredText(metadata.run_id, 'run_id'); requiredText(metadata.operator, 'operator'); if (iso(metadata.recorded_at) === null) throw inputError('run metadata recorded_at is invalid');
  const id = metadata.identity; const eui = requiredText(id.current_device_eui, 'current_device_eui');
  if (id.current_device_eui !== eui || !EUI_RE.test(eui) || eui !== eui.toUpperCase()) throw inputError('current_device_eui is not canonical');
  for (const key of ['previous_device_eui', 'uart_device_eui', 'chirpstack_device_eui', 'edge_device_eui']) { const value = requiredText(id[key], key); if (id[key] !== value || !EUI_RE.test(value) || value !== value.toUpperCase()) throw inputError(`${key} is not canonical`); }
  if (id.uart_device_eui !== eui || id.chirpstack_device_eui !== eui || id.edge_device_eui !== eui) throw inputError('identity EUI mismatch');
  requiredText(id.physical_board_id, 'physical_board_id'); requiredText(id.physical_board_statement, 'physical_board_statement');
  requiredText(metadata.firmware.build_id, 'firmware.build_id');
  if (!/^[0-9a-f]{40}$/i.test(requiredText(metadata.firmware.commit, 'firmware.commit')) || !/^[0-9a-f]{64}$/i.test(requiredText(metadata.firmware.image_sha256, 'firmware.image_sha256'))) throw inputError('firmware provenance invalid');
  requiredText(metadata.circuit.revision, 'circuit.revision'); requiredText(metadata.circuit.channel_1_probe_id, 'channel_1_probe_id'); requiredText(metadata.circuit.channel_2_probe_id, 'channel_2_probe_id'); requiredText(metadata.calibration_record_path, 'calibration_record_path');
  const capture = metadata.capture;
  if (!['edge_db_csv', 'raw_logger_json'].includes(capture.source_type) || !requiredText(capture.source_record, 'capture.source_record')) throw inputError('capture provenance invalid');
  if (capture.source_type === 'raw_logger_json' && (!requiredText(capture.raw_source_path, 'capture.raw_source_path') || !/^[0-9a-f]{64}$/i.test(requiredText(capture.raw_source_sha256, 'capture.raw_source_sha256')))) throw inputError('raw.source provenance required');
  if (capture.source_type === 'edge_db_csv' && (capture.raw_source_path !== null || capture.raw_source_sha256 !== null)) throw inputError('raw.source fields must be null for edge_db_csv');
  const calibrationEui = requiredText(calibration.device_eui, 'calibration.device_eui');
  if (calibration.device_eui !== calibrationEui || calibration.schema_version !== 1 || !EUI_RE.test(calibrationEui) || calibrationEui !== calibrationEui.toUpperCase() || calibrationEui !== eui) throw inputError('calibration device_eui mismatch');
  const p = calibration.provenance || {};
  for (const key of ['physical_board_id', 'previous_device_eui', 'circuit_revision', 'source_record_path']) { const value = requiredText(p[key], `calibration.provenance.${key}`); if (key === 'previous_device_eui' && (p[key] !== value || !EUI_RE.test(value) || value !== value.toUpperCase())) throw inputError('calibration.provenance.previous_device_eui is not canonical'); }
  if (p.physical_board_id !== id.physical_board_id || p.previous_device_eui !== id.previous_device_eui || p.circuit_revision !== metadata.circuit.revision || p.source_record_path !== metadata.calibration_record_path) throw inputError('calibration provenance mismatch');
  const seen = new Set(); const observationSeen = new Map();
  for (const row of readings) {
    const rowId = requiredText(row.id, 'reading id'); const readingEui = requiredText(row.deveui, `reading ${rowId} deveui`); if (row.deveui !== readingEui || !EUI_RE.test(readingEui) || readingEui !== eui) throw inputError(`reading ${rowId} deveui is not canonical or mismatched`);
    if (seen.has(rowId)) throw inputError('reading id missing or duplicate');
    seen.add(rowId);
    if (iso(row.recorded_at) === null) throw inputError('reading timestamp invalid');
    const frameCount = strictInteger(row.f_cnt, `reading ${rowId} f_cnt`); if (frameCount < 0) throw inputError(`reading ${rowId} f_cnt must be nonnegative`);
    const payload = String(row.payload_hex || '');
    if (payload.length % 2 || !payload || !HEX_RE.test(payload)) throw inputError('reading payload_hex invalid');
    if (!['accepted', 'frame_rejected'].includes(row.frame_status)) throw inputError('reading frame_status invalid');
    if (row.frame_status === 'accepted') {
      const identity = `${readingEui}|${frameCount}`; const normalizedPayload = payload.toLowerCase(); const previous = observationSeen.get(identity);
      if (previous) { if (previous.payload === normalizedPayload) throw inputError(`duplicate accepted observation identity ${identity}: rows ${previous.id} and ${rowId}`); throw inputError(`conflicting accepted frame counter evidence ${identity}: rows ${previous.id} and ${rowId}`); }
      observationSeen.set(identity, { id: rowId, payload: normalizedPayload });
    }
  }
  const acceptedByDevice = new Map();
  for (const row of readings) {
    if (row.frame_status !== 'accepted') continue;
    const list = acceptedByDevice.get(row.deveui) || [];
    list.push(row);
    acceptedByDevice.set(row.deveui, list);
  }
  for (const [deviceEui, list] of acceptedByDevice) {
    const ordered = list.slice().sort((a, b) => iso(a.recorded_at) - iso(b.recorded_at));
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1]; const curr = ordered[i];
      if (!(Number(curr.f_cnt) > Number(prev.f_cnt))) throw inputError(`frame counter out of order for ${deviceEui}: row ${curr.id} f_cnt ${curr.f_cnt} does not exceed row ${prev.id} f_cnt ${prev.f_cnt}`);
    }
  }
  return eui;
}

function validateCalibration(calibration) {
  if (!calibration || calibration.schema_version !== 1 || !Number.isSafeInteger(strictInteger(calibration.sync_version, 'calibration.sync_version')) || Number(calibration.sync_version) < 1) throw inputError('calibration sync_version invalid');
  for (const n of [1, 2]) for (const key of [`pullup_${n}_ohm`, `pulldown_${n}_ohm`]) { const value = strictPositive(calibration[key], `calibration.${key}`); if (!(value >= 25000 && value <= 65000)) throw inputError(`calibration.${key} outside limits`); }
  for (const n of [1, 2]) for (const key of [`series_fwd_${n}_ohm`, `series_rev_${n}_ohm`]) { const value = strictFinite(calibration[key], `calibration.${key}`); if (!(value >= 0 && value <= 500)) throw inputError(`calibration.${key} outside limits`); }
}

function normalizeResistorRows(rowsInput, label) {
  return rows(rowsInput, REQUIRED_RESISTOR).map((row, index) => {
    const resistor_id = requiredText(row.resistor_id, `${label}.row${index + 1}.resistor_id`);
    const nominal_band = requiredText(row.nominal_band, `${label}.row${index + 1}.nominal_band`);
    const channel = strictInteger(row.channel, `${label}.row${index + 1}.channel`);
    const repeat = strictInteger(row.repeat, `${label}.row${index + 1}.repeat`);
    const meter_ohm = strictPositive(row.meter_ohm, `${label}.row${index + 1}.meter_ohm`);
    const adc = {}; for (const key of ['fwd_early', 'fwd_late', 'rev_early', 'rev_late']) { adc[key] = strictInteger(row[key], `${label}.row${index + 1}.${key}`); if (adc[key] < 0 || adc[key] > 4095) throw inputError(`${label}.${key} ADC code outside limits`); }
    const supply_mv = strictPositive(row.supply_mv, `${label}.row${index + 1}.supply_mv`);
    return { ...row, resistor_id, nominal_band, channel, repeat, meter_ohm, ...adc, supply_mv };
  });
}

function matrix(rowsInput, calibration, label) {
  const input = normalizeResistorRows(rowsInput, label); const groups = new Map(); const defects = { missing: [], duplicates: [], mapping: [], unexpected: [] }; const evaluated = [];
  const validRows = input.filter((row) => {
    const key = `${row.channel}|${row.nominal_band}|${row.repeat}`;
    if (![1, 2].includes(row.channel) || ![1, 2, 3].includes(row.repeat) || !BANDS.has(row.nominal_band)) { defects.unexpected.push(key); return false; }
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); if (groups.get(key).length > 1) defects.duplicates.push(key); return true;
  });
  for (const channel of [1, 2]) for (const band of BANDS) for (const repeat of [1, 2, 3]) { const key = `${channel}|${band}|${repeat}`; if (!groups.has(key)) defects.missing.push(key); }
  const bandIds = new Map(); const idBands = new Map(); const conflictedBands = new Set(); const conflictedResistors = new Set();
  for (const row of validRows) {
    if (bandIds.has(row.nominal_band) && bandIds.get(row.nominal_band) !== row.resistor_id) { defects.mapping.push(`${row.nominal_band}:${bandIds.get(row.nominal_band)}!=${row.resistor_id}`); conflictedBands.add(row.nominal_band); conflictedResistors.add(row.resistor_id); conflictedResistors.add(bandIds.get(row.nominal_band)); } else bandIds.set(row.nominal_band, row.resistor_id);
    if (idBands.has(row.resistor_id) && idBands.get(row.resistor_id) !== row.nominal_band) { defects.mapping.push(`${row.resistor_id}:${idBands.get(row.resistor_id)}!=${row.nominal_band}`); conflictedResistors.add(row.resistor_id); conflictedBands.add(row.nominal_band); conflictedBands.add(idBands.get(row.resistor_id)); } else idBands.set(row.resistor_id, row.nominal_band);
  }
  const meterByResistor = new Map();
  for (const row of validRows) {
    if (!meterByResistor.has(row.resistor_id)) meterByResistor.set(row.resistor_id, row.meter_ohm);
    else if (row.meter_ohm !== meterByResistor.get(row.resistor_id)) { defects.mapping.push(`meter_ohm changed for ${row.resistor_id}`); conflictedResistors.add(row.resistor_id); }
  }
  if (new Set([...bandIds.values()]).size !== bandIds.size || bandIds.size !== 4) defects.mapping.push('band/resistor mapping is not one-to-one');
  for (const [key, group] of groups) {
    if (group.length !== 1) continue;
    const row = group[0]; const excluded = conflictedResistors.has(row.resistor_id) || conflictedBands.has(row.nominal_band); const cal = wm.channelCalibration(calibration, row.channel); const solved = cal ? wm.resistanceFromCodes(row.fwd_late, row.rev_late, cal, row.supply_mv).r : null; const limit = LIMITS.resistorRel * row.meter_ohm + LIMITS.resistorAbsOhm; const error = Number.isFinite(solved) ? Math.abs(solved - row.meter_ohm) : null;
    evaluated.push({ key, channel: row.channel, band: row.nominal_band, repeat: row.repeat, solved_ohm: solved, meter_ohm: row.meter_ohm, error_ohm: error, limit_ohm: limit, evidence_valid: !excluded, excluded, excluded_reason: excluded ? 'resistor_identity_conflict' : null, pass: excluded ? null : error !== null && error <= limit });
  }
  return { input_count: input.length, rows: input, cells: evaluated, missing: [...new Set(defects.missing)].sort(), duplicates: [...new Set(defects.duplicates)].sort(), mapping: [...new Set(defects.mapping)].sort(), unexpected: [...new Set(defects.unexpected)].sort(), complete: defects.missing.length === 0 && defects.duplicates.length === 0 && defects.mapping.length === 0 && defects.unexpected.length === 0 && input.length === 24, label };
}

function channelMetrics(frame, n, calibration, tempC) {
  const p = frame.probes[n - 1]; const codes = [p.fwd_early, p.fwd, p.rev_early, p.rev];
  if (p.flags & FLAGS_UNTRUSTED) return { reason: 'untrusted_flags' };
  if (codes.some((c) => !Number.isInteger(c) || c < 0 || c > 4095)) return { reason: 'bad_adc_code' };
  if (p.fwd >= 4087 || p.rev <= 8 || p.rev === 4095 || p.fwd === 0) return { reason: 'open_circuit' };
  const cal = wm.channelCalibration(calibration, n); if (!cal) return { reason: 'invalid_calibration' };
  const late = wm.resistanceFromCodes(p.fwd, p.rev, cal, frame.supply_mv); const earlyOk = p.fwd_early > 0 && p.rev_early < 4095; const early = earlyOk ? wm.resistanceFromCodes(p.fwd_early, p.rev_early, cal, frame.supply_mv) : null;
  return { metric: { channel: n, unsettled: (p.flags & FLAG_UNSETTLED) !== 0, r_late: late.r, r_early: early ? early.r : null, rho: early && Number.isFinite(early.r) && Number.isFinite(late.r) && late.r !== 0 ? Math.abs(early.r - late.r) / Math.abs(late.r) : null, drift_fwd: Math.abs(p.fwd_early - p.fwd), drift_rev: Math.abs(p.rev_early - p.rev), drift_fwd_x_tol: Math.abs(p.fwd_early - p.fwd) / Math.max(6, Math.floor(p.fwd / 50)), drift_rev_x_tol: Math.abs(p.rev_early - p.rev) / Math.max(6, Math.floor((4095 - p.rev) / 50)), offset_mv: Number.isFinite(late.offset_mv) ? late.offset_mv : null, r_fwd: late.r_fwd, r_rev: late.r_rev, kpa_late: kpaAt(late.r, tempC), kpa_early: early ? kpaAt(early.r, tempC) : null, temp_c: tempC, band: bandOf(late.r) } };
}

function continuityResidual(reading, settled, windowMs) {
  let before = null; let after = null;
  for (const candidate of settled) {
    if (candidate === reading) continue;
    if (candidate.t < reading.t && reading.t - candidate.t <= windowMs && (!before || candidate.t > before.t)) before = candidate;
    if (candidate.t > reading.t && candidate.t - reading.t <= windowMs && (!after || candidate.t < after.t)) after = candidate;
  }
  if (!before || !after || !Number.isFinite(reading.r_late)) return null;
  const f = (reading.t - before.t) / (after.t - before.t); const reference = Math.exp(Math.log(before.r_late) + f * (Math.log(after.r_late) - Math.log(before.r_late))); const kpa = kpaAt(reference, reading.temp_c); return kpa === null ? null : Math.abs(reading.kpa_late - kpa);
}

function candidateTable(unsettled) {
  return LIMITS.envelopeCandidates.map((value, index) => {
    const previous = index ? LIMITS.envelopeCandidates[index - 1] : 0; const set = unsettled.filter((r) => Number.isFinite(r.rho) && Number.isFinite(r.epsilon) && r.rho <= value); const support = set.filter((r) => r.rho > previous && r.rho <= value); const largest = set.length ? Math.max(...set.map((r) => r.epsilon)) : null;
    let reason = null; if (set.length < LIMITS.envelopeMinReadings) reason = 'insufficient_observations'; else if (largest > LIMITS.kpaTolerance) reason = 'residual_above_limit'; else if (!support.length) reason = 'no_observed_support';
    return { value, previous, interval: `( ${previous}, ${value} ]`, count: set.length, support_count: support.length, largest_residual: largest, qualifies: reason === null, reason };
  });
}

function analyze(input) {
  const readings = rows(input.readings, REQUIRED_READING); const calibration = input.calibration; const metadata = input.runMetadata || input.metadata; validateCalibration(calibration); const eui = validateMetadata(metadata, calibration, readings); const intervalMin = strictPositive(input.intervalMin, 'interval-min');
  const before = matrix(input.resistorsBefore ?? input.before ?? [], calibration, 'before'); const after = matrix(input.resistorsAfter ?? input.after ?? [], calibration, 'after');
  const mappingBefore = new Map(before.rows.filter((r) => BANDS.has(r.nominal_band)).map((r) => [r.nominal_band, r.resistor_id])); const mappingAfter = new Map(after.rows.filter((r) => BANDS.has(r.nominal_band)).map((r) => [r.nominal_band, r.resistor_id]));
  const remappedBands = new Set([...new Set([...mappingBefore.keys(), ...mappingAfter.keys()])].filter((band) => mappingBefore.get(band) !== mappingAfter.get(band)));
  if (remappedBands.size) { before.mapping.push('before/after band-resistor mapping differs'); after.mapping.push('before/after band-resistor mapping differs'); for (const cell of [...before.cells, ...after.cells]) if (remappedBands.has(cell.band)) { cell.evidence_valid = false; cell.excluded = true; cell.excluded_reason = 'cross_file_band_resistor_remap'; cell.pass = null; } }
  const p1Cells = [...before.cells.map((c) => ({ ...c, phase: 'before' })), ...after.cells.map((c) => ({ ...c, phase: 'after' }))]; const failures = p1Cells.filter((c) => c.pass === false); const mappingDefects = [...before.mapping, ...after.mapping]; const unexpected = [...before.unexpected, ...after.unexpected]; const p1Defect = !before.complete || !after.complete || mappingDefects.length > 0 || unexpected.length > 0; const P1Verdict = failures.length ? 'fail' : (p1Defect ? 'no_data' : 'pass'); const P1 = { value: failures.length, limit: 0, verdict: P1Verdict, reason: failures.length ? 'electrical_failure' : p1Defect ? 'structural_incomplete' : null, cells: p1Cells, failures, missing: [...new Set([...before.missing, ...after.missing])].sort(), duplicates: [...new Set([...before.duplicates, ...after.duplicates])].sort(), mapping: mappingDefects, unexpected, matrices: { before, after } };
  const perProbe = [null, [], []]; const frames = []; const analyzedRows = []; const rejectedFrames = []; const droppedChannels = [null, {}, {}];
  for (const row of readings) {
    if (row.frame_status !== 'accepted') continue; const parsed = wm.parseProfile3(Buffer.from(String(row.payload_hex), 'hex')); if (!parsed.ok) throw inputError(`accepted row ${row.id} has invalid Profile-3 payload: ${parsed.reason}`); const f = parsed.frame; const temp = f.soil_temp_source === 2 && !f.ds18b20_failed && Number.isFinite(f.soil_temp_c) && f.soil_temp_c >= 0 && f.soil_temp_c <= 50 ? f.soil_temp_c : null; const t = iso(row.recorded_at); frames.push({ id: row.id, recorded_at: row.recorded_at, t, temp_c: temp, supply_mv: f.supply_mv });
    if (!(Number.isFinite(f.supply_mv) && f.supply_mv > 0)) { rejectedFrames.push({ id: row.id, reason: 'invalid_supply_mv' }); continue; }
    for (const n of [1, 2]) { const result = channelMetrics(f, n, calibration, temp); if (!result.metric) { droppedChannels[n][result.reason] = (droppedChannels[n][result.reason] || 0) + 1; continue; } const full = { ...result.metric, id: row.id, deveui: eui, f_cnt: Number(row.f_cnt), recorded_at: row.recorded_at, t }; perProbe[n].push(full); analyzedRows.push(full); }
  }
  for (const n of [1, 2]) {
    const list = perProbe[n].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id)); const inBand = list.filter((r) => r.band !== null && r.temp_c !== null); const settled = inBand.filter((r) => !r.unsettled); const unsettled = inBand.filter((r) => r.unsettled);
    const missingValidTemperature = list.filter((r) => r.temp_c === null).length;
    const dropped = droppedChannels[n]; const droppedTotal = (dropped.untrusted_flags || 0) + (dropped.bad_adc_code || 0) + (dropped.open_circuit || 0) + (dropped.invalid_calibration || 0) + missingValidTemperature;
    const dropped_channels = { untrusted_flags: dropped.untrusted_flags || 0, bad_adc_code: dropped.bad_adc_code || 0, open_circuit: dropped.open_circuit || 0, invalid_calibration: dropped.invalid_calibration || 0, missing_valid_temperature: missingValidTemperature, total: droppedTotal };
    const deviations = settled.map((r, i) => { const around = settled.slice(Math.max(0, i - LIMITS.offsetNeighbours), i).concat(settled.slice(i + 1, i + 1 + LIMITS.offsetNeighbours)).filter((x) => Number.isFinite(x.offset_mv)); return Number.isFinite(r.offset_mv) && around.length ? Math.abs(r.offset_mv - median(around.map((x) => x.offset_mv))) : null; }).filter((v) => Number.isFinite(v));
    for (const r of settled) r.epsilon = continuityResidual(r, settled, LIMITS.neighbourIntervals * intervalMin * 60000); for (const r of unsettled) r.epsilon = continuityResidual(r, settled, LIMITS.neighbourIntervals * intervalMin * 60000);
    const candidates = candidateTable(unsettled); const qualifying = candidates.filter((c) => c.qualifies); const envelope = qualifying.length ? qualifying[qualifying.length - 1].value : null; const sub = [0, 1, 2].map((b) => inBand.filter((r) => r.band === b).length); const p2Pass = inBand.length >= LIMITS.minInBand && sub.every((v) => v >= LIMITS.minPerSubBand); const p2 = { value: inBand.length, limit: LIMITS.minInBand, verdict: p2Pass ? 'pass' : 'no_data', reason: p2Pass ? null : 'insufficient_in_band_evidence', sub_band_counts: sub }; const p3v = p95(deviations); const p3Pass = p3v !== null && p3v <= LIMITS.offsetDevMv; const p3 = { value: p3v, limit: LIMITS.offsetDevMv, verdict: p3v === null ? 'no_data' : p3Pass ? 'pass' : 'fail', reason: p3v === null ? 'insufficient_offset_neighbours' : p3Pass ? null : 'offset_instability' }; const p4v = p95(settled.map((r) => r.epsilon).filter((v) => v !== null)); const p4Pass = p4v !== null && p4v <= LIMITS.kpaTolerance; const p4 = { value: p4v, limit: LIMITS.kpaTolerance, verdict: p4v === null || p4v > LIMITS.kpaTolerance ? 'no_data' : 'pass', reason: p4Pass ? null : 'continuity_insufficient_or_residual_excessive' };
    perProbe[n] = { readings: list, in_band: inBand.length, sub_band_counts: sub, settled: settled.length, unsettled: unsettled.length, candidates, envelope, dropped_channels, P2: p2, P3: p3, P4: p4 };
  }
  const globalEnvelope = perProbe[1].envelope !== null && perProbe[2].envelope !== null ? Math.min(perProbe[1].envelope, perProbe[2].envelope) : null;
  const p5Probes = [1, 2].map((n) => { const rowsInBand = perProbe[n].readings.filter((r) => r.band !== null && r.temp_c !== null); const unusable = rowsInBand.filter((r) => r.unsettled && (globalEnvelope === null || !Number.isFinite(r.rho) || r.rho > globalEnvelope)).length; const share = rowsInBand.length ? unusable / rowsInBand.length : null; const verdict = rowsInBand.length === 0 ? 'no_data' : share <= LIMITS.unusableShare ? 'pass' : 'fail'; return { denominator: rowsInBand.length, unusable, share, verdict, reason: verdict === 'pass' ? null : verdict === 'fail' ? 'unusable_share_exceeded' : 'no_usable_rows' }; });
  const P5Verdict = p5Probes.some((p) => p.verdict === 'fail') ? 'fail' : (p5Probes.some((p) => p.verdict === 'no_data') ? 'no_data' : 'pass'); const P5Value = p5Probes.map((p) => p.share).filter(Number.isFinite); const P5 = { value: P5Value.length ? Math.max(...P5Value) : null, verdict: P5Verdict, reason: P5Verdict === 'pass' ? null : P5Verdict === 'fail' ? 'unusable_share_exceeded' : 'no_usable_rows', limit: LIMITS.unusableShare, envelope: globalEnvelope, probes: p5Probes };
  const refs = rows(input.references ?? input.referenceTemperature ?? [], REQUIRED_REFERENCE); const referenceIds = new Set(); for (const ref of refs) { const referenceId = requiredText(ref.reference_id, 'reference_id'); if (referenceIds.has(referenceId)) throw inputError('reference_id missing or duplicate'); referenceIds.add(referenceId); } const validFrames = frames.filter((f) => f.temp_c !== null); const details = []; let matched = 0; let maxDelta = null;
  for (const ref of refs) { const t = iso(ref.recorded_at); const referenceC = strictFinite(ref.reference_c, 'reference_c'); if (t === null) throw inputError('reference temperature invalid'); const nearest = validFrames.slice().sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t) || a.t - b.t || a.id.localeCompare(b.id))[0]; const allowed = nearest && Math.abs(nearest.t - t) <= LIMITS.refWindowMin * 60000; if (!allowed) { details.push({ reference_id: ref.reference_id, matched: false, nearest_frame_id: nearest ? nearest.id : null, nearest_distance_min: nearest ? Math.abs(nearest.t - t) / 60000 : null }); continue; } const delta = Math.abs(nearest.temp_c - referenceC); matched += 1; if (maxDelta === null || delta > maxDelta) maxDelta = delta; details.push({ reference_id: ref.reference_id, matched: true, frame_id: nearest.id, delta_c: delta }); }
  const p6Verdict = refs.length === 0 || matched < refs.length ? (maxDelta !== null && maxDelta > LIMITS.tempDeltaC ? 'fail' : 'no_data') : (maxDelta !== null && maxDelta > LIMITS.tempDeltaC ? 'fail' : 'pass'); const P6 = { total: refs.length, matched, unmatched: refs.length - matched, value: maxDelta, limit: LIMITS.tempDeltaC, verdict: p6Verdict, reason: p6Verdict === 'pass' ? null : p6Verdict === 'fail' ? 'temperature_delta_exceeded' : refs.length === 0 ? 'no_reference_rows' : 'unmatched_reference', details };
  const aggregate = (name, probes, limit) => { const verdict = probes.some((c) => c.verdict === 'fail') ? 'fail' : probes.every((c) => c.verdict === 'pass') ? 'pass' : 'no_data'; const reason = verdict === 'pass' ? null : verdict === 'fail' ? `${name.toLowerCase()}_failure` : `${name.toLowerCase()}_insufficient_evidence`; return { value: probes.map((c) => c.value), limit, probes, verdict, reason }; }; const criteria = { P1, P5, P6, P2: aggregate('P2', [perProbe[1].P2, perProbe[2].P2], LIMITS.minInBand), P3: aggregate('P3', [perProbe[1].P3, perProbe[2].P3], LIMITS.offsetDevMv), P4: aggregate('P4', [perProbe[1].P4, perProbe[2].P4], LIMITS.kpaTolerance), P2_ch1: perProbe[1].P2, P2_ch2: perProbe[2].P2, P3_ch1: perProbe[1].P3, P3_ch2: perProbe[2].P3, P4_ch1: perProbe[1].P4, P4_ch2: perProbe[2].P4 }; const allCriteria = [P1, P5, P6, criteria.P2, criteria.P3, criteria.P4]; const verdict = allCriteria.some((c) => c.verdict === 'fail') ? 'FAIL' : (allCriteria.some((c) => c.verdict !== 'pass') ? 'INCONCLUSIVE' : 'PASS'); const topReason = verdict === 'PASS' ? null : verdict === 'FAIL' ? 'criterion_failure' : 'insufficient_evidence';
  const normalizedMetadata = JSON.parse(JSON.stringify(metadata)); normalizedMetadata.run_id = normalizedMetadata.run_id.trim(); normalizedMetadata.operator = normalizedMetadata.operator.trim(); normalizedMetadata.recorded_at = normalizedMetadata.recorded_at.trim(); for (const key of ['physical_board_id', 'previous_device_eui', 'current_device_eui', 'physical_board_statement', 'uart_device_eui', 'chirpstack_device_eui', 'edge_device_eui']) normalizedMetadata.identity[key] = normalizedMetadata.identity[key].trim(); for (const key of ['commit', 'image_sha256', 'build_id']) normalizedMetadata.firmware[key] = normalizedMetadata.firmware[key].trim(); for (const key of ['revision', 'channel_1_probe_id', 'channel_2_probe_id']) normalizedMetadata.circuit[key] = normalizedMetadata.circuit[key].trim(); normalizedMetadata.calibration_record_path = normalizedMetadata.calibration_record_path.trim(); normalizedMetadata.capture.source_record = normalizedMetadata.capture.source_record.trim();
  return { verdict, reason: topReason, envelope: globalEnvelope, criteria, run_metadata: normalizedMetadata, calibration: JSON.parse(JSON.stringify(calibration)), probes: [perProbe[1], perProbe[2]], resistor_check: { before, after }, reference_temperature_matches: details, rejected_frames: rejectedFrames, input_manifest: input.inputManifest || null, identity: { current_device_eui: eui, physical_board_id: metadata.identity.physical_board_id, previous_device_eui: metadata.identity.previous_device_eui, circuit_revision: metadata.circuit.revision, calibration_record_path: metadata.calibration_record_path, capture: metadata.capture, calibration_provenance: calibration.provenance }, readings: analyzedRows.sort((a, b) => a.t - b.t || a.channel - b.channel), limits: LIMITS };
}

const CSV_COLUMNS = ['deveui', 'id', 'f_cnt', 'recorded_at', 'channel', 'band', 'settled', 'unsettled', 'r_late', 'r_early', 'rho', 'drift_fwd', 'drift_rev', 'drift_fwd_x_tol', 'drift_rev_x_tol', 'offset_mv', 'r_fwd', 'r_rev', 'kpa_late', 'kpa_early', 'epsilon', 'temp_c', 'final_envelope_acceptance'];
function csvEscape(value) { const text = value === null || value === undefined ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function csvOut(rowsOut, envelope) { return `${CSV_COLUMNS.join(',')}\n${rowsOut.map((r) => CSV_COLUMNS.map((c) => { if (c === 'settled') return csvEscape(!r.unsettled); if (c === 'final_envelope_acceptance') return csvEscape(!r.unsettled || r.band === null ? 'not_applicable' : envelope === null ? 'rejected' : Number.isFinite(r.rho) && r.rho <= envelope ? 'accepted' : 'rejected'); return csvEscape(r[c]); }).join(',')).join('\n')}\n`; }
function args(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) { if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error('invalid CLI arguments'); out[argv[i].slice(2)] = argv[i + 1]; } return out; }
function hashBuffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function writeAtomic(file, content) { const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`; try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, file); } catch (error) { try { fs.unlinkSync(temp); } catch (_) {} throw error; } }
function pathExistsIncludingSymlink(target) { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function rejectOutputCollisions(outputDir, inputFiles) { const output = path.resolve(outputDir); if (pathExistsIncludingSymlink(output)) throw inputError(`output path already exists: ${output}`); for (const input of Object.values(inputFiles)) { const resolved = path.resolve(input); for (const artifact of ['readings.csv', 'summary.json']) if (path.resolve(output, artifact) === resolved) throw inputError(`output artifact collides with input: ${input}`); } }
function cli(argv) {
  let a; let staging = null; try { a = args(argv); const required = ['readings', 'calibration', 'run-metadata', 'resistors-before', 'resistors-after', 'reference-temperature', 'interval-min', 'out']; for (const key of required) if (!a[key]) throw inputError(`missing --${key}`); const inputFiles = { readings: a.readings, calibration: a['calibration'], run_metadata: a['run-metadata'], resistors_before: a['resistors-before'], resistors_after: a['resistors-after'], reference_temperature: a['reference-temperature'] }; rejectOutputCollisions(a.out, inputFiles); const contents = Object.fromEntries(Object.entries(inputFiles).map(([key, file]) => [key, fs.readFileSync(file)])); const parsed = { readings: parseCsv(contents.readings.toString('utf8'), REQUIRED_READING), calibration: JSON.parse(contents.calibration.toString('utf8')), runMetadata: JSON.parse(contents.run_metadata.toString('utf8')), resistorsBefore: parseCsv(contents.resistors_before.toString('utf8'), REQUIRED_RESISTOR), resistorsAfter: parseCsv(contents.resistors_after.toString('utf8'), REQUIRED_RESISTOR), references: parseCsv(contents.reference_temperature.toString('utf8'), REQUIRED_REFERENCE), intervalMin: strictPositive(a['interval-min'], 'interval-min') }; parsed.inputManifest = Object.fromEntries(Object.entries(inputFiles).map(([key, file]) => [key, { path: path.basename(file), sha256: hashBuffer(contents[key]), count: key === 'calibration' || key === 'run_metadata' ? 1 : parsed[key === 'resistors_before' ? 'resistorsBefore' : key === 'resistors_after' ? 'resistorsAfter' : key === 'reference_temperature' ? 'references' : key].length }])); const report = analyze(parsed); const output = path.resolve(a.out); const parent = path.dirname(output); fs.mkdirSync(parent, { recursive: true }); staging = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.tmp-`)); writeAtomic(path.join(staging, 'readings.csv'), csvOut(report.readings, report.envelope)); const summary = { ...report, readings: undefined, schema_version: 1, input_manifest: report.input_manifest }; delete summary.readings; writeAtomic(path.join(staging, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`); fs.renameSync(staging, output); staging = null; process.stdout.write(`${report.verdict}\n`); return 0; } catch (error) { if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {} } process.stderr.write(`${error && error.message ? error.message : error}\n`); const message = String(error && error.message ? error.message : error); return error && error.code === 'INPUT' || /^(missing --|invalid CLI|required column|identity|calibration|reading|capture|raw.source|firmware|circuit|reference|interval)/.test(message) || error instanceof SyntaxError || (error && ['ENOENT', 'EISDIR'].includes(error.code)) ? 2 : 1; }
}

function deriveProbeEnvelope(rowsInput) { const table = candidateTable(rowsInput || []); const good = table.filter((c) => c.qualifies); return good.length ? good[good.length - 1].value : null; }
function selectGlobalEnvelope(a, b) { const left = a && typeof a === 'object' ? a.envelope : a; const right = b && typeof b === 'object' ? b.envelope : b; return Number.isFinite(left) && Number.isFinite(right) ? Math.min(left, right) : null; }
function evaluateP5(rowsInput, envelope) { const denominator = rowsInput.length; const unusable = rowsInput.filter((r) => r.unsettled && (envelope === null || !Number.isFinite(r.rho) || r.rho > envelope)).length; return { denominator, unusable, share: denominator ? unusable / denominator : null, verdict: denominator === 0 ? 'no_data' : unusable / denominator > LIMITS.unusableShare ? 'fail' : 'pass' }; }
module.exports = { analyze, parseCsv, deriveProbeEnvelope, selectGlobalEnvelope, evaluateP5, LIMITS };
if (require.main === module) process.exitCode = cli(process.argv.slice(2));
