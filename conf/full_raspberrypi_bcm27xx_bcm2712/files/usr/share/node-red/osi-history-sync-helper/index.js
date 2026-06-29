const crypto = require('crypto');

const TABLE_COLUMNS = {
  device_data: [
    ['id', 'INTEGER'],
    ['deveui', 'TEXT'],
    ['recorded_at', 'TIMESTAMP'],
    ['swt_1', 'REAL'],
    ['swt_2', 'REAL'],
    ['dendro_valid', 'BOOLEAN']
  ],
  chameleon_readings: [
    ['id', 'INTEGER'],
    ['deveui', 'TEXT'],
    ['recorded_at', 'TIMESTAMP'],
    ['payload_version', 'INTEGER'],
    ['status_flags', 'INTEGER'],
    ['data_invalid', 'BOOLEAN'],
    ['comp_pending', 'BOOLEAN'],
    ['f_port', 'INTEGER'],
    ['f_cnt', 'INTEGER'],
    ['calibration_status', 'TEXT']
  ],
  dendrometer_readings: [
    ['id', 'INTEGER'],
    ['deveui', 'TEXT'],
    ['recorded_at', 'TIMESTAMP'],
    ['position_um', 'REAL'],
    ['is_valid', 'BOOLEAN'],
    ['is_outlier', 'BOOLEAN'],
    ['dendro_saturated', 'BOOLEAN']
  ],
  dendrometer_daily: [
    ['deveui', 'TEXT'],
    ['date', 'TEXT'],
    ['mds_um', 'REAL'],
    ['twd_um', 'REAL'],
    ['stress_level', 'TEXT'],
    ['computed_at', 'TIMESTAMP']
  ],
  zone_daily_environment: [
    ['zone_uuid', 'TEXT'],
    ['date', 'TEXT'],
    ['rainfall_mm', 'REAL'],
    ['flow_liters', 'REAL'],
    ['rain_source', 'TEXT'],
    ['computed_at', 'TIMESTAMP']
  ],
  zone_daily_recommendations: [
    ['zone_uuid', 'TEXT'],
    ['date', 'TEXT'],
    ['recommendation_json', 'JSON']
  ],
  irrigation_events: [
    ['event_uuid', 'TEXT'],
    ['created_at', 'TIMESTAMP'],
    ['action', 'TEXT'],
    ['reason', 'TEXT'],
    ['aggregate_kpa', 'REAL'],
    ['threshold_kpa', 'REAL'],
    ['duration_minutes', 'INTEGER'],
    ['valve_deveui', 'TEXT'],
    ['payload_json', 'JSON']
  ]
};

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function encodeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp ${value}`);
  return date.toISOString();
}

function encodeReal(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid REAL ${value}`);
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(Object.is(number, -0) ? 0 : number, 0);
  return buffer.toString('hex');
}

function encodeInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
  throw new Error(`invalid INTEGER ${value}`);
}

function encodeBoolean(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error(`invalid BOOLEAN ${value}`);
}

function encodeJson(value) {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return canonicalJson(parsed);
}

function encodeValue(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'TEXT') return String(value);
  if (type === 'INTEGER') return encodeInteger(value);
  if (type === 'REAL') return encodeReal(value);
  if (type === 'BOOLEAN') return encodeBoolean(value);
  if (type === 'TIMESTAMP') return encodeTimestamp(value);
  if (type === 'JSON') return encodeJson(value);
  throw new Error(`unsupported hash type ${type}`);
}

function buildCanonicalColumns(tableName, row) {
  const spec = TABLE_COLUMNS[tableName];
  if (!spec) throw new Error(`unsupported history table ${tableName}`);
  return spec.map(([name, type]) => [name, type, encodeValue(type, row[name])]);
}

function hashHistoryRow(tableName, historyKey, row) {
  const input = JSON.stringify({
    hashVersion: 1,
    tableName,
    historyKey,
    columns: buildCanonicalColumns(tableName, row)
  });
  return crypto.createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex');
}

function historyKey(tableName, gatewayEui, row) {
  const gateway = String(gatewayEui || '').trim().toUpperCase();
  if (tableName === 'device_data') return `DEVICE_DATA|${gateway}|${row.id}`;
  if (tableName === 'chameleon_readings') return `CHAMELEON_READING|${gateway}|${row.id}`;
  if (tableName === 'dendrometer_readings') return `DENDRO_READING|${gateway}|${row.id}`;
  if (tableName === 'dendrometer_daily') return `DENDRO_DAILY|${row.deveui}|${row.date}`;
  if (tableName === 'zone_daily_environment') return `ZONE_ENVIRONMENT|${row.zone_uuid}|${row.date}`;
  if (tableName === 'zone_daily_recommendations') return `ZONE_RECOMMENDATION|${row.zone_uuid}|${row.date}`;
  if (tableName === 'irrigation_events') return `IRRIGATION_EVENT|${row.event_uuid}`;
  throw new Error(`unsupported history table ${tableName}`);
}

function nextRawQuery(tableName) {
  if (!['device_data', 'chameleon_readings', 'dendrometer_readings'].includes(tableName)) {
    throw new Error(`not a raw id-cursor table ${tableName}`);
  }
  return `SELECT * FROM ${tableName} WHERE id > ? ORDER BY id ASC LIMIT ?`;
}

function cursorPatchFromResponse(response) {
  const results = Array.isArray(response.results) ? response.results : [];
  const permanent = results.find((result) => result && result.status === 'REJECTED_PERMANENT');
  const patch = {};
  if (response.ackedThroughId != null) {
    patch.last_acked_id = encodeInteger(response.ackedThroughId);
  } else if (response.ackedThroughKey != null) {
    patch.last_acked_key = String(response.ackedThroughKey);
  }
  if (permanent) {
    patch.last_error = `permanent: ${permanent.reason || 'rejected'}`;
    patch.next_attempt_at = '9999-12-31T00:00:00.000Z';
    return patch;
  }
  if (response.ackedThroughId == null && response.ackedThroughKey == null) {
    return { last_error: 'missing ACK boundary' };
  }
  patch.last_error = null;
  patch.retry_count = 0;
  return patch;
}

function isBackfillComplete(cursor) {
  if (!cursor || cursor.snapshot_high_id == null) return false;
  return BigInt(encodeInteger(cursor.last_acked_id || 0)) >= BigInt(encodeInteger(cursor.snapshot_high_id));
}

function batchPhase(cursor) {
  return isBackfillComplete(cursor) ? 'tail' : 'backfill';
}

function shouldApplyDurableAck(batch, capabilities) {
  return batch &&
    batch.phase !== 'shadow' &&
    capabilities &&
    capabilities.history_mirror_write_v1_confirmed === true;
}

function segmentKey(tableName, row) {
  if (tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings') {
    return `${row.deveui}|${String(row.recorded_at).slice(0, 10)}`;
  }
  if (tableName === 'zone_daily_environment' || tableName === 'zone_daily_recommendations') {
    return `${row.zone_uuid}|${row.date}`;
  }
  if (tableName === 'dendrometer_daily') {
    return `${row.deveui}|${row.date}`;
  }
  throw new Error(`unsupported segment table ${tableName}`);
}

module.exports = {
  buildCanonicalColumns,
  hashHistoryRow,
  historyKey,
  nextRawQuery,
  cursorPatchFromResponse,
  isBackfillComplete,
  batchPhase,
  shouldApplyDurableAck,
  segmentKey
};
