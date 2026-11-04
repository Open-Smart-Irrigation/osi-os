'use strict';

const fsDefault = require('node:fs');
const { parseInstant } = require('./timestamps');

const stickyFailures = new Map();

function markerSignature(marker) {
  if (!marker || typeof marker !== 'object') return null;
  return [marker.boot_id, marker.epoch_ms, marker.uptime_ms, marker.stratum].join('|');
}

function parseBound(value) {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : parseInstant(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function clockStatus({ bootId, marker, uptime, now = Date.now(), lastDue, latestSample } = {}) {
  if (!marker || typeof marker !== 'object') return { trusted: false, reason: 'clock_untrusted_missing_marker' };
  if (!bootId || marker.boot_id !== bootId) return { trusted: false, reason: 'clock_untrusted_boot' };
  if (typeof marker.boot_id !== 'string' || !marker.boot_id || !Number.isInteger(marker.epoch_ms) || !Number.isInteger(marker.uptime_ms) || !Number.isInteger(marker.stratum) || marker.stratum < 1 || marker.stratum > 15) {
    return { trusted: false, reason: 'clock_untrusted_marker' };
  }
  const runtimeNow = now instanceof Date ? now.getTime() : now;
  const runtimeUptime = uptime instanceof Date ? uptime.getTime() : uptime;
  if (!Number.isFinite(runtimeUptime) || !Number.isFinite(runtimeNow)) return { trusted: false, reason: 'clock_untrusted_runtime' };
  const wallElapsed = runtimeNow - marker.epoch_ms;
  const uptimeElapsed = runtimeUptime - marker.uptime_ms;
  if (wallElapsed < 0) return { trusted: false, reason: 'clock_untrusted_backward' };
  if (uptimeElapsed < 0 || Math.abs(wallElapsed - uptimeElapsed) > 5000) {
    return { trusted: false, reason: 'clock_untrusted_jump' };
  }
  const due = parseBound(lastDue); const sample = parseBound(latestSample);
  if (Number.isNaN(due) || Number.isNaN(sample)) return { trusted: false, reason: 'clock_untrusted_lower_bound' };
  if (due != null && runtimeNow < due || sample != null && runtimeNow < sample) return { trusted: false, reason: 'clock_untrusted_lower_bound' };
  return { trusted: true, reason: 'trusted' };
}

// /proc/uptime prints seconds with two decimals. Multiplying the parsed float
// does not give whole milliseconds (parseFloat('2.01') * 1000 is
// 2009.9999999999998), and the dispatcher only accepts an integer receipt, so
// the decimal digits are converted directly. Up to three fractional digits are
// exact and keep reading order; any other token leaves uptime untrusted (null).
const UPTIME_SECONDS = /^(\d+)(?:\.(\d{1,3}))?$/;

function uptimeMilliseconds(token) {
  const match = UPTIME_SECONDS.exec(token);
  if (!match) return null;
  const ms = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
  return Number.isSafeInteger(ms) ? ms : null;
}

function readRuntimeClock({ fs = fsDefault, bootPath = '/proc/sys/kernel/random/boot_id', uptimePath = '/proc/uptime', markerPath = '/var/run/osi-irrigation-clock.json' } = {}) {
  let bootId = null; let uptime = null; let marker = null;
  try { bootId = fs.readFileSync(bootPath, 'utf8').trim() || null; } catch (_) { /* untrusted */ }
  try { uptime = uptimeMilliseconds(fs.readFileSync(uptimePath, 'utf8').trim().split(/\s+/)[0]); } catch (_) { /* untrusted */ }
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_) { /* untrusted */ }
  return { bootId, uptime, marker };
}

function validRejection(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.boot_id === 'string' && value.boot_id.length > 0
    && typeof value.marker === 'string' && value.marker.length > 0
    && (value.reason === 'clock_untrusted_backward' || value.reason === 'clock_untrusted_jump');
}

function readRejection(fs, rejectionPath) {
  try {
    const value = JSON.parse(fs.readFileSync(rejectionPath, 'utf8'));
    return validRejection(value) ? { value } : { error: new Error('malformed rejection') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { value: null };
    return { error };
  }
}

function readDurableRejection(fs, rejectionPath, fallbackPath) {
  const primary = readRejection(fs, rejectionPath);
  const fallback = fallbackPath === rejectionPath ? { value: null } : readRejection(fs, fallbackPath);
  if (primary.error || fallback.error) return { __error: primary.error || fallback.error };
  return [primary.value, fallback.value].filter(Boolean);
}

function writeRejection(fs, rejectionPath, value) {
  const directory = require('node:path').dirname(rejectionPath);
  const temporary = `${rejectionPath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, rejectionPath);
    return true;
  } catch (_) {
    try { fs.unlinkSync(temporary); } catch (_) { /* best effort cleanup */ }
    return false;
  }
}

function persistRejection(fs, rejectionPath, fallbackPath, value) {
  if (writeRejection(fs, rejectionPath, value)) return 'primary';
  if (fallbackPath !== rejectionPath && writeRejection(fs, fallbackPath, value)) return 'fallback';
  return null;
}

function clearRejection(fs, rejectionPath) {
  try { fs.unlinkSync(rejectionPath); return true; } catch (error) { return error && error.code === 'ENOENT'; }
}

function clearDurableRejection(fs, rejectionPath, fallbackPath) {
  return clearRejection(fs, rejectionPath) && (fallbackPath === rejectionPath || clearRejection(fs, fallbackPath));
}

// Task 6 must call this gate immediately before creating a decision, writing a
// missed-start audit, or dispatching. It persists actual wall-clock jumps under
// the boot-scoped rejection path; missing marker, procfs, or persistence IO is
// always untrusted. A fresh valid stratum marker clears both rejection records.
function runtimeClockStatus(options = {}) {
  const fs = options.fs || fsDefault;
  const runtime = readRuntimeClock(options);
  const bootId = options.bootId === undefined ? runtime.bootId : options.bootId;
  const uptime = options.uptime === undefined ? runtime.uptime : options.uptime;
  const marker = options.marker === undefined ? runtime.marker : options.marker;
  const markerPath = options.markerPath || '/var/run/osi-irrigation-clock.json';
  const rejectionPath = options.rejectionPath || '/var/run/osi-irrigation-clock-rejection.json';
  const fallbackPath = options.fallbackPath || `${markerPath}.rejected.json`;
  const signature = markerSignature(marker);
  const stickyKey = `${rejectionPath}|${fallbackPath}`;
  const sticky = stickyFailures.get(stickyKey);
  if (sticky && sticky.kind === 'rejection') {
    const record = sticky.record;
    if (record.boot_id === bootId && record.marker === signature) {
      const persisted = persistRejection(fs, rejectionPath, fallbackPath, record);
      if (!persisted) return { trusted: false, reason: 'clock_untrusted_persistence' };
      const retried = readDurableRejection(fs, rejectionPath, fallbackPath);
      if (retried.__error || !retried.some((entry) => entry.boot_id === bootId && entry.marker === signature)) {
        return { trusted: false, reason: 'clock_untrusted_persistence' };
      }
      stickyFailures.delete(stickyKey);
      return { trusted: false, reason: 'clock_untrusted_invalidated' };
    }
    const persisted = persistRejection(fs, rejectionPath, fallbackPath, record);
    if (!persisted || !clearDurableRejection(fs, rejectionPath, fallbackPath)) {
      return { trusted: false, reason: 'clock_untrusted_persistence' };
    }
    stickyFailures.delete(stickyKey);
  } else if (sticky && sticky.kind === 'cleanup') {
    const durable = readDurableRejection(fs, rejectionPath, fallbackPath);
    if (durable.__error || !clearDurableRejection(fs, rejectionPath, fallbackPath)) {
      return { trusted: false, reason: 'clock_untrusted_persistence' };
    }
    stickyFailures.delete(stickyKey);
  }
  const rejection = readDurableRejection(fs, rejectionPath, fallbackPath);
  if (rejection.__error) return { trusted: false, reason: 'clock_untrusted_persistence' };
  if (rejection.some((record) => record.boot_id === bootId && record.marker === signature)) {
    return { trusted: false, reason: 'clock_untrusted_invalidated' };
  }
  const status = clockStatus({ ...options, bootId, uptime, marker });
  if (status.trusted) {
    if (rejection.length && !clearDurableRejection(fs, rejectionPath, fallbackPath)) {
      stickyFailures.set(stickyKey, { kind: 'cleanup', boot_id: bootId, marker: signature });
      return { trusted: false, reason: 'clock_untrusted_persistence' };
    }
    return status;
  }
  if (status.reason === 'clock_untrusted_backward' || status.reason === 'clock_untrusted_jump') {
    const record = { boot_id: bootId, marker: signature, reason: status.reason };
    const persisted = persistRejection(fs, rejectionPath, fallbackPath, record);
    if (!persisted) {
      stickyFailures.set(stickyKey, { kind: 'rejection', record });
      return { trusted: false, reason: 'clock_untrusted_persistence' };
    }
    if (persisted === 'fallback') return { trusted: false, reason: 'clock_untrusted_persistence' };
  }
  return status;
}

// Owner decision 2026-10-24: gateway-originated opens (schedules, manual, conditional, ONCE) no
// longer require an NTP sync since boot. The open paths use this status: the marker-based
// runtimeClockStatus is computed for display and diagnostics only (diagnostic), and the only
// refusal left is a clock behind data the gateway already holds (lower bound: the last decided
// due time or the newest sample), which would re-decide the past.
function openClockStatus(options = {}) {
  let diagnostic;
  try { diagnostic = runtimeClockStatus(options); } catch (error) { diagnostic = { trusted: false, reason: 'clock_untrusted_runtime' }; }
  const now = options.now instanceof Date ? options.now.getTime() : (options.now == null ? Date.now() : options.now);
  const due = parseBound(options.lastDue);
  const sample = parseBound(options.latestSample);
  if (!Number.isFinite(now) || Number.isNaN(due) || Number.isNaN(sample)) return { trusted: false, reason: 'clock_untrusted_lower_bound', diagnostic };
  if ((due != null && now < due) || (sample != null && now < sample)) return { trusted: false, reason: 'clock_untrusted_lower_bound', diagnostic };
  return { trusted: true, reason: diagnostic && diagnostic.trusted === true ? 'trusted' : 'ntp_not_required', diagnostic };
}

module.exports = { clockStatus, runtimeClockStatus, openClockStatus, readRuntimeClock };
