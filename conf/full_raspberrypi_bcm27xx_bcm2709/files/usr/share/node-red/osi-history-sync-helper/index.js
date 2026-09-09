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
  ],
  valve_actuation_expectations: [
    ['expectation_id', 'TEXT'],
    ['device_eui', 'TEXT'],
    ['zone_uuid', 'TEXT'],
    ['commanded_at', 'TIMESTAMP'],
    ['commanded_duration_seconds', 'INTEGER'],
    ['expected_close_at', 'TIMESTAMP'],
    ['estimated_gross_liters', 'REAL'],
    ['volume_source', 'TEXT'],
    ['observed_open_at', 'TIMESTAMP'],
    ['observed_close_at', 'TIMESTAMP'],
    ['reconciliation_state', 'TEXT'],
    ['cancel_reason', 'TEXT'],
    ['valve_channel', 'INTEGER'],
    ['created_at', 'TIMESTAMP']
  ]
};

const TABLE_DEFINITIONS = {
  device_data: {
    cursor: 'id',
    select: 'SELECT * FROM device_data',
    cursorExpression: 'id',
    segmentOwner: 'deveui',
    segmentDate: 'recorded_at'
  },
  chameleon_readings: {
    cursor: 'id',
    select: 'SELECT * FROM chameleon_readings',
    cursorExpression: 'id',
    segmentOwner: 'deveui',
    segmentDate: 'recorded_at'
  },
  dendrometer_readings: {
    cursor: 'id',
    select: 'SELECT * FROM dendrometer_readings',
    cursorExpression: 'id',
    segmentOwner: 'deveui',
    segmentDate: 'recorded_at'
  },
  dendrometer_daily: {
    cursor: 'key',
    select: 'SELECT * FROM dendrometer_daily',
    cursorExpression: "deveui || '|' || date",
    segmentOwner: 'deveui',
    segmentDate: 'date'
  },
  zone_daily_environment: {
    cursor: 'key',
    select: "SELECT zde.*, COALESCE(iz.zone_uuid, 'zone-id:' || zde.zone_id) AS zone_uuid FROM zone_daily_environment zde LEFT JOIN irrigation_zones iz ON iz.id = zde.zone_id AND iz.deleted_at IS NULL",
    cursorExpression: "COALESCE(iz.zone_uuid, 'zone-id:' || zde.zone_id) || '|' || zde.date",
    segmentOwner: 'zone_uuid',
    segmentDate: 'date'
  },
  zone_daily_recommendations: {
    cursor: 'key',
    select: "SELECT zdr.*, COALESCE(iz.zone_uuid, 'zone-id:' || zdr.zone_id) AS zone_uuid FROM zone_daily_recommendations zdr LEFT JOIN irrigation_zones iz ON iz.id = zdr.zone_id AND iz.deleted_at IS NULL",
    cursorExpression: "COALESCE(iz.zone_uuid, 'zone-id:' || zdr.zone_id) || '|' || zdr.date",
    segmentOwner: 'zone_uuid',
    segmentDate: 'date'
  },
  irrigation_events: {
    cursor: 'id',
    select: "SELECT ie.*, COALESCE(iz.zone_uuid, 'zone-id:' || ie.irrigation_zone_id) AS zone_uuid FROM irrigation_events ie LEFT JOIN irrigation_zones iz ON iz.id = ie.irrigation_zone_id AND iz.deleted_at IS NULL",
    cursorExpression: 'ie.id',
    segmentOwner: 'zone_uuid',
    segmentDate: 'created_at'
  },
  valve_actuation_expectations: {
    cursor: 'key',
    select: "SELECT vae.*, COALESCE(iz.zone_uuid, 'zone-id:' || vae.zone_id) AS zone_uuid FROM valve_actuation_expectations vae LEFT JOIN irrigation_zones iz ON iz.id = vae.zone_id AND iz.deleted_at IS NULL",
    cursorExpression: 'vae.expectation_id',
    segmentOwner: 'device_eui',
    segmentDate: 'commanded_at'
  }
};

const TABLE_NAMES = Object.freeze(Object.keys(TABLE_DEFINITIONS));

function definition(tableName) {
  const value = TABLE_DEFINITIONS[tableName];
  if (!value) throw new Error(`unsupported history table ${tableName}`);
  return value;
}

function tableNames() {
  return TABLE_NAMES.slice();
}

function nextTable(currentTable, availableTables = TABLE_NAMES) {
  const available = availableTables.filter((name) => TABLE_DEFINITIONS[name]);
  if (!available.length) throw new Error('history table rotation is empty');
  const currentIndex = available.indexOf(currentTable);
  return available[(currentIndex + 1 + available.length) % available.length];
}

function cursorKind(tableName) {
  return definition(tableName).cursor;
}

function snapshotHighQuery(tableName) {
  const spec = definition(tableName);
  const alias = spec.cursor === 'id' ? 'snapshot_high_id' : 'snapshot_high_key';
  const fallback = spec.cursor === 'id' ? '0' : "''";
  let projectedCursorExpression = 'id';
  if (tableName === 'dendrometer_daily') projectedCursorExpression = "deveui || '|' || date";
  if (tableName === 'zone_daily_environment' || tableName === 'zone_daily_recommendations') {
    projectedCursorExpression = "zone_uuid || '|' || date";
  }
  if (tableName === 'valve_actuation_expectations') {
    projectedCursorExpression = 'expectation_id';
  }
  return `SELECT COALESCE(MAX(${projectedCursorExpression}), ${fallback}) AS ${alias} FROM (${spec.select}) history_source`;
}

function batchQuery(tableName, phase) {
  const spec = definition(tableName);
  const bounded = phase === 'shadow' || phase === 'backfill';
  const upperBound = bounded ? ` AND ${spec.cursorExpression} <= ?` : '';
  return `${spec.select} WHERE ${spec.cursorExpression} > ?${upperBound} ORDER BY ${spec.cursorExpression} ASC LIMIT ?`;
}

function batchQueryParams(tableName, phase, after, snapshotHigh, limit) {
  const bounded = phase === 'shadow' || phase === 'backfill';
  const fallback = cursorKind(tableName) === 'id' ? '0' : '';
  const params = [after == null ? fallback : String(after)];
  if (bounded) params.push(snapshotHigh == null ? fallback : String(snapshotHigh));
  params.push(Number(limit));
  return params;
}

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

function hashHistoryRow(tableName, historyKeyValue, row) {
  const input = JSON.stringify({
    hashVersion: 1,
    tableName,
    historyKey: historyKeyValue,
    columns: buildCanonicalColumns(tableName, row)
  });
  return crypto.createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex');
}

function historyKey(tableName, gatewayEui, row) {
  const gateway = String(gatewayEui || '').trim().toUpperCase();
  if (tableName === 'device_data') return `DEVICE_DATA|${gateway}|${row.id}`;
  if (tableName === 'chameleon_readings') return `CHAMELEON_READING|${gateway}|${row.id}`;
  if (tableName === 'dendrometer_readings') return `DENDRO_READING|${gateway}|${row.id}`;
  if (tableName === 'dendrometer_daily') return `DENDRO_DAILY|${String(row.deveui || '').toUpperCase()}|${row.date}`;
  if (tableName === 'zone_daily_environment') return `ZONE_ENVIRONMENT|${row.zone_uuid}|${row.date}`;
  if (tableName === 'zone_daily_recommendations') return `ZONE_RECOMMENDATION|${row.zone_uuid}|${row.date}`;
  if (tableName === 'irrigation_events') return `IRRIGATION_EVENT|${row.event_uuid}|${row.id}`;
  if (tableName === 'valve_actuation_expectations') {
    return `VALVE_ACTUATION|${gateway}|${row.expectation_id}`;
  }
  throw new Error(`unsupported history table ${tableName}`);
}

function naturalKey(tableName, row) {
  if (tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings') {
    return `${String(row.deveui || '').toUpperCase()}|${encodeTimestamp(row.recorded_at)}|${encodeInteger(row.id)}`;
  }
  if (tableName === 'dendrometer_daily') {
    return `${String(row.deveui || '').toUpperCase()}|${row.date}`;
  }
  if (tableName === 'zone_daily_environment' || tableName === 'zone_daily_recommendations') {
    return `${row.zone_uuid}|${row.date}`;
  }
  if (tableName === 'irrigation_events') return String(row.event_uuid || '');
  if (tableName === 'valve_actuation_expectations') return String(row.expectation_id || '');
  throw new Error(`unsupported history table ${tableName}`);
}

function cursorValue(tableName, row) {
  if (cursorKind(tableName) === 'id') return encodeInteger(row.id);
  if (tableName === 'dendrometer_daily') return `${row.deveui}|${row.date}`;
  if (tableName === 'zone_daily_environment' || tableName === 'zone_daily_recommendations') {
    return `${row.zone_uuid}|${row.date}`;
  }
  if (tableName === 'valve_actuation_expectations') return String(row.expectation_id || '');
  throw new Error(`unsupported cursor table ${tableName}`);
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

function isCursorComplete(tableName, cursor, shadow) {
  const spec = definition(tableName);
  if (spec.cursor === 'id') {
    if (cursor.snapshot_high_id == null) return false;
    const ack = shadow ? cursor.last_shadow_acked_id : cursor.last_acked_id;
    return BigInt(encodeInteger(ack || 0)) >= BigInt(encodeInteger(cursor.snapshot_high_id));
  }
  if (cursor.snapshot_high_key == null) return false;
  const ack = shadow ? cursor.last_shadow_acked_key : cursor.last_acked_key;
  return String(ack || '') >= String(cursor.snapshot_high_key || '');
}

function batchPhase(cursor) {
  return isBackfillComplete(cursor) ? 'tail' : 'backfill';
}

function serverConfirmsDurable(response) {
  return !!response && response.durableMirrorConfirmed === true;
}

function shouldApplyDurableAck(batch, response) {
  if (!batch || batch.phase === 'shadow' || !serverConfirmsDurable(response)) return false;
  return String(response.phase || '').toLowerCase() === String(batch.phase || '').toLowerCase();
}

function day(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value);
  return encodeTimestamp(value).slice(0, 10);
}

function segmentKey(tableName, row) {
  const spec = definition(tableName);
  const owner = String(row[spec.segmentOwner] || '').trim();
  if (!owner) throw new Error(`missing ${spec.segmentOwner} for ${tableName}`);
  const segmentOwner = spec.segmentOwner === 'zone_uuid' ? owner : owner.toUpperCase();
  return `${segmentOwner}|${day(row[spec.segmentDate])}`;
}

function segmentHash(rows) {
  const digest = crypto.createHash('sha256');
  rows.slice()
    .sort((left, right) => String(left.historyKey).localeCompare(String(right.historyKey)))
    .forEach((row) => {
      digest.update(String(row.historyKey), 'utf8');
      digest.update(Buffer.from([0]));
      digest.update(String(row.payloadHash), 'utf8');
      digest.update('\n', 'utf8');
    });
  return digest.digest('hex');
}

function quarantineHash(tableName, historyKeyValue, error) {
  return crypto.createHash('sha256')
    .update(`QUARANTINE\0${tableName}\0${historyKeyValue}\0${String(error && error.message || error)}`, 'utf8')
    .digest('hex');
}

function prepareRow(tableName, gatewayEui, row) {
  const key = historyKey(tableName, gatewayEui, row);
  try {
    return {
      historyKey: key,
      naturalKey: naturalKey(tableName, row),
      payloadHash: hashHistoryRow(tableName, key, row),
      payload: row,
      quarantineReason: null
    };
  } catch (error) {
    return {
      historyKey: key,
      naturalKey: key,
      payloadHash: quarantineHash(tableName, key, error),
      payload: row,
      quarantineReason: String(error && error.message || error)
    };
  }
}

function buildSegment(tableName, gatewayEui, key, rows) {
  const prepared = rows.map((row) => prepareRow(tableName, gatewayEui, row));
  const syncable = prepared.filter((row) => !row.quarantineReason);
  const quarantine = prepared.filter((row) => row.quarantineReason);
  return {
    manifest: {
      tableName,
      segmentKey: key,
      hashVersion: 1,
      canonicalRowCount: prepared.length,
      syncableRowCount: syncable.length,
      quarantinedCount: quarantine.length,
      tombstoneCount: 0,
      syncablePayloadHash: segmentHash(syncable)
    },
    quarantine
  };
}

function splitOwnerAndDay(key) {
  const separator = String(key || '').lastIndexOf('|');
  if (separator <= 0) throw new Error(`invalid segment key ${key}`);
  return [String(key).slice(0, separator), String(key).slice(separator + 1)];
}

function segmentQuery(tableName, key) {
  const [owner, segmentDay] = splitOwnerAndDay(key);
  if (tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings') {
    return {
      sql: `SELECT * FROM ${tableName} WHERE upper(deveui) = ? AND substr(recorded_at, 1, 10) = ? ORDER BY id ASC`,
      params: [owner.toUpperCase(), segmentDay]
    };
  }
  if (tableName === 'dendrometer_daily') {
    return {
      sql: 'SELECT * FROM dendrometer_daily WHERE upper(deveui) = ? AND date = ? ORDER BY deveui, date',
      params: [owner.toUpperCase(), segmentDay]
    };
  }
  if (tableName === 'zone_daily_environment' || tableName === 'zone_daily_recommendations') {
    const alias = tableName === 'zone_daily_environment' ? 'zde' : 'zdr';
    return {
      sql: `${definition(tableName).select} WHERE COALESCE(iz.zone_uuid, 'zone-id:' || ${alias}.zone_id) = ? AND ${alias}.date = ? ORDER BY ${alias}.date`,
      params: [owner, segmentDay]
    };
  }
  if (tableName === 'irrigation_events') {
    return {
      sql: `${definition(tableName).select} WHERE COALESCE(iz.zone_uuid, 'zone-id:' || ie.irrigation_zone_id) = ? AND substr(ie.created_at, 1, 10) = ? ORDER BY ie.id ASC`,
      params: [owner, segmentDay]
    };
  }
  if (tableName === 'valve_actuation_expectations') {
    return {
      sql: `${definition(tableName).select} WHERE upper(vae.device_eui) = ? AND substr(vae.commanded_at, 1, 10) = ? ORDER BY vae.expectation_id ASC`,
      params: [owner.toUpperCase(), segmentDay]
    };
  }
  throw new Error(`unsupported segment table ${tableName}`);
}

function rowByHistoryKeyQuery(tableName, key) {
  const parts = String(key || '').split('|');
  if (tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings') {
    return {
      sql: `${definition(tableName).select} WHERE id = ? LIMIT 1`,
      params: [parts[parts.length - 1]]
    };
  }
  if (tableName === 'dendrometer_daily') {
    return {
      sql: 'SELECT * FROM dendrometer_daily WHERE upper(deveui) = ? AND date = ? LIMIT 1',
      params: [parts[1].toUpperCase(), parts[2]]
    };
  }
  if (tableName === 'zone_daily_environment' || tableName === 'zone_daily_recommendations') {
    const alias = tableName === 'zone_daily_environment' ? 'zde' : 'zdr';
    return {
      sql: `${definition(tableName).select} WHERE COALESCE(iz.zone_uuid, 'zone-id:' || ${alias}.zone_id) = ? AND ${alias}.date = ? LIMIT 1`,
      params: [parts[1], parts[2]]
    };
  }
  if (tableName === 'irrigation_events') {
    return {
      sql: `${definition(tableName).select} WHERE ie.id = ? LIMIT 1`,
      params: [parts[parts.length - 1]]
    };
  }
  if (tableName === 'valve_actuation_expectations') {
    return {
      sql: `${definition(tableName).select} WHERE vae.expectation_id = ? LIMIT 1`,
      params: [parts.slice(2).join('|')]
    };
  }
  throw new Error(`unsupported dirty-key table ${tableName}`);
}

module.exports = {
  tableNames,
  nextTable,
  cursorKind,
  snapshotHighQuery,
  batchQuery,
  batchQueryParams,
  buildCanonicalColumns,
  hashHistoryRow,
  historyKey,
  naturalKey,
  cursorValue,
  nextRawQuery,
  cursorPatchFromResponse,
  isBackfillComplete,
  isCursorComplete,
  batchPhase,
  serverConfirmsDurable,
  shouldApplyDurableAck,
  segmentKey,
  segmentHash,
  prepareRow,
  buildSegment,
  segmentQuery,
  rowByHistoryKeyQuery
};
