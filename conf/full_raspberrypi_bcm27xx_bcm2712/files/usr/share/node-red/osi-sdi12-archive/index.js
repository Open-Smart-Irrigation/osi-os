'use strict';

// Local evidence archive: never parse or round transmitted measurement text.
// Canonical telemetry remains the responsibility of osi-device-writer.
const fs = require('node:fs');
const path = require('node:path');

const MAX_ASCII = 1500;
const MAX_JSON_BYTES = 256 * 1024;
// The archive has no retention rule yet. Below this much free space on the
// database filesystem it stops inserting so it cannot fill the gateway disk.
const ARCHIVE_MIN_FREE_BYTES = 1073741824;
const DISK_WARN_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_DB_PATH = '/data/db/farming.db';
const lastDiskWarnAt = new Map();

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

// Returns true when archiving may proceed. A failing probe never stops the archive.
function hasFreeSpace(options, warn, nowMs) {
  const opts = options || {};
  const dbPath = typeof opts.dbPath === 'string' ? opts.dbPath : DEFAULT_DB_PATH;
  let freeBytes;
  try {
    const statfs = typeof opts.statfs === 'function' ? opts.statfs : fs.statfsSync;
    const stats = statfs(path.dirname(dbPath));
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < 0) throw new Error('unusable statfs result');
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

async function record(db, info, row, nowMs, loadNormalizer, warn, options) {
  if (!info || info.quarantineOnly || info.fPort !== 2
      || !info.decoded || typeof info.decoded.data_sum !== 'string') return false;
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
  const clockMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!hasFreeSpace(options, warn, clockMs)) return { archived: false, reason: 'low_disk' };
  const receivedAt = new Date(clockMs).toISOString();
  await db.run(
    'INSERT INTO sdi12_transmissions ' +
    '(deveui, recorded_at, received_at, payload_version, raw_ascii, frames_json, context_json) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [deveui, typeof info.recordedAt === 'string' ? info.recordedAt : null, receivedAt,
      Number.isInteger(info.decoded.Payver) ? info.decoded.Payver : null,
      raw, framesJson, contextJson]
  );
  return true;
}

function store(dbApi, info, row, nowMs, loadNormalizer, warn, options) {
  return dbApi.isolatedFarmingTransaction(tx => record(tx, info, row, nowMs, loadNormalizer, warn, options));
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
  const frames = info && Array.isArray(info.frames) ? info.frames : [];
  const hasOriginalBytes = frames.some(frame => frame && typeof frame === 'object'
    && frame.event && typeof frame.event === 'object' && typeof frame.event.data === 'string');
  if (info && info.fPort === 2 && (!info.decoded || typeof info.decoded.data_sum !== 'string') && hasOriginalBytes) {
    notifyNode(node, 'warn', 'SDI12 decoded payload missing data_sum');
    return notifyNode(node, 'status', {fill:'yellow',shape:'dot',text:'SDI12 decoded payload missing data_sum'});
  }
  return notifyNode(node, 'status', {fill:'grey',shape:'ring',text:'SDI12 no transmission'});
}

module.exports = { record, store, report, ARCHIVE_MIN_FREE_BYTES, resetDiskWarnings };
