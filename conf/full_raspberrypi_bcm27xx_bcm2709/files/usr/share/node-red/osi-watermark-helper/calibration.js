'use strict';

// Edge-authored WATERMARK calibration: validation, optimistic-concurrency
// writes, tombstone deletes, dry-run preview, first-calibration backfill.
// `db` is the osi-db-helper facade (get/all/run/transaction; run() returns
// undefined). Spec section 6, "Calibration writer" and "Backfill".

const conversion = require('./conversion');

const VALUE_FIELDS = [
  'pullup_1_ohm', 'pulldown_1_ohm', 'series_fwd_1_ohm', 'series_rev_1_ohm',
  'pullup_2_ohm', 'pulldown_2_ohm', 'series_fwd_2_ohm', 'series_rev_2_ohm'
];
const META_FIELDS = ['measured_at', 'method', 'worst_residual_pct', 'notes'];
// Readings converted per backfill transaction (see backfillBatch).
const BACKFILL_BATCH_SIZE = 500;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function httpError(statusCode, code, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function limitFor(field) {
  return field.indexOf('series_') === 0 ? conversion.CALIBRATION_LIMITS.series : conversion.CALIBRATION_LIMITS.pull;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function parseExpectedVersion(value) {
  const n = toNumber(value);
  if (!Number.isInteger(n) || n < 0) {
    throw httpError(400, 'invalid_expected_sync_version', 'expected_sync_version must be a non-negative integer');
  }
  return n;
}

function validateCalibrationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  const values = {};
  for (const field of VALUE_FIELDS) {
    const n = toNumber(body[field]);
    const lim = limitFor(field);
    if (!Number.isFinite(n) || (n !== 0 && Math.abs(n) < conversion.MIN_NORMAL) || n < lim.min || n > lim.max) {
      throw httpError(400, 'invalid_calibration', field + ' must be between ' + lim.min + ' and ' + lim.max + ' ohm', { field });
    }
    values[field] = n;
  }
  // Metadata is partial: a field the body omits is absent from `meta`, and
  // saveCalibration keeps its stored value (the GUI edits coefficients only).
  // An explicit null or '' clears the field; any other value is validated.
  const meta = {};
  const has = (field) => Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined;
  const blank = (field) => body[field] === null || body[field] === '';
  if (has('measured_at')) {
    if (blank('measured_at')) meta.measured_at = null;
    else if (!Number.isFinite(Date.parse(String(body.measured_at)))) {
      throw httpError(400, 'invalid_calibration', 'measured_at must be an ISO date', { field: 'measured_at' });
    } else meta.measured_at = new Date(Date.parse(String(body.measured_at))).toISOString();
  }
  if (has('method')) {
    meta.method = blank('method') ? null : String(body.method).slice(0, 64);
  }
  if (has('worst_residual_pct')) {
    if (blank('worst_residual_pct')) meta.worst_residual_pct = null;
    else {
      const r = toNumber(body.worst_residual_pct);
      if (!Number.isFinite(r) || (r !== 0 && Math.abs(r) < conversion.MIN_NORMAL) || r < 0 || r > 100) {
        throw httpError(400, 'invalid_calibration', 'worst_residual_pct must be between 0 and 100', { field: 'worst_residual_pct' });
      }
      meta.worst_residual_pct = r;
    }
  }
  if (has('notes')) {
    meta.notes = blank('notes') ? null : String(body.notes).slice(0, 500);
  }
  const dryRun = body.dry_run === true;
  const expectedSyncVersion = dryRun ? null : parseExpectedVersion(body.expected_sync_version);
  return { values, meta, dryRun, expectedSyncVersion };
}

// Scoped mode: the caller (scoped-device-config-guard for writes, the
// account-wide read check for GET) has already authorized this device, so no
// owner filter here -- an assigned researcher is not the owner. Legacy mode:
// the device must belong to the authenticated user.
async function assertAccessibleLsn50(db, deveui, access) {
  const scoped = access && access.scoped === true;
  if (!scoped && !Number.isFinite(Number(access && access.userId))) {
    throw httpError(401, 'unauthorized', 'Unauthorized');
  }
  const row = await db.get(
    "SELECT deveui FROM devices WHERE UPPER(deveui) = ? AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL" +
      (scoped ? '' : ' AND user_id = ?'),
    scoped ? [deveui] : [deveui, Number(access.userId)]
  );
  if (!row) throw httpError(404, 'device_not_found', 'Device not found');
  return row.deveui;
}

function publicCalibration(row) {
  if (!row || row.deleted_at) return null;
  const out = {};
  for (const f of VALUE_FIELDS.concat(META_FIELDS)) out[f] = row[f] == null ? null : row[f];
  out.updated_at = row.updated_at;
  return out;
}

async function readRow(db, deveui) {
  return db.get('SELECT * FROM watermark_calibrations WHERE deveui = ?', [deveui]);
}

// GET: live calibration (or null) plus the version a writer must quote.
async function getCalibration(db, { deveui, userId, scoped }) {
  const key = await assertAccessibleLsn50(db, normalizeDeveui(deveui), { userId, scoped });
  const row = await readRow(db, key);
  return { deveui: key, sync_version: row ? row.sync_version : 0, calibration: publicCalibration(row) };
}

function normalizeDeveui(deveui) {
  const key = String(deveui || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(key)) throw httpError(400, 'invalid_deveui', 'Invalid device EUI');
  return key;
}

async function latestAcceptedReading(db, deveui) {
  return db.get(
    "SELECT recorded_at, payload_hex FROM watermark_readings WHERE deveui = ? AND frame_status = 'accepted' ORDER BY recorded_at DESC, id DESC LIMIT 1",
    [deveui]
  );
}

function convertStored(payloadHex, calibrationRow) {
  const parsed = conversion.parseProfile3(Buffer.from(String(payloadHex || ''), 'hex'));
  return parsed.ok ? conversion.convertFrame(parsed.frame, calibrationRow) : null;
}

async function saveCalibration(db, { deveui, userId, scoped, body }) {
  const key = normalizeDeveui(deveui);
  const input = validateCalibrationBody(body);
  if (input.dryRun) {
    await assertAccessibleLsn50(db, key, { userId, scoped });
    const latest = await latestAcceptedReading(db, key);
    const converted = latest ? convertStored(latest.payload_hex, Object.assign({ sync_version: null }, input.values)) : null;
    return { deveui: key, dry_run: true, preview: converted ? { recorded_at: latest.recorded_at, channels: converted.channels } : null };
  }
  const saved = await db.transaction(async (tx) => {
    await assertAccessibleLsn50(tx, key, { userId, scoped });
    const current = await readRow(tx, key);
    const currentVersion = current ? current.sync_version : 0;
    if (input.expectedSyncVersion !== currentVersion) {
      throw httpError(409, 'stale_sync_version', 'Calibration changed since it was loaded', { currentSyncVersion: currentVersion });
    }
    // An omitted metadata field keeps the live row's value; there is none to
    // keep on a first save or after a delete (the tombstone's metadata went
    // with it), so it is null there.
    const live = current && !current.deleted_at ? current : null;
    const cols = VALUE_FIELDS.concat(META_FIELDS);
    const vals = cols.map((c) => {
      if (c in input.values) return input.values[c];
      if (c in input.meta) return input.meta[c];
      return live && live[c] != null ? live[c] : null;
    });
    await tx.run(
      'INSERT INTO watermark_calibrations (deveui, ' + cols.join(', ') + ', sync_version, updated_at, deleted_at) ' +
      'VALUES (?, ' + cols.map(() => '?').join(', ') + ', ?, ' + NOW_SQL + ', NULL) ' +
      'ON CONFLICT(deveui) DO UPDATE SET ' + cols.map((c) => c + ' = excluded.' + c).join(', ') +
      ', sync_version = excluded.sync_version, updated_at = excluded.updated_at, deleted_at = NULL',
      [key].concat(vals, [currentVersion + 1])
    );
    const row = await readRow(tx, key);
    // The first batch commits atomically with the calibration itself.
    const first = await backfillBatch(tx, key, row, null);
    return { row, first };
  });
  const rest = await backfillRemaining(db, key, saved.row, saved.first);
  const result = {
    deveui: key, sync_version: saved.row.sync_version, calibration: publicCalibration(saved.row),
    backfilled: saved.first.converted + rest.converted
  };
  // The calibration is committed either way; a failed later batch only leaves
  // readings waiting for the next save, so it is reported, not thrown.
  if (rest.error) result.backfill_incomplete = true;
  return result;
}

async function deleteCalibration(db, { deveui, userId, scoped, expectedSyncVersion }) {
  const key = normalizeDeveui(deveui);
  const expected = parseExpectedVersion(expectedSyncVersion);
  return db.transaction(async (tx) => {
    await assertAccessibleLsn50(tx, key, { userId, scoped });
    const current = await readRow(tx, key);
    if (!current || current.deleted_at) throw httpError(404, 'calibration_not_found', 'No calibration to delete');
    if (current.sync_version !== expected) {
      throw httpError(409, 'stale_sync_version', 'Calibration changed since it was loaded', { currentSyncVersion: current.sync_version });
    }
    await tx.run(
      'UPDATE watermark_calibrations SET deleted_at = ' + NOW_SQL + ', updated_at = ' + NOW_SQL +
      ', sync_version = sync_version + 1 WHERE deveui = ?',
      [key]
    );
    return { deveui: key, sync_version: current.sync_version + 1, calibration: null };
  });
}

const CHANNEL_RESULT_COLUMNS = ['r_fwd', 'r_rev', 'r_solved', 'offset_mv', 'r_upper_bound', 'kpa_upper_bound', 'status', 'kpa'];

// Convert readings that were waiting for a first calibration. Only channels
// whose stored status is 'calibration_required' change; device_data is
// updated in place by row id, and the dirty-history trigger carries the correction to
// the cloud (spec section 3). Readings that already have kPa are never touched.
//
// Bounded: one call converts at most BACKFILL_BATCH_SIZE readings after
// `cursor` (keyset on recorded_at, id, so a reading that cannot be converted
// is passed over instead of being selected again). saveCalibration runs the
// first batch inside the transaction that saves the calibration and every
// later batch in a transaction of its own, so a node that waited weeks for its
// calibration does not hold the shared DB queue for the whole conversion:
// uplinks and API calls run between batches. Each batch is atomic. A crash
// between batches leaves the remaining readings 'calibration_required'; the
// next calibration save converts them.
async function backfillBatch(tx, deveui, calibrationRow, cursor) {
  const after = cursor ? ' AND (recorded_at > ? OR (recorded_at = ? AND id > ?))' : '';
  const rows = await tx.all(
    "SELECT id, recorded_at, device_data_id, payload_hex, ch1_status, ch2_status FROM watermark_readings " +
    "WHERE deveui = ? AND frame_status = 'accepted' AND (ch1_status = 'calibration_required' OR ch2_status = 'calibration_required')" +
    after + ' ORDER BY recorded_at, id LIMIT ?',
    [deveui].concat(cursor ? [cursor.recorded_at, cursor.recorded_at, cursor.id] : [], [BACKFILL_BATCH_SIZE])
  );
  let converted = 0;
  for (const row of rows) {
    const result = convertStored(row.payload_hex, calibrationRow);
    if (!result) continue;
    for (const n of [1, 2]) {
      if (row['ch' + n + '_status'] !== 'calibration_required') continue;
      const ch = result.channels[n - 1];
      await tx.run(
        'UPDATE watermark_readings SET ' + CHANNEL_RESULT_COLUMNS.map((c) => 'ch' + n + '_' + c + ' = ?').join(', ') +
        ', calibration_sync_version = ?, conversion_version = ? WHERE id = ?',
        CHANNEL_RESULT_COLUMNS.map((c) => ch[c]).concat([result.calibration_sync_version, result.conversion_version, row.id])
      );
      // By row id: device_data has no UNIQUE(deveui, recorded_at), so a
      // timestamp match could hit another observation.
      if (ch.kpa !== null && row.device_data_id !== null) {
        await tx.run(
          'UPDATE device_data SET swt_' + n + ' = ? WHERE id = ? AND deveui = ? AND swt_' + n + ' IS NULL',
          [ch.kpa, row.device_data_id, deveui]
        );
      }
    }
    converted += 1;
  }
  const last = rows[rows.length - 1];
  return {
    converted,
    cursor: last ? { recorded_at: last.recorded_at, id: last.id } : cursor,
    more: rows.length === BACKFILL_BATCH_SIZE
  };
}

// The batches after the first, one transaction each, with the calibration
// saveCalibration wrote. A batch that finds the calibration changed (a newer
// save, which runs its own backfill, or a delete) ends the loop, and so does
// a batch that fails (it rolls back; its readings keep waiting).
async function backfillRemaining(db, deveui, calibrationRow, first) {
  let converted = 0;
  let batch = first;
  while (batch.more) {
    const cursor = batch.cursor;
    try {
      batch = await db.transaction(async (tx) => {
        const live = await readRow(tx, deveui);
        if (!live || live.deleted_at || live.sync_version !== calibrationRow.sync_version) {
          return { converted: 0, cursor, more: false };
        }
        return backfillBatch(tx, deveui, live, cursor);
      });
    } catch (error) {
      return { converted, error };
    }
    converted += batch.converted;
  }
  return { converted, error: null };
}

// Every waiting reading inside the caller's own transaction, batch after
// batch (unbounded). saveCalibration does not use it; kept for a caller that
// already holds a transaction.
async function backfillPending(tx, deveui, calibrationRow) {
  let total = 0;
  let batch = { cursor: null, more: true };
  while (batch.more) {
    batch = await backfillBatch(tx, deveui, calibrationRow, batch.cursor);
    total += batch.converted;
  }
  return total;
}

module.exports = {
  VALUE_FIELDS,
  validateCalibrationBody,
  getCalibration,
  saveCalibration,
  deleteCalibration,
  backfillPending,
  backfillBatch,
  BACKFILL_BATCH_SIZE,
  CHANNEL_RESULT_COLUMNS
};
