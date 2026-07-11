'use strict';
// Static contract for deploy.sh's Stage 1 migration wiring. This deliberately
// avoids running deploy.sh because the real script targets a live gateway path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const deploy = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(
  path.join(REPO, 'database/migrations/ordered/CHECKSUMS.json'),
  'utf8'
));

function indexOf(needle) {
  const idx = deploy.indexOf(needle);
  assert.notEqual(idx, -1, `missing deploy.sh snippet: ${needle}`);
  return idx;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('deploy migration wiring fetches the ordered migration corpus from CHECKSUMS.json', () => {
  assert.deepEqual(Object.keys(manifest).sort(), [
    '0001__baseline.sql',
    '0002__gateway_health.sql',
    '0003__stamp_contract_version_and_zone_op_split.sql',
    '0004__widen_schedule_trigger_metric_check.sql',
    '0005__field_work_requests.sql',
    '0006__improvement_request_contact_email.sql',
    '0007__analysis_views.sql',
  ]);
  assert.match(deploy, /database\/migrations\/ordered\/CHECKSUMS\.json/);
  assert.match(deploy, /Object\.keys\(manifest\)\.sort\(\)/);
  assert.match(deploy, /database\/migrations\/ordered\/\$migration/);
  assert.match(deploy, /\$migrations_dir\/\$migration/);
});

test('deploy migration wiring fetches the runner, Stage 0 helpers, and semantic compare dependency', () => {
  for (const script of [
    'baseline-existing-db.js',
    'repair-sync-outbox-v2.js',
    'migrate-cli.js',
    'semantic-schema-compare.js',
  ]) {
    assert.match(deploy, new RegExp(`\\b${escapeRegExp(script)}\\b`), script);
  }
  assert.match(deploy, /"scripts\/\$script" "\$TMP_DIR\/scripts\/\$script"/);
  for (const module of [
    'backup.js',
    'fingerprints.js',
    'index.js',
    'ledger.js',
    'migrations-loader.js',
    'runner-iface.js',
    'runner.js',
    'sql-normalize.js',
  ]) {
    assert.match(deploy, new RegExp(`\\b${escapeRegExp(module)}\\b`), module);
  }
  assert.match(deploy, /"lib\/osi-migrate\/\$module" "\$TMP_DIR\/lib\/osi-migrate\/\$module"/);
});

test('deploy migration wiring stops writers, checkpoints WAL, baselines, and applies in order', () => {
  const stopIdx = indexOf('/etc/init.d/node-red stop');
  const pgrepIdx = indexOf("pgrep -f 'node-red'");
  const firstCheckpointIdx = indexOf('if ! checkpoint_live_db; then');
  const ledgerIdx = indexOf("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1;");
  const ledgerRowsIdx = indexOf('SELECT COUNT(*) FROM schema_migrations;');
  const repairIdx = indexOf('node "$TMP_DIR/scripts/repair-sync-outbox-v2.js" "$DB_PATH"');
  const baselineIdx = indexOf('node "$TMP_DIR/scripts/baseline-existing-db.js" "$DB_PATH" --migrations-dir "$migrations_dir"');
  const secondCheckpointIdx = deploy.indexOf('if ! checkpoint_live_db; then', firstCheckpointIdx + 1);
  const migrateIdx = indexOf('node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --migrations-dir "$migrations_dir"');

  assert.ok(stopIdx < firstCheckpointIdx, 'Node-RED must stop before checkpointing');
  assert.ok(stopIdx < pgrepIdx && pgrepIdx < firstCheckpointIdx, 'Node-RED process poll must precede checkpointing');
  assert.ok(firstCheckpointIdx < ledgerIdx, 'checkpoint must precede ledger inspection');
  assert.ok(ledgerIdx < ledgerRowsIdx, 'ledger presence check must precede row-count inspection');
  assert.ok(ledgerRowsIdx < repairIdx, 'pre-baseline repair only runs after ledger row-count inspection');
  assert.ok(repairIdx < baselineIdx, 'sync_outbox v2 repair must precede semantic baseline');
  assert.ok(baselineIdx < secondCheckpointIdx, 'baseline writes must be checkpointed before byte-copy backup');
  assert.ok(secondCheckpointIdx < migrateIdx, 'second checkpoint must precede migrate-cli');
  assert.match(deploy, /SKIP: schema_migrations ledger already has rows/);
});

test('deploy migration wiring provisions sqlite3-cli before refusing', () => {
  const ensureIdx = indexOf('ensure_sqlite3_cli()');
  const installIdx = indexOf('opkg install sqlite3-cli');
  const callIdx = indexOf('if ! ensure_sqlite3_cli; then');

  assert.ok(ensureIdx < installIdx, 'ensure_sqlite3_cli must own opkg provisioning');
  assert.ok(installIdx < callIdx, 'function must be defined before use');
  assert.match(deploy, /opkg update/);
  assert.match(deploy, /ERROR: sqlite3 CLI unavailable and could not be installed/);
});

test('deploy migration wiring uses persistent backup path and preserves cleanup trap behavior', () => {
  assert.match(deploy, /MIGRATE_BACKUP_DIR:-\/data\/backups\/migrate/);
  assert.match(deploy, /trap 'restart_node_red \|\| true; cleanup' EXIT INT TERM/);
  assert.match(deploy, /restore_deploy_trap\(\) \{\n    trap cleanup EXIT INT TERM\n\}/);

  const rc3Start = indexOf('if [ "$migration_rc" = "3" ]; then');
  const rc3End = indexOf('echo "ERROR: schema migration failed; Node-RED will be restarted before deploy exits"');
  const rc3Block = deploy.slice(rc3Start, rc3End);
  assert.match(rc3Block, /node_red_restart_needed=0/);
  assert.match(rc3Block, /restore_deploy_trap/);
  assert.doesNotMatch(rc3Block, /restart_node_red/);
});

test('deploy.sh has a single migration call site and no inline schema DDL helpers', () => {
  assert.match(deploy, /run_schema_migration\(\)/);
  assert.match(deploy, /run_schema_migration \|\| exit 1/);
  assert.doesNotMatch(deploy, /\bensure_(dendro|zone_irrigation_calibration|analysis_views|chameleon|gateway_health|improvement_requests)_schema\b/);
  assert.doesNotMatch(deploy, /\bCREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(deploy, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(deploy, /\bDROP\s+(TABLE|TRIGGER)\b/i);
});
