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
  zone_daily_recommendations: [
    ['zone_uuid', 'TEXT'],
    ['date', 'TEXT'],
    ['recommendation_json', 'JSON']
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

function encodeJson(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return canonicalJson(parsed);
}

function encodeValue(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'TEXT') return String(value);
  if (type === 'INTEGER') return String(Number.parseInt(value, 10));
  if (type === 'REAL') return encodeReal(value);
  if (type === 'BOOLEAN') return !!Number(value);
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
