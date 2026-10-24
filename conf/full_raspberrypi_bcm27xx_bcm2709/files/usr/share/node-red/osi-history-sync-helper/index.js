const crypto = require('crypto');

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
  compareHistoryKeys
};
