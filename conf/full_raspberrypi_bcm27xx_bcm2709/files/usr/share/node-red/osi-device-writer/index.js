'use strict';

const FLOOR = Date.parse('2024-01-01T00:00:00Z');
const SKEW_MS = 3600000;
const QUARANTINE_CAP = 1000;

let columnCache = null;

function clampRecordedAt(raw, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(now).toISOString();
  if (raw === undefined || raw === null || raw === '') {
    return { recordedAt: nowIso, clamped: false };
  }
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t) || t < FLOOR || t > now + SKEW_MS) {
    return { recordedAt: nowIso, clamped: true };
  }
  return { recordedAt: String(raw), clamped: false };
}

function resetColumnCache() {
  columnCache = null;
}

// The two real callers ('UC512 Normalize + Write' 6b28e0d879808dd9 and
// 'SDI12 Normalize + Write' sdi12-write-fn in flows.json) always pass
// `new osiDb.Database('/data/db/farming.db')` from osi-db-helper -- a
// sqlite3 callback facade (run/get/all/close, promise-returning, no
// `.prepare`). This module's own tests exercise it against node:sqlite's
// DatabaseSync directly, which DOES have `.prepare` and is fully
// synchronous. Both shapes are real: DatabaseSync for the module's unit
// tests and any future synchronous embedding, the facade for every actual
// flows.json call site. Detect which one we were given and dispatch to a
// matching implementation rather than assuming one or the other.
function isPreparedDb(db) {
  return !!(db && typeof db.prepare === 'function');
}

function getDeviceDataColumnsSync(db) {
  if (columnCache) return columnCache;
  const rows = db.prepare('PRAGMA table_info(device_data)').all();
  columnCache = new Set(rows.map((r) => r.name));
  return columnCache;
}

async function getDeviceDataColumnsAsync(db) {
  if (columnCache) return columnCache;
  const rows = await db.all('PRAGMA table_info(device_data)');
  columnCache = new Set((rows || []).map((r) => r.name));
  return columnCache;
}

function evictQuarantineSync(db) {
  db.prepare(
    'DELETE FROM ingest_quarantine WHERE id NOT IN (SELECT id FROM ingest_quarantine ORDER BY id DESC LIMIT ?)'
  ).run(QUARANTINE_CAP);
}

async function evictQuarantineAsync(db) {
  await db.run(
    'DELETE FROM ingest_quarantine WHERE id NOT IN (SELECT id FROM ingest_quarantine ORDER BY id DESC LIMIT ?)',
    [QUARANTINE_CAP]
  );
}

function deadLetterSync(db, deveui, channel, reason, rawValue) {
  db.prepare(
    'INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value) VALUES (?, ?, ?, ?)'
  ).run(deveui, channel, reason, rawValue != null ? String(rawValue) : null);
}

async function deadLetterAsync(db, deveui, channel, reason, rawValue) {
  await db.run(
    'INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value) VALUES (?, ?, ?, ?)',
    [deveui, channel, reason, rawValue != null ? String(rawValue) : null]
  );
}

// Pure classification, shared by both the sync and async write paths: given
// the manifest and the current device_data columns, decide which channels
// become INSERT columns/values and which get dead-lettered. No DB I/O here,
// so both implementations below make exactly the same accept/reject
// decisions.
function classifyChannels(node, manifestByKey, dbCols, channels, unknown) {
  const cols = [];
  const vals = [];
  const deadLettered = [];
  const quarantineWrites = [];

  for (const [key, value] of Object.entries(channels)) {
    const entry = manifestByKey.get(key);
    if (!entry) {
      deadLettered.push({ channel: key, reason: 'unmapped_channel' });
      quarantineWrites.push({ channel: key, reason: 'unmapped_channel', rawValue: value });
      continue;
    }
    if (entry.edgeField == null) {
      deadLettered.push({ channel: key, reason: 'server_only_channel' });
      quarantineWrites.push({ channel: key, reason: 'server_only_channel', rawValue: value });
      continue;
    }
    if (!dbCols.has(entry.edgeField)) {
      deadLettered.push({ channel: key, reason: 'column_missing' });
      quarantineWrites.push({ channel: key, reason: 'column_missing', rawValue: value });
      node.error('osi-device-writer: manifest edgeField "' + entry.edgeField + '" not in device_data');
      continue;
    }
    cols.push(entry.edgeField);
    vals.push(value != null ? value : null);
  }

  for (const [key, value] of Object.entries(unknown)) {
    deadLettered.push({ channel: key, reason: 'unknown_channel' });
    quarantineWrites.push({ channel: key, reason: 'unknown_channel', rawValue: value });
  }

  return { cols, vals, deadLettered, quarantineWrites };
}

function buildManifestIndex(manifest) {
  const manifestByKey = new Map();
  for (const entry of manifest) {
    manifestByKey.set(entry.key, entry);
  }
  return manifestByKey;
}

function writeDeviceDataSync(db, manifest, normalizeResult, meta, options) {
  const node = (options && options.node) || { warn() {}, error() {} };
  const shadow = !!(options && options.shadow);
  const nowMs = (options && options.nowMs) || undefined;
  const deveui = String((meta && meta.deveui) || '').toUpperCase().trim();

  if (!deveui) {
    node.error('osi-device-writer: empty deveui');
    return { inserted: false, deadLettered: [], columns: [] };
  }

  const clamp = clampRecordedAt(
    (normalizeResult && normalizeResult.recordedAt) || (meta && meta.recordedAt),
    nowMs
  );
  if (clamp.clamped) {
    node.warn(
      'timestamp_clamped: implausible timestamp for ' + deveui + ' clamped to ' + clamp.recordedAt
    );
  }

  const manifestByKey = buildManifestIndex(manifest);
  const dbCols = getDeviceDataColumnsSync(db);
  const channels = (normalizeResult && normalizeResult.channels) || {};
  const unknown = (normalizeResult && normalizeResult.unknown) || {};

  const plan = classifyChannels(node, manifestByKey, dbCols, channels, unknown);
  const cols = ['deveui', 'recorded_at'].concat(plan.cols);
  const vals = [deveui, clamp.recordedAt].concat(plan.vals);

  for (const write of plan.quarantineWrites) {
    deadLetterSync(db, deveui, write.channel, write.reason, write.rawValue);
  }
  if (plan.quarantineWrites.length > 0) {
    evictQuarantineSync(db);
  }

  if (shadow) {
    const shadowRow = {};
    for (let i = 0; i < cols.length; i++) {
      shadowRow[cols[i]] = vals[i];
    }
    return { inserted: false, shadowRow, columns: cols.slice(), deadLettered: plan.deadLettered };
  }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = 'INSERT INTO device_data (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
  db.prepare(sql).run(...vals);

  return { inserted: true, deadLettered: plan.deadLettered, columns: cols.slice() };
}

async function writeDeviceDataAsync(db, manifest, normalizeResult, meta, options) {
  const node = (options && options.node) || { warn() {}, error() {} };
  const shadow = !!(options && options.shadow);
  const nowMs = (options && options.nowMs) || undefined;
  const deveui = String((meta && meta.deveui) || '').toUpperCase().trim();

  if (!deveui) {
    node.error('osi-device-writer: empty deveui');
    return { inserted: false, deadLettered: [], columns: [] };
  }

  const clamp = clampRecordedAt(
    (normalizeResult && normalizeResult.recordedAt) || (meta && meta.recordedAt),
    nowMs
  );
  if (clamp.clamped) {
    node.warn(
      'timestamp_clamped: implausible timestamp for ' + deveui + ' clamped to ' + clamp.recordedAt
    );
  }

  const manifestByKey = buildManifestIndex(manifest);
  const dbCols = await getDeviceDataColumnsAsync(db);
  const channels = (normalizeResult && normalizeResult.channels) || {};
  const unknown = (normalizeResult && normalizeResult.unknown) || {};

  const plan = classifyChannels(node, manifestByKey, dbCols, channels, unknown);
  const cols = ['deveui', 'recorded_at'].concat(plan.cols);
  const vals = [deveui, clamp.recordedAt].concat(plan.vals);

  for (const write of plan.quarantineWrites) {
    await deadLetterAsync(db, deveui, write.channel, write.reason, write.rawValue);
  }
  if (plan.quarantineWrites.length > 0) {
    await evictQuarantineAsync(db);
  }

  if (shadow) {
    const shadowRow = {};
    for (let i = 0; i < cols.length; i++) {
      shadowRow[cols[i]] = vals[i];
    }
    return { inserted: false, shadowRow, columns: cols.slice(), deadLettered: plan.deadLettered };
  }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = 'INSERT INTO device_data (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
  await db.run(sql, vals);

  return { inserted: true, deadLettered: plan.deadLettered, columns: cols.slice() };
}

// Dispatch on the shape of `db`: node:sqlite's DatabaseSync (used by this
// module's own tests, `.prepare`-shaped, fully synchronous -- returns the
// result object directly, unchanged from before this fix) vs. the
// osi-db-helper facade (used by every real flows.json caller, run/get/all
// only, promise-returning -- returns a Promise callers must await, exactly
// as the SDI12 node already does).
function writeDeviceData(db, manifest, normalizeResult, meta, options) {
  if (isPreparedDb(db)) {
    return writeDeviceDataSync(db, manifest, normalizeResult, meta, options);
  }
  return writeDeviceDataAsync(db, manifest, normalizeResult, meta, options);
}

function quarantineOnly(db, deveui, channel, rawValue) {
  const normalizedDeveui = String(deveui || '').toUpperCase().trim();
  if (isPreparedDb(db)) {
    deadLetterSync(db, normalizedDeveui, channel, 'unknown_channel', rawValue);
    evictQuarantineSync(db);
    return undefined;
  }
  return (async () => {
    await deadLetterAsync(db, normalizedDeveui, channel, 'unknown_channel', rawValue);
    await evictQuarantineAsync(db);
  })();
}

module.exports = { writeDeviceData, quarantineOnly, clampRecordedAt, resetColumnCache };
