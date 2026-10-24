'use strict';

// Indexed lower-bound lookups are shared by policy activation and due
// evaluation.  The pager keeps memory bounded while preserving the accepted
// strict timestamp parser and the distinction between an absent bound and a
// malformed recorded timestamp.

const model = require('./model');
const { parseInstant } = require('./timestamps');

const EUI_RE = /^[0-9A-F]{16}$/;
const SAMPLE_TIMESTAMP_COLUMNS = Object.freeze({
  swt_1: 'COALESCE(swt_1, swt_wm1)',
  swt_2: 'COALESCE(swt_2, swt_wm2)',
  swt_3: 'swt_3',
  vwc_1: 'vwc_1', vwc_2: 'vwc_2', vwc_3: 'vwc_3', vwc_4: 'vwc_4', vwc_5: 'vwc_5',
  vwc_6: 'vwc_6', vwc_7: 'vwc_7', vwc_8: 'vwc_8', vwc_9: 'vwc_9', vwc_10: 'vwc_10',
});
const CLOCK_LOOKUP_PAGE_SIZE = 256;

function normalizeEui(value, name = 'device_eui') {
  const eui = String(value == null ? '' : value).trim().toUpperCase();
  if (!EUI_RE.test(eui)) {
    throw Object.assign(new Error(`${name} must be 16 hexadecimal characters`), {
      statusCode: 422, code: 'invalid_device_eui',
    });
  }
  return eui;
}

async function latestIndexedTimestamp(db, table, eui, valueExpression = null) {
  let afterRaw = null;
  let latest = null;
  let unknown = false;
  for (;;) {
    const predicates = ['deveui=?'];
    const params = [eui];
    if (valueExpression) predicates.push(`${valueExpression} IS NOT NULL`);
    if (afterRaw !== null) {
      predicates.push('recorded_at > ?');
      params.push(afterRaw);
    }
    params.push(CLOCK_LOOKUP_PAGE_SIZE);
    const rows = await db.all(`SELECT DISTINCT recorded_at FROM ${table} WHERE ${predicates.join(' AND ')} ORDER BY recorded_at COLLATE BINARY LIMIT ?`, params);
    for (const row of rows || []) {
      const parsed = parseInstant(row && row.recorded_at);
      if (!Number.isFinite(parsed)) unknown = true;
      else if (latest == null || parsed > latest) latest = parsed;
    }
    if (!rows || rows.length < CLOCK_LOOKUP_PAGE_SIZE) break;
    afterRaw = rows[rows.length - 1] && rows[rows.length - 1].recorded_at;
    if (typeof afterRaw !== 'string') {
      unknown = true;
      break;
    }
  }
  return { value: latest == null ? null : new Date(latest).toISOString(), unknown };
}

async function latestRelevantSample(db, condition, zoneId) {
  if (!condition || typeof condition !== 'object') return { value: null, unknown: false };
  const kind = String(condition.kind || '').toUpperCase();
  if (kind === 'DENDRO') {
    const devices = await db.all("SELECT deveui FROM devices WHERE irrigation_zone_id=? AND type_id='DRAGINO_LSN50' AND dendro_enabled=1 AND deleted_at IS NULL ORDER BY deveui", [zoneId]);
    let latest = null;
    let unknown = false;
    for (const device of devices || []) {
      const candidate = await latestIndexedTimestamp(db, 'dendrometer_readings', normalizeEui(device.deveui, 'dendrometer device_eui'));
      unknown = unknown || candidate.unknown;
      const candidateMs = parseInstant(candidate.value);
      if (Number.isFinite(candidateMs) && (latest == null || candidateMs > latest)) latest = candidateMs;
    }
    return { value: latest == null ? null : new Date(latest).toISOString(), unknown };
  }
  if (kind === 'SWT' || kind === 'VWC') {
    let latest = null;
    let unknown = false;
    for (const source of Array.isArray(condition.sources) ? condition.sources : []) {
      const eui = normalizeEui(source.device_eui, 'source device_eui');
      const channel = model.normalizeChannel(source.channel);
      const expression = SAMPLE_TIMESTAMP_COLUMNS[channel];
      if (!expression) continue;
      const candidate = await latestIndexedTimestamp(db, 'device_data', eui, expression);
      unknown = unknown || candidate.unknown;
      const candidateMs = parseInstant(candidate.value);
      if (Number.isFinite(candidateMs) && (latest == null || candidateMs > latest)) latest = candidateMs;
    }
    return { value: latest == null ? null : new Date(latest).toISOString(), unknown };
  }
  return { value: null, unknown: false };
}

async function readClockBounds(db, condition, zoneId) {
  const runtime = await db.get('SELECT last_decided_due_at FROM irrigation_runtime_state WHERE singleton_id=1');
  const sample = await latestRelevantSample(db, condition, zoneId);
  return {
    lastDue: runtime && runtime.last_decided_due_at || null,
    latestSample: sample.value,
    latestSampleUnknown: sample.unknown,
  };
}

function assertClockBoundsAtActivation(bounds, activationMs) {
  if (bounds && bounds.latestSampleUnknown) {
    const error = Object.assign(new Error('conditional policy activation requires a trusted runtime clock'), {
      statusCode: 503, code: 'clock_untrusted',
      details: { reason: 'clock_untrusted_lower_bound', bound: 'latestSample' },
    });
    throw error;
  }
  for (const [name, value] of [['lastDue', bounds && bounds.lastDue], ['latestSample', bounds && bounds.latestSample]]) {
    if (value == null || value === '') continue;
    const boundMs = parseInstant(value);
    if (!Number.isFinite(boundMs) || activationMs < boundMs) {
      const error = Object.assign(new Error('conditional policy activation requires a trusted runtime clock'), {
        statusCode: 503, code: 'clock_untrusted',
        details: { reason: 'clock_untrusted_lower_bound', bound: name },
      });
      throw error;
    }
  }
}

module.exports = {
  SAMPLE_TIMESTAMP_COLUMNS,
  CLOCK_LOOKUP_PAGE_SIZE,
  latestIndexedTimestamp,
  latestRelevantSample,
  readClockBounds,
  assertClockBoundsAtActivation,
};
