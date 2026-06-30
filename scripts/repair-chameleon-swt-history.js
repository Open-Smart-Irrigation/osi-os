#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const MAX_BUFFER = 64 * 1024 * 1024;
const DEVICE_DATA_PAYLOAD_COLUMNS = [
  ['swt_wm1', 'number'],
  ['swt_wm2', 'number'],
  ['swt_1', 'number'],
  ['swt_2', 'number'],
  ['swt_3', 'number'],
  ['light_lux', 'number'],
  ['ambient_temperature', 'number'],
  ['relative_humidity', 'number'],
  ['ext_temperature_c', 'number'],
  ['bat_v', 'number'],
  ['adc_ch0v', 'number'],
  ['dendro_position_mm', 'number'],
  ['dendro_valid', 'integer'],
  ['dendro_delta_mm', 'number'],
  ['dendro_stem_change_um', 'number'],
  ['adc_ch1v', 'number'],
  ['dendro_ratio', 'number'],
  ['dendro_mode_used', 'string'],
  ['lsn50_mode_code', 'integer'],
  ['lsn50_mode_label', 'string'],
  ['lsn50_mode_observed_at', 'string'],
  ['rain_count_cumulative', 'integer'],
  ['rain_tips_delta', 'integer'],
  ['rain_mm_delta', 'number'],
  ['rain_mm_per_hour', 'number'],
  ['rain_mm_per_10min', 'number'],
  ['rain_mm_today', 'number'],
  ['rain_delta_status', 'string'],
  ['flow_count_cumulative', 'integer'],
  ['flow_pulses_delta', 'integer'],
  ['flow_liters_delta', 'number'],
  ['flow_liters_per_min', 'number'],
  ['flow_liters_per_10min', 'number'],
  ['flow_liters_today', 'number'],
  ['flow_delta_status', 'string'],
  ['counter_interval_seconds', 'integer'],
  ['barometric_pressure_hpa', 'number'],
  ['wind_speed_mps', 'number'],
  ['wind_direction_deg', 'number'],
  ['wind_gust_mps', 'number'],
  ['uv_index', 'number'],
  ['rain_gauge_cumulative_mm', 'number'],
  ['bat_pct', 'number'],
];

function usage(exitCode) {
  const out = exitCode === 0 ? console.log : console.error;
  out([
    'Usage:',
    '  node scripts/repair-chameleon-swt-history.js --db <path> --deveui <EUI> --since <ISO> [--gateway <EUI>] [--queue-sync] [--apply --backup-ok]',
    '',
    'Default mode is dry-run. --apply writes device_data.swt_1/2/3 and chameleon_readings.swt_1/2/3.',
    '--queue-sync queues corrected DEVICE_DATA_APPENDED events for repaired device_data rows.',
  ].join('\n'));
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { apply: false, queueSync: false, backupOk: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--queue-sync') {
      args.queueSync = true;
    } else if (arg === '--backup-ok') {
      args.backupOk = true;
    } else if (arg === '--db' || arg === '--deveui' || arg === '--since' || arg === '--gateway') {
      i += 1;
      if (i >= argv.length) throw new Error(arg + ' requires a value');
      args[arg.slice(2)] = argv[i];
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  if (!args.db) throw new Error('--db is required');
  if (!args.deveui) throw new Error('--deveui is required');
  if (!args.since) throw new Error('--since is required');
  args.deveui = normalizeEui(args.deveui);
  if (args.gateway) args.gateway = normalizeEui(args.gateway);
  if (!args.deveui) throw new Error('--deveui must be a 16-character hex EUI');
  if (args.gateway === null) throw new Error('--gateway must be a 16-character hex EUI when provided');
  if (!Number.isFinite(Date.parse(args.since))) throw new Error('--since must be an ISO timestamp');
  if (args.apply && !args.backupOk) throw new Error('--apply requires --backup-ok after creating a database backup');
  return args;
}

function normalizeEui(value) {
  const normalized = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!normalized) return null;
  return normalized.length === 16 ? normalized : null;
}

function normalizeArrayId(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[0-9A-F]{16}$/.test(normalized) ? normalized : null;
}

function loadChameleonHelper() {
  const candidates = [
    path.join(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'osi-chameleon-helper'),
    '/srv/node-red/osi-chameleon-helper',
    '/srv/node-red/node_modules/osi-chameleon-helper',
    '/usr/share/node-red/osi-chameleon-helper',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('Could not find osi-chameleon-helper in repo or /usr/share/node-red');
}

function sqliteRows(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-batch', '-header', '-separator', '\t', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  }).trimEnd();
  if (!output) return [];
  const lines = output.split(/\r?\n/);
  const headers = lines.shift().split('\t');
  return lines.filter(Boolean).map((line) => {
    const values = line.split('\t');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] === undefined ? '' : values[index];
    });
    return row;
  });
}

function runSql(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || 'sqlite3 failed').trim());
  }
}

function tableColumns(dbPath, tableName) {
  return new Set(sqliteRows(dbPath, 'PRAGMA table_info(' + tableName + ');').map((row) => row.name));
}

function ensureColumn(dbPath, tableName, columnName, definition) {
  const columns = tableColumns(dbPath, tableName);
  if (columns.has(columnName)) return false;
  runSql(dbPath, 'ALTER TABLE ' + tableName + ' ADD COLUMN ' + columnName + ' ' + definition + ';\n');
  return true;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function sqlNumber(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'NULL';
  return String(number);
}

function field(row, key) {
  return row[key] === undefined || row[key] === '' ? null : row[key];
}

function numberField(row, key) {
  const value = field(row, key);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerField(row, key) {
  const value = numberField(row, key);
  return value === null ? null : Math.trunc(value);
}

function typedValue(row, key, type) {
  if (type === 'integer') return integerField(row, key);
  if (type === 'number') return numberField(row, key);
  return field(row, key);
}

function numbersEqual(left, right) {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return Math.abs(Number(left) - Number(right)) < 0.005;
}

function makeEventUuid() {
  return crypto.randomBytes(16).toString('hex');
}

function buildCalibration(row) {
  return {
    swt1: {
      a: numberField(row, 'sensor1_a'),
      b: numberField(row, 'sensor1_b'),
      c: numberField(row, 'sensor1_c'),
    },
    swt2: {
      a: numberField(row, 'sensor2_a'),
      b: numberField(row, 'sensor2_b'),
      c: numberField(row, 'sensor2_c'),
    },
    swt3: {
      a: numberField(row, 'sensor3_a'),
      b: numberField(row, 'sensor3_b'),
      c: numberField(row, 'sensor3_c'),
    },
  };
}

function hasCompleteCalibration(calibration) {
  return ['swt1', 'swt2', 'swt3'].every((key) =>
    ['a', 'b', 'c'].every((coef) => Number.isFinite(calibration[key][coef])));
}

function buildPayload(row, metrics, gatewayDeviceEui) {
  const payload = {
    device_eui: field(row, 'deveui'),
    device_name: field(row, 'device_name'),
    device_type: field(row, 'device_type'),
    zone_id: integerField(row, 'zone_id'),
    zone_uuid: field(row, 'zone_uuid'),
    gateway_device_eui: gatewayDeviceEui,
    recorded_at: field(row, 'recorded_at'),
  };
  for (const [column, type] of DEVICE_DATA_PAYLOAD_COLUMNS) {
    payload[column] = typedValue(row, column, type);
  }
  payload.swt_1 = metrics.swt1Kpa;
  payload.swt_2 = metrics.swt2Kpa;
  payload.swt_3 = metrics.swt3Kpa;
  return payload;
}

function assertPayload(row, payload, metrics) {
  const expectedKey = String(field(row, 'deveui') || '') + '|' + String(field(row, 'recorded_at') || '');
  if (payload.device_eui !== field(row, 'deveui')) throw new Error('payload device_eui mismatch for ' + expectedKey);
  if (payload.recorded_at !== field(row, 'recorded_at')) throw new Error('payload recorded_at mismatch for ' + expectedKey);
  if (!numbersEqual(payload.swt_1, metrics.swt1Kpa)) throw new Error('payload swt_1 mismatch for ' + expectedKey);
  if (!numbersEqual(payload.swt_2, metrics.swt2Kpa)) throw new Error('payload swt_2 mismatch for ' + expectedKey);
  if (!numbersEqual(payload.swt_3, metrics.swt3Kpa)) throw new Error('payload swt_3 mismatch for ' + expectedKey);
}

function existingSwtEvent(dbPath, aggregateKey) {
  const rows = sqliteRows(dbPath, [
    'SELECT payload_json',
    'FROM sync_outbox',
    "WHERE aggregate_type = 'DEVICE_DATA'",
    "  AND op = 'DEVICE_DATA_APPENDED'",
    '  AND aggregate_key = ' + sqlString(aggregateKey),
  ].join('\n'));
  return rows.some((row) => {
    try {
      const payload = JSON.parse(field(row, 'payload_json') || '{}');
      return payload.swt_1 !== null && payload.swt_1 !== undefined
        || payload.swt_2 !== null && payload.swt_2 !== undefined
        || payload.swt_3 !== null && payload.swt_3 !== undefined;
    } catch (_) {
      return false;
    }
  });
}

function buildSelectSql(args, deviceColumns, chameleonColumns, maxResistanceOhms) {
  const payloadSelects = DEVICE_DATA_PAYLOAD_COLUMNS.map(([column]) => {
    return deviceColumns.has(column)
      ? '  dd.' + column + ' AS ' + column + ','
      : '  NULL AS ' + column + ',';
  });
  const chameleonSwtSelects = ['swt_1', 'swt_2', 'swt_3'].map((column) => {
    return chameleonColumns.has(column)
      ? '  cr.' + column + ' AS cr_' + column + ','
      : '  NULL AS cr_' + column + ',';
  });
  return [
    'SELECT',
    '  dd.id AS device_data_id,',
    '  dd.deveui AS deveui,',
    '  dd.recorded_at AS recorded_at,',
    '  dd.swt_1 AS dd_swt_1,',
    '  dd.swt_2 AS dd_swt_2,',
    '  dd.swt_3 AS dd_swt_3,',
    '  d.name AS device_name,',
    '  d.type_id AS device_type,',
    '  d.irrigation_zone_id AS zone_id,',
    '  iz.zone_uuid AS zone_uuid,',
    '  COALESCE(NULLIF(d.gateway_device_eui, \'\'), NULLIF(iz.gateway_device_eui, \'\')) AS db_gateway_device_eui,',
    ...payloadSelects,
    '  cr.id AS chameleon_reading_id,',
    ...chameleonSwtSelects,
    '  cr.i2c_missing AS i2c_missing,',
    '  cr.timeout AS timeout,',
    '  cr.ch1_open AS ch1_open,',
    '  cr.ch2_open AS ch2_open,',
    '  cr.ch3_open AS ch3_open,',
    '  cr.r1_ohm_comp AS r1_ohm_comp,',
    '  cr.r2_ohm_comp AS r2_ohm_comp,',
    '  cr.r3_ohm_comp AS r3_ohm_comp,',
    '  cr.array_id AS array_id,',
    '  cc.sensor1_a AS sensor1_a,',
    '  cc.sensor1_b AS sensor1_b,',
    '  cc.sensor1_c AS sensor1_c,',
    '  cc.sensor2_a AS sensor2_a,',
    '  cc.sensor2_b AS sensor2_b,',
    '  cc.sensor2_c AS sensor2_c,',
    '  cc.sensor3_a AS sensor3_a,',
    '  cc.sensor3_b AS sensor3_b,',
    '  cc.sensor3_c AS sensor3_c',
    'FROM device_data dd',
    'JOIN devices d ON d.deveui = dd.deveui AND d.deleted_at IS NULL',
    'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL',
    'JOIN chameleon_readings cr ON cr.id = (',
    '  SELECT cr2.id',
    '  FROM chameleon_readings cr2',
    '  WHERE upper(cr2.deveui) = upper(dd.deveui)',
    '    AND cr2.recorded_at = dd.recorded_at',
    '  ORDER BY cr2.id DESC',
    '  LIMIT 1',
    ')',
    'JOIN chameleon_calibrations cc ON upper(cc.array_id) = upper(cr.array_id)',
    'WHERE upper(dd.deveui) = ' + sqlString(args.deveui),
    '  AND dd.recorded_at >= ' + sqlString(args.since),
    "  AND lower(COALESCE(cr.calibration_status, '')) = 'calibrated'",
    '  AND COALESCE(cr.data_invalid, 0) = 0',
    '  AND COALESCE(cr.i2c_missing, 0) = 0',
    '  AND COALESCE(cr.timeout, 0) = 0',
    '  AND COALESCE(cr.ch1_open, 0) = 0',
    '  AND COALESCE(cr.ch2_open, 0) = 0',
    '  AND COALESCE(cr.ch3_open, 0) = 0',
    '  AND cr.r1_ohm_comp > 0 AND cr.r1_ohm_comp < ' + String(maxResistanceOhms),
    '  AND cr.r2_ohm_comp > 0 AND cr.r2_ohm_comp < ' + String(maxResistanceOhms),
    '  AND cr.r3_ohm_comp > 0 AND cr.r3_ohm_comp < ' + String(maxResistanceOhms),
    'ORDER BY dd.recorded_at ASC, dd.id ASC;',
  ].join('\n');
}

function requireColumns(columns, tableName, requiredColumns) {
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length) {
    throw new Error(tableName + ' is missing required column(s): ' + missing.join(', '));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const helper = loadChameleonHelper();
  const dbPath = path.resolve(args.db);
  if (!fs.existsSync(dbPath)) throw new Error('database not found: ' + dbPath);

  if (args.apply) {
    ensureColumn(dbPath, 'chameleon_readings', 'swt_1', 'REAL');
    ensureColumn(dbPath, 'chameleon_readings', 'swt_2', 'REAL');
    ensureColumn(dbPath, 'chameleon_readings', 'swt_3', 'REAL');
  }

  const deviceColumns = tableColumns(dbPath, 'device_data');
  const chameleonColumns = tableColumns(dbPath, 'chameleon_readings');
  const outboxColumns = tableColumns(dbPath, 'sync_outbox');
  requireColumns(deviceColumns, 'device_data', ['id', 'deveui', 'recorded_at', 'swt_1', 'swt_2', 'swt_3']);
  requireColumns(chameleonColumns, 'chameleon_readings', [
    'id', 'deveui', 'recorded_at', 'calibration_status', 'data_invalid', 'i2c_missing', 'timeout',
    'ch1_open', 'ch2_open', 'ch3_open', 'r1_ohm_comp', 'r2_ohm_comp', 'r3_ohm_comp', 'array_id',
  ]);
  if (args.queueSync) {
    requireColumns(outboxColumns, 'sync_outbox', [
      'event_uuid', 'aggregate_type', 'aggregate_key', 'op', 'payload_json',
      'sync_version', 'occurred_at', 'gateway_device_eui',
    ]);
  }

  const missingChameleonSwtColumns = ['swt_1', 'swt_2', 'swt_3'].filter((column) => !chameleonColumns.has(column));
  const rows = sqliteRows(dbPath, buildSelectSql(args, deviceColumns, chameleonColumns, helper.MAX_VALID_RESISTANCE_OHMS || 10000000));

  const updates = [];
  let skippedInvalidCalibration = 0;
  let skippedInvalidMetrics = 0;
  for (const row of rows) {
    const arrayId = normalizeArrayId(field(row, 'array_id'));
    const calibration = buildCalibration(row);
    if (!arrayId || !hasCompleteCalibration(calibration)) {
      skippedInvalidCalibration += 1;
      continue;
    }
    const metrics = helper.buildChameleonSwtMetrics({
      i2cMissing: integerField(row, 'i2c_missing'),
      timeout: integerField(row, 'timeout'),
      ch1Open: integerField(row, 'ch1_open'),
      ch2Open: integerField(row, 'ch2_open'),
      ch3Open: integerField(row, 'ch3_open'),
      r1OhmComp: numberField(row, 'r1_ohm_comp'),
      r2OhmComp: numberField(row, 'r2_ohm_comp'),
      r3OhmComp: numberField(row, 'r3_ohm_comp'),
    }, { enabled: true, calibration });
    if (metrics.swt1Kpa === null || metrics.swt2Kpa === null || metrics.swt3Kpa === null) {
      skippedInvalidMetrics += 1;
      continue;
    }
    const deviceNeedsUpdate = !numbersEqual(numberField(row, 'dd_swt_1'), metrics.swt1Kpa)
      || !numbersEqual(numberField(row, 'dd_swt_2'), metrics.swt2Kpa)
      || !numbersEqual(numberField(row, 'dd_swt_3'), metrics.swt3Kpa);
    const chameleonNeedsUpdate = missingChameleonSwtColumns.length > 0
      || !numbersEqual(numberField(row, 'cr_swt_1'), metrics.swt1Kpa)
      || !numbersEqual(numberField(row, 'cr_swt_2'), metrics.swt2Kpa)
      || !numbersEqual(numberField(row, 'cr_swt_3'), metrics.swt3Kpa);
    const aggregateKey = String(field(row, 'deveui') || '') + '|' + String(field(row, 'recorded_at') || '');
    const gatewayDeviceEui = args.gateway || normalizeEui(field(row, 'db_gateway_device_eui')) || null;
    const shouldQueueSync = args.queueSync && deviceNeedsUpdate && !existingSwtEvent(dbPath, aggregateKey);
    const payload = shouldQueueSync ? buildPayload(row, metrics, gatewayDeviceEui) : null;
    if (payload) assertPayload(row, payload, metrics);
    updates.push({ row, metrics, deviceNeedsUpdate, chameleonNeedsUpdate, shouldQueueSync, aggregateKey, gatewayDeviceEui, payload });
  }

  let syncEventsQueued = 0;
  if (args.apply && updates.some((update) => update.deviceNeedsUpdate || update.chameleonNeedsUpdate || update.shouldQueueSync)) {
    const sql = ['PRAGMA busy_timeout=5000;', 'BEGIN IMMEDIATE;'];
    for (const update of updates) {
      const deviceDataId = integerField(update.row, 'device_data_id');
      const chameleonReadingId = integerField(update.row, 'chameleon_reading_id');
      if (update.deviceNeedsUpdate) {
        sql.push([
          'UPDATE device_data',
          'SET swt_1 = ' + sqlNumber(update.metrics.swt1Kpa) + ',',
          '    swt_2 = ' + sqlNumber(update.metrics.swt2Kpa) + ',',
          '    swt_3 = ' + sqlNumber(update.metrics.swt3Kpa),
          'WHERE id = ' + sqlNumber(deviceDataId) + ';',
        ].join('\n'));
      }
      if (update.chameleonNeedsUpdate) {
        sql.push([
          'UPDATE chameleon_readings',
          'SET swt_1 = ' + sqlNumber(update.metrics.swt1Kpa) + ',',
          '    swt_2 = ' + sqlNumber(update.metrics.swt2Kpa) + ',',
          '    swt_3 = ' + sqlNumber(update.metrics.swt3Kpa),
          'WHERE id = ' + sqlNumber(chameleonReadingId) + ';',
        ].join('\n'));
      }
      if (update.shouldQueueSync) {
        sql.push([
          'INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui)',
          'VALUES (',
          '  ' + sqlString(makeEventUuid()) + ',',
          "  'DEVICE_DATA',",
          '  ' + sqlString(update.aggregateKey) + ',',
          "  'DEVICE_DATA_APPENDED',",
          '  ' + sqlString(JSON.stringify(update.payload)) + ',',
          '  0,',
          "  strftime('%Y-%m-%dT%H:%M:%fZ','now'),",
          '  ' + sqlString(update.gatewayDeviceEui),
          ');',
        ].join('\n'));
        syncEventsQueued += 1;
      }
    }
    sql.push('COMMIT;');
    runSql(dbPath, sql.join('\n'));
  }

  const eligibleRows = updates.length;
  const deviceDataUpdates = updates.filter((update) => update.deviceNeedsUpdate).length;
  const chameleonReadingUpdates = updates.filter((update) => update.chameleonNeedsUpdate).length;
  const wouldQueueSyncEvents = updates.filter((update) => update.shouldQueueSync).length;
  const summary = {
    db: dbPath,
    deveui: args.deveui,
    since: args.since,
    dryRun: !args.apply,
    queueSync: args.queueSync,
    schema: {
      missingChameleonSwtColumns,
    },
    eligibleRows,
    deviceDataUpdates,
    chameleonReadingUpdates,
    syncEventsQueued,
    wouldQueueSyncEvents,
    skippedInvalidCalibration,
    skippedInvalidMetrics,
    firstAt: eligibleRows ? field(updates[0].row, 'recorded_at') : null,
    lastAt: eligibleRows ? field(updates[updates.length - 1].row, 'recorded_at') : null,
  };
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
