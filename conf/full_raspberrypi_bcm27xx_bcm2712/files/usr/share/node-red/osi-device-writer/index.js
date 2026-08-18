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

async function getDeviceDataColumns(db) {
  if (columnCache) return columnCache;
  const rows = await db.all('PRAGMA table_info(device_data)');
  columnCache = new Set(rows.map((row) => row.name));
  return columnCache;
}

function resetColumnCache() {
  columnCache = null;
}

async function evictQuarantine(db) {
  await db.run(
    'DELETE FROM ingest_quarantine WHERE id NOT IN ' +
      '(SELECT id FROM ingest_quarantine ORDER BY id DESC LIMIT ?)',
    [QUARANTINE_CAP]
  );
}

async function deadLetter(db, deveui, channel, reason, rawValue) {
  await db.run(
    'INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value) VALUES (?, ?, ?, ?)',
    [deveui, channel, reason, rawValue != null ? String(rawValue) : null]
  );
}

async function writeDeviceData(db, manifest, normalizeResult, meta, options) {
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

  const manifestByKey = new Map();
  for (const entry of manifest) {
    manifestByKey.set(entry.key, entry);
  }

  const dbCols = await getDeviceDataColumns(db);
  const channels = (normalizeResult && normalizeResult.channels) || {};
  const unknown = (normalizeResult && normalizeResult.unknown) || {};

  const cols = ['deveui', 'recorded_at'];
  const vals = [deveui, clamp.recordedAt];
  const deadLettered = [];
  const missingColumns = [];

  for (const [key, value] of Object.entries(channels)) {
    const entry = manifestByKey.get(key);
    if (!entry) {
      deadLettered.push({ channel: key, reason: 'unmapped_channel' });
      await deadLetter(db, deveui, key, 'unmapped_channel', value);
      continue;
    }
    if (entry.edgeField == null) {
      deadLettered.push({ channel: key, reason: 'server_only_channel' });
      await deadLetter(db, deveui, key, 'server_only_channel', value);
      continue;
    }
    if (!dbCols.has(entry.edgeField)) {
      deadLettered.push({ channel: key, reason: 'column_missing' });
      await deadLetter(db, deveui, key, 'column_missing', value);
      node.error('osi-device-writer: manifest edgeField "' + entry.edgeField + '" not in device_data');
      missingColumns.push(entry.edgeField);
      continue;
    }
    cols.push(entry.edgeField);
    vals.push(value != null ? value : null);
  }

  for (const [key, value] of Object.entries(unknown)) {
    deadLettered.push({ channel: key, reason: 'unknown_channel' });
    await deadLetter(db, deveui, key, 'unknown_channel', value);
  }

  if (deadLettered.length > 0) {
    await evictQuarantine(db);
  }

  if (missingColumns.length) {
    // Fail closed: a manifest naming a column the live schema doesn't have
    // yet is a hard error, not a partial insert. Invalidate the cache so the
    // very next call re-reads PRAGMA table_info and can observe an in-place
    // schema repair without a module restart.
    columnCache = null;
    const error = new Error(
      'osi-device-writer: device_data schema missing ' + missingColumns.join(',')
    );
    error.code = 'DEVICE_DATA_SCHEMA_MISMATCH';
    error.missingColumns = missingColumns.slice();
    throw error;
  }

  if (shadow) {
    const shadowRow = {};
    for (let i = 0; i < cols.length; i++) {
      shadowRow[cols[i]] = vals[i];
    }
    return { inserted: false, shadowRow, columns: cols.slice(), deadLettered };
  }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = 'INSERT INTO device_data (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
  await db.run(sql, vals);

  return { inserted: true, deadLettered, columns: cols.slice() };
}

module.exports = { writeDeviceData, clampRecordedAt, resetColumnCache };
