const crypto = require('crypto');
const { performance } = require('node:perf_hooks');

const TABLE_COLUMNS = {
  tensiomark_observations: [
    ['id', 'INTEGER'], ['device_data_id', 'INTEGER'], ['deveui', 'TEXT'],
    ['recorded_at', 'TIMESTAMP'], ['received_at', 'TIMESTAMP'],
    ['raw_response_hex', 'TEXT'], ['payload_base64', 'TEXT'],
    ['configuration_hash', 'TEXT'], ['configuration_json', 'TEXT'],
    ['disposition', 'TEXT'], ['normalized_json', 'TEXT']
  ],
  radio_uplinks: [
    ['id', 'INTEGER'], ['installation_uuid', 'TEXT'], ['deveui', 'TEXT'],
    ['recorded_at', 'TIMESTAMP'], ['deduplication_id', 'TEXT'], ['metadata_json', 'JSON']
  ],
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
  radio_uplinks: {
    cursor: 'id', select: 'SELECT * FROM radio_uplinks', cursorExpression: 'id',
    segmentOwner: 'deveui', segmentDate: 'recorded_at'
  },
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

// SQL hex reads every stored byte, including NUL that some SQLite bindings
// truncate when returning TEXT. Every observation query uses this projection.
TABLE_DEFINITIONS.tensiomark_observations = {
  cursor: 'id',
  select: 'SELECT id,device_data_id,deveui,recorded_at,received_at,hex(CAST(raw_response AS BLOB)) AS raw_response_hex,payload_base64,configuration_hash,configuration_json,disposition,normalized_json FROM tensiomark_observations',
  cursorExpression: 'id', segmentOwner: 'deveui', segmentDate: 'recorded_at'
};

const TABLE_NAMES = Object.freeze(Object.keys(TABLE_DEFINITIONS));

function definition(tableName) {
  const value = TABLE_DEFINITIONS[tableName];
  if (!value) throw new Error(`unsupported history table ${tableName}`);
  return value;
}

function tableNames(options = {}) {
  return TABLE_NAMES.filter(name => name !== 'radio_uplinks' || options.includeRadio === true);
}

function nextTable(currentTable, availableTables = tableNames()) {
  const available = availableTables.filter((name) => TABLE_DEFINITIONS[name]);
  if (!available.length) throw new Error('history table rotation is empty');
  const currentIndex = available.indexOf(currentTable);
  return available[(currentIndex + 1 + available.length) % available.length];
}

function cursorKind(tableName) {
  return definition(tableName).cursor;
}

function edgeV1WireInstantSql(valueSql) {
  const value = `(${valueSql})`;
  const digits = `replace(replace(replace(replace(replace(${value},'-',''),'T',''),':',''),'.',''),'Z','')`;
  const year = `CAST(substr(${value},1,4) AS INTEGER)`;
  const month = `CAST(substr(${value},6,2) AS INTEGER)`;
  const day = `CAST(substr(${value},9,2) AS INTEGER)`;
  const maxDay = `CASE ${month}
    WHEN 1 THEN 31
    WHEN 2 THEN 28 + CASE WHEN (${year}%400=0 OR (${year}%4=0 AND ${year}%100<>0)) THEN 1 ELSE 0 END
    WHEN 3 THEN 31 WHEN 4 THEN 30 WHEN 5 THEN 31 WHEN 6 THEN 30
    WHEN 7 THEN 31 WHEN 8 THEN 31 WHEN 9 THEN 30 WHEN 10 THEN 31
    WHEN 11 THEN 30 WHEN 12 THEN 31 ELSE 0 END`;
  return `typeof(${value})='text'
    AND (length(${value})=20 OR (length(${value}) BETWEEN 22 AND 30 AND substr(${value},20,1)='.'))
    AND substr(${value},5,1)='-'
    AND substr(${value},8,1)='-'
    AND substr(${value},11,1)='T'
    AND substr(${value},14,1)=':'
    AND substr(${value},17,1)=':'
    AND substr(${value},-1,1)='Z'
    AND ${digits} NOT GLOB '*[^0-9]*'
    AND ${month} BETWEEN 1 AND 12
    AND ${day} BETWEEN 1 AND (${maxDay})
    AND CAST(substr(${value},12,2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(${value},15,2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(${value},18,2) AS INTEGER) BETWEEN 0 AND 59`;
}

function v1LegacyCompatibilitySql(alias = 'vae') {
  const transport = `${alias}.transport_json`;
  const markerType = `json_type(${transport}, '$.physical_run')`;
  const compatType = `json_type(${transport}, '$.physical_run.legacy_v1_compatibility')`;
  const bound = (path, column) => `(
    (json_type(${transport}, '${path}') = 'null')
    OR (json_type(${transport}, '${path}') = 'text' AND ${edgeV1WireInstantSql(`json_extract(${transport}, '${path}')`)})
  )`;
  const terms = `(
    ${alias}.command_id IS NULL
    AND ${alias}.trigger = 'on_valve_schedule'
    AND typeof(${alias}.commanded_duration_seconds) = 'integer'
    AND ${alias}.commanded_duration_seconds > 0
    AND ${alias}.commanded_duration_seconds <= 9007199254740991
    AND ${edgeV1WireInstantSql(`${alias}.commanded_at`)}
    AND ${edgeV1WireInstantSql(`${alias}.expected_close_at`)}
    AND json_valid(${transport}) = 1
    AND json_type(${transport}) = 'object'
    AND ${markerType} = 'object'
    AND json_extract(${transport}, '$.physical_run.version') = 1
    AND json_type(${transport}, '$.physical_run.version') = 'integer'
    AND json_extract(${transport}, '$.physical_run.source') = 'explicit_report'
    AND json_type(${transport}, '$.physical_run.source') = 'text'
    AND ${bound('$.physical_run.earliest_possible_start_at', `${alias}.commanded_at`)}
    AND ${bound('$.physical_run.latest_possible_end_at', `${alias}.expected_close_at`)}
    AND ${compatType} = 'object'
    AND json_extract(${transport}, '$.physical_run.legacy_v1_compatibility.version') = 1
    AND json_type(${transport}, '$.physical_run.legacy_v1_compatibility.version') = 'integer'
    AND json_extract(${transport}, '$.physical_run.legacy_v1_compatibility.source') = 'preexisting_on_valve_schedule'
    AND json_type(${transport}, '$.physical_run.legacy_v1_compatibility.source') = 'text'
    AND json_type(${transport}, '$.physical_run.legacy_v1_compatibility.expectation_id') = 'text'
    AND json_extract(${transport}, '$.physical_run.legacy_v1_compatibility.expectation_id') = ${alias}.expectation_id
    AND json_type(${transport}, '$.physical_run.legacy_v1_compatibility.commanded_at') = 'text'
    AND json_extract(${transport}, '$.physical_run.legacy_v1_compatibility.commanded_at') = ${alias}.commanded_at
    AND json_type(${transport}, '$.physical_run.legacy_v1_compatibility.commanded_duration_seconds') = 'integer'
    AND json_extract(${transport}, '$.physical_run.legacy_v1_compatibility.commanded_duration_seconds') = ${alias}.commanded_duration_seconds
    AND json_type(${transport}, '$.physical_run.legacy_v1_compatibility.expected_close_at') = 'text'
    AND json_extract(${transport}, '$.physical_run.legacy_v1_compatibility.expected_close_at') = ${alias}.expected_close_at
  )`;
  return `(CASE WHEN json_valid(${transport}) = 0 THEN 0 WHEN json_type(${transport}) <> 'object' THEN 0 ELSE COALESCE(${terms}, 0) END = 1)`;
}

function v1LocalOnlyPredicate(alias = 'vae') {
  const transport = `${alias}.transport_json`;
  const safetyReportOnly = `CASE
    WHEN ${transport} IS NULL OR ${transport} = '' THEN 0
    WHEN json_valid(${transport}) = 0 THEN 1
    WHEN json_type(${transport}) <> 'object' THEN 1
    WHEN COALESCE(json_type(${transport}, '$.physical_run'), 'null') <> 'null' THEN 1
    ELSE 0 END`;
  const compatibility = v1LegacyCompatibilitySql(alias);
  return `(${alias}.command_id IS NULL AND (
    (${alias}.commanded_duration_seconds = -1 AND ${alias}.expected_close_at = '')
    OR (${safetyReportOnly} = 1 AND NOT ${compatibility})
  ))`;
}

function v1ReplicationPredicate(alias = 'vae') {
  return `NOT ${v1LocalOnlyPredicate(alias)}`;
}

function appendConditions(select, conditions) {
  const list = (Array.isArray(conditions) ? conditions : [conditions]).filter(Boolean);
  return select + (list.length ? ' WHERE ' + list.join(' AND ') : '');
}

function filteredSelect(tableName, conditions = []) {
  const spec = definition(tableName);
  const predicate = tableName === 'valve_actuation_expectations' ? v1ReplicationPredicate('vae') : null;
  return appendConditions(spec.select, [predicate, ...(Array.isArray(conditions) ? conditions : [conditions])]);
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
  return `SELECT COALESCE(MAX(${projectedCursorExpression}), ${fallback}) AS ${alias} FROM (${filteredSelect(tableName)}) history_source`;
}

function batchQuery(tableName, phase) {
  const spec = definition(tableName);
  const bounded = phase === 'shadow' || phase === 'backfill';
  const upperBound = bounded ? ` AND ${spec.cursorExpression} <= ?` : '';
  return `${filteredSelect(tableName, [`${spec.cursorExpression} > ?${upperBound}`])} ORDER BY ${spec.cursorExpression} ASC LIMIT ?`;
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
  if (tableName === 'radio_uplinks') return `RADIO_UPLINK|${gateway}|${row.id}`;
  if (tableName === 'device_data') return `DEVICE_DATA|${gateway}|${row.id}`;
  if (tableName === 'tensiomark_observations') return `TENSIOMARK_OBSERVATION|${gateway}|${row.id}`;
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
  if (tableName === 'radio_uplinks') return `${row.installation_uuid}|${row.deduplication_id}`;
  if (tableName === 'radio_uplinks' || tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings' || tableName === 'tensiomark_observations') {
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
  if (!['radio_uplinks', 'device_data', 'chameleon_readings', 'dendrometer_readings', 'tensiomark_observations'].includes(tableName)) {
    throw new Error(`not a raw id-cursor table ${tableName}`);
  }
  return `${definition(tableName).select} WHERE id > ? ORDER BY id ASC LIMIT ?`;
}

function normalizeValveAckKey(value, gatewayEui) {
  if (value == null) return null;
  const raw = String(value);
  if (!raw) return null;
  if (!raw.startsWith('VALVE_ACTUATION|')) return raw;
  const gateway = String(gatewayEui || '').trim().toUpperCase();
  const prefix = `VALVE_ACTUATION|${gateway}|`;
  if (!gateway || !raw.startsWith(prefix)) return null;
  const suffix = raw.slice(prefix.length);
  return suffix ? suffix : null;
}

function normalizeCursor(tableName, cursor, gatewayEui) {
  const value = Object.assign({}, cursor || {});
  if (tableName !== 'valve_actuation_expectations') return value;
  for (const field of ['last_shadow_acked_key', 'last_acked_key']) {
    if (value[field] != null) value[field] = normalizeValveAckKey(value[field], gatewayEui);
  }
  return value;
}

function normalizedValveCursorSql(column = 'last_acked_key') {
  return `CASE WHEN ${column} GLOB 'VALVE_ACTUATION|*' THEN CASE WHEN ${column} GLOB 'VALVE_ACTUATION|'||?||'|*' THEN substr(${column},length('VALVE_ACTUATION|'||?||'|')+1) ELSE '' END ELSE ${column} END`;
}

// Compare a valid incoming raw suffix against the durable cursor atomically.
// Exact current-gateway prefixes canonicalize to their raw suffix even when
// the incoming ACK is equal or older. Invalid loaded prefixes normalize to the
// empty replay boundary and never hide progress from the exact validator.
function monotonicValveCursorSql(column = 'last_acked_key') {
  const normalized = normalizedValveCursorSql(column);
  return `CASE WHEN ${column} IS NULL OR ?>(${normalized}) THEN ? WHEN ${column} GLOB 'VALVE_ACTUATION|'||?||'|*' THEN (${normalized}) ELSE ${column} END`;
}

function cursorPatchFromResponse(response, options = {}) {
  const results = Array.isArray(response.results) ? response.results : [];
  const permanent = results.find((result) => result && result.status === 'REJECTED_PERMANENT');
  const patch = {};
  if (response.ackedThroughId != null) {
    patch.last_acked_id = encodeInteger(response.ackedThroughId);
  } else if (response.ackedThroughKey != null) {
    const ackedKey = options.tableName === 'valve_actuation_expectations'
      ? normalizeValveAckKey(response.ackedThroughKey, options.gatewayEui)
      : String(response.ackedThroughKey);
    if (ackedKey == null) {
      patch.last_error = 'invalid ACK boundary';
      return patch;
    }
    patch.last_acked_key = ackedKey;
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

// Cloud reasons that condemn one submitted row, not the protocol, table or
// phase. Only these may set a dirty key aside; any other permanent answer
// keeps the table backed off.
const ROW_REJECTION_REASONS = new Set(['hash_mismatch', 'out_of_order_history_key']);

function rowRejection(response) {
  const results = response && Array.isArray(response.results) ? response.results : [];
  const permanent = results.find((result) => result && result.status === 'REJECTED_PERMANENT');
  if (!permanent || !ROW_REJECTION_REASONS.has(String(permanent.reason || ''))) return null;
  return { historyKey: String(permanent.historyKey || ''), reason: String(permanent.reason) };
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
  if (tableName === 'valve_actuation_expectations') {
    const valveControl = require('../osi-valve-control');
    if (typeof valveControl.isV1LocalOnlyExpectation !== 'function') {
      throw new Error('ValveActuation v1 classifier unavailable');
    }
    if (valveControl.isV1LocalOnlyExpectation(row)) {
      throw new Error('ValveActuation v1 local-only row reached durable history canonicalizer');
    }
  }
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
  return buildPreparedSegment(tableName, key, rows.map((row) => prepareRow(tableName, gatewayEui, row)));
}

function buildPreparedSegment(tableName, key, prepared) {
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
  if (tableName === 'radio_uplinks' || tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings' || tableName === 'tensiomark_observations') {
    return {
      sql: `${definition(tableName).select} WHERE upper(deveui) = ? AND substr(recorded_at, 1, 10) = ? ORDER BY id ASC`,
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
      sql: `${filteredSelect(tableName, ["upper(vae.device_eui) = ?", "substr(vae.commanded_at, 1, 10) = ?"])} ORDER BY vae.expectation_id ASC`,
      params: [owner.toUpperCase(), segmentDay]
    };
  }
  throw new Error(`unsupported segment table ${tableName}`);
}

function rowByHistoryKeyQuery(tableName, key) {
  const parts = String(key || '').split('|');
  if (tableName === 'radio_uplinks' || tableName === 'device_data' || tableName === 'chameleon_readings' || tableName === 'dendrometer_readings' || tableName === 'tensiomark_observations') {
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

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

// The text after the last '|' as Java's Long.parseLong reads it, or null.
function historyKeyLong(key) {
  const text = String(key || '');
  const pos = text.lastIndexOf('|');
  if (pos < 0) return null;
  const tail = text.slice(pos + 1);
  if (!/^[+-]?\d+$/.test(tail)) return null;
  const value = BigInt(tail);
  return value < LONG_MIN || value > LONG_MAX ? null : value;
}

// Mirrors the cloud's batch order check for every table: two keys compare
// numerically when both tails parse as a Long (row ids, and valve expectation
// ids that are cloud command ids), otherwise by code unit over the whole key.
function compareHistoryKeys(tableName, left, right) {
  definition(tableName);
  const leftId = historyKeyLong(left), rightId = historyKeyLong(right);
  if (leftId !== null && rightId !== null) return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  const leftKey = String(left || ''), rightKey = String(right || '');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}



// Cooperative row-loading budget; a slow SQLite read may finish after the deadline.
async function loadDirtyRows({ q, sourceQuery, tableName, now, skipRepair, valveControl, node, setSyncState, run, clock = () => performance.now() }) {
  const started = clock();
  const dirty = await q(
    "SELECT * FROM sync_history_dirty_keys WHERE peer_node='cloud' AND table_name=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (? = 0 OR change_kind <> 'repair') ORDER BY changed_at, row_key LIMIT ?",
    [tableName, now, skipRepair ? 1 : 0, 250]
  );
  if (dirty.length) {
    const changeKind = String(dirty[0].change_kind || 'correction');
    const selected = dirty.slice(0, changeKind === 'repair' ? 250 : 50).filter((entry) => String(entry.change_kind || 'correction') === changeKind).sort((left, right) => compareHistoryKeys(tableName, left.row_key, right.row_key));
    const rows = [];
    const dirtyKeys = [];
    const dirtyVersions = {};
    let dropped = 0;
    let visited = 0;
    try {
      for (const entry of selected) {
        if (visited++ > 0 && clock() - started >= 200) break;
        const lookup = rowByHistoryKeyQuery(tableName, entry.row_key);
        const found = await sourceQuery(tableName,lookup.sql, lookup.params);
        if (!found.length) {
          const gone = await q(
            "UPDATE sync_history_dirty_keys SET status='dropped', attempts=attempts+1, last_error='source row missing', next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=? AND row_key=? AND status='pending' AND changed_at=? RETURNING row_key",
            [tableName, entry.row_key, entry.changed_at]
          );
          dropped += gone.length;
          continue;
        }
        const sourceRow = found[0];
        if (tableName === 'valve_actuation_expectations' && valveControl.isV1LocalOnlyExpectation(sourceRow)) {
          const localOnlyPredicate = v1LocalOnlyPredicate('vae');
          await run(
            "UPDATE sync_history_dirty_keys SET status='done', last_error=NULL, next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=? AND row_key=? AND status='pending' AND changed_at=? AND EXISTS(SELECT 1 FROM valve_actuation_expectations vae WHERE vae.expectation_id=? AND " + localOnlyPredicate + ")",
            [tableName, entry.row_key, entry.changed_at, sourceRow.expectation_id]
          );
          continue;
        }
        rows.push(sourceRow);
        dirtyKeys.push(entry.row_key);
        dirtyVersions[entry.row_key] = entry.changed_at;
      }
    } finally {
      // Each drop commits on its own: log them even when a later lookup throws.
      if (dropped) {
        node.warn('Build History Batch: dropped ' + dropped + ' queued ' + tableName + ' key(s): source row missing');
        setSyncState({ lastHistoryDroppedMissing: { at: now, table: tableName, count: dropped }, updatedAt: now });
      }
    }
    return { rows, dirtyKeys, dirtyVersions, changeKind };
  }
  return null;
}

async function completeDirtyBatch({ batch, response, tableName, gatewayEui, sourceQuery, db, now = new Date().toISOString(), manifestClock }) {
  const accepted = new Set((response.results || [])
    .filter((result) => ['APPLIED', 'UPDATED', 'DUPLICATE', 'QUARANTINED'].includes(result && result.status))
    .map((result) => String(result.historyKey || '')));
  const completed = new Map();
  for (const [submitted, rowKeys] of Object.entries(batch.dirtyRowKeysByHistoryKey || {})) {
    if (accepted.has(submitted)) for (const rowKey of rowKeys || []) completed.set(String(rowKey), submitted);
  }
  for (const dirtyKey of batch.dirtyKeys || []) {
    if (accepted.has(String(dirtyKey)) && !completed.has(String(dirtyKey))) completed.set(String(dirtyKey), String(dirtyKey));
  }
  if (!completed.size) return;
  // Radio reads can resolve the installation through farming.db. Do them before
  // acquiring its queue, avoiding a recursive queued read inside a transaction.
  const radioRows = new Map();
  if (tableName === 'radio_uplinks') for (const submitted of new Set(completed.values())) {
    const lookup = rowByHistoryKeyQuery(tableName, submitted);
    radioRows.set(submitted, await sourceQuery(tableName, lookup.sql, lookup.params));
  }
  await db.transaction(async tx => {
    for (const [dirtyKey, submitted] of completed) {
      const version = (batch.dirtyVersions || {})[dirtyKey];
      const hash = (batch.dirtyPayloadHashes || {})[submitted];
      // Batches built before this version lack a fence; leave them pending for replay.
      if (version == null || !hash) continue;
      const lookup = rowByHistoryKeyQuery(tableName, submitted);
      const rows = tableName === 'radio_uplinks' ? radioRows.get(submitted) : await tx.all(lookup.sql, lookup.params);
      if (!rows.length || prepareRow(tableName, gatewayEui, rows[0]).payloadHash !== hash) continue;
      await tx.run(
        "UPDATE sync_history_dirty_keys SET status='done', last_error=NULL, next_attempt_at=NULL WHERE peer_node='cloud' AND table_name=? AND row_key=? AND status='pending' AND changed_at=?" + (tableName === 'radio_uplinks' ? " AND EXISTS(SELECT 1 FROM radio_history_bridge rb WHERE rb.history_key=sync_history_dirty_keys.row_key AND rb.generation=?)" : ''),
        [tableName, dirtyKey, version].concat(tableName === 'radio_uplinks' ? [(batch.dirtyGenerations || {})[submitted] ?? -1] : [])
      );
    }
    for (const segment of batch.segmentKeys || []) {
      const key = 'history_repair_segment:' + JSON.stringify([tableName, segment]);
      const value = await tx.get('SELECT value FROM app_settings WHERE key=?', [key]);
      if (!value) continue;
      const state = repairState(value.value);
      state.lastAckAt = now;
      if (manifestClock) state.ackFence = manifestClock;
      await saveRepairState(tx, key, state, now);
    }
  });
}

function summarizeQuickCheck(rows) {
  const detail = (rows || []).map((row) => {
    if (!row || typeof row !== 'object') return String(row || '');
    if (Object.prototype.hasOwnProperty.call(row, 'quick_check')) return String(row.quick_check || '');
    if (Object.prototype.hasOwnProperty.call(row, 'integrity_check')) return String(row.integrity_check || '');
    const firstKey = Object.keys(row)[0];
    return firstKey ? String(row[firstKey] || '') : '';
  }).filter(Boolean);
  if (!detail.length) return { status: 'ok', detail: [] };
  if (detail.length === 1 && detail[0].toLowerCase() === 'ok') return { status: 'ok', detail: [] };
  return { status: 'issues', detail };
}

async function pendingRepairCounts(q) {
  const counts = Object.fromEntries(TABLE_NAMES.map(table => [table, 0]));
  const rows = await q("SELECT table_name,COUNT(*) AS n FROM sync_history_dirty_keys INDEXED BY idx_sync_history_pending WHERE peer_node='cloud' AND change_kind='repair' AND status='pending' GROUP BY table_name");
  for (const row of rows) if (TABLE_NAMES.includes(row.table_name)) counts[row.table_name] = Number(row.n);
  return counts;
}

// The checkpoint identifies the segment generation whose repairs were queued.
// Keep it separate from sync_history_segments: ACKs recompute that local cache,
// which is not evidence that a partial segment was delivered to the cloud.
const MANIFEST_REPAIR_LIMITS = Object.freeze({ segments: 32, rows: 2000, oversizedRows: 10000, milliseconds: 2000, rounds: 3 });
const REPAIR_QUARANTINE_REASON = 'manifest_repair_exhausted';

function manifestFingerprint(manifest) {
  return JSON.stringify([manifest.hashVersion, manifest.canonicalRowCount, manifest.syncablePayloadHash, manifest.quarantinedCount, manifest.tombstoneCount]);
}

function captureManifestRequest(flow, payload, target = {}, link = {}) {
  const scope = crypto.createHash('sha256').update(JSON.stringify([payload.gatewayDeviceEui, link.server_url || target.server_url || null, link.cloud_user_id ?? null, target.id ?? null, target.server_linked_at ?? null])).digest('hex');
  const previous = flow.get('history_manifest_clock');
  const clock = previous ? { epoch: previous.epoch, sequence: previous.sequence + 1, scope }
    : { epoch: crypto.randomUUID(), sequence: 1, scope };
  flow.set('history_manifest_clock', clock);
  return { clock, scope, generatedAt: payload.generatedAt, segments: payload.segments };
}

function repairState(value) {
  if (!value || value === 'matched') return { version: 2, round: 0 };
  const parsed = JSON.parse(value);
  // The original draft's array only identified local content, not cloud parity.
  return parsed && !Array.isArray(parsed) && parsed.version === 2 ? parsed : { version: 2, round: 0 };
}

function obsoleteManifest(request, state, currentClock) {
  const clock = request.clock;
  if (clock && currentClock && (clock.epoch !== currentClock.epoch || (request.scope && currentClock.scope && request.scope !== currentClock.scope))) return true;
  if (clock) return [state.lastRequest, state.ackFence].some(fence => fence && fence.epoch === clock.epoch && clock.sequence <= fence.sequence);
  return !!state.lastAckAt && Date.parse(request.generatedAt) <= Date.parse(state.lastAckAt);
}

async function saveRepairState(tx, key, state, now) {
  await tx.run('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', [key, JSON.stringify(state), now]);
}

async function quarantineRepair(tx, table, segment, state, now) {
  const historyKey = 'REPAIR_SEGMENT|' + segment;
  const hash = state.fingerprint ? crypto.createHash('sha256').update(state.fingerprint).digest('hex') : null;
  await tx.run("INSERT INTO sync_history_quarantine(peer_node,table_name,history_key,payload_hash,reason,first_seen_at,last_seen_at,attempts) VALUES('cloud',?,?,?,?,?,?,?) ON CONFLICT(peer_node,table_name,history_key) DO UPDATE SET payload_hash=excluded.payload_hash,reason=excluded.reason,last_seen_at=excluded.last_seen_at,attempts=excluded.attempts", [table, historyKey, hash, REPAIR_QUARANTINE_REASON, now, now, Math.max(state.round || 0, state.budgetFailures || 0)]);
}

async function clearRepairQuarantine(tx, table, segment) {
  await tx.run("DELETE FROM sync_history_quarantine WHERE peer_node='cloud' AND table_name=? AND history_key=? AND reason=?", [table, 'REPAIR_SEGMENT|' + segment, REPAIR_QUARANTINE_REASON]);
}

async function unresolvedRepairCounts(q) {
  const counts = Object.fromEntries(TABLE_NAMES.map(table => [table, 0]));
  const rows = await q("SELECT table_name,COUNT(*) AS n FROM sync_history_quarantine INDEXED BY idx_sync_history_repair_unresolved WHERE peer_node='cloud' AND reason='manifest_repair_exhausted' GROUP BY table_name");
  for (const row of rows) if (TABLE_NAMES.includes(row.table_name)) counts[row.table_name] = Number(row.n);
  return counts;
}

async function repairProgress(q) {
  return { historyRepairPendingByTable: await pendingRepairCounts(q), historyRepairUnresolvedByTable: await unresolvedRepairCounts(q) };
}

async function queueManifestRepairs({ comparisons, db, q, sourceQuery, now, gatewayEui, request = null, currentClock = null, clock = () => performance.now() }) {
  const REPAIR_CAP = 2000;
  request = request || { generatedAt: now };
  if (comparisons.length > 500) throw new Error('history manifest answer exceeds 500 segments');
  const sentSegments = new Map((request.segments || []).map(segment => [JSON.stringify([segment.tableName,segment.segmentKey]),segment]));
  const started = clock();
  const deadline = () => {
    if (clock() - started >= MANIFEST_REPAIR_LIMITS.milliseconds) {
      const error = new Error('manifest work deadline'); error.code = 'MANIFEST_BUDGET'; throw error;
    }
  };
  const pageKey = 'history_repair_cursor:' + crypto.createHash('sha256').update(JSON.stringify([request.scope || null, comparisons.map(c => c && [c.tableName,c.segmentKey])])).digest('hex');
  const saved = (await q('SELECT value FROM app_settings WHERE key=?', [pageKey]))[0];
  let index = saved ? Number(saved.value) : 0;
  if (!Number.isInteger(index) || index < 0 || index >= comparisons.length) index = 0;
  let repairCount = 0, repairSkipped = 0, examinedRows = 0, examinedSegments = 0, quarantinedSegments = 0;
  const pendingRepair = {};
  while (index < comparisons.length && examinedSegments < MANIFEST_REPAIR_LIMITS.segments) {
    if (clock() - started >= MANIFEST_REPAIR_LIMITS.milliseconds || examinedRows >= MANIFEST_REPAIR_LIMITS.rows || repairCount >= REPAIR_CAP) break;
    const comparison = comparisons[index];
    examinedSegments++;
    if (!comparison) { index++; continue; }
    const table = comparison.tableName, segment = comparison.segmentKey;
    definition(table);
    const checkpoint = 'history_repair_segment:' + JSON.stringify([table, segment]);
    const sent = sentSegments.get(JSON.stringify([table, segment]));
    const reportedFingerprint = sent ? manifestFingerprint(sent) : null;
    const prior = repairState(((await q('SELECT value FROM app_settings WHERE key=?', [checkpoint]))[0] || {}).value);
    if (obsoleteManifest(request, prior, currentClock)) { index++; continue; }
    const matched = comparison.repairRequested === false && Array.isArray(comparison.mismatchFields) && comparison.mismatchFields.length === 0;
    if (matched) {
      await db.transaction(async tx => {
        const state = repairState((await tx.get('SELECT value FROM app_settings WHERE key=?', [checkpoint]) || {}).value);
        if (obsoleteManifest(request, state, currentClock)) return;
        await clearRepairQuarantine(tx, table, segment);
        await saveRepairState(tx, checkpoint, { version: 2, round: 0, scope: request.scope, lastRequest: request.clock, matchedAt: now }, now);
      });
      index++; continue;
    }
    if (comparison.repairRequested !== true) { index++; continue; }
    if (prior.unresolved && reportedFingerprint && prior.fingerprint === reportedFingerprint && (!request.scope || prior.scope === request.scope)) { quarantinedSegments++; index++; continue; }
    if (pendingRepair[table] == null) pendingRepair[table] = Number(((await q("SELECT COUNT(*) AS n FROM sync_history_dirty_keys INDEXED BY idx_sync_history_pending WHERE peer_node='cloud' AND table_name=? AND status='pending'", [table]))[0] || {}).n || 0);
    if (pendingRepair[table] >= REPAIR_CAP) { repairSkipped++; index++; continue; }
    const lookup = segmentQuery(table, segment);
    const remaining = MANIFEST_REPAIR_LIMITS.rows - examinedRows;
    const limit = examinedRows === 0 ? MANIFEST_REPAIR_LIMITS.oversizedRows + 1 : remaining + 1;
    // Bounded source read, outside the write transaction. The node dispatches
    // radio_uplinks to radio.db and every other source to farming.db.
    const readSql = lookup.sql + ' LIMIT ?';
    const rows = await sourceQuery(table, readSql, lookup.params.concat(limit));
    examinedRows += rows.length;
    if (rows.length > MANIFEST_REPAIR_LIMITS.oversizedRows) {
      await db.transaction(async tx => {
        const state = { ...prior, version: 2, scope: request.scope, fingerprint: reportedFingerprint, unresolved: 'segment_row_limit', lastRequest: request.clock, round: MANIFEST_REPAIR_LIMITS.rounds };
        await quarantineRepair(tx, table, segment, state, now);
        await saveRepairState(tx, checkpoint, state, now);
      });
      quarantinedSegments++; index++; break;
    }
    if ((rows.length > remaining && examinedRows !== rows.length) || (repairCount > 0 && repairCount + rows.length > REPAIR_CAP)
      || (pendingRepair[table] > 0 && pendingRepair[table] + rows.length > REPAIR_CAP)) break;
    try {
      const prepared = [];
      for (const row of rows) { deadline(); prepared.push(prepareRow(table, gatewayEui, row)); }
      const fingerprint = manifestFingerprint(buildPreparedSegment(table, segment, prepared).manifest);
      deadline();
      const added = await db.transaction(async tx => {
        const state = repairState((await tx.get('SELECT value FROM app_settings WHERE key=?', [checkpoint]) || {}).value);
        if (obsoleteManifest(request, state, currentClock)) return 0;
        const existing = [];
        for (const row of prepared) {
          deadline();
          existing.push(await tx.get("SELECT status FROM sync_history_dirty_keys WHERE peer_node='cloud' AND table_name=? AND row_key=?", [table, row.historyKey]));
        }
        const changed = state.fingerprint !== fingerprint || (request.scope && request.scope !== state.scope);
        if (changed) { state.round = 0; state.budgetFailures = 0; delete state.unresolved; await clearRepairQuarantine(tx, table, segment); }
        // An active partial generation already has per-row durable ACKs. A new
        // mismatch after it drains must recheck the cloud, even before parity.
        const active = !changed && state.round > 0 && existing.some(row => row && row.status === 'pending');
        if (!active && state.round >= MANIFEST_REPAIR_LIMITS.rounds) {
          state.unresolved = state.unresolved || 'round_limit';
          state.lastRequest = request.clock;
          await quarantineRepair(tx, table, segment, state, now);
          await saveRepairState(tx, checkpoint, state, now);
          quarantinedSegments++; return 0;
        }
        if (state.unresolved === 'work_deadline') { delete state.unresolved; await clearRepairQuarantine(tx, table, segment); }
        if (!active) state.round = (state.round || 0) + 1;
        let count = 0;
        for (let i = 0; i < prepared.length; i++) {
          deadline();
          const entry = existing[i];
          if (entry && (entry.status === 'pending' || entry.status === 'rejected' || (entry.status === 'done' && active))) continue;
          await tx.run("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,source_row_id,changed_at,status,attempts,next_attempt_at,last_error) VALUES('cloud',?,?,'repair',?,?,'pending',0,NULL,NULL) ON CONFLICT(peer_node,table_name,row_key) DO UPDATE SET change_kind='repair',source_row_id=excluded.source_row_id,changed_at=excluded.changed_at,status='pending',attempts=0,next_attempt_at=NULL,last_error=NULL", [table, prepared[i].historyKey, rows[i].id == null ? null : rows[i].id, now]);
          count++;
        }
        deadline();
        await saveRepairState(tx, checkpoint, { ...state, version: 2, scope: request.scope, fingerprint, budgetFailures: 0, lastRequest: request.clock, startedAt: state.startedAt || now }, now);
        return count;
      });
      repairCount += added;
      pendingRepair[table] += added;
      index++;
    } catch (error) {
      if (error.code !== 'MANIFEST_BUDGET') throw error;
      // The transaction rolled back. Retry this whole segment next time; a
      // repeatedly unserviceable segment becomes explicit unresolved work.
      await db.transaction(async tx => {
        const state = repairState((await tx.get('SELECT value FROM app_settings WHERE key=?', [checkpoint]) || {}).value);
        if (request.scope && state.scope !== request.scope) { state.round = 0; state.budgetFailures = 0; }
        state.scope = request.scope;
        state.fingerprint = state.fingerprint || reportedFingerprint;
        state.budgetFailures = (state.budgetFailures || 0) + 1;
        if (state.budgetFailures >= MANIFEST_REPAIR_LIMITS.rounds) {
          state.unresolved = 'work_deadline'; await quarantineRepair(tx, table, segment, state, now); quarantinedSegments++; index++;
        }
        await saveRepairState(tx, checkpoint, state, now);
      });
      break;
    }
  }
  repairSkipped += comparisons.slice(index).filter(c => c && c.repairRequested === true).length;
  await db.transaction(async tx => tx.run('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', [pageKey, String(index >= comparisons.length ? 0 : index), now]));
  return { repairCount, repairSkipped, examinedRows, examinedSegments, quarantinedSegments };
}

function normalizeCloudServerUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}
function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}

module.exports = {
  tableNames,
  nextTable,
  cursorKind,
  edgeV1WireInstantSql,
  v1LegacyCompatibilitySql,
  v1LocalOnlyPredicate,
  v1ReplicationPredicate,
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
  normalizeValveAckKey,
  normalizeCursor,
  normalizedValveCursorSql,
  monotonicValveCursorSql,
  rowRejection,
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
  rowByHistoryKeyQuery,
  compareHistoryKeys,
  loadDirtyRows,
  queueManifestRepairs,
  completeDirtyBatch,
  summarizeQuickCheck,
  pendingRepairCounts,
  unresolvedRepairCounts,
  repairProgress,
  captureManifestRequest,
  normalizeCloudServerUrl,
  normalizeGatewayDeviceEui
};
