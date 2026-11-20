'use strict';

// Local evidence archive: never parse or round transmitted measurement text.
// Canonical telemetry remains the responsibility of osi-device-writer.
const fs = require('node:fs');
const path = require('node:path');

const MAX_ASCII = 1500;
const MAX_JSON_BYTES = 256 * 1024;
// Both maintained profiles support 16 GB-class cards and larger media.
const MIB = 1024 ** 2;
const ARCHIVE_MIN_FREE_BYTES = 1024 * MIB;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 365 * DAY_MS;
const PRESSURE_MIN_AGE_MS = 30 * DAY_MS;
const FUTURE_TOLERANCE_MS = DAY_MS;
const EMERGENCY_FREE_BYTES = 16 * MIB;
const PRESSURE_EPISODE_CAP = 32;
const PRESSURE_KEY = 'sdi12_archive_pressure_v1';
// One bounded WAL write per tick. Each row can hold two 256 KiB JSON fields.
const RETENTION_BATCH_SIZE = 8;
const ORDERED_ROWS = 'FROM sdi12_transmissions INDEXED BY idx_sdi12_transmissions_receipt_time';
const RECEIPT_ORDER = 'ORDER BY received_at, id';
const READ_PRESSURE = 'SELECT value FROM app_settings WHERE key = ?';
const CLEAR_PRESSURE = 'DELETE FROM app_settings WHERE key = ? AND value IS ?';
const DISK_WARN_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_DB_PATH = '/data/db/farming.db';
const lastDiskWarnAt = new Map();
let maintenanceRunning = false;

function warnClassification(warn, message) {
  if (typeof warn !== 'function') return false;
  try {
    warn(message);
    return true;
  } catch (error) {
    // A diagnostic callback must not prevent the archive commit.
    return false;
  }
}

function resetDiskWarnings() {
  lastDiskWarnAt.clear();
}

function warnDiskOncePerHour(kind, warn, message, nowMs) {
  const last = lastDiskWarnAt.get(kind);
  if (last !== undefined && nowMs - last < DISK_WARN_INTERVAL_MS) return false;
  lastDiskWarnAt.set(kind, nowMs);
  return warnClassification(warn, message);
}

function filesystemFreeBytes(dbPath, statfs) {
  const { bavail, bsize } = statfs(path.dirname(dbPath));
  const bytes = Number(bavail) * Number(bsize);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !(bsize > 0)) throw new Error('unusable statfs result');
  return bytes;
}

// Returns true when archiving may proceed. A failing probe never stops the archive.
function hasFreeSpace(options, warn, nowMs) {
  const opts = options || {};
  const dbPath = typeof opts.dbPath === 'string' ? opts.dbPath : DEFAULT_DB_PATH;
  let freeBytes;
  try {
    const statfs = typeof opts.statfs === 'function' ? opts.statfs : fs.statfsSync;
    freeBytes = filesystemFreeBytes(dbPath, statfs);
  } catch (error) {
    warnDiskOncePerHour('probe', warn,
      'SDI12 archive disk probe failed: ' + String(error && error.message ? error.message : error), nowMs);
    return true;
  }
  if (freeBytes >= ARCHIVE_MIN_FREE_BYTES) return true;
  warnDiskOncePerHour('low_disk', warn,
    'SDI12 archive skipped: free disk ' + freeBytes + ' bytes is below ' + ARCHIVE_MIN_FREE_BYTES, nowMs);
  return false;
}

function classifyNormalization(config, loadNormalizer, warn) {
  if (config.sdi12_probe_profile !== 'SENTEK_ENVIROSCAN' || typeof loadNormalizer !== 'function') return null;
  try {
    const loaded = loadNormalizer();
    if (!loaded || loaded.ok !== true) {
      warnClassification(warn, 'SDI12 layout classification failed: normalizer unavailable');
      return null;
    }
    if (!loaded.value || typeof loaded.value.validateSentekLayout !== 'function') {
      warnClassification(warn, 'SDI12 layout classification failed: validator unavailable');
      return null;
    }
    const validation = loaded.value.validateSentekLayout(config.sdi12_channel_layout_json);
    return validation && validation.ok === true && validation.hasTriScan === true ? 'sentek_mixed_v1' : null;
  } catch (error) {
    warnClassification(warn, 'SDI12 layout classification failed: ' + String(error && error.message ? error.message : error));
    return null;
  }
}

function receiptClock(now, clock) {
  const { clockStatus, readRuntimeClock } = require('../osi-irrigation-policy/clock');
  return clockStatus({ ...(clock || readRuntimeClock)(), now });
}

async function capture(info, nowMs, warn, options, save) {
  if (!info || info.quarantineOnly || info.fPort !== 2
      || !info.decoded || typeof info.decoded.data_sum !== 'string') return false;
  const clockMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const time = receiptClock(clockMs, options?.clock);
  if (!time.trusted) {
    warnDiskOncePerHour('capture_clock', warn, 'SDI12 archive skipped: untrusted clock (' + time.reason + ')', performance.now());
    return { archived: false, reason: 'untrusted_clock' };
  }
  if (!hasFreeSpace(options, warn, clockMs)) return { archived: false, reason: 'low_disk' };
  return save(new Date(clockMs).toISOString());
}

async function insertRecord(db, info, row, receivedAt, loadNormalizer, warn) {
  const deveui = String(info.deveui || '').trim().toUpperCase();
  if (!deveui) throw new Error('SDI12 archive requires a device identity');
  const raw = info.decoded.data_sum;
  if (raw.length > MAX_ASCII) throw new Error('SDI12 archive ASCII exceeds 1500 characters');
  const frames = info.frames || [];
  if (!Array.isArray(frames) || frames.length > 15) throw new Error('SDI12 archive invalid frame list');
  const config = row || {};
  const normalization = classifyNormalization(config, loadNormalizer, warn);
  const context = {
    version: 1,
    probeProfile: config.sdi12_probe_profile ?? null,
    probeStatus: config.sdi12_probe_status ?? null,
    probeIdentity: config.sdi12_identity ?? null,
    channelLayout: config.sdi12_channel_layout_json ?? null,
    depths: config.soil_moisture_probe_depths_json ?? null,
    depthsConfigured: config.soil_moisture_probe_depths_configured ?? null,
    deploymentStatus: config.sdi12_deployment_status ?? null,
    valueCount: config.sdi12_value_count ?? null,
    deploymentDesiredVersion: config.sdi12_deployment_desired_version ?? null,
    deploymentDesiredLayoutHash: config.sdi12_deployment_desired_layout_hash ?? null,
    compatibleLayout: config.sdi12_deployment_compatible_layout_json ?? null,
    compatibleRecipe: config.sdi12_deployment_compatible_recipe_json ?? null,
    compatibleAt: config.sdi12_deployment_compatible_at ?? null,
    normalization,
    profileFamily: config.sdi12_probe_profile === 'SENTEK_ENVIROSCAN' ? 'sentek_v1' : null
  };
  const framesJson = JSON.stringify(frames);
  const contextJson = JSON.stringify(context);
  if (Buffer.byteLength(framesJson) > MAX_JSON_BYTES || Buffer.byteLength(contextJson) > MAX_JSON_BYTES) {
    throw new Error('SDI12 archive JSON exceeds 256 KiB');
  }
  const uplinkKey = require('../osi-uplink-dedup-guard/durable').sdi12Key(info);
  await db.run(
    'INSERT INTO sdi12_transmissions ' +
    '(deveui, recorded_at, received_at, payload_version, raw_ascii, frames_json, context_json' + (uplinkKey ? ', uplink_key' : '') + ') ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?' + (uplinkKey ? ', ?' : '') + ')'
      + (uplinkKey ? ' ON CONFLICT(deveui, uplink_key) WHERE uplink_key IS NOT NULL DO NOTHING' : ''),
    [deveui, typeof info.recordedAt === 'string' ? info.recordedAt : null, receivedAt,
      Number.isInteger(info.decoded.Payver) ? info.decoded.Payver : null,
      raw, framesJson, contextJson].concat(uplinkKey ? [uplinkKey] : [])
  );
  return true;
}

function record(db, info, row, nowMs, loadNormalizer, warn, options) {
  return capture(info, nowMs, warn, options, receivedAt => insertRecord(db, info, row, receivedAt, loadNormalizer, warn));
}

function store(dbApi, info, row, nowMs, loadNormalizer, warn, options) {
  return capture(info, nowMs, warn, options, receivedAt =>
    dbApi.isolatedFarmingTransaction(tx => insertRecord(tx, info, row, receivedAt, loadNormalizer, warn)));
}

function notifyNode(node, method, value) {
  if (!node || typeof node[method] !== 'function') return false;
  try {
    node[method](value);
    return true;
  } catch (error) {
    // Status rendering is best-effort after the durable archive write.
    return false;
  }
}

function report(node, info, saved) {
  if (!node || typeof node.status !== 'function') return false;
  if (saved === true) {
    return notifyNode(node, 'status', {fill:'green',shape:'dot',text:'SDI12 transmission archived'});
  }
  if (saved && saved.reason === 'low_disk') {
    return notifyNode(node, 'status', {fill:'yellow',shape:'dot',text:'SDI12 archive skipped: low disk'});
  }
  if (saved && saved.reason === 'untrusted_clock') {
    return notifyNode(node, 'status', {fill:'yellow',shape:'dot',text:'SDI12 archive skipped: untrusted clock'});
  }
  const frames = info && Array.isArray(info.frames) ? info.frames : [];
  const hasOriginalBytes = frames.some(frame => frame && typeof frame === 'object'
    && frame.event && typeof frame.event === 'object' && typeof frame.event.data === 'string');
  if (info && info.fPort === 2 && (!info.decoded || typeof info.decoded.data_sum !== 'string') && hasOriginalBytes) {
    notifyNode(node, 'warn', 'SDI12 decoded payload missing data_sum');
    return notifyNode(node, 'status', {fill:'yellow',shape:'dot',text:'SDI12 decoded payload missing data_sum'});
  }
  return notifyNode(node, 'status', {fill:'grey',shape:'ring',text:'SDI12 no transmission'});
}

function openMaintenanceDb(dbApi) {
  return new Promise((resolve, reject) => {
    const db = dbApi.openNativeFarming(dbApi.OPEN_READWRITE, error => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function query(db, method, sql, params = []) {
  return new Promise((resolve, reject) => {
    db[method](sql, params, function onQuery(error, row) {
      if (error) reject(error);
      else resolve(method === 'run' ? this.changes : row);
    });
  });
}

function deleteBatch(db, where, cutoff, limit = RETENTION_BATCH_SIZE) {
  return query(db, 'run', `DELETE FROM sdi12_transmissions WHERE id IN (
    SELECT id ${ORDERED_ROWS} ${where} ${RECEIPT_ORDER} LIMIT ?
  )`, [cutoff, limit]);
}

async function reusableBytes(db) {
  const { freelist_count: pages } = await query(db, 'get', 'PRAGMA freelist_count');
  const { page_size: bytes } = await query(db, 'get', 'PRAGMA page_size');
  return pages * bytes;
}

async function readPressureState(db) {
  const row = await query(db, 'get', READ_PRESSURE, [PRESSURE_KEY]);
  if (!row) return { deleted: 0, freeBytes: 0 };
  const state = JSON.parse(row.value);
  if (!state || !Number.isSafeInteger(state.deleted) || state.deleted < 1 || state.deleted > PRESSURE_EPISODE_CAP
      || !Number.isSafeInteger(state.freeBytes) || state.freeBytes < EMERGENCY_FREE_BYTES
      || state.freeBytes >= ARCHIVE_MIN_FREE_BYTES) {
    throw new Error('invalid SDI12 archive pressure state');
  }
  return state;
}

function pressureStop(state, freeBytes) {
  if (state.deleted >= PRESSURE_EPISODE_CAP) return 'pressure_cap';
  if (freeBytes <= state.freeBytes) return 'pressure_stalled';
  return null;
}

async function deleteUnderPressure(db, cutoff, freeBytes) {
  await query(db, 'run', 'BEGIN IMMEDIATE');
  try {
    // Re-read under the write lock. The batch and the episode receipt must
    // commit together, including if Node-RED stops before the second statfs.
    const state = await readPressureState(db);
    const stopped = pressureStop(state, freeBytes);
    if (stopped) {
      await query(db, 'run', 'COMMIT');
      return { reason: stopped, deleted: 0 };
    }
    const limit = Math.min(RETENTION_BATCH_SIZE, PRESSURE_EPISODE_CAP - state.deleted);
    const deleted = await deleteBatch(db, 'WHERE received_at <= ?', cutoff, limit);
    const total = state.deleted + deleted;
    if (deleted) {
      await query(db, 'run', `INSERT INTO app_settings(key, value, updated_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [PRESSURE_KEY, JSON.stringify({ deleted: total, freeBytes })]);
    }
    await query(db, 'run', 'COMMIT');
    return { reason: deleted ? 'pressure' : 'pressure_protected', deleted, total };
  } catch (error) {
    try {
      await query(db, 'run', 'ROLLBACK');
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

async function prunePressure(db, cutoff, statFree, freeBytes) {
  const state = await readPressureState(db);
  const stopped = pressureStop(state, freeBytes);
  if (stopped) return { reason: stopped, deleted: 0, freeBytes, reusableBytes: await reusableBytes(db) };
  const eligible = await query(db, 'get', `SELECT id ${ORDERED_ROWS} WHERE received_at <= ? LIMIT 1`, [cutoff]);
  if (!eligible) {
    const any = await query(db, 'get', `SELECT id ${ORDERED_ROWS} LIMIT 1`);
    return { reason: any ? 'pressure_protected' : 'pressure_empty', deleted: 0, freeBytes, reusableBytes: await reusableBytes(db) };
  }

  const { reason, deleted, total } = await deleteUnderPressure(db, cutoff, freeBytes);
  const reusable = await reusableBytes(db);
  if (!deleted) return { reason, deleted, freeBytes, reusableBytes: reusable };
  let afterFree;
  try {
    afterFree = statFree();
  } catch (error) {
    return { reason: 'pressure_stalled', deleted, freeBytes, reusableBytes: reusable, detail: error.message };
  }
  const episode = { deleted: total, freeBytes };
  if (afterFree >= ARCHIVE_MIN_FREE_BYTES) {
    await query(db, 'run', CLEAR_PRESSURE, [PRESSURE_KEY, JSON.stringify(episode)]);
    return { reason: 'pressure', deleted, freeBytes: afterFree, reusableBytes: reusable };
  }
  const afterReason = pressureStop(episode, afterFree) || 'pressure';
  return { reason: afterReason, deleted, freeBytes: afterFree, reusableBytes: reusable };
}

async function prune(db, now, statFree, freeBytes) {
  if (freeBytes >= ARCHIVE_MIN_FREE_BYTES) {
    const prior = await query(db, 'get', READ_PRESSURE, [PRESSURE_KEY]);
    if (prior) {
      await query(db, 'run', CLEAR_PRESSURE, [PRESSURE_KEY, prior.value]);
    }
  }
  for (const [where, boundary, reason] of [
    ['WHERE received_at <= ?', now - RETENTION_MS, 'expired'],
    ['WHERE received_at > ?', now + FUTURE_TOLERANCE_MS, 'future_outlier'],
  ]) {
    const cutoff = new Date(boundary).toISOString();
    const row = await query(db, 'get', `SELECT id ${ORDERED_ROWS} ${where} LIMIT 1`, [cutoff]);
    if (row) return { reason, deleted: await deleteBatch(db, where, cutoff), freeBytes };
  }
  if (freeBytes >= ARCHIVE_MIN_FREE_BYTES) return { reason: 'idle', deleted: 0 };
  return prunePressure(db, new Date(now - PRESSURE_MIN_AGE_MS).toISOString(), statFree, freeBytes);
}

async function maintain(dbApi, {
  now = Date.now(), clock, statfs = fs.statfsSync, dbPath = DEFAULT_DB_PATH,
} = {}) {
  // Use the boot's last successful NTP sample and elapsed uptime. A wall-clock
  // step can otherwise make a recent archive look a year old.
  const time = receiptClock(now, clock);
  if (!time.trusted) return { reason: time.reason, deleted: 0 };
  const statFree = () => filesystemFreeBytes(dbPath, statfs);
  let freeBytes;
  try {
    freeBytes = statFree();
  } catch (error) {
    return { reason: 'disk_probe_failed', deleted: 0, detail: error.message };
  }
  if (freeBytes < EMERGENCY_FREE_BYTES) return { reason: 'disk_critical', deleted: 0, freeBytes };

  let db;
  try {
    db = await openMaintenanceDb(dbApi);
    await query(db, 'get', 'PRAGMA busy_timeout=0');
    // The regular writers checkpoint. Maintenance leaves checkpoint work off
    // its short write path and yields immediately if a writer has the lock.
    await query(db, 'get', 'PRAGMA wal_autocheckpoint=0');
    await query(db, 'get', 'PRAGMA synchronous=NORMAL');
    return await prune(db, now, statFree, freeBytes);
  } catch (error) {
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') return { reason: 'busy', deleted: 0 };
    throw error;
  } finally {
    if (db) await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }
}

async function liveMaintain({ node, osiLib }) {
  if (maintenanceRunning) return null;
  maintenanceRunning = true;
  try {
    const loaded = osiLib.require('osi-db-helper');
    if (!loaded.ok) throw new Error(loaded.error);
    const result = await maintain(loaded.value);
    const lowDisk = result.freeBytes < ARCHIVE_MIN_FREE_BYTES;
    const healthy = !lowDisk && ['idle', 'expired', 'future_outlier', 'pressure'].includes(result.reason);
    const blocked = ['pressure_cap', 'pressure_stalled', 'pressure_protected', 'pressure_empty'].includes(result.reason);
    const status = blocked ? 'SDI12 archive cannot recover space' : 'SDI12 retention';
    const text = `${status}: ${result.reason} (${result.deleted} removed)`;
    notifyNode(node, 'status', { fill: healthy ? 'green' : 'yellow', shape: 'dot', text });
    if (!healthy && result.reason !== 'busy') {
      const storage = lowDisk ? `, filesystem free ${result.freeBytes} bytes, SQLite reusable ${result.reusableBytes ?? 'unknown'} bytes` : '';
      warnDiskOncePerHour(`maintenance:${result.reason}`, message => node.warn(message),
        text + storage + (result.detail ? `: ${result.detail}` : ''), performance.now());
    }
  } catch (error) {
    node.error('SDI12 retention failed: ' + error.message);
  } finally {
    maintenanceRunning = false;
  }
  return null;
}

module.exports = { record, store, report, maintain, liveMaintain, ARCHIVE_MIN_FREE_BYTES, resetDiskWarnings };
