#!/usr/bin/env node
'use strict';
// Uganda schema-reconciliation table-rebuild artifact generator (2026-09-11).
//
// After scripts/ops/generate-uganda-catchup-20260911.js (missing whole
// tables/indexes/triggers), 17 residual diffs remain against reference(1)
// (database/migrations/ordered/0001__baseline.sql) - see
// docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md for
// the full audit and design this generator implements. All 17 land on tables
// that already exist, so they need SQLite's table-rebuild class of change
// (https://sqlite.org/lang_altertable.html section 7, "Making Other Kinds Of
// Table Schema Changes"): create a canonical replacement table, copy rows
// with an explicit column mapping, drop the old table, rename, recreate
// indexes/triggers - all under PRAGMA foreign_keys=OFF held across the WHOLE
// transaction (not per table), because devices has five FK children
// (device_data, dendrometer_readings, dendro_baselines, weather_station_zones,
// chameleon_readings) with ON DELETE CASCADE, and dropping devices with FK
// enforcement on would cascade-wipe every one of them (the exact incident
// class documented in docs/operations/edge-history-retention.md and guarded
// against in the sync-init-fn devices-rebuild exception).
//
// Table DDL is extracted VERBATIM from 0001__baseline.sql - never hand
// retyped - the same discipline as generate-uganda-catchup-20260911.js.
// irrigation_events is the one exception: its single diff (a missing
// nullable column + its unique index) is safely expressible as a plain
// ALTER TABLE ADD COLUMN, so it does NOT go through the rebuild procedure -
// see the design doc for why grouping it with the other five "non-additive"
// diffs in the rehearsal report was a scope classification, not a mechanism
// one.
//
// Usage:
//   node generate-uganda-schema-rebuild-20260911.js                 # (re)generate the .sql artifact
//   node generate-uganda-schema-rebuild-20260911.js --dry-run <db>  # print what WOULD run per table, no writes
//   node generate-uganda-schema-rebuild-20260911.js --apply <db>    # guarded, per-table, idempotent apply
//   node generate-uganda-schema-rebuild-20260911.js --verify <db>   # assert live schema now matches reference(1) on all 6 tables
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../../lib/osi-migrate');
const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('../semantic-schema-compare');

const REPO = path.resolve(__dirname, '..', '..');
const SOURCE_MIGRATION = path.join(REPO, 'database/migrations/ordered/0001__baseline.sql');
const ARTIFACT_PATH = path.join(__dirname, 'uganda-schema-rebuild-20260911.sql');
const STAGING_SUFFIX = '_rebuild_20260911';

// Guard: refuse to run against a DB whose drift signature does not match what
// this artifact was designed against (constraint from the brief: "the
// artifact must refuse to run on a DB whose sha256/shape doesn't match the
// audit expectations"). We cannot pin a single sha256 (the DB legitimately
// changes: telemetry keeps landing, and the additive catch-up artifact +
// repair-sync-outbox-v2.js run before this one in the window script), so the
// guard is semantic: exactly these 17 diffs against reference(1), no more, no
// fewer, all on exactly these 6 tables. A live DB that already has some of
// them fixed, or has picked up NEW unrelated drift, fails this guard and the
// tool exits non-zero with a diff instead of guessing.
const EXPECTED_TABLES = [
  'devices', 'device_data', 'irrigation_events',
  'valve_actuation_expectations', 'zone_irrigation_calibration', 'zone_weather_cache',
];
const EXPECTED_DIFF_KEYS = [
  'changed:foreign_key:device_data',
  'changed:column:devices.chameleon_enabled',
  'changed:check:devices',
  'missing:column:irrigation_events.event_uuid',
  'changed:column:valve_actuation_expectations.created_at',
  'changed:column:valve_actuation_expectations.volume_source',
  'changed:column:zone_irrigation_calibration.created_at',
  'changed:column:zone_irrigation_calibration.measured_at',
  'changed:column:zone_irrigation_calibration.measured_flow_rate_lpm',
  'changed:column:zone_irrigation_calibration.measurement_method',
  'changed:column:zone_irrigation_calibration.updated_at',
  'changed:column:zone_weather_cache.expires_at',
  'missing:column:zone_weather_cache.fetched_at',
  'extra_unknown:column:zone_weather_cache.created_at',
  'extra_unknown:column:zone_weather_cache.updated_at',
  'changed:foreign_key:zone_weather_cache',
  'missing:index:idx_irrigation_events_event_uuid',
];

// --- statement extraction (same algorithm as generate-uganda-catchup-20260911.js:
// 0001__baseline.sql is generated/flush-left, so "next column-0 statement
// keyword" is a robust terminator; duplicated rather than imported to keep
// each generator a standalone, independently-reviewable artifact-producer). ---
const STATEMENT_START_RE = /^(?:CREATE|INSERT|DROP|PRAGMA|ALTER)\b/;

function statementStarts(text) {
  const lines = text.split('\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    if (STATEMENT_START_RE.test(line)) starts.push(offset);
    offset += line.length + 1;
  }
  starts.push(text.length);
  return starts;
}

function extractStatements(text, type) {
  const starts = statementStarts(text);
  const re = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?${type}\\s+(?:IF NOT EXISTS\\s+)?(\\w+)`, 'gim');
  const out = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const end = starts.find((s) => s > m.index);
    out.set(name, text.slice(m.index, end).trimEnd());
  }
  return out;
}

function requireAll(map, names, label) {
  const missing = names.filter((n) => !map.has(n));
  if (missing.length) throw new Error(`${label} not found in ${SOURCE_MIGRATION}: ${missing.join(', ')}`);
}

function renameCreateTable(createSql, oldName, newName) {
  const re = new RegExp(`^CREATE TABLE\\s+${oldName}\\b`);
  if (!re.test(createSql)) throw new Error(`could not find "CREATE TABLE ${oldName}" at the start of extracted DDL`);
  return createSql.replace(re, `CREATE TABLE ${newName}`);
}

// --- reference(1) build (needed to enumerate exact column names per table so
// the generated INSERT's column list is explicit and complete, never "SELECT *") ---
async function buildReference1(scratchRoot) {
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'uganda-rebuild-ref1-'));
  const subset = path.join(dir, 'migrations');
  fs.mkdirSync(subset);
  fs.copyFileSync(SOURCE_MIGRATION, path.join(subset, path.basename(SOURCE_MIGRATION)));
  const dbPath = path.join(dir, 'ref1.db');
  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, appVersion: 'uganda-rebuild-ref1' });
  return dbPath;
}

async function columnNames(runner, table) {
  const rows = await runner.all(`PRAGMA table_xinfo(${table})`);
  return rows.filter((r) => !r.hidden).map((r) => r.name);
}

// Builds one table's rebuild block: CREATE <table>_rebuild_20260911 (verbatim
// DDL, renamed) -> INSERT ... SELECT with an explicit column mapping ->
// DROP old -> RENAME -> recreate indexes/triggers (verbatim DDL). `mapping`
// is a Map from new-table column name -> SQL expression to select from the
// OLD table (usually just the same column name; zone_weather_cache.fetched_at
// is the one real remap, `created_at`).
function buildRebuildBlock({
  table, tableDdl, columns, mapping, indexDdls = [], triggerDdls = [],
}) {
  const staging = `${table}${STAGING_SUFFIX}`;
  const lines = [];
  lines.push(`-- === REBUILD: ${table} ===`);
  lines.push(renameCreateTable(tableDdl, table, staging));
  lines.push('');
  const destCols = columns.join(',\n    ');
  const srcExprs = columns.map((c) => mapping.get(c) || c).join(',\n    ');
  lines.push(`INSERT INTO ${staging} (\n    ${destCols}\n  )`);
  lines.push(`  SELECT\n    ${srcExprs}\n  FROM ${table};`);
  lines.push('');
  lines.push(`DROP TABLE ${table};`);
  lines.push(`ALTER TABLE ${staging} RENAME TO ${table};`);
  lines.push('');
  for (const ddl of indexDdls) { lines.push(ddl); lines.push(''); }
  for (const ddl of triggerDdls) {
    const name = /CREATE TRIGGER\s+(\w+)/i.exec(ddl)[1];
    lines.push(`DROP TRIGGER IF EXISTS ${name};`);
    lines.push(ddl);
    lines.push('');
  }
  lines.push(`-- === END REBUILD: ${table} ===`);
  return lines.join('\n');
}

async function generate() {
  const src = fs.readFileSync(SOURCE_MIGRATION, 'utf8');
  const tables = extractStatements(src, 'TABLE');
  const indexes = extractStatements(src, 'INDEX');
  const triggers = extractStatements(src, 'TRIGGER');

  requireAll(tables, ['devices', 'device_data', 'valve_actuation_expectations', 'zone_irrigation_calibration', 'zone_weather_cache'], 'table');
  requireAll(indexes, [
    'idx_devices_user_id', 'idx_devices_deveui', 'idx_devices_farm_id', 'idx_devices_irrigation_zone_id',
    'idx_device_data_deveui', 'idx_device_data_recorded_at', 'idx_device_data_deveui_recorded_at',
    'idx_valve_act_exp_device_eui', 'idx_valve_act_exp_active', 'idx_valve_act_exp_effect_key',
    'idx_irrigation_events_event_uuid',
  ], 'index');
  requireAll(triggers, [
    'trg_sync_devices_defaults_ai', 'trg_sync_devices_outbox_au',
    'trg_dp_device_data_outbox_ai', 'trg_sync_device_data_dirty_au', 'sync_dendro_to_readings',
  ], 'trigger');

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-rebuild-gen-'));
  const ref1Path = await buildReference1(scratchRoot);
  const ref1 = cliRunner(ref1Path);

  const devicesCols = await columnNames(ref1, 'devices');
  const deviceDataCols = await columnNames(ref1, 'device_data');
  const valveCols = await columnNames(ref1, 'valve_actuation_expectations');
  const zicCols = await columnNames(ref1, 'zone_irrigation_calibration');
  const zwcCols = await columnNames(ref1, 'zone_weather_cache');

  const blocks = [];

  // 1. devices - parent of 5 FK children; rebuilt FIRST so device_data's new
  // FK declaration (below) references the already-canonical `devices` table
  // by its final name. Column mapping: 1:1 by name (audited: no
  // missing/extra columns, only the CHECK and chameleon_enabled nullability
  // differ - see design doc "devices").
  blocks.push(buildRebuildBlock({
    table: 'devices',
    tableDdl: tables.get('devices'),
    columns: devicesCols,
    mapping: new Map(),
    indexDdls: [
      indexes.get('idx_devices_user_id'),
      indexes.get('idx_devices_deveui'),
      indexes.get('idx_devices_farm_id'),
      indexes.get('idx_devices_irrigation_zone_id'),
    ],
    triggerDdls: [
      triggers.get('trg_sync_devices_defaults_ai'),
      triggers.get('trg_sync_devices_outbox_au'),
    ],
  }));

  // 2. device_data - adds the missing `FOREIGN KEY(deveui) REFERENCES
  // devices(deveui)` declaration. Column mapping: 1:1 by name (audited: no
  // missing/extra columns). apply() preflights zero orphans before running
  // this block (see runPreflights()).
  blocks.push(buildRebuildBlock({
    table: 'device_data',
    tableDdl: tables.get('device_data'),
    columns: deviceDataCols,
    mapping: new Map(),
    indexDdls: [
      indexes.get('idx_device_data_deveui'),
      indexes.get('idx_device_data_recorded_at'),
      indexes.get('idx_device_data_deveui_recorded_at'),
    ],
    triggerDdls: [
      triggers.get('trg_dp_device_data_outbox_ai'),
      triggers.get('trg_sync_device_data_dirty_au'),
      triggers.get('sync_dendro_to_readings'),
    ],
  }));

  // 3. irrigation_events - NOT a rebuild. event_uuid is nullable in
  // reference(1) (no NOT NULL, no default), so `ALTER TABLE ... ADD COLUMN`
  // is sufficient and SQLite-safe (no full-table copy needed). The unique
  // index tolerates the column being all-NULL today (SQLite treats each NULL
  // as distinct for UNIQUE purposes) - source both statements verbatim.
  blocks.push([
    '-- === ALTER: irrigation_events (no rebuild needed - event_uuid is a plain nullable column; see design doc) ===',
    'ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT;',
    '',
    indexes.get('idx_irrigation_events_event_uuid'),
    '',
    '-- === END ALTER: irrigation_events ===',
  ].join('\n'));

  // 4. valve_actuation_expectations - drops live-only DEFAULT clauses on
  // created_at/volume_source so both match reference(1) exactly (both
  // columns stay NOT NULL; audited: 0 existing rows have a NULL in either,
  // so no data is at risk - only future INSERTs lose the DB-side default,
  // which the ordinary write path already supplies explicitly).
  blocks.push(buildRebuildBlock({
    table: 'valve_actuation_expectations',
    tableDdl: tables.get('valve_actuation_expectations'),
    columns: valveCols,
    mapping: new Map(),
    indexDdls: [
      indexes.get('idx_valve_act_exp_device_eui'),
      indexes.get('idx_valve_act_exp_active'),
      indexes.get('idx_valve_act_exp_effect_key'),
    ],
  }));

  // 5. zone_irrigation_calibration - 5 columns go nullable -> NOT NULL.
  // apply() preflights zero NULLs across all 5 before running this block.
  blocks.push(buildRebuildBlock({
    table: 'zone_irrigation_calibration',
    tableDdl: tables.get('zone_irrigation_calibration'),
    columns: zicCols,
    mapping: new Map(),
  }));

  // 6. zone_weather_cache - expires_at goes nullable -> NOT NULL (preflighted
  // for zero NULLs); fetched_at is added, backfilled from the live-only
  // created_at (the design doc's recommended mapping - see
  // "zone_weather_cache" there for the row-lifecycle argument); the live-only
  // updated_at is dropped (apply() preflights that no row's updated_at
  // differs from its created_at before running this block, so no observed
  // drift information is silently discarded); FK to irrigation_zones(id) is
  // added (apply() preflights zero orphans).
  const zwcMapping = new Map([['fetched_at', 'created_at']]);
  blocks.push(buildRebuildBlock({
    table: 'zone_weather_cache',
    tableDdl: tables.get('zone_weather_cache'),
    columns: zwcCols,
    mapping: zwcMapping,
  }));

  fs.rmSync(scratchRoot, { recursive: true, force: true });

  const header = [
    '-- Uganda schema-reconciliation table-rebuild artifact (2026-09-11)',
    '-- GENERATED by scripts/ops/generate-uganda-schema-rebuild-20260911.js - do not hand-edit.',
    `-- Source: ${path.relative(REPO, SOURCE_MIGRATION)} (reference(1)), verbatim DDL bodies.`,
    '-- Design: docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md',
    '-- Fixes the 17 residual diffs left after the additive catch-up artifact',
    '-- (scripts/ops/uganda-catchup-20260911.sql) + repair-sync-outbox-v2.js, all on',
    '-- 6 tables that already exist (table-rebuild class, sqlite.org/lang_altertable.html §7).',
    '--',
    '-- DO NOT pipe this file directly to `sqlite3` on a live device. It is a',
    '-- reviewable RENDERING of the DDL each table block runs; the sanctioned',
    '-- execution path is `generate-uganda-schema-rebuild-20260911.js --apply <db>`,',
    '-- which: (1) preflights the exact 17-diff drift signature this artifact was',
    '-- designed against and refuses on any mismatch; (2) runs per-table, skipping',
    '-- any table whose live sqlite_master DDL already matches reference(1)',
    '-- (idempotent re-run); (3) preflights orphan/NULL/drift guards documented',
    '-- inline above each block before running it; (4) holds',
    '-- PRAGMA foreign_keys=OFF across the ENTIRE transaction (devices has 5 FK',
    '-- children with ON DELETE CASCADE - see file header comment) and restores it',
    '-- ON afterward, outside the transaction; (5) runs PRAGMA integrity_check and',
    '-- PRAGMA foreign_key_check after commit and refuses to report success if',
    '-- either fails.',
    '',
    '-- PRAGMA legacy_alter_table=ON is also required (not just FK-off): with it OFF',
    '-- (the modern default), SQLite eagerly re-validates every OTHER schema object',
    "-- that mentions a renamed table's name while executing `ALTER TABLE ... RENAME",
    '-- TO devices` below, and raises a spurious `no such table: main.devices` for',
    "-- device_data's own triggers (they reference `devices` by name) during the",
    "-- instant between DROP TABLE devices and the rename completing - even though",
    '-- foreign key ENFORCEMENT is already off. legacy_alter_table=ON skips that',
    '-- eager re-validation pass entirely (empirically verified 2026-09-11: the',
    '-- fixture in generate-uganda-schema-rebuild-20260911.test.js reproduces the',
    '-- spurious error with this PRAGMA left at its default and passes with it set).',
    '',
    'PRAGMA foreign_keys = OFF;',
    'PRAGMA legacy_alter_table = ON;',
    'BEGIN IMMEDIATE;',
    '',
  ];
  const footer = ['', 'COMMIT;', 'PRAGMA foreign_keys = ON;', 'PRAGMA legacy_alter_table = OFF;', ''];

  const text = [...header, ...blocks, ...footer].join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(ARTIFACT_PATH, text);
  return ARTIFACT_PATH;
}

// --- guarded orchestration (JS layer; the .sql artifact above is provenance,
// this is what actually runs) -----------------------------------------------

async function referenceCompare(dbPath) {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-rebuild-cmp-'));
  const ref1Path = await buildReference1(scratchRoot);
  const liveSnap = await snapshotSchema(cliRunner(dbPath));
  const refSnap = await snapshotSchema(cliRunner(ref1Path));
  const cmp = compareSchemas(liveSnap, refSnap, null);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  return cmp;
}

// Index/trigger diffs are named by the object's own name (e.g.
// idx_valve_act_exp_active), which carries no table prefix - unlike column
// diffs (table.column). verify()'s "does this diff belong to one of the 6
// rebuild tables" scoping needs a name->table lookup for those, built
// dynamically from a fresh reference(1) (sqlite_master.tbl_name) rather than
// hand-maintained, so it can never silently miss an index/trigger the way a
// hardcoded list could (this is exactly the class of bug caught 2026-09-11:
// valve_actuation_expectations' 3 indexes were dropped by the rebuild and
// never recreated, and a hand-maintained scoping list did not catch it).
async function objectNamesForTables(dbPath, tableNames) {
  const runner = cliRunner(dbPath);
  const placeholders = tableNames.map((t) => `'${t}'`).join(',');
  const rows = await runner.all(
    `SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name IN (${placeholders})`);
  return new Set(rows.map((r) => r.name));
}

// Refuses to run against a DB whose drift signature isn't EXACTLY the 17
// diffs this artifact targets (a subset check, not equality, so it also
// catches "some tables already fixed" - a subset is fine, see below - but
// never an unexpected diff outside the known set). A live DB may legitimately
// have FEWER of the 17 (idempotent partial re-run scenario); it must never
// have diffs this artifact doesn't know about.
// Scopes a compareSchemas() result's failing diffs to ONLY the 6 rebuild
// tables (by column-diff table prefix, or by object name for index/trigger
// diffs via `relatedNames`, dynamically derived from reference(1) -
// see objectNamesForTables()). Diffs on any OTHER table (e.g. sync_outbox's
// 3 missing v2 columns, which repair-sync-outbox-v2.js - not this artifact -
// is responsible for, and which the window script deliberately runs AFTER
// this artifact per the design doc's ordering) are none of this tool's
// business and must never cause a refusal or count toward "clean."
function scopedFailingDiffs(cmp, relatedNames) {
  return cmp.diffs.filter((d) => {
    if (!FAILING_CLASSES.has(d.class)) return false;
    const table = d.name.includes('.') ? d.name.split('.')[0] : d.name;
    return EXPECTED_TABLES.includes(table) || relatedNames.has(d.name);
  });
}

async function preflightDriftSignature(dbPath, log) {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-rebuild-preflight-'));
  const ref1Path = await buildReference1(scratchRoot);
  const relatedNames = await objectNamesForTables(ref1Path, EXPECTED_TABLES);
  fs.rmSync(scratchRoot, { recursive: true, force: true });

  const cmp = await referenceCompare(dbPath);
  const scoped = scopedFailingDiffs(cmp, relatedNames);
  const outOfScope = scoped.filter((d) => {
    const key = `${d.class}:${d.kind}:${d.name}`;
    return !EXPECTED_DIFF_KEYS.includes(key);
  });
  if (outOfScope.length) {
    log('[uganda-rebuild] REFUSING: drift signature does not match this artifact\'s design:');
    for (const d of outOfScope) log(`  UNEXPECTED [${d.class}] ${d.kind} ${d.name} - ${d.detail}`);
    const err = new Error(`${outOfScope.length} diff(s) outside the audited 17-diff set - re-run the audit (scripts/ops/uganda-schema-audit.js) and update the design before rebuilding`);
    err.refuseAndHold = true; // distinguishes a known, examined, no-DDL-ran refusal from a genuine crash - see main()'s exit-code split
    throw err;
  }
  return { cmp, relatedNames, scoped };
}

// Per-table canonical check, SEMANTIC (not DDL-text comparison) - reuses the
// exact same scopedFailingDiffs() mechanism verify() uses: a table is
// canonical iff it has zero failing diffs against reference(1). This
// replaced a normalized-sqlite_master.sql-text comparison that was wrong for
// irrigation_events (the one ALTER-class table, see design doc §3.3):
// `ALTER TABLE ... ADD COLUMN event_uuid` appends the new column at the END
// of the live DDL text, while reference(1) declares it earlier in the
// column list, so the text comparison never matched even after a
// successful, fully-correct first apply() - a second apply() then tried
// `ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT` again and
// crashed with "duplicate column name: event_uuid" (found by the PR
// reviewer 2026-09-11; regression test:
// 'apply() is idempotent for irrigation_events across two real apply() calls').
function tableIsCanonical(scoped, table) {
  return !scoped.some((d) => (d.name.includes('.') ? d.name.split('.')[0] : d.name) === table
    || (table === 'irrigation_events' && d.name === 'idx_irrigation_events_event_uuid'));
}

// Defense-in-depth for the ALTER-class table specifically, independent of
// the semantic canonical check above: never emit `ALTER TABLE
// irrigation_events ADD COLUMN event_uuid` if the column already exists,
// full stop. This is a second, cheap, orthogonal guard (PRAGMA table_info,
// not a schema diff) - the reviewer asked for it explicitly so a future bug
// in the semantic check alone cannot reintroduce the duplicate-column crash.
async function irrigationEventsAlterBlock(runner, rawBlock) {
  const cols = await runner.all("PRAGMA table_info(irrigation_events)");
  const hasEventUuid = cols.some((c) => c.name === 'event_uuid');
  if (!hasEventUuid) return rawBlock;
  const stripped = rawBlock.replace(/^ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT;\n/m, '');
  if (stripped === rawBlock) {
    throw new Error('internal error: expected to find the irrigation_events ADD COLUMN statement in its artifact block');
  }
  return stripped;
}

// Per-table data guards. Returns null (ok to proceed) or a refusal message.
async function preflightTableData(runner, table) {
  if (table === 'device_data') {
    const [{ n }] = await runner.all("SELECT COUNT(*) AS n FROM device_data WHERE deveui NOT IN (SELECT deveui FROM devices)");
    if (Number(n) > 0) return `${n} device_data row(s) have a deveui with no matching devices row (would violate the new FK) - quarantine or repair before rebuilding, see design doc "orphan handling policy"`;
  }
  if (table === 'zone_weather_cache') {
    const [{ n: orphans }] = await runner.all("SELECT COUNT(*) AS n FROM zone_weather_cache WHERE zone_id NOT IN (SELECT id FROM irrigation_zones)");
    if (Number(orphans) > 0) return `${orphans} zone_weather_cache row(s) have a zone_id with no matching irrigation_zones row (would violate the new FK)`;
    const [{ n: nullExpires }] = await runner.all('SELECT COUNT(*) AS n FROM zone_weather_cache WHERE expires_at IS NULL');
    if (Number(nullExpires) > 0) return `${nullExpires} zone_weather_cache row(s) have NULL expires_at (would violate the new NOT NULL)`;
    const [{ n: driftedUpdated }] = await runner.all('SELECT COUNT(*) AS n FROM zone_weather_cache WHERE updated_at IS NOT created_at');
    if (Number(driftedUpdated) > 0) return `${driftedUpdated} zone_weather_cache row(s) have updated_at <> created_at - dropping updated_at would silently discard real drift information; see design doc "zone_weather_cache" before proceeding`;
  }
  if (table === 'zone_irrigation_calibration') {
    for (const col of ['created_at', 'measured_at', 'measured_flow_rate_lpm', 'measurement_method', 'updated_at']) {
      const [{ n }] = await runner.all(`SELECT COUNT(*) AS n FROM zone_irrigation_calibration WHERE ${col} IS NULL`);
      if (Number(n) > 0) return `${n} zone_irrigation_calibration row(s) have NULL ${col} (would violate the new NOT NULL)`;
    }
  }
  return null;
}

function parseArtifactBlocks(sql) {
  const blocks = new Map(); // table -> { text, startsWith }
  const re = /-- === (?:REBUILD|ALTER): (\w+)[\s\S]*?-- === END (?:REBUILD|ALTER): \1 ===/g;
  let m;
  while ((m = re.exec(sql)) !== null) blocks.set(m[1], m[0]);
  return blocks;
}

async function dryRun(dbPath, log = console.error) {
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: database file does not exist: ${dbPath}`);
  if (!fs.existsSync(ARTIFACT_PATH)) throw new Error(`artifact not generated yet: ${ARTIFACT_PATH}`);
  const { scoped } = await preflightDriftSignature(dbPath, log);
  const runner = cliRunner(dbPath);
  const sql = fs.readFileSync(ARTIFACT_PATH, 'utf8');
  const blocks = parseArtifactBlocks(sql);
  for (const table of EXPECTED_TABLES) {
    if (tableIsCanonical(scoped, table)) { log(`[uganda-rebuild] DRY-RUN: ${table} already canonical - would SKIP`); continue; }
    const refusal = await preflightTableData(runner, table);
    if (refusal) { log(`[uganda-rebuild] DRY-RUN: ${table} would REFUSE: ${refusal}`); continue; }
    log(`[uganda-rebuild] DRY-RUN: ${table} would REBUILD (${blocks.has(table) ? blocks.get(table).split('\n').length : '?'} lines)`);
  }
}

async function apply(dbPath, log = console.error) {
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: database file does not exist: ${dbPath}`);
  if (!fs.existsSync(ARTIFACT_PATH)) throw new Error(`artifact not generated yet: ${ARTIFACT_PATH}`);
  const { scoped } = await preflightDriftSignature(dbPath, log);

  const runner = cliRunner(dbPath);
  const sql = fs.readFileSync(ARTIFACT_PATH, 'utf8');
  const blocks = parseArtifactBlocks(sql);

  const toRun = [];
  for (const table of EXPECTED_TABLES) {
    if (tableIsCanonical(scoped, table)) { log(`[uganda-rebuild] ${table}: already canonical, skipping (idempotent re-run)`); continue; }
    const refusal = await preflightTableData(runner, table);
    if (refusal) {
      const err = new Error(`${table}: refusing to rebuild - ${refusal}`);
      err.refuseAndHold = true;
      throw err;
    }
    if (!blocks.has(table)) throw new Error(`internal error: no artifact block found for ${table}`);
    toRun.push(table);
  }

  if (toRun.length === 0) {
    log('[uganda-rebuild] all 6 tables already canonical; nothing to do.');
    return { ran: [] };
  }

  const blockTexts = [];
  for (const t of toRun) {
    if (t === 'irrigation_events') {
      blockTexts.push(await irrigationEventsAlterBlock(runner, blocks.get(t)));
    } else {
      blockTexts.push(blocks.get(t));
    }
  }
  const body = blockTexts.join('\n\n');
  // Both PRAGMAs are no-ops inside an open transaction, so both the OFF/ON and
  // legacy_alter_table toggles bracket BEGIN/COMMIT rather than sitting inside
  // it (see the artifact header comment for why legacy_alter_table=ON is
  // required, not just foreign_keys=OFF).
  const script = `PRAGMA foreign_keys = OFF;\nPRAGMA legacy_alter_table = ON;\nBEGIN IMMEDIATE;\n\n${body}\n\nCOMMIT;\n`;
  await runner.exec(script);
  await runner.exec('PRAGMA foreign_keys = ON;\nPRAGMA legacy_alter_table = OFF;');

  const integrity = execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim();
  if (integrity !== 'ok') throw new Error(`post-apply integrity_check failed: ${integrity}`);
  const fkViolations = execFileSync('sqlite3', [dbPath, 'PRAGMA foreign_key_check'], { encoding: 'utf8' }).trim();
  if (fkViolations !== '') throw new Error(`post-apply foreign_key_check found violations:\n${fkViolations}`);

  log(`[uganda-rebuild] applied: ${toRun.join(', ')}; integrity_check ok; foreign_key_check ok`);
  return { ran: toRun };
}

async function verify(dbPath, log = console.error) {
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: database file does not exist: ${dbPath}`);
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-rebuild-verify-'));
  const ref1Path = await buildReference1(scratchRoot);
  const relatedNames = await objectNamesForTables(ref1Path, EXPECTED_TABLES);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  const cmp = await referenceCompare(dbPath);
  const failing = scopedFailingDiffs(cmp, relatedNames);
  if (failing.length) {
    log(`[uganda-rebuild] --verify FAILED: ${failing.length} diff(s) remain on the 6 rebuild tables:`);
    for (const d of failing) log(`  [${d.class}] ${d.kind} ${d.name} - ${d.detail}`);
    return false;
  }
  log('[uganda-rebuild] --verify PASSED: all 6 tables match reference(1) (devices, device_data, irrigation_events, valve_actuation_expectations, zone_irrigation_calibration, zone_weather_cache).');
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--apply') {
    await apply(argv[1]);
  } else if (argv[0] === '--dry-run') {
    await dryRun(argv[1]);
  } else if (argv[0] === '--verify') {
    const ok = await verify(argv[1]);
    process.exit(ok ? 0 : 1);
  } else {
    const p = await generate();
    console.error(`[uganda-rebuild] generated ${p}`);
  }
}

// Exit codes for --apply (and --dry-run, which never mutates but shares the
// same preflight): 0 = success (including "nothing to do, already
// canonical"). 1 = REFUSE-AND-HOLD - a known precondition failed (drift
// signature mismatch, or a per-table orphan/NULL/drift data guard) BEFORE
// any DDL ran; the DB is untouched and the fix is to repair the data or
// re-run the audit, not to restore a backup. 2 = an unexpected failure
// (e.g. a crash mid-DDL, caught by SQLite's own transaction rollback rather
// than one of this tool's own preflight guards) - the window script treats
// this as a signal to stop and have an operator restore the pre-rebuild
// on-device backup before retrying, even though the transaction itself
// rolled back cleanly, because it means something this design did not
// anticipate happened.
if (require.main === module) {
  main().catch((e) => {
    console.error(`[uganda-rebuild] FAILED: ${e.message}`);
    process.exit(e.refuseAndHold ? 1 : 2);
  });
}

module.exports = {
  generate, dryRun, apply, verify,
  preflightDriftSignature, preflightTableData, tableIsCanonical, irrigationEventsAlterBlock, parseArtifactBlocks,
  EXPECTED_TABLES, EXPECTED_DIFF_KEYS, ARTIFACT_PATH, STAGING_SUFFIX,
};
