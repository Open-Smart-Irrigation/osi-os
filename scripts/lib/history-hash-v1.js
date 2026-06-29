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

function columnsForHash(row) {
  return row.columns || row.expectedColumns || buildCanonicalColumns(row.tableName, row.sourceRow || row.payload || {});
}

function encodeHashInput(row) {
  return JSON.stringify({
    hashVersion: 1,
    tableName: row.tableName,
    historyKey: row.historyKey,
    columns: columnsForHash(row)
  });
}

function hashRow(row) {
  return crypto.createHash('sha256').update(Buffer.from(encodeHashInput(row), 'utf8')).digest('hex');
}

module.exports = { buildCanonicalColumns, encodeHashInput, hashRow };
