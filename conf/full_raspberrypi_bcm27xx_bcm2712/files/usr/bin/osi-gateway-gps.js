#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { createRequire } = require('module');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DB_PATH = '/data/db/farming.db';
const CACHE_PATH = '/data/db/gateway-location-cache.json';
const CHIRPSTACK_ENV_PATH = '/srv/node-red/.chirpstack.env';
const NODE_RED_PACKAGE_PATH = '/usr/share/node-red/package.json';
const CHIRPSTACK_HELPER_PATH = '/usr/share/node-red/osi-chirpstack-helper';
const GATEWAY_IDENTITY_HELPER_PATH = '/usr/libexec/osi-gateway-identity.sh';

function log(message) {
  process.stdout.write(`[osi-gateway-gps] ${new Date().toISOString()} ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[osi-gateway-gps] ${new Date().toISOString()} ${message}\n`);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uciGet(key, fallback = '') {
  try {
    return execFileSync('uci', ['-q', 'get', key], { encoding: 'utf8' }).trim() || fallback;
  } catch (_) {
    return fallback;
  }
}

function uciShow(configName) {
  try {
    return execFileSync('uci', ['-q', 'show', configName], { encoding: 'utf8' });
  } catch (_) {
    return '';
  }
}

function uciSet(key, value) {
  execFileSync('uci', ['set', `${key}=${value}`], { stdio: 'pipe' });
}

function uciAddList(key, value) {
  execFileSync('uci', ['add_list', `${key}=${value}`], { stdio: 'pipe' });
}

function uciCommit(configName) {
  execFileSync('uci', ['commit', configName], { stdio: 'pipe' });
}

function restartService(name) {
  try {
    execFileSync(`/etc/init.d/${name}`, ['restart'], { stdio: 'pipe' });
  } catch (error) {
    warn(`failed to restart ${name}: ${error.message}`);
  }
}

function sqlEscape(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function sqlValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  return `'${sqlEscape(value)}'`;
}

function sqliteExec(sql) {
  execFileSync('sqlite3', [DB_PATH, sql], { stdio: 'pipe' });
}

function sqliteQuery(sql) {
  const output = execFileSync('sqlite3', ['-json', DB_PATH, sql], { encoding: 'utf8', stdio: 'pipe' }).trim();
  return output ? JSON.parse(output) : [];
}

function ensureSchema() {
  sqliteExec([
    'CREATE TABLE IF NOT EXISTS gateway_locations(',
    '  gateway_device_eui TEXT PRIMARY KEY,',
    '  latitude REAL,',
    '  longitude REAL,',
    '  altitude_m REAL,',
    '  accuracy_m REAL,',
    '  hdop REAL,',
    '  satellites INTEGER,',
    '  fix_mode INTEGER,',
    "  status TEXT NOT NULL DEFAULT 'no_fix',",
    "  source TEXT NOT NULL DEFAULT 'gpsd',",
    '  native_concentratord_status TEXT,',
    '  chirpstack_mirror_status TEXT,',
    '  last_fix_at TEXT,',
    '  last_good_fix_at TEXT,',
    '  sync_version INTEGER NOT NULL DEFAULT 0,',
    '  updated_at TEXT NOT NULL',
    ')'
  ].join(' '));
}

function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}

function parseShellKeyValueOutput(rawOutput) {
  const parsed = {};
  for (const line of String(rawOutput || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    parsed[trimmed.slice(0, equals)] = trimmed.slice(equals + 1);
  }
  return parsed;
}

function resolveGatewayIdentity() {
  try {
    const output = execFileSync('sh', [GATEWAY_IDENTITY_HELPER_PATH, 'resolve'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const parsed = parseShellKeyValueOutput(output);
    const deviceEui = normalizeGatewayDeviceEui(parsed.DEVICE_EUI || '');
    if (deviceEui) {
      return {
        deviceEui,
        source: String(parsed.DEVICE_EUI_SOURCE || '').trim() || 'helper',
        confidence: String(parsed.DEVICE_EUI_CONFIDENCE || '').trim().toLowerCase() || 'persisted',
        lastVerifiedAt: String(parsed.DEVICE_EUI_LAST_VERIFIED_AT || '').trim() || null
      };
    }
  } catch (_) {}

  const fromEnv = normalizeGatewayDeviceEui(process.env.DEVICE_EUI || '');
  if (fromEnv) {
    return {
      deviceEui: fromEnv,
      source: String(process.env.DEVICE_EUI_SOURCE || '').trim() || 'env',
      confidence: String(process.env.DEVICE_EUI_CONFIDENCE || '').trim().toLowerCase() || 'persisted',
      lastVerifiedAt: String(process.env.DEVICE_EUI_LAST_VERIFIED_AT || '').trim() || null
    };
  }

  const fromCloud = normalizeGatewayDeviceEui(uciGet('osi-server.cloud.device_eui', ''));
  if (fromCloud) {
    return {
      deviceEui: fromCloud,
      source: String(uciGet('osi-server.cloud.device_eui_source', '')).trim() || 'persisted',
      confidence: String(uciGet('osi-server.cloud.device_eui_confidence', '')).trim().toLowerCase() || 'persisted',
      lastVerifiedAt: String(uciGet('osi-server.cloud.device_eui_last_verified_at', '')).trim() || null
    };
  }

  return {
    deviceEui: 'UNKNOWN',
    source: 'unknown',
    confidence: 'provisional',
    lastVerifiedAt: null
  };
}

function readCurrentSnapshot(gatewayDeviceEui) {
  const rows = sqliteQuery([
    'SELECT json_object(',
    "  'gatewayDeviceEui', gateway_device_eui,",
    "  'latitude', latitude,",
    "  'longitude', longitude,",
    "  'altitudeM', altitude_m,",
    "  'accuracyM', accuracy_m,",
    "  'hdop', hdop,",
    "  'sats', satellites,",
    "  'fixMode', fix_mode,",
    "  'status', status,",
    "  'source', source,",
    "  'nativeConcentratordStatus', native_concentratord_status,",
    "  'chirpstackMirrorStatus', chirpstack_mirror_status,",
    "  'lastFixAt', last_fix_at,",
    "  'lastGoodFixAt', last_good_fix_at,",
    "  'syncVersion', sync_version,",
    "  'updatedAt', updated_at",
    ') AS payload ',
    'FROM gateway_locations ',
    `WHERE gateway_device_eui = '${sqlEscape(gatewayDeviceEui)}' `,
    'LIMIT 1'
  ].join(''));
  if (!rows.length || !rows[0].payload) return null;
  return JSON.parse(rows[0].payload);
}

function persistSnapshot(previous, snapshot, bumpSyncVersion) {
  const nextSyncVersion = bumpSyncVersion
    ? Number(previous?.syncVersion || 0) + 1
    : Number(previous?.syncVersion || 0);
  sqliteExec([
    'INSERT INTO gateway_locations(',
    'gateway_device_eui, latitude, longitude, altitude_m, accuracy_m, hdop, satellites, fix_mode,',
    'status, source, native_concentratord_status, chirpstack_mirror_status, last_fix_at, last_good_fix_at, sync_version, updated_at',
    ') VALUES (',
    [
      sqlValue(snapshot.gatewayDeviceEui),
      sqlValue(snapshot.latitude),
      sqlValue(snapshot.longitude),
      sqlValue(snapshot.altitudeM),
      sqlValue(snapshot.accuracyM),
      sqlValue(snapshot.hdop),
      sqlValue(snapshot.sats),
      sqlValue(snapshot.fixMode),
      sqlValue(snapshot.status),
      sqlValue(snapshot.source || 'gpsd'),
      sqlValue(snapshot.nativeConcentratordStatus),
      sqlValue(snapshot.chirpstackMirrorStatus),
      sqlValue(snapshot.lastFixAt),
      sqlValue(snapshot.lastGoodFixAt),
      sqlValue(nextSyncVersion),
      sqlValue(snapshot.updatedAt)
    ].join(', '),
    ') ON CONFLICT(gateway_device_eui) DO UPDATE SET ',
    [
      `latitude = ${sqlValue(snapshot.latitude)}`,
      `longitude = ${sqlValue(snapshot.longitude)}`,
      `altitude_m = ${sqlValue(snapshot.altitudeM)}`,
      `accuracy_m = ${sqlValue(snapshot.accuracyM)}`,
      `hdop = ${sqlValue(snapshot.hdop)}`,
      `satellites = ${sqlValue(snapshot.sats)}`,
      `fix_mode = ${sqlValue(snapshot.fixMode)}`,
      `status = ${sqlValue(snapshot.status)}`,
      `source = ${sqlValue(snapshot.source || 'gpsd')}`,
      `native_concentratord_status = ${sqlValue(snapshot.nativeConcentratordStatus)}`,
      `chirpstack_mirror_status = ${sqlValue(snapshot.chirpstackMirrorStatus)}`,
      `last_fix_at = ${sqlValue(snapshot.lastFixAt)}`,
      `last_good_fix_at = ${sqlValue(snapshot.lastGoodFixAt)}`,
      `sync_version = ${sqlValue(nextSyncVersion)}`,
      `updated_at = ${sqlValue(snapshot.updatedAt)}`
    ].join(', ')
  ].join(''));
  return nextSyncVersion;
}

function deleteGatewaySnapshot(gatewayDeviceEui) {
  if (!gatewayDeviceEui || gatewayDeviceEui === 'UNKNOWN') return;
  try {
    sqliteExec(`DELETE FROM gateway_locations WHERE gateway_device_eui = ${sqlValue(gatewayDeviceEui)}`);
  } catch (_) {}
}

function clearPendingGatewayLocationOutbox(gatewayDeviceEui) {
  if (!gatewayDeviceEui || gatewayDeviceEui === 'UNKNOWN') return;
  try {
    sqliteExec([
      'DELETE FROM sync_outbox',
      "WHERE delivered_at IS NULL",
      "  AND aggregate_type = 'GATEWAY_LOCATION'",
      `  AND (gateway_device_eui = ${sqlValue(gatewayDeviceEui)} OR aggregate_key = ${sqlValue(gatewayDeviceEui)})`
    ].join(' '));
  } catch (_) {}
}

function migrateGatewayState(previousGatewayDeviceEui, nextGatewayDeviceEui, state) {
  if (!previousGatewayDeviceEui || !nextGatewayDeviceEui || previousGatewayDeviceEui === nextGatewayDeviceEui) {
    return null;
  }
  const oldSnapshot = readCurrentSnapshot(previousGatewayDeviceEui)
    || ((state.snapshot && state.snapshot.gatewayDeviceEui === previousGatewayDeviceEui) ? state.snapshot : null);
  const existingNextSnapshot = readCurrentSnapshot(nextGatewayDeviceEui);
  let migratedSnapshot = existingNextSnapshot
    ? Object.assign({}, existingNextSnapshot, { gatewayDeviceEui: nextGatewayDeviceEui })
    : null;

  if (!migratedSnapshot && oldSnapshot) {
    const nextSnapshot = Object.assign({}, oldSnapshot, {
      gatewayDeviceEui: nextGatewayDeviceEui,
      source: oldSnapshot.source || 'gpsd',
      updatedAt: currentTimestamp()
    });
    nextSnapshot.syncVersion = persistSnapshot(null, nextSnapshot, true);
    migratedSnapshot = nextSnapshot;
  }

  clearPendingGatewayLocationOutbox(previousGatewayDeviceEui);
  deleteGatewaySnapshot(previousGatewayDeviceEui);

  if (migratedSnapshot) {
    log(`migrated gateway GPS state from ${previousGatewayDeviceEui} to ${nextGatewayDeviceEui}`);
  } else {
    log(`switched gateway GPS identity from ${previousGatewayDeviceEui} to ${nextGatewayDeviceEui} without a prior snapshot`);
  }

  if (state) {
    state.lastMirroredFix = null;
  }

  return migratedSnapshot;
}

function haversineMeters(a, b) {
  if (!a || !b || !Number.isFinite(a.latitude) || !Number.isFinite(a.longitude) || !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)) {
    return null;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function positionsDiffer(previous, next, thresholdMeters) {
  if (!Number.isFinite(previous?.latitude) || !Number.isFinite(previous?.longitude) || !Number.isFinite(next?.latitude) || !Number.isFinite(next?.longitude)) {
    return Number.isFinite(previous?.latitude) !== Number.isFinite(next?.latitude)
      || Number.isFinite(previous?.longitude) !== Number.isFinite(next?.longitude);
  }
  const distance = haversineMeters(previous, next);
  return distance == null ? false : distance >= thresholdMeters;
}

function parseGpspipeOutput(rawOutput) {
  const reports = String(rawOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

  let sky = null;
  let fix = null;
  for (const report of reports) {
    if (report.class === 'SKY') {
      sky = report;
    }
    if (report.class === 'TPV' && Number(report.mode || 0) >= 2 && Number.isFinite(report.lat) && Number.isFinite(report.lon)) {
      fix = report;
    }
  }

  if (!fix) return null;

  const satellites = Array.isArray(sky?.satellites)
    ? sky.satellites.filter((sat) => sat && sat.used).length
    : null;
  const accuracyM = Number.isFinite(fix.epx) || Number.isFinite(fix.epy)
    ? Math.max(Number(fix.epx || 0), Number(fix.epy || 0))
    : null;

  return {
    latitude: Number(fix.lat),
    longitude: Number(fix.lon),
    altitudeM: Number.isFinite(fix.altHAE) ? Number(fix.altHAE) : (Number.isFinite(fix.altMSL) ? Number(fix.altMSL) : (Number.isFinite(fix.alt) ? Number(fix.alt) : null)),
    accuracyM,
    hdop: Number.isFinite(sky?.hdop) ? Number(sky.hdop) : null,
    sats: Number.isFinite(satellites) ? satellites : null,
    fixMode: Number(fix.mode || 0),
  };
}

function pollGpsd() {
  const result = spawnSync('gpspipe', ['-w', '-n', '12'], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'gpspipe failed').trim() || 'gpspipe failed');
  }
  return parseGpspipeOutput(result.stdout);
}

function parseEnvFile(filePath) {
  const content = safeRead(filePath);
  if (!content) return {};
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadChirpstackClient() {
  const envValues = parseEnvFile(CHIRPSTACK_ENV_PATH);
  const apiUrl = String(envValues.CHIRPSTACK_API_URL || '').trim();
  const apiKey = String(envValues.CHIRPSTACK_API_KEY || '').trim();
  if (!apiUrl || !apiKey) return null;

  const nodeRedRequire = createRequire(NODE_RED_PACKAGE_PATH);
  const chirpstack = nodeRedRequire(CHIRPSTACK_HELPER_PATH);
  return chirpstack.createClient({ apiUrl, apiKey });
}

async function mirrorToChirpStack(snapshot) {
  const client = loadChirpstackClient();
  if (!client) {
    return { status: 'disabled', mirrored: false };
  }
  await client.updateGatewayLocation(snapshot.gatewayDeviceEui, {
    latitude: snapshot.latitude,
    longitude: snapshot.longitude,
    altitude: snapshot.altitudeM
  });
  return { status: 'enabled', mirrored: true };
}

function currentTimestamp() {
  return new Date().toISOString();
}

function loadConfig() {
  return {
    enabled: uciGet('osi-gateway-gps.core.enabled', '1') !== '0',
    pollIntervalS: Math.max(15, toInt(uciGet('osi-gateway-gps.core.poll_interval_s', '60'), 60)),
    staleAfterS: Math.max(60, toInt(uciGet('osi-gateway-gps.core.stale_after_s', '900'), 900)),
    minMoveM: Math.max(1, toInt(uciGet('osi-gateway-gps.core.min_move_m', '20'), 20)),
    nativeProbeEnabled: uciGet('osi-gateway-gps.core.native_probe_enabled', '1') !== '0',
    chirpstackMirrorEnabled: uciGet('osi-gateway-gps.core.chirpstack_mirror_enabled', '1') !== '0',
    chirpstackMirrorThresholdM: Math.max(1, toInt(uciGet('osi-gateway-gps.core.chirpstack_mirror_threshold_m', '20'), 20)),
    serialDevice: String(uciGet('osi-gateway-gps.core.serial_device', '/dev/ttyAMA0') || '/dev/ttyAMA0'),
    serialBaud: Math.max(1, toInt(uciGet('osi-gateway-gps.core.serial_baud', '9600'), 9600))
  };
}

function detectSerialConsoleConflict(serialDevice) {
  const cmdline = safeRead('/proc/cmdline') || '';
  const normalized = serialDevice.includes('/dev/') ? serialDevice.replace('/dev/', '') : serialDevice;
  return cmdline.includes(`console=${normalized}`) || cmdline.includes('console=serial0');
}

function ensureNativeConcentratord(config) {
  if (!config.nativeProbeEnabled) return 'disabled';
  const show = uciShow('chirpstack-concentratord');
  const section = show.includes('chirpstack-concentratord.@sx1302[0]=')
    ? 'chirpstack-concentratord.@sx1302[0]'
    : (show.includes('chirpstack-concentratord.@sx1301[0]=') ? 'chirpstack-concentratord.@sx1301[0]' : '');
  if (!section) {
    return 'unsupported';
  }

  let changed = false;
  const gnssPath = 'gpsd://127.0.0.1:2947';
  if (!show.includes(`${section}.gnss_dev_path='gpsd://127.0.0.1:2947'`)) {
    uciSet(`${section}.gnss_dev_path`, gnssPath);
    changed = true;
  }
  if (!show.includes(`${section}.model_flags='GNSS'`)) {
    uciAddList(`${section}.model_flags`, 'GNSS');
    changed = true;
  }
  if (changed) {
    uciCommit('chirpstack-concentratord');
    restartService('chirpstack-concentratord');
  }
  return changed ? 'configured' : 'configured';
}

function mergeWithLastGood(previous, currentFix, now, staleAfterS, nativeStatus, mirrorStatus) {
  if (currentFix) {
    return {
      gatewayDeviceEui: previous.gatewayDeviceEui,
      latitude: currentFix.latitude,
      longitude: currentFix.longitude,
      altitudeM: currentFix.altitudeM,
      accuracyM: currentFix.accuracyM,
      hdop: currentFix.hdop,
      sats: currentFix.sats,
      fixMode: currentFix.fixMode,
      status: 'live',
      source: 'gpsd',
      nativeConcentratordStatus: nativeStatus,
      chirpstackMirrorStatus: mirrorStatus,
      lastFixAt: now,
      lastGoodFixAt: now,
      updatedAt: now
    };
  }

  const lastGoodFixAt = previous.lastGoodFixAt || null;
  const hasCoordinates = Number.isFinite(previous.latitude) && Number.isFinite(previous.longitude);
  const lastFixAgeMs = lastGoodFixAt ? Date.parse(now) - Date.parse(lastGoodFixAt) : Number.POSITIVE_INFINITY;
  const stale = hasCoordinates || lastFixAgeMs > staleAfterS * 1000;

  return {
    gatewayDeviceEui: previous.gatewayDeviceEui,
    latitude: hasCoordinates ? previous.latitude : null,
    longitude: hasCoordinates ? previous.longitude : null,
    altitudeM: Number.isFinite(previous.altitudeM) ? previous.altitudeM : null,
    accuracyM: Number.isFinite(previous.accuracyM) ? previous.accuracyM : null,
    hdop: Number.isFinite(previous.hdop) ? previous.hdop : null,
    sats: Number.isFinite(previous.sats) ? previous.sats : null,
    fixMode: Number.isFinite(previous.fixMode) ? previous.fixMode : 1,
    status: stale ? 'stale' : 'no_fix',
    source: 'gpsd',
    nativeConcentratordStatus: nativeStatus,
    chirpstackMirrorStatus: mirrorStatus,
    lastFixAt: previous.lastFixAt || null,
    lastGoodFixAt,
    updatedAt: now
  };
}

function shouldBumpSync(previous, next, minMoveM) {
  if (!previous) return true;
  if (String(previous.status || '') !== String(next.status || '')) return true;
  if (String(previous.nativeConcentratordStatus || '') !== String(next.nativeConcentratordStatus || '')) return true;
  if (String(previous.chirpstackMirrorStatus || '') !== String(next.chirpstackMirrorStatus || '')) return true;
  return positionsDiffer(previous, next, minMoveM);
}

function shouldMirror(previousMirroredFix, next, thresholdMeters) {
  if (next.status !== 'live') return false;
  return !previousMirroredFix || positionsDiffer(previousMirroredFix, next, thresholdMeters);
}

async function runCycle(config, state) {
  const now = currentTimestamp();
  const gatewayIdentity = resolveGatewayIdentity();
  const gatewayDeviceEui = gatewayIdentity.deviceEui || state.gatewayDeviceEui || 'UNKNOWN';
  if (!gatewayDeviceEui || gatewayDeviceEui === 'UNKNOWN') {
    warn('gateway identity is not available yet; skipping GPS sync cycle');
    return;
  }
  const previousGatewayDeviceEui = state.gatewayDeviceEui && state.gatewayDeviceEui !== gatewayDeviceEui
    ? state.gatewayDeviceEui
    : ((state.snapshot && state.snapshot.gatewayDeviceEui && state.snapshot.gatewayDeviceEui !== gatewayDeviceEui)
      ? state.snapshot.gatewayDeviceEui
      : '');
  let previous = readCurrentSnapshot(gatewayDeviceEui)
    || ((state.snapshot && state.snapshot.gatewayDeviceEui === gatewayDeviceEui) ? state.snapshot : null)
    || null;
  if (previousGatewayDeviceEui) {
    const migratedSnapshot = migrateGatewayState(previousGatewayDeviceEui, gatewayDeviceEui, state);
    if (migratedSnapshot) {
      previous = migratedSnapshot;
    }
  }
  const baseSnapshot = Object.assign({}, previous || {}, { gatewayDeviceEui });
  const nativeStatus = ensureNativeConcentratord(config);

  let currentFix = null;
  try {
    currentFix = pollGpsd();
  } catch (error) {
    warn(`gpsd poll failed: ${error.message}`);
  }

  let snapshot = mergeWithLastGood(
    Object.assign({}, baseSnapshot, { gatewayDeviceEui }),
    currentFix,
    now,
    config.staleAfterS,
    nativeStatus,
    config.chirpstackMirrorEnabled ? (baseSnapshot.chirpstackMirrorStatus || 'pending') : 'disabled'
  );

  if (config.chirpstackMirrorEnabled && gatewayIdentity.confidence !== 'provisional'
      && shouldMirror(state.lastMirroredFix, snapshot, config.chirpstackMirrorThresholdM)) {
    try {
      const mirrorResult = await mirrorToChirpStack(snapshot);
      snapshot.chirpstackMirrorStatus = mirrorResult.status;
      state.lastMirroredFix = {
        latitude: snapshot.latitude,
        longitude: snapshot.longitude,
        altitudeM: snapshot.altitudeM
      };
    } catch (error) {
      snapshot.chirpstackMirrorStatus = 'error';
      warn(`failed to mirror gateway location to ChirpStack: ${error.message}`);
    }
  } else if (config.chirpstackMirrorEnabled && gatewayIdentity.confidence === 'provisional') {
    snapshot.chirpstackMirrorStatus = 'identity_pending';
  } else if (!config.chirpstackMirrorEnabled) {
    snapshot.chirpstackMirrorStatus = 'disabled';
  }

  const bumpSyncVersion = shouldBumpSync(previous, snapshot, config.minMoveM);
  const nextSyncVersion = persistSnapshot(previous, snapshot, bumpSyncVersion);
  snapshot.syncVersion = nextSyncVersion;

  state.gatewayDeviceEui = gatewayDeviceEui;
  state.gatewayIdentity = gatewayIdentity;
  state.snapshot = snapshot;
  saveJson(CACHE_PATH, {
    snapshot,
    lastMirroredFix: state.lastMirroredFix || null
  });
}

async function main() {
  const config = loadConfig();
  if (!config.enabled) {
    log('service disabled by UCI');
    process.exit(0);
  }

  if (detectSerialConsoleConflict(config.serialDevice)) {
    warn(`serial console still appears attached to ${config.serialDevice}; GNSS reads may fail until UART console is disabled`);
  }

  ensureDir(path.dirname(CACHE_PATH));
  ensureSchema();

  const gatewayIdentity = resolveGatewayIdentity();
  const gatewayDeviceEui = gatewayIdentity.deviceEui || 'UNKNOWN';
  const cache = loadJson(CACHE_PATH) || {};
  const previous = readCurrentSnapshot(gatewayDeviceEui);
  const state = {
    gatewayDeviceEui,
    gatewayIdentity,
    snapshot: previous || cache.snapshot || (gatewayDeviceEui && gatewayDeviceEui !== 'UNKNOWN' ? { gatewayDeviceEui } : null),
    lastMirroredFix: cache.lastMirroredFix || null
  };

  if (!previous
      && gatewayDeviceEui
      && gatewayDeviceEui !== 'UNKNOWN'
      && cache.snapshot
      && (!cache.snapshot.gatewayDeviceEui || cache.snapshot.gatewayDeviceEui === gatewayDeviceEui)
      && Number.isFinite(cache.snapshot.latitude)
      && Number.isFinite(cache.snapshot.longitude)) {
    const seeded = Object.assign({}, cache.snapshot, {
      gatewayDeviceEui,
      status: 'stale',
      source: 'gpsd',
      updatedAt: currentTimestamp()
    });
    seeded.syncVersion = persistSnapshot(null, seeded, true);
    state.snapshot = seeded;
  }

  log(`starting gateway GPS loop for ${gatewayDeviceEui} (${gatewayIdentity.source}/${gatewayIdentity.confidence})`);
  while (true) {
    try {
      await runCycle(config, state);
    } catch (error) {
      warn(`gateway GPS cycle failed: ${error.stack || error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalS * 1000));
  }
}

main().catch((error) => {
  warn(`fatal startup error: ${error.stack || error.message}`);
  process.exit(1);
});
