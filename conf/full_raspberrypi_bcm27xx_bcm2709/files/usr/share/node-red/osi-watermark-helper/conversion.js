'use strict';

// WATERMARK 200SS conversion. Two layers:
//  - node-neutral: tensionFromResistance (any 200SS, any node type)
//  - LSN50 profile 3 front end: parseProfile3, resistanceFromCodes, convertFrame
// Spec: docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md sections 4-5.

// v2 (#415): an unsettled reading keeps its 'unsettled' status and gets kPa.
var CONVERSION_VERSION = 'wm-lsn50-p3-v2';
var FRAME_BYTES = 27;
var FRAME_TAG = 0xA2;
var FRAME_PROFILE = 3;
var ADC_FULL = 4095;
var INVALID_CODE = 0xFFFF;
var TEMP_UNKNOWN = -32768;
var FLAG_UNSETTLED = 0x04;
var FLAGS_UNTRUSTED = 0x1B; // ADC 0x01, timing 0x02, setup 0x08, charge imbalance 0x10
var FLAGS_RESERVED = 0xC0;
var OPEN_FWD_MIN = 4087;
var OPEN_REV_MAX = 8;
var SHORT_BELOW_OHM = 300;
var SATURATED_MAX_OHM = 550;
var SOURCE_DS18B20 = 2;

var CALIBRATION_LIMITS = {
  pull: { min: 25000, max: 65000 },
  series: { min: 0, max: 500 }
};
var MIN_NORMAL = 2.2250738585072014e-308;

function tensionFromResistance(ohm, soilTempC) {
  if (typeof ohm !== 'number' || !isFinite(ohm)) return { kpa: null, status: 'invalid_sample' };
  if (typeof soilTempC !== 'number' || !isFinite(soilTempC)) return { kpa: null, status: 'temperature_missing' };
  if (soilTempC < 0 || soilTempC > 50) return { kpa: null, status: 'temperature_out_of_range' };
  if (ohm < SHORT_BELOW_OHM) return { kpa: null, status: 'short' };
  if (ohm <= SATURATED_MAX_OHM) return { kpa: 0, status: 'saturated' };
  var r = ohm / 1000;
  var td = 1 + 0.018 * (soilTempC - 24);
  var kpa;
  // IRROMETER 200SS (Shock et al. 1998), 1 kPa = 1 centibar, positive tension.
  if (ohm <= 1000) kpa = (23.156 * r - 12.736) * td;
  else if (ohm <= 8000) kpa = (3.213 * r + 4.093) / (1 - 0.009733 * r - 0.01205 * soilTempC);
  else kpa = 2.246 + 5.239 * r * td + 0.06756 * r * r * td * td;
  if (!(kpa >= 0 && kpa <= 200)) return { kpa: null, status: 'outside_200ss_range' };
  return { kpa: Math.round(kpa * 10) / 10, status: 'ok' };
}

// Largest tension any resistance in [0, ohm] can have. The 200SS relation is
// not monotonic across its 8 kOhm segment boundary at warm temperatures (at
// 50 C it drops from 93 to 73 kPa there), so the tension at the bound alone
// can understate it. Null when the bound itself is outside the sensor range.
function tensionUpperBound(ohm, soilTempC) {
  var atBound = tensionFromResistance(ohm, soilTempC).kpa;
  if (atBound === null) return null;
  if (ohm <= 8000) return atBound;
  var atSegmentEdge = tensionFromResistance(8000, soilTempC).kpa;
  return atSegmentEdge !== null && atSegmentEdge > atBound ? atSegmentEdge : atBound;
}

function word(b, i) { return (b[i] << 8) | b[i + 1]; }
function int16(v) { return v & 0x8000 ? v - 0x10000 : v; }

function parseProbe(b, offset) {
  return {
    flags: b[offset],
    fwd_early: word(b, offset + 1), fwd: word(b, offset + 3),
    rev_early: word(b, offset + 5), rev: word(b, offset + 7)
  };
}

function parseProfile3(bytes) {
  if (!bytes || bytes.length !== FRAME_BYTES) return { ok: false, reason: 'length' };
  var b = bytes;
  if (b[0] !== FRAME_TAG) return { ok: false, reason: 'tag' };
  if (b[1] !== FRAME_PROFILE) return { ok: false, reason: 'profile' };
  var status = b[8];
  if (status & 0xF0) return { ok: false, reason: 'reserved_status_bits' };
  if ((status & 0x03) === 0x03) return { ok: false, reason: 'reserved_source' };
  if ((b[9] & FLAGS_RESERVED) || (b[18] & FLAGS_RESERVED)) return { ok: false, reason: 'reserved_flag_bits' };
  var soil = int16(word(b, 4));
  var die = int16(word(b, 6));
  return {
    ok: true,
    frame: {
      tag: b[0], profile: b[1], supply_mv: word(b, 2),
      soil_temp_c: soil === TEMP_UNKNOWN ? null : soil / 100,
      soil_temp_source: status & 0x03,
      ds18b20_failed: (status & 0x04) !== 0,
      die_temp_c: die === TEMP_UNKNOWN ? null : die / 100,
      die_temp_valid: (status & 0x08) === 0,
      status_byte: status,
      probes: [parseProbe(b, 9), parseProbe(b, 18)]
    }
  };
}

// Measured soil temperature usable for conversion, or a status saying why not.
function conversionTemperature(frame) {
  var t = frame.soil_temp_c;
  if (frame.soil_temp_source !== SOURCE_DS18B20 || frame.ds18b20_failed || t === null) {
    return { value: null, status: 'temperature_missing' };
  }
  if (t < 0 || t > 50) return { value: null, status: 'temperature_out_of_range' };
  return { value: t, status: null };
}

function channelCalibration(row, channel) {
  if (!row || row.deleted_at) return null;
  var n = channel;
  var cal = {
    pullup: Number(row['pullup_' + n + '_ohm']),
    pulldown: Number(row['pulldown_' + n + '_ohm']),
    seriesFwd: Number(row['series_fwd_' + n + '_ohm']),
    seriesRev: Number(row['series_rev_' + n + '_ohm'])
  };
  return validChannelCalibration(cal) ? cal : null;
}

function inRange(v, lim) {
  return typeof v === 'number' && isFinite(v) && (v === 0 || Math.abs(v) >= MIN_NORMAL) &&
    v >= lim.min && v <= lim.max;
}

function validChannelCalibration(cal) {
  return inRange(cal.pullup, CALIBRATION_LIMITS.pull) && inRange(cal.pulldown, CALIBRATION_LIMITS.pull) &&
    inRange(cal.seriesFwd, CALIBRATION_LIMITS.series) && inRange(cal.seriesRev, CALIBRATION_LIMITS.series);
}

// Joint solve for probe resistance R and electrode offset e (spec 5.1).
// With a code at its rail the same expression is an upper bound on R.
function resistanceFromCodes(fwd, rev, cal, supplyMv) {
  var xf = fwd / ADC_FULL;
  var xr = rev / ADC_FULL;
  var af = (1 - xf) / cal.pullup;
  var ar = xr / cal.pulldown;
  var r = (xf + 1 - xr - af * cal.seriesFwd - ar * cal.seriesRev) / (af + ar);
  var e = xf - af * (r + cal.seriesFwd);
  return {
    r_fwd: xf < 1 ? cal.pullup * xf / (1 - xf) - cal.seriesFwd : null,
    r_rev: xr > 0 ? cal.pulldown * (1 - xr) / xr - cal.seriesRev : null,
    r: r,
    offset_mv: typeof supplyMv === 'number' && supplyMv > 0 ? e * supplyMv : null
  };
}

function roundTo(v, decimals) {
  if (v === null || v === undefined) return null;
  var f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function emptyChannel(status, probe) {
  return {
    flags: probe.flags, fwd_early: probe.fwd_early, fwd: probe.fwd, rev_early: probe.rev_early, rev: probe.rev,
    r_fwd: null, r_rev: null, r_solved: null, offset_mv: null, r_upper_bound: null, kpa_upper_bound: null,
    status: status, kpa: null
  };
}

function convertChannel(probe, cal, temperature, supplyMv) {
  var codes = [probe.fwd_early, probe.fwd, probe.rev_early, probe.rev];
  if ((probe.flags & FLAGS_UNTRUSTED) || codes.indexOf(INVALID_CODE) !== -1 ||
      codes.some(function (c) { return c > ADC_FULL; })) {
    return emptyChannel('invalid_sample', probe);
  }
  if (probe.fwd >= OPEN_FWD_MIN || probe.rev <= OPEN_REV_MAX) return emptyChannel('open', probe);
  if (!cal) return emptyChannel('calibration_required', probe);

  var out = emptyChannel(null, probe);
  var solved = resistanceFromCodes(probe.fwd, probe.rev, cal, supplyMv);
  out.r_fwd = roundTo(solved.r_fwd, 0);
  out.r_rev = roundTo(solved.r_rev, 0);
  out.offset_mv = roundTo(solved.offset_mv, 1);

  var clipped = probe.rev === ADC_FULL || probe.fwd === 0;
  if (clipped) {
    out.r_upper_bound = roundTo(solved.r, 0);
    if (solved.r < SHORT_BELOW_OHM) { out.status = 'short_suspected'; return out; }
    if (solved.r > SATURATED_MAX_OHM) {
      out.status = 'wet_offset_clipped';
      if (temperature.value !== null) out.kpa_upper_bound = tensionUpperBound(solved.r, temperature.value);
      return out;
    }
    // Bound within the saturated band: fall through as a saturated reading.
  } else {
    out.r_solved = roundTo(solved.r, 0);
    if (solved.r < SHORT_BELOW_OHM) { out.status = 'short'; return out; }
  }
  if (temperature.value === null) { out.status = temperature.status; return out; }
  var t = tensionFromResistance(clipped ? SATURATED_MAX_OHM : solved.r, temperature.value);
  out.status = t.status;
  out.kpa = t.kpa;
  // Unsettled (firmware flag 0x04) alone is not a fault: the value is kept and
  // the status says it was flagged (#415). Any other status above wins.
  if ((probe.flags & FLAG_UNSETTLED) && t.status === 'ok') out.status = 'unsettled';
  return out;
}

function convertFrame(frame, calibrationRow) {
  var temperature = conversionTemperature(frame);
  var channels = [1, 2].map(function (n) {
    return convertChannel(frame.probes[n - 1], channelCalibration(calibrationRow, n), temperature, frame.supply_mv);
  });
  return {
    conversion_version: CONVERSION_VERSION,
    calibration_sync_version: calibrationRow && !calibrationRow.deleted_at ? calibrationRow.sync_version : null,
    soil_temp_for_conversion_c: temperature.value,
    channels: channels
  };
}

module.exports = {
  CONVERSION_VERSION: CONVERSION_VERSION,
  CALIBRATION_LIMITS: CALIBRATION_LIMITS,
  MIN_NORMAL: MIN_NORMAL,
  tensionFromResistance: tensionFromResistance,
  tensionUpperBound: tensionUpperBound,
  parseProfile3: parseProfile3,
  resistanceFromCodes: resistanceFromCodes,
  convertChannel: convertChannel,
  convertFrame: convertFrame,
  channelCalibration: channelCalibration
};
