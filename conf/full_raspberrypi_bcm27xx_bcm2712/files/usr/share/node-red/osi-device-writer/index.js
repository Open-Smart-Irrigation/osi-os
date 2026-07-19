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

function getDeviceDataColumns(db) {
  if (columnCache) return columnCache;
  const rows = db.prepare('PRAGMA table_info(device_data)').all();
  columnCache = new Set(rows.map((r) => r.name));
  return columnCache;
}

function resetColumnCache() {
  columnCache = null;
}

function evictQuarantine(db) {
  db.prepare(
    'DELETE FROM ingest_quarantine WHERE id NOT IN (SELECT id FROM ingest_quarantine ORDER BY id DESC LIMIT ?)'
  ).run(QUARANTINE_CAP);
}

function deadLetter(db, deveui, channel, reason, rawValue) {
  db.prepare(
    'INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value) VALUES (?, ?, ?, ?)'
  ).run(deveui, channel, reason, rawValue != null ? String(rawValue) : null);
}

function writeDeviceData(db, manifest, normalizeResult, meta, options) {
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

  const dbCols = getDeviceDataColumns(db);
  const channels = (normalizeResult && normalizeResult.channels) || {};
  const unknown = (normalizeResult && normalizeResult.unknown) || {};

  const cols = ['deveui', 'recorded_at'];
  const vals = [deveui, clamp.recordedAt];
  const deadLettered = [];

  for (const [key, value] of Object.entries(channels)) {
    const entry = manifestByKey.get(key);
    if (!entry) {
      deadLettered.push({ channel: key, reason: 'unmapped_channel' });
      deadLetter(db, deveui, key, 'unmapped_channel', value);
      continue;
    }
    if (entry.edgeField == null) {
      deadLettered.push({ channel: key, reason: 'server_only_channel' });
      deadLetter(db, deveui, key, 'server_only_channel', value);
      continue;
    }
    if (!dbCols.has(entry.edgeField)) {
      deadLettered.push({ channel: key, reason: 'column_missing' });
      deadLetter(db, deveui, key, 'column_missing', value);
      node.error('osi-device-writer: manifest edgeField "' + entry.edgeField + '" not in device_data');
      continue;
    }
    cols.push(entry.edgeField);
    vals.push(value != null ? value : null);
  }

  for (const [key, value] of Object.entries(unknown)) {
    deadLettered.push({ channel: key, reason: 'unknown_channel' });
    deadLetter(db, deveui, key, 'unknown_channel', value);
  }

  if (deadLettered.length > 0) {
    evictQuarantine(db);
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
  db.prepare(sql).run(...vals);

  return { inserted: true, deadLettered, columns: cols.slice() };
}

module.exports = { writeDeviceData, clampRecordedAt, resetColumnCache };
