'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../../lib/osi-migrate');
const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('../semantic-schema-compare');
const {
  generate, dryRun, apply, verify, preflightDriftSignature, preflightTableData,
  EXPECTED_TABLES, ARTIFACT_PATH,
} = require('./generate-uganda-schema-rebuild-20260911');
const { apply: catchupApply, generate: catchupGenerate } = require('./generate-uganda-catchup-20260911');
const { repairSyncOutboxV2 } = require('../repair-sync-outbox-v2');

const REPO = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-schema-rebuild-test-'));
  return path.join(dir, 'test.db');
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// buildDriftedFixture() only ever needs reference(1) (migration 0001) as its
// starting point - NOT the full 53-migration chain. bootstrapFresh's
// per-migration fingerprint stamping is the expensive part (see
// generate-uganda-catchup-20260911.test.js's header comment: ~3.5 minutes for
// a full-chain reference build), so every call site below that only needs
// reference(1) uses this subset dir; only the final end-to-end test (which
// genuinely needs to reach head via migrate-cli) uses the full MIGRATIONS_DIR.
function ref1MigrationsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-schema-rebuild-ref1-subset-'));
  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001__baseline.sql'), path.join(dir, '0001__baseline.sql'));
  return dir;
}

async function tableSql(runner, name) {
  const [row] = await runner.all(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${name}'`);
  if (!row) throw new Error(`table not found: ${name}`);
  return row.sql;
}

async function objectSqls(runner, type, tblName) {
  const rows = await runner.all(`SELECT sql FROM sqlite_master WHERE type='${type}' AND tbl_name='${tblName}' AND sql IS NOT NULL`);
  return rows.map((r) => r.sql);
}

// Builds a reference(1)-shaped DB, then DEGRADES it to reproduce exactly the
// 17-diff drift shape audited on the real Uganda copy. Every DDL statement
// below starts from the REAL reference(1) DDL (captured via sqlite_master,
// not hand-retyped) with only the specific targeted clause string-replaced -
// so column order/types/defaults everywhere else stay byte-identical to
// reference(1) and this fixture cannot itself introduce accidental drift the
// real audit didn't find. Indexes/triggers on devices/device_data are
// captured before the drop and recreated verbatim after the rename, exactly
// mirroring what the real additive catch-up artifact + pre-existing schema
// already provide on Uganda before this rebuild artifact ever runs.
async function buildDriftedFixture(db) {
  await bootstrapFresh(cliRunner(db), { migrationsDir: ref1MigrationsDir(), appVersion: 'test' });
  const runner = cliRunner(db);

  const devicesSql = await tableSql(runner, 'devices');
  const devicesObjs = [...await objectSqls(runner, 'index', 'devices'), ...await objectSqls(runner, 'trigger', 'devices')];
  const deviceDataSql = await tableSql(runner, 'device_data');
  const deviceDataObjs = [...await objectSqls(runner, 'index', 'device_data'), ...await objectSqls(runner, 'trigger', 'device_data')];
  const vaeSql = await tableSql(runner, 'valve_actuation_expectations');
  const vaeObjs = await objectSqls(runner, 'index', 'valve_actuation_expectations');
  const zicSql = await tableSql(runner, 'zone_irrigation_calibration');
  const zwcSql = await tableSql(runner, 'zone_weather_cache');

  const devicesDrift = devicesSql
    .replace(/^CREATE TABLE devices\b/, 'CREATE TABLE devices_drift')
    .replace(/,'AQUASCOPE_LORAIN'/, '')
    .replace(/chameleon_enabled(\s+)INTEGER DEFAULT 0/i, 'chameleon_enabled$1INTEGER NOT NULL DEFAULT 0');
  if (devicesDrift === devicesSql) throw new Error('devices drift replacement had no effect - DDL shape changed upstream?');

  const deviceDataDrift = deviceDataSql
    .replace(/^CREATE TABLE device_data\b/, 'CREATE TABLE device_data_drift')
    .replace(/,\s*\n\s*FOREIGN KEY \(deveui\) REFERENCES devices\(deveui\) ON DELETE CASCADE\s*\n/, '\n');
  if (deviceDataDrift === deviceDataSql) throw new Error('device_data drift replacement had no effect');

  const vaeDrift = vaeSql
    .replace(/^CREATE TABLE valve_actuation_expectations\b/, 'CREATE TABLE vae_drift')
    .replace(/created_at(\s+)TEXT NOT NULL/, "created_at$1TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .replace(/volume_source(\s+)TEXT NOT NULL/, "volume_source$1TEXT NOT NULL DEFAULT 'unknown'");
  if (vaeDrift === vaeSql) throw new Error('valve_actuation_expectations drift replacement had no effect');

  const zicDrift = zicSql
    .replace(/^CREATE TABLE zone_irrigation_calibration\b/, 'CREATE TABLE zic_drift')
    .replace(/measured_flow_rate_lpm(\s+)REAL NOT NULL/, 'measured_flow_rate_lpm$1REAL')
    .replace(/measurement_method(\s+)TEXT NOT NULL/, 'measurement_method$1TEXT')
    .replace(/measured_at(\s+)TEXT NOT NULL/, 'measured_at$1TEXT')
    .replace(/created_at(\s+)TEXT NOT NULL/, 'created_at$1TEXT')
    .replace(/updated_at(\s+)TEXT NOT NULL/, 'updated_at$1TEXT');
  if (zicDrift === zicSql) throw new Error('zone_irrigation_calibration drift replacement had no effect');

  const zwcDrift = zwcSql
    .replace(/^CREATE TABLE zone_weather_cache\b/, 'CREATE TABLE zwc_drift')
    .replace(/fetched_at\s+TEXT NOT NULL,\s*\n/, '')
    .replace(/expires_at(\s+)TEXT NOT NULL/, 'expires_at$1TEXT')
    .replace(/,\s*\n\s*FOREIGN KEY \(zone_id\) REFERENCES irrigation_zones\(id\) ON DELETE CASCADE\s*\n/, '\n')
    .replace(/PRIMARY KEY \(zone_id, cache_key\)/, 'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (zone_id, cache_key)');
  if (zwcDrift === zwcSql) throw new Error('zone_weather_cache drift replacement had no effect');

  const stmts = [
    'PRAGMA foreign_keys=OFF;',
    'PRAGMA legacy_alter_table=ON;',
    'BEGIN IMMEDIATE;',

    devicesDrift + ';',
    'INSERT INTO devices_drift SELECT * FROM devices;',
    'DROP TABLE devices;',
    'ALTER TABLE devices_drift RENAME TO devices;',
    ...devicesObjs.map((s) => `${s};`),
    "INSERT INTO devices (deveui, name, type_id, created_at, updated_at) VALUES ('TESTDEV01', 'test', 'KIWI_SENSOR', datetime('now'), datetime('now'));",

    deviceDataDrift + ';',
    'INSERT INTO device_data_drift SELECT * FROM device_data;',
    'DROP TABLE device_data;',
    'ALTER TABLE device_data_drift RENAME TO device_data;',
    ...deviceDataObjs.map((s) => `${s};`),

    vaeDrift + ';',
    'INSERT INTO vae_drift SELECT * FROM valve_actuation_expectations;',
    'DROP TABLE valve_actuation_expectations;',
    'ALTER TABLE vae_drift RENAME TO valve_actuation_expectations;',
    ...vaeObjs.map((s) => `${s};`),

    zicDrift + ';',
    'INSERT INTO zic_drift SELECT * FROM zone_irrigation_calibration;',
    'DROP TABLE zone_irrigation_calibration;',
    'ALTER TABLE zic_drift RENAME TO zone_irrigation_calibration;',
    "INSERT INTO zone_irrigation_calibration (zone_id, valve_device_eui, measured_flow_rate_lpm, measurement_method, measured_at, created_at, updated_at) VALUES (7777, 'X', 3.5, 'bucket_test', datetime('now'), datetime('now'), datetime('now'));",

    zwcDrift + ';',
    'INSERT INTO zwc_drift (zone_id, cache_key, source, payload_json, observed_at, expires_at) SELECT zone_id, cache_key, source, payload_json, observed_at, expires_at FROM zone_weather_cache;',
    'DROP TABLE zone_weather_cache;',
    'ALTER TABLE zwc_drift RENAME TO zone_weather_cache;',
    "INSERT INTO zone_weather_cache (zone_id, cache_key, payload_json, expires_at, created_at, updated_at) SELECT id, 'et0', '{}', '2026-01-01', datetime('now'), datetime('now') FROM irrigation_zones LIMIT 1;",

    'COMMIT;',
    'PRAGMA foreign_keys=ON;',
    'PRAGMA legacy_alter_table=OFF;',
  ];
  await runner.exec(stmts.join('\n'));
  return db;
}

test('generate() emits verbatim, per-table REBUILD/ALTER blocks with no ad hoc DDL', async () => {
  await generate();
  const sql = fs.readFileSync(ARTIFACT_PATH, 'utf8');
  assert.match(sql, /-- === REBUILD: devices ===/);
  assert.match(sql, /CREATE TABLE devices_rebuild_20260911/);
  assert.match(sql, /-- === REBUILD: device_data ===/);
  assert.match(sql, /-- === ALTER: irrigation_events/);
  assert.match(sql, /ALTER TABLE irrigation_events ADD COLUMN event_uuid TEXT;/);
  assert.match(sql, /-- === REBUILD: valve_actuation_expectations ===/);
  assert.match(sql, /-- === REBUILD: zone_irrigation_calibration ===/);
  assert.match(sql, /-- === REBUILD: zone_weather_cache ===/);
  assert.match(sql, /created_at\s*\n\s*\)\s*\n\s*FROM zone_weather_cache;/); // fetched_at <- created_at mapping present
  assert.match(sql, /PRAGMA foreign_keys = OFF;\nPRAGMA legacy_alter_table = ON;\nBEGIN IMMEDIATE;/);
});

test('preflightDriftSignature accepts the expected 17-diff fixture and refuses unexpected drift', async () => {
  const db = tmpDb();
  await buildDriftedFixture(db);
  await preflightDriftSignature(db, () => {}); // must not throw

  const clean = tmpDb();
  await bootstrapFresh(cliRunner(clean), { migrationsDir: ref1MigrationsDir(), appVersion: 'test' });
  const cRunner = cliRunner(clean);
  await cRunner.exec('BEGIN IMMEDIATE;\nALTER TABLE users ADD COLUMN surprise_unrelated_column TEXT;\nCOMMIT;');
  await assert.rejects(() => preflightDriftSignature(clean, () => {}), /outside the audited 17-diff set/);
});

test('preflightTableData refuses on orphans/NULLs and passes on clean data', async () => {
  const db = tmpDb();
  await buildDriftedFixture(db);
  const runner = cliRunner(db);
  // clean fixture: all preflights pass (no orphans planted)
  assert.equal(await preflightTableData(runner, 'device_data'), null);
  assert.equal(await preflightTableData(runner, 'zone_weather_cache'), null);
  assert.equal(await preflightTableData(runner, 'zone_irrigation_calibration'), null);

  // plant an orphan and confirm the guard catches it
  await runner.exec("INSERT INTO device_data (deveui, recorded_at) VALUES ('NOT-A-REAL-DEVICE', datetime('now'));");
  const refusal = await preflightTableData(runner, 'device_data');
  assert.match(refusal, /no matching devices row/);
});

test('apply() rebuilds the drifted fixture to a clean reference(1) match, is idempotent, and preserves row counts/data', async () => {
  const db = tmpDb();
  await buildDriftedFixture(db);

  const before = {};
  const runner = cliRunner(db);
  for (const t of EXPECTED_TABLES) before[t] = Number((await runner.all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);

  const res1 = await apply(db);
  assert.deepEqual(res1.ran.sort(), ['device_data', 'devices', 'valve_actuation_expectations', 'zone_irrigation_calibration', 'zone_weather_cache'].sort());

  const ok = await verify(db);
  assert.equal(ok, true);

  // Regression (found 2026-09-11): the rebuild block for
  // valve_actuation_expectations originally dropped its 3 indexes and never
  // recreated them, and verify()'s table-scoping filter (keyed by
  // `name.split('.')[0]`, which is a no-op for an index name with no dot)
  // silently excluded the resulting [missing] index diffs from its own
  // failure check - so verify() reported PASS even with 3 real indexes
  // missing. Assert the indexes explicitly, independent of verify()'s own
  // (now-fixed) scoping.
  const vaeIndexNames = (await runner.all(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='valve_actuation_expectations'"))
    .map((r) => r.name);
  assert.deepEqual(vaeIndexNames.sort(), ['idx_valve_act_exp_active', 'idx_valve_act_exp_device_eui', 'idx_valve_act_exp_effect_key'].sort());

  for (const t of EXPECTED_TABLES) {
    const after = Number((await runner.all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
    assert.equal(after, before[t], `row count changed for ${t}`);
  }

  // zone_weather_cache fetched_at was backfilled from created_at (the one row)
  const [row] = await runner.all('SELECT fetched_at, created_at_is_gone FROM (SELECT fetched_at, 1 AS created_at_is_gone FROM zone_weather_cache LIMIT 1)');
  assert.ok(row.fetched_at);

  const integ = (await runner.all('PRAGMA integrity_check'))[0];
  assert.equal(integ.integrity_check || Object.values(integ)[0], 'ok');
  const fk = await runner.all('PRAGMA foreign_key_check');
  assert.deepEqual(fk, []);

  // idempotent re-run: everything already canonical, nothing to do
  const res2 = await apply(db);
  assert.deepEqual(res2.ran, []);
  const ok2 = await verify(db);
  assert.equal(ok2, true);

  // verify()'s scoping must actually catch a missing index/trigger on one of
  // the 6 tables, not just report PASS by construction (regression for the
  // same 2026-09-11 scoping bug - this asserts the DETECTOR, independent of
  // whether the generator's own artifact currently has the bug).
  await runner.exec('DROP INDEX idx_valve_act_exp_active;');
  const okAfterDamage = await verify(db);
  assert.equal(okAfterDamage, false, 'verify() must detect a manually-dropped index on an in-scope table');
});

test('apply() end-to-end: catch-up artifact -> rebuild artifact -> repair-sync-outbox-v2 -> baseline-existing-db stamps N=1 -> migrate-cli reaches head -> verify-head ok', async () => {
  const { runBaseline } = require('../baseline-existing-db');
  const { runMigrateCli } = require('../migrate-cli');
  const { runVerifyHead } = require('../verify-head-cli');

  // Build a Uganda-shaped fixture: reference(1) shape, but with the 6 missing
  // whole objects the catch-up artifact targets ALSO stripped out first (the
  // real on-device order: additive catch-up runs before this rebuild).
  const db = tmpDb();
  await buildDriftedFixture(db);
  const runner = cliRunner(db);
  const { TABLES: catchupTables, TRIGGERS: catchupTriggers } = require('./generate-uganda-catchup-20260911');
  const drops = [];
  for (const t of catchupTables) drops.push(`DROP TABLE IF EXISTS ${t};`);
  for (const tr of catchupTriggers) drops.push(`DROP TRIGGER IF EXISTS ${tr};`);
  await runner.exec(`PRAGMA foreign_keys=OFF;\nBEGIN IMMEDIATE;\n${drops.join('\n')}\nCOMMIT;\nPRAGMA foreign_keys=ON;`);

  const shaBeforeCatchup = sha256File(db);

  catchupGenerate();
  await catchupApply(db);
  await repairSyncOutboxV2(db);
  const rebuildRes = await apply(db);
  assert.ok(rebuildRes.ran.length > 0);

  const { matched } = await runBaseline({ dbPath: db, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.equal(matched, 1, 'baseline-existing-db must stamp N=1 after both artifacts');

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-rebuild-migrate-backup-'));
  await runMigrateCli({ dbPath: db, backupDir, migrationsDir: MIGRATIONS_DIR, log: () => {} });

  const head = await runVerifyHead({ dbPath: db, migrationsDir: MIGRATIONS_DIR });
  assert.equal(head.ok, true, `verify-head not ok: ${JSON.stringify(head)}`);

  const integ = (await runner.all('PRAGMA integrity_check'))[0];
  assert.equal(integ.integrity_check || Object.values(integ)[0], 'ok');
  const fk = await runner.all('PRAGMA foreign_key_check');
  assert.deepEqual(fk, []);

  assert.notEqual(sha256File(db), shaBeforeCatchup, 'sanity: the DB actually changed across this pipeline');
});
