'use strict';
// Static contract for deploy.sh's Stage 1 migration wiring. This deliberately
// avoids running deploy.sh because the real script targets a live gateway path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const deploy = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const migrationsDir = path.join(REPO, 'database/migrations/ordered');
const manifest = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'CHECKSUMS.json'), 'utf8'));

function indexOf(needle) {
  const idx = deploy.indexOf(needle);
  assert.notEqual(idx, -1, `missing deploy.sh snippet: ${needle}`);
  return idx;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('deploy migration wiring fetches the ordered migration corpus from CHECKSUMS.json', () => {
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter((name) => /^\d{4}__.*\.sql$/.test(name))
    .sort();
  assert.deepEqual(Object.keys(manifest).sort(), migrationFiles);
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
    'restamp-fingerprints.js',
    'verify-head-cli.js',
    'verify-runtime-schema-parity.js',
  ]) {
    assert.match(deploy, new RegExp(`\\b${escapeRegExp(script)}\\b`), script);
  }
  assert.match(deploy, /"scripts\/\$script" "\$TMP_DIR\/scripts\/\$script"/);
  for (const module of [
    'add-column-compat.js',
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
  const serviceStateIdx = indexOf('node_red_service_state()');
  const stopStateIdx = deploy.indexOf('wait_for_node_red_stop "$NODE_RED_STOP_TIMEOUT"', stopIdx);
  const firstCheckpointIdx = indexOf('if ! checkpoint_live_db; then');
  const ledgerIdx = deploy.indexOf("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1;", firstCheckpointIdx);
  const ledgerRowsIdx = indexOf('SELECT COUNT(*) FROM schema_migrations;');
  const repairIdx = indexOf('node "$TMP_DIR/scripts/repair-sync-outbox-v2.js" "$DB_PATH"');
  const baselineIdx = indexOf('node "$TMP_DIR/scripts/baseline-existing-db.js" "$DB_PATH" --migrations-dir "$migrations_dir"');
  const secondCheckpointIdx = deploy.indexOf('if ! checkpoint_live_db; then', firstCheckpointIdx + 1);
  const migrateIdx = indexOf('node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --migrations-dir "$migrations_dir"');

  assert.ok(stopIdx < firstCheckpointIdx, 'Node-RED must stop before checkpointing');
  assert.ok(serviceStateIdx < stopIdx, 'the named service-state helper must be defined before the stop gate');
  assert.ok(stopIdx < stopStateIdx && stopStateIdx < firstCheckpointIdx, 'Node-RED service-state poll must precede checkpointing');
  assert.ok(firstCheckpointIdx < ledgerIdx, 'checkpoint must precede ledger inspection');
  assert.ok(ledgerIdx < ledgerRowsIdx, 'ledger presence check must precede row-count inspection');
  assert.ok(ledgerRowsIdx < repairIdx, 'pre-baseline repair only runs after ledger row-count inspection');
  assert.ok(repairIdx < baselineIdx, 'sync_outbox v2 repair must precede semantic baseline');
  assert.ok(baselineIdx < secondCheckpointIdx, 'baseline writes must be checkpointed before byte-copy backup');
  assert.ok(secondCheckpointIdx < migrateIdx, 'second checkpoint must precede migrate-cli');
  assert.match(deploy, /SKIP: schema_migrations ledger already has rows/);
});

test('deploy migration wiring self-heal prunes and disk-preflights before stopping Node-RED', () => {
  const backupDirIdx = indexOf('backup_dir="${MIGRATE_BACKUP_DIR:-/data/backups/migrate}"');
  const mkdirIdx = deploy.indexOf('mkdir -p "$backup_dir"', backupDirIdx);
  const pruneOnlyIdx = indexOf(
    'node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --prune-only || true'
  );
  const dbBytesIdx = indexOf('db_bytes=$(ls -ln "$DB_PATH" | awk \'{print $5}\')');
  const availKbIdx = indexOf('avail_kb=$(df -k "$backup_dir" | tail -1 | awk \'{print $(NF-2)}\')');
  const reqKbIdx = indexOf('req_kb=$(( 2 * db_kb + margin_mb * 1024 ))');
  const errorIdx = indexOf('ERROR: insufficient disk for a safe schema migration');
  const restartFlagIdx = indexOf('node_red_restart_needed=1');
  const stopIdx = indexOf('/etc/init.d/node-red stop');

  assert.ok(mkdirIdx > 0 && backupDirIdx < mkdirIdx, 'backup_dir must be resolved before mkdir -p');
  assert.ok(mkdirIdx < pruneOnlyIdx, 'self-heal prune-only runs after backup_dir exists');
  assert.ok(pruneOnlyIdx < dbBytesIdx, 'self-heal prune runs before the disk preflight size check');
  assert.ok(dbBytesIdx < availKbIdx, 'DB size read precedes available-space read');
  assert.ok(availKbIdx < reqKbIdx, 'available-space read precedes the required-space threshold calc');
  assert.ok(reqKbIdx < errorIdx, 'threshold calc precedes the fail-fast error message');
  assert.ok(errorIdx < restartFlagIdx, 'disk preflight gate runs before node_red_restart_needed is set');
  assert.ok(restartFlagIdx < stopIdx, 'disk preflight leaves Node-RED running: it precedes the stop call');

  // BusyBox df wraps long device rows onto their own line, shifting every
  // field right by one — Available must be read as the 3rd-from-last field,
  // matching the wrap-safe idiom already used for the mount-point comparison.
  assert.match(deploy, /awk '\{print \$\(NF-2\)\}'/);
  // O(1) size via `ls -ln`, never `wc -c`.
  assert.doesNotMatch(deploy, /wc -c.*DB_PATH/);
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

test('deploy migration wiring uses persistent backup path and lifecycle-aware cleanup', () => {
  assert.match(deploy, /MIGRATE_BACKUP_DIR:-\/data\/backups\/migrate/);
  assert.match(deploy, /trap 'deploy_exit_handler \$\?' EXIT/);
  assert.match(deploy, /trap 'exit 130' INT/);
  assert.match(deploy, /trap 'exit 143' TERM/);

  const exitHandlerStart = indexOf('deploy_exit_handler() {');
  const trapInstallStart = indexOf('install_deploy_exit_trap() {');
  const exitHandlerBlock = deploy.slice(exitHandlerStart, trapInstallStart);
  const nodeRedRestoreIdx = exitHandlerBlock.lastIndexOf('restart_node_red');
  const identitydRestoreIdx = exitHandlerBlock.lastIndexOf('restore_identityd_prior_state');
  assert.ok(nodeRedRestoreIdx >= 0, 'EXIT handler must restore Node-RED when required');
  assert.ok(identitydRestoreIdx > nodeRedRestoreIdx, 'EXIT handler must restore Node-RED before identityd');

  const quiesceIdx = indexOf('quiesce_identityd_for_deploy || exit 1');
  const migrationCallIdx = indexOf('run_schema_migration || exit 1');
  assert.ok(quiesceIdx < migrationCallIdx, 'identityd quiescence must precede schema migration');

  const rc3Start = indexOf('if [ "$migration_rc" = "3" ]; then');
  const rc3End = indexOf('echo "ERROR: schema migration failed; Node-RED will be restarted before deploy exits"');
  const rc3Block = deploy.slice(rc3Start, rc3End);
  assert.match(rc3Block, /node_red_restart_needed=0/);
  assert.match(rc3Block, /identityd_deploy_state="fatal_hold"/);
  assert.doesNotMatch(rc3Block, /restart_node_red/);
  assert.doesNotMatch(rc3Block, /restore_identityd_prior_state/);
  assert.doesNotMatch(rc3Block, /identityd_service start/);
});

test('deploy migration wiring probes for a foreign-numbered ledger only after SKIP, before the second checkpoint', () => {
  const skipIdx = indexOf('SKIP: schema_migrations ledger already has rows');
  const beginMarkerIdx = indexOf('# reconcile probe begin');
  const probeIdx = indexOf('recon_ledger_rows="$(sqlite3 "$DB_PATH" "SELECT version, checksum FROM schema_migrations WHERE version > 21 ORDER BY version;")"');
  const decisionIdx = indexOf('recon_probe_version="$(printf \'%s\\n\' "$recon_ledger_rows" | node -e');
  const endMarkerIdx = indexOf('# reconcile probe end');
  const mismatchIdx = indexOf('if [ -n "$recon_probe_version" ]; then');
  const fetchAssetsCallIdx = deploy.indexOf('fetch_reconciliation_assets', mismatchIdx);
  const reconcileCallIdx = indexOf('node "$TMP_DIR/scripts/reconcile-ledger-numbering.js" "$DB_PATH"');
  const reconcileRefuseIdx = indexOf('ERROR: ledger numbering reconciliation refused or failed; aborting schema migration');
  const secondCheckpointIdx = deploy.indexOf('if ! checkpoint_live_db; then', skipIdx);
  const migrateIdx = indexOf('node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --migrations-dir "$migrations_dir"');

  assert.ok(skipIdx < beginMarkerIdx, 'the foreign-ledger probe runs inside the ledger-already-has-rows branch, after the SKIP message');
  assert.ok(beginMarkerIdx < probeIdx && probeIdx < decisionIdx, 'the whole-ledger query must be read before the per-row decision is computed');
  assert.ok(decisionIdx < endMarkerIdx && endMarkerIdx < mismatchIdx, 'the probe markers must bracket exactly the read + decide steps, ending before the reconcile-invocation branch');
  assert.ok(mismatchIdx < fetchAssetsCallIdx, 'reconciliation assets are fetched only inside the mismatch branch (lazy fetch)');
  assert.ok(fetchAssetsCallIdx < reconcileCallIdx, 'assets must be fetched before the reconciliation CLI is invoked');
  assert.ok(reconcileCallIdx < reconcileRefuseIdx, 'a refusing/failing reconcile run must abort the deploy');
  assert.ok(reconcileRefuseIdx < secondCheckpointIdx, 'reconciliation (or its absence) resolves before the pre-migrate-cli checkpoint');
  assert.ok(secondCheckpointIdx < migrateIdx, 'second checkpoint still precedes migrate-cli');
  assert.match(deploy, /--apply\s*$/m, 'the deploy hook must invoke reconciliation in --apply mode, never --report');

  // The probe must compare EVERY applied row above 0021, not just the lowest
  // one: a single-row MIN(version) probe misses a lineage whose early
  // foreign-numbered versions happen to be byte-identical to main's own
  // migrations at those same numbers (osi-os stabilization program PR-L /
  // external consult Q1: Bovey 0022-0024 match, only 0025 differs). Behavior
  // is proven against a real sqlite3 fixture ledger in
  // scripts/test-deploy-reconcile-probe.js; this is only the static shape.
  assert.doesNotMatch(deploy, /SELECT MIN\(version\) FROM schema_migrations/, 'must not regress to a single-row MIN(version) probe');
  assert.match(deploy, /ORDER BY version/, 'the whole-ledger probe query must read rows in ascending version order (first mismatch wins)');
});

test('deploy migration wiring: a main-numbered gateway (checksums already match) takes the untouched fast path', () => {
  // Static proof that nothing beyond one read-only sqlite3 query and one
  // node invocation runs when the ledger is already main-numbered: the ONLY
  // way to reach fetch_reconciliation_assets or the reconcile CLI call is
  // through the recon_probe_version conditional — there is no other call site.
  const fetchAssetsDefIdx = indexOf('fetch_reconciliation_assets() {');
  const fetchAssetsCallSites = [...deploy.matchAll(/\bfetch_reconciliation_assets\b/g)].map((m) => m.index);
  assert.equal(fetchAssetsCallSites.length, 2, 'fetch_reconciliation_assets must have exactly one definition and one call site');
  assert.ok(fetchAssetsDefIdx === fetchAssetsCallSites[0]);
  const callSiteIdx = fetchAssetsCallSites[1];
  const mismatchIdx = indexOf('if [ -n "$recon_probe_version" ]; then');
  const mismatchFiIdx = deploy.indexOf('\n        fi\n', mismatchIdx);
  assert.ok(mismatchFiIdx > mismatchIdx, 'must find the mismatch conditional\'s own closing fi');
  assert.ok(mismatchIdx < callSiteIdx && callSiteIdx < mismatchFiIdx,
    'the only call to fetch_reconciliation_assets must be inside the checksum-mismatch branch');

  const reconcileMentions = [...deploy.matchAll(/scripts\/reconcile-ledger-numbering\.js/g)].map((m) => m.index);
  // Two live OUTSIDE the mismatch branch entirely: fetch_reconciliation_assets's
  // own (source, dest) path literals, defined once, up near fetch_migration_runner
  // — a function DEFINITION is not itself an execution, so those two are exempt.
  // Only the actual `node .../reconcile-ledger-numbering.js` invocation runs at
  // deploy time, and THAT one must be gated.
  const invocationMentions = reconcileMentions.filter((idx) => idx > mismatchIdx && idx < mismatchFiIdx);
  assert.equal(reconcileMentions.length, 3, 'reconcile-ledger-numbering.js must be referenced exactly 3 times: fetch source, fetch dest, invocation');
  assert.equal(invocationMentions.length, 1, 'exactly one (the invocation) must fall inside the checksum-mismatch branch');
});

test('deploy migration wiring flips the payload BEFORE restarting Node-RED on migrate-cli success (issue #222 / F4)', () => {
  // The Uganda 2026-09-12 incident's fleet-wide root cause: run_schema_migration
  // used to call restart_node_red() immediately after a successful migrate-cli,
  // while the deploy's new flows.json payload was still only staged (the flip
  // happens much later, in the "Flip payload + local health self-check" block).
  // That restart started Node-RED on the OLD flows against the NEWLY migrated
  // schema. The fix: flip the staged payload first, so any restart from this
  // point on is always on the migration-target flows.
  const migrateSuccessIdx = indexOf(
    'if node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --migrations-dir "$migrations_dir"; then'
  );
  const migrateFailureIdx = indexOf('migration_rc=$?');
  assert.ok(migrateFailureIdx > migrateSuccessIdx, 'must find the failure branch of the migrate-cli conditional');
  const successBlock = deploy.slice(migrateSuccessIdx, migrateFailureIdx);

  const flipCallIdx = successBlock.indexOf('swap_call flipTo "$DEPLOY_STAMP"');
  const payloadFlippedSetIdx = successBlock.indexOf('PAYLOAD_FLIPPED=1');
  const restartCallIdx = successBlock.indexOf('if ! restart_node_red; then');

  assert.ok(flipCallIdx >= 0, 'migrate-cli success branch must flip the staged payload');
  assert.ok(payloadFlippedSetIdx >= 0, 'migrate-cli success branch must record that the payload was already flipped');
  assert.ok(restartCallIdx >= 0, 'migrate-cli success branch must still restart Node-RED');
  assert.ok(flipCallIdx < restartCallIdx, 'payload must be flipped BEFORE Node-RED is restarted after a schema migration');
  assert.ok(payloadFlippedSetIdx < restartCallIdx, 'PAYLOAD_FLIPPED must be recorded before the restart');

  // The later "Flip payload + local health self-check" block must not
  // unconditionally re-flip (which would be harmless but misleading); it
  // must skip the flip when run_schema_migration already did it, and only
  // flip there for the no-live-DB / no-migration-needed path.
  const healthCheckHeaderIdx = indexOf('--- Flip payload + local health self-check + auto-rollback (5.3 / DD10) ---');
  const nodeRedRestartAfterFlipIdx = deploy.indexOf('/etc/init.d/node-red restart || true', healthCheckHeaderIdx);
  const healthCheckBlock = deploy.slice(healthCheckHeaderIdx, nodeRedRestartAfterFlipIdx);
  assert.match(healthCheckBlock, /PAYLOAD_FLIPPED/, 'the post-migration flip block must consult PAYLOAD_FLIPPED before re-flipping');

  // PAYLOAD_FLIPPED must exist as a top-level default before run_schema_migration
  // is even defined, so a deploy where run_schema_migration is SKIPped (no live
  // DB) or never flips still reaches the health-check block with a defined flag.
  const defaultDeclIdx = deploy.indexOf('PAYLOAD_FLIPPED=0');
  const runSchemaMigrationDefIdx = indexOf('run_schema_migration() {');
  assert.ok(defaultDeclIdx >= 0 && defaultDeclIdx < runSchemaMigrationDefIdx, 'PAYLOAD_FLIPPED must default to 0 before run_schema_migration is defined');
  assert.match(successBlock, /if ! swap_call flipTo "\$DEPLOY_STAMP" "\$GUI_ROOT"/,
    'paired activation must be checked explicitly while errexit is disabled by the migration call site');
  assert.match(successBlock, /if \[ ! -d "\$PAYLOADS_ROOT\/\$DEPLOY_STAMP" \]; then[\s\S]*leaving Node-RED stopped/,
    'a missing staged payload must abort before restarting on an older payload');
});

test('deploy migration wiring verifies the post-migration ledger/fingerprint head before flipping the payload (PR-L / external consult Q1)', () => {
  const migrateSuccessIdx = indexOf(
    'if node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --migrations-dir "$migrations_dir"; then'
  );
  const migrateFailureIdx = indexOf('migration_rc=$?');
  const successBlock = deploy.slice(migrateSuccessIdx, migrateFailureIdx);

  const verifyHeadCallIdx = successBlock.indexOf('node "$TMP_DIR/scripts/verify-head-cli.js" "$DB_PATH" --migrations-dir "$migrations_dir"');
  const verifyHeadAbortIdx = successBlock.indexOf('aborting before the payload flip');
  const flipCallIdx = successBlock.indexOf('swap_call flipTo "$DEPLOY_STAMP"');
  const restartCallIdx = successBlock.indexOf('if ! restart_node_red; then');

  assert.ok(verifyHeadCallIdx >= 0, 'migrate-cli success branch must invoke verify-head-cli.js against the migrated DB');
  assert.ok(verifyHeadAbortIdx > verifyHeadCallIdx, 'a non-ok verify-head-cli result must abort the deploy');
  assert.ok(verifyHeadAbortIdx < flipCallIdx, 'verify-head-cli must be checked BEFORE the payload flip');
  assert.ok(flipCallIdx < restartCallIdx, 'payload flip still precedes the Node-RED restart');
  assert.match(successBlock, /write_payload_compatibility "\$DEPLOY_STAMP"/,
    'new payload records its schema head/ledger before activation');

  // verify-head-cli.js and lib/osi-migrate are already fetched by
  // fetch_migration_runner (osi-os#212) — this must be the only place that
  // invokes the CLI, and it must not re-fetch it.
  const fetchListIdx = indexOf('verify-head-cli.js \\');
  assert.ok(fetchListIdx < migrateSuccessIdx, 'verify-head-cli.js must already be in the Stage 1 fetch list, not fetched again here');
});

test('deploy migration wiring: a boot-node "devices rebuild ABORTED" log line during the post-restart window turns the health self-check red (PR-L / external consult Q1)', () => {
  // A refused devices-CHECK rebuild does not stop Node-RED or its HTTP
  // listener, so /gui reachability alone cannot prove schema init succeeded.
  const healthCheckHeaderIdx = indexOf('--- Flip payload + local health self-check + auto-rollback (5.3 / DD10) ---');
  const restartIdx = deploy.indexOf('/etc/init.d/node-red restart || true', healthCheckHeaderIdx);
  const logMarkIdx = deploy.indexOf('NODE_RED_LOG_MARK="$(logread 2>/dev/null | wc -l)"', healthCheckHeaderIdx);
  const probeCallIdx = indexOf('if wait_for_node_red_health "$NODE_RED_HEALTH_TIMEOUT"; then');
  const grepIdx = indexOf('grep -q "devices rebuild ABORTED"');
  const overrideIdx = deploy.indexOf('PROBE_OK=1', grepIdx);
  const commitDecisionIdx = deploy.indexOf('if [ "$PROBE_OK" = "0" ]; then\n    echo "OK: committing payload $DEPLOY_STAMP"');

  assert.ok(logMarkIdx >= 0 && logMarkIdx < restartIdx, 'the log line count must be captured BEFORE the restart, so only new lines from this restart are considered');
  assert.ok(restartIdx < grepIdx, 'restart still precedes the schema-init log gate');
  assert.ok(grepIdx < probeCallIdx, 'the abort-log check must run before the /gui reachability wait');
  assert.ok(grepIdx < overrideIdx && overrideIdx < commitDecisionIdx, 'a found abort log line must flip PROBE_OK back to failing BEFORE the commit/rollback decision');
  assert.match(deploy, /tail -n "\+\$\(\(NODE_RED_LOG_MARK \+ 1\)\)"/, 'must only scan log lines appended since the mark (busybox tail -n +N), never the whole ring including stale prior aborts');
});

test('deploy.sh has a single migration call site and no inline schema DDL helpers', () => {
  assert.match(deploy, /run_schema_migration\(\)/);
  assert.match(deploy, /run_schema_migration \|\| exit 1/);
  assert.doesNotMatch(deploy, /\bensure_(dendro|zone_irrigation_calibration|analysis_views|chameleon|gateway_health|improvement_requests)_schema\b/);
  assert.doesNotMatch(deploy, /\bCREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(deploy, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(deploy, /\bDROP\s+(TABLE|TRIGGER)\b/i);
});

test('migration failure after commit keeps Node-RED stopped without restarting an unverified pair', () => {
  assert.match(deploy, /DB_MIGRATION_COMMITTED=1/);
  assert.match(deploy, /migrated database has no proven compatible active payload; keeping Node-RED stopped/);
  assert.match(deploy, /hold_node_red_stopped/);
  assert.match(deploy, /hold_identityd_stopped/);
  assert.match(deploy, /DEPLOY_HOLD_SERVICES=1/);
});

test('retry EXIT path proves retained payload compatibility before any fallback restart', () => {
  const fallbackIdx = deploy.indexOf('fallback payload is not proven compatible with the current database');
  const verifyIdx = deploy.lastIndexOf('verify_payload_db_compatibility "$PREV_STAMP"', fallbackIdx);
  const restartIdx = deploy.indexOf('restart_node_red', fallbackIdx);
  assert.ok(fallbackIdx > 0 && verifyIdx < fallbackIdx && fallbackIdx < restartIdx,
    'a retry failure must prove the retained payload before fallback restart');
  assert.match(deploy.slice(fallbackIdx, restartIdx), /hold_node_red_stopped/);
  assert.match(deploy.slice(fallbackIdx, restartIdx), /hold_identityd_stopped/);
});

test('rollback uses retained verification only when the migration runner was unavailable', () => {
  assert.match(deploy, /MIGRATION_RUNNER_AVAILABLE=0/);
  assert.match(deploy, /MIGRATION_RUNNER_AVAILABLE=1/);
  assert.match(deploy, /rollback_verify_mode="full"/);
  assert.match(deploy, /rollback_verify_mode="retained"/);
  assert.match(deploy, /verify_payload_db_compatibility "\$PREV_STAMP" "\$rollback_verify_mode"/);
});
