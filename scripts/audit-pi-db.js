#!/usr/bin/env node
// Read-only deployed-Pi DB audit. Prints JSON and exits non-zero when required
// schema or PRAGMA checks fail. It never writes to the DB or sidecar files.
const { execFileSync } = require('child_process');
const fs = require('fs');

const dbPath = process.argv[2] || '/data/db/farming.db';

const REQUIRED_TABLES = {
  devices: ['deveui', 'name', 'type_id', 'user_id', 'current_state'],
  device_data: ['deveui', 'recorded_at'],
  irrigation_zones: ['id', 'user_id'],
  irrigation_schedules: ['irrigation_zone_id', 'trigger_metric', 'duration_minutes', 'enabled'],
  sync_outbox: ['event_uuid', 'delivered_at'],
  sync_inbox: ['event_uuid'],
  applied_commands: ['command_id', 'result', 'applied_at'],
  command_ack_outbox: ['command_id', 'payload_json', 'delivered_at'],
  valve_actuation_expectations: ['expectation_id', 'reconciliation_state'],
  zone_irrigation_calibration: ['zone_id', 'measured_flow_rate_lpm'],
};

const OPTIONAL_CAPABILITY_TABLES = [
  'actuator_log',
  'chameleon_readings',
  'dendrometer_readings',
  'zone_daily_recommendations',
];

function sqlite(query) {
  return execFileSync('sqlite3', ['-readonly', dbPath, query], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function safeSqlite(report, query, fallback = '') {
  try {
    return sqlite(query);
  } catch (error) {
    report.ok = false;
    report.errors.push({
      query,
      error: String(error.stderr || error.message || error).trim(),
    });
    return fallback;
  }
}

function tableNames(report) {
  return safeSqlite(
    report,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ''
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function columns(report, table) {
  return safeSqlite(report, `PRAGMA table_info(${quoteIdent(table)})`, '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|')[1])
    .filter(Boolean);
}

function countRows(report, table) {
  const value = safeSqlite(report, `SELECT COUNT(*) FROM ${quoteIdent(table)}`, '0');
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteIdent(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function addTableReport(report, table, requiredColumns, existingTables) {
  if (!existingTables.includes(table)) {
    report.ok = false;
    report.tables[table] = { ok: false, error: 'missing' };
    return;
  }

  const tableColumns = columns(report, table);
  const missing = requiredColumns.filter((column) => !tableColumns.includes(column));
  if (missing.length > 0) {
    report.ok = false;
    report.tables[table] = {
      ok: false,
      missing,
      columns: tableColumns,
      rowCount: countRows(report, table),
    };
    return;
  }

  report.tables[table] = {
    ok: true,
    columns: tableColumns,
    rowCount: countRows(report, table),
  };
}

function pragma(report, name) {
  return safeSqlite(report, `PRAGMA ${name};`, null);
}

function openValves(report, existingTables) {
  if (!existingTables.includes('devices')) return [];
  const deviceColumns = columns(report, 'devices');
  const timestampColumn = deviceColumns.includes('last_seen')
    ? 'last_seen'
    : (deviceColumns.includes('updated_at') ? 'updated_at' : null);
  const selectedColumns = ['deveui', 'name', 'current_state'];
  if (timestampColumn) selectedColumns.push(timestampColumn);

  const sql = [
    'SELECT ' + selectedColumns.map(quoteIdent).join(', '),
    'FROM devices',
    "WHERE type_id = 'STREGA_VALVE' AND current_state = 'OPEN'",
  ].join(' ');
  const rows = safeSqlite(report, sql, '');
  return rows
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));
}

function audit(path) {
  const report = {
    ok: true,
    dbPath: path,
    checkedAt: new Date().toISOString(),
    file: null,
    sidecars: {},
    pragmas: {},
    tables: {},
    capabilities: {},
    openValves: [],
    counters: {},
    errors: [],
  };

  if (!fs.existsSync(path)) {
    report.ok = false;
    report.errors.push({ error: `db missing: ${path}` });
    return report;
  }

  const stat = fs.statSync(path);
  report.file = {
    sizeBytes: stat.size,
    sizeMb: Math.round((stat.size / 1024 / 1024) * 10) / 10,
  };

  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecarPath = path + suffix;
    if (fs.existsSync(sidecarPath)) {
      const sidecarStat = fs.statSync(sidecarPath);
      report.sidecars[suffix.slice(1)] = {
        sizeBytes: sidecarStat.size,
        sizeKb: Math.round((sidecarStat.size / 1024) * 10) / 10,
      };
    }
  }

  report.pragmas.integrityCheck = pragma(report, 'integrity_check');
  report.pragmas.quickCheck = pragma(report, 'quick_check');
  report.pragmas.journalMode = pragma(report, 'journal_mode');
  const foreignKeyRows = String(pragma(report, 'foreign_key_check') || '')
    .split('\n')
    .filter(Boolean);
  report.pragmas.foreignKeyCheck = {
    ok: foreignKeyRows.length === 0,
    violationCount: foreignKeyRows.length,
    sample: foreignKeyRows.slice(0, 20),
  };
  report.pragmas.pageCount = Number.parseInt(pragma(report, 'page_count') || '0', 10) || 0;
  report.pragmas.freelistCount = Number.parseInt(pragma(report, 'freelist_count') || '0', 10) || 0;
  report.pragmas.pageSize = Number.parseInt(pragma(report, 'page_size') || '0', 10) || 0;
  report.pragmas.dbSizeMb = Math.round(
    (report.pragmas.pageCount * report.pragmas.pageSize / 1024 / 1024) * 10
  ) / 10;

  if (report.pragmas.integrityCheck !== 'ok' || report.pragmas.quickCheck !== 'ok') {
    report.ok = false;
  }
  if (!report.pragmas.foreignKeyCheck.ok) {
    report.ok = false;
  }

  const existingTables = tableNames(report);
  report.tableCount = existingTables.length;
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLES)) {
    addTableReport(report, table, requiredColumns, existingTables);
  }
  for (const table of OPTIONAL_CAPABILITY_TABLES) {
    report.capabilities[table] = existingTables.includes(table) ? 'present' : 'absent';
  }

  report.openValves = openValves(report, existingTables);
  if (existingTables.includes('sync_outbox')) {
    report.counters.pendingOutboxEvents = countRowsWhere(report, 'sync_outbox', 'delivered_at IS NULL');
  }
  if (existingTables.includes('valve_actuation_expectations')) {
    report.counters.unresolvedActuationExpectations = countRowsWhere(
      report,
      'valve_actuation_expectations',
      "reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING')"
    );
  }

  return report;
}

function countRowsWhere(report, table, whereClause) {
  const value = safeSqlite(
    report,
    `SELECT COUNT(*) FROM ${quoteIdent(table)} WHERE ${whereClause}`,
    '0'
  );
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

const report = audit(dbPath);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
