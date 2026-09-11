#!/usr/bin/env node
'use strict';
// Uganda schema-reconciliation data audit (2026-09-11).
//
// Read-only. Never writes to the target DB, never creates a `.db` alongside
// it, never runs DDL against it. It exists to answer one question for each
// of the 17 residual [changed]/[missing]/[extra_unknown] diffs that survive
// the additive catch-up artifact (docs/operations/uganda-catchup-rehearsal-20260911-report.md
// "What's blocking G4"): what does the DATA say - would rebuilding this table
// to the reference(1) shape lose rows, orphan a foreign key, or violate a
// CHECK, and by how much? The design doc
// (docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md)
// is written FROM this script's output, not the other way around.
//
// Usage: node scripts/ops/uganda-schema-audit.js <db> [--out <file>]
// Prints JSON to stdout (or writes it to --out); exit 0 always unless the DB
// is missing/unreadable (exit 2) - this is a report, not a gate.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../../lib/osi-migrate');
const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('../semantic-schema-compare');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const SOURCE_MIGRATION = path.join(DEFAULT_MIGRATIONS_DIR, '0001__baseline.sql');

// The six tables in scope for the table-rebuild reconciliation (runbook "What's
// blocking G4"; every one of the 17 residual diffs lands on exactly these six).
const REBUILD_TABLES = [
  'device_data',
  'devices',
  'irrigation_events',
  'valve_actuation_expectations',
  'zone_irrigation_calibration',
  'zone_weather_cache',
];

// semantic-schema-compare.js diffs are named `table` (table/check/foreign_key
// kinds) or `table.column` (column kind) - both resolve to a table via a
// simple split. Index/trigger diffs are named by the OBJECT's own name, which
// carries no table prefix, so the one index in this rebuild's scope
// (idx_irrigation_events_event_uuid, blocked on irrigation_events.event_uuid
// existing first - see the design doc) needs an explicit name->table mapping
// or it silently falls out of REBUILD_TABLES scoping.
const OBJECT_NAME_TO_TABLE = {
  idx_irrigation_events_event_uuid: 'irrigation_events',
};

function diffTable(d) {
  if (d.name.includes('.')) return d.name.split('.')[0];
  return OBJECT_NAME_TO_TABLE[d.name] || d.name;
}

// Declarative "what would this diff mean for the data" plan, keyed the same
// way semantic-schema-compare.js names a diff (`${kind}:${name}` where name is
// `table` for check/foreign_key/table diffs and `table.column` for column
// diffs). Each entry describes what query answers "does this diff matter for
// THIS DB's actual rows" - not the fix itself (that is the design doc's job).
const DIFF_DATA_QUESTIONS = {
  'foreign_key:device_data': {
    question: 'orphans: device_data.deveui values with no matching devices.deveui',
    query: "SELECT COUNT(*) AS n FROM device_data WHERE deveui NOT IN (SELECT deveui FROM devices)",
  },
  'foreign_key:zone_weather_cache': {
    question: 'orphans: zone_weather_cache.zone_id values with no matching irrigation_zones.id',
    query: "SELECT COUNT(*) AS n FROM zone_weather_cache WHERE zone_id NOT IN (SELECT id FROM irrigation_zones)",
  },
  'check:devices': {
    question: 'devices.type_id values outside the canonical CHECK set (extracted from reference(1))',
    // handled specially in auditDevicesCheck() - needs the canonical set, not a fixed query
  },
  'column:zone_irrigation_calibration.created_at': { question: 'NULL count if made NOT NULL', query: 'SELECT COUNT(*) AS n FROM zone_irrigation_calibration WHERE created_at IS NULL' },
  'column:zone_irrigation_calibration.measured_at': { question: 'NULL count if made NOT NULL', query: 'SELECT COUNT(*) AS n FROM zone_irrigation_calibration WHERE measured_at IS NULL' },
  'column:zone_irrigation_calibration.measured_flow_rate_lpm': { question: 'NULL count if made NOT NULL', query: 'SELECT COUNT(*) AS n FROM zone_irrigation_calibration WHERE measured_flow_rate_lpm IS NULL' },
  'column:zone_irrigation_calibration.measurement_method': { question: 'NULL count if made NOT NULL', query: 'SELECT COUNT(*) AS n FROM zone_irrigation_calibration WHERE measurement_method IS NULL' },
  'column:zone_irrigation_calibration.updated_at': { question: 'NULL count if made NOT NULL', query: 'SELECT COUNT(*) AS n FROM zone_irrigation_calibration WHERE updated_at IS NULL' },
  'column:zone_weather_cache.expires_at': { question: 'NULL count if made NOT NULL', query: 'SELECT COUNT(*) AS n FROM zone_weather_cache WHERE expires_at IS NULL' },
  'column:irrigation_events.event_uuid': { question: 'row count that would need a backfilled value (column entirely absent live)', query: 'SELECT COUNT(*) AS n FROM irrigation_events' },
  'column:zone_weather_cache.fetched_at': { question: 'row count that would need a backfilled value (column entirely absent live)', query: 'SELECT COUNT(*) AS n FROM zone_weather_cache' },
};

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function buildReference1(scratchRoot) {
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'uganda-audit-ref1-'));
  const subset = path.join(dir, 'migrations');
  fs.mkdirSync(subset);
  fs.copyFileSync(SOURCE_MIGRATION, path.join(subset, path.basename(SOURCE_MIGRATION)));
  const dbPath = path.join(dir, 'ref1.db');
  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, appVersion: 'uganda-audit-ref1' });
  return dbPath;
}

async function rowCounts(runner, tables) {
  const out = {};
  for (const t of tables) {
    const present = (await runner.all(
      `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='${t}'`)).length > 0;
    out[t] = present ? Number((await runner.all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n) : null;
  }
  return out;
}

// Extracts the CHECK(type_id IN (...)) member list from a CREATE TABLE devices
// statement - same style the sync-init-fn boot-node regex uses, applied here
// to reference(1)'s DDL rather than the live schema (audit reads the live
// schema's actual values via PRAGMA table_xinfo/sqlite_master separately).
function extractTypeIdCheckSet(createTableSql) {
  const m = /type_id\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type_id\s+IN\s*\(([^)]*)\)\s*\)/i.exec(createTableSql);
  if (!m) throw new Error('could not find devices.type_id CHECK in reference(1) DDL');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

async function auditDevicesTypeId(liveRunner, ref1Runner) {
  const ref1Sql = (await ref1Runner.all(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'"))[0].sql;
  const canonical = extractTypeIdCheckSet(ref1Sql);
  const distribution = await liveRunner.all('SELECT type_id, COUNT(*) AS n FROM devices GROUP BY type_id');
  const outsideCanonical = distribution
    .filter((r) => !canonical.includes(r.type_id))
    .map((r) => ({ type_id: r.type_id, count: Number(r.n) }));
  return {
    canonicalTypes: canonical,
    liveDistribution: distribution.map((r) => ({ type_id: r.type_id, count: Number(r.n) })),
    outsideCanonical,
  };
}

async function auditZoneWeatherCacheMapping(liveRunner) {
  const rowCount = Number((await liveRunner.all('SELECT COUNT(*) AS n FROM zone_weather_cache'))[0].n);
  const sample = rowCount > 0
    ? await liveRunner.all('SELECT zone_id, cache_key, created_at, updated_at, observed_at, expires_at FROM zone_weather_cache LIMIT 5')
    : [];
  return {
    rowCount,
    sampleRows: sample,
    proposedMapping: {
      fetched_at: 'created_at (row-insertion time; the closest live analogue to "when was this cache entry fetched")',
      'updated_at (extra, dropped)': rowCount === 0
        ? 'table is empty on this copy - no data loss regardless of disposition'
        : 'live-only column with no reference(1) counterpart; carries no information created_at does not already carry for a cache row that is never updated in place (see design doc for the row-lifecycle argument) - propose dropping, not migrating',
    },
  };
}

async function runAudit({ dbPath, migrationsDir = DEFAULT_MIGRATIONS_DIR, log = () => {} }) {
  if (!dbPath) throw new Error('usage: uganda-schema-audit.js <path-to-farming.db> [--out <file>]');
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: database file does not exist: ${dbPath}`);

  const shaBefore = sha256File(dbPath);
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-audit-'));
  const liveRunner = cliRunner(dbPath);
  const ref1Path = await buildReference1(scratchRoot);
  const ref1Runner = cliRunner(ref1Path);

  log('[audit] snapshotting live schema and reference(1)...');
  const liveSnap = await snapshotSchema(liveRunner);
  const ref1Snap = await snapshotSchema(ref1Runner);
  const cmp = compareSchemas(liveSnap, ref1Snap, null);

  const scoped = cmp.diffs.filter((d) => REBUILD_TABLES.includes(diffTable(d)) && FAILING_CLASSES.has(d.class));

  const diffs = [];
  for (const d of scoped) {
    const table = diffTable(d);
    const key = `${d.kind}:${d.name}`;
    const dq = DIFF_DATA_QUESTIONS[key];
    let dataImplication = null;
    if (dq && dq.query) {
      const rows = await liveRunner.all(dq.query);
      dataImplication = { question: dq.question, value: Number(rows[0].n) };
    } else if (dq) {
      dataImplication = { question: dq.question, value: 'see devicesTypeIdAudit below' };
    }
    diffs.push({ table, class: d.class, kind: d.kind, name: d.name, detail: d.detail, dataImplication });
  }

  const tables = await rowCounts(liveRunner, REBUILD_TABLES);
  const devicesTypeIdAudit = await auditDevicesTypeId(liveRunner, ref1Runner);
  const zoneWeatherCacheMapping = await auditZoneWeatherCacheMapping(liveRunner);
  const orphans = {
    device_data_deveui_not_in_devices: Number(
      (await liveRunner.all("SELECT COUNT(*) AS n FROM device_data WHERE deveui NOT IN (SELECT deveui FROM devices)"))[0].n),
    zone_weather_cache_zone_id_not_in_irrigation_zones: Number(
      (await liveRunner.all("SELECT COUNT(*) AS n FROM zone_weather_cache WHERE zone_id NOT IN (SELECT id FROM irrigation_zones)"))[0].n),
  };

  const shaAfter = sha256File(dbPath);
  if (shaAfter !== shaBefore) {
    // Should be structurally impossible (every query above is a SELECT/PRAGMA
    // through a read-only runner) - kept as a hard, loud assertion because
    // "read-only" is a safety property of this script, not an incidental fact.
    throw new Error(`INVARIANT VIOLATED: ${dbPath} sha256 changed during a read-only audit (before=${shaBefore} after=${shaAfter})`);
  }

  fs.rmSync(scratchRoot, { recursive: true, force: true });

  return {
    db: path.resolve(dbPath),
    sha256: shaAfter,
    generatedAt: new Date().toISOString(),
    referenceMigration: path.relative(REPO, SOURCE_MIGRATION),
    rebuildTables: REBUILD_TABLES,
    rowCounts: tables,
    diffs,
    devicesTypeIdAudit,
    zoneWeatherCacheMapping,
    orphans,
  };
}

function parseArgs(argv) {
  const opts = { dbPath: null, out: null, migrationsDir: DEFAULT_MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--migrations-dir') opts.migrationsDir = path.resolve(argv[++i] || '');
    else if (!opts.dbPath) opts.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runAudit({ ...opts, log: console.error });
  const json = JSON.stringify(result, null, 2);
  if (opts.out) {
    fs.writeFileSync(opts.out, json);
    console.error(`[audit] wrote ${opts.out}`);
  } else {
    console.log(json);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`[audit] FAILED: ${e.message}`); process.exit(2); });
}

module.exports = { runAudit, parseArgs, REBUILD_TABLES, extractTypeIdCheckSet, diffTable };
