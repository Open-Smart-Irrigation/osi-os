#!/usr/bin/env node
'use strict';
// Behavioral proof for deploy.sh's FRESH-INSTALL path: seeding a brand-new
// gateway must land it at the migration head, fast, with no Stage 0 baseline
// rebuild.
//
// The defect this pins (2026-09-17, main 94659f9ed): the bundled
// farming.db shipped with the full head schema but NO schema_migrations and
// NO schema_object_fingerprints. On a fresh Pi, seed_db_if_missing() copied
// that image in and run_schema_migration() then found an empty ledger, so it
// took the Stage 0 pre-ledger branch - repair-sync-outbox-v2 followed by
// baseline-existing-db, which rebuilds the entire 1..head reference chain on
// the gateway to discover which version the live schema matches. That is a
// >10 minute job on a 16-core workstation; a Pi 5 is not going to do it
// inside a deploy. The fix ships the seed already stamped by bootstrapFresh
// (scripts/build-seed-db.js), so the ledger branch is taken instead and
// applyPending has nothing to do.
//
// This test does not re-implement deploy.sh's decision logic in JS. It
// extracts the ACTUAL shell text - seed_db_if_missing(), checkpoint_live_db(),
// fetch_migration_runner(), and the schema-decision fragment between
// deploy.sh's own "# schema decision begin/end" markers - and runs it with
// real sqlite3 and real node against a temp DB_DIR, the same technique
// scripts/test-deploy-reconcile-probe.js uses for the nested reconcile probe.
//
// Stubs are limited to what is genuinely not schema: fetch() copies from the
// working tree instead of curling a tunnel, and restart_node_red()/swap_call()
// stand in for the Node-RED service and the payload symlink flip. Everything
// that touches the database is the shipped code.
//
// baseline-existing-db.js is replaced by a TRIPWIRE that refuses and records
// it was called, so a regression back to the Stage 0 branch fails this test
// in milliseconds instead of hanging a CI job for ten minutes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const { CANONICAL_SEED_DB_RELATIVE_PATH } = require('./seed-db-paths');

const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}__[a-z0-9_]+\.sql$/.test(f))
  .sort();
const EXPECTED_LEDGER_ROWS = MIGRATION_FILES.length;
const EXPECTED_HEAD = Number(MIGRATION_FILES[MIGRATION_FILES.length - 1].slice(0, 4));

// --- deploy.sh text extraction ---------------------------------------------

// Pulls one shell function's full source out of deploy.sh. deploy.sh indents
// function bodies and closes every function with a `}` in column 0, so that
// is the terminator.
function extractFunction(name) {
  const open = new RegExp(String.raw`^${name}\(\) \{$`, 'm').exec(DEPLOY);
  assert.ok(open, `deploy.sh is missing the ${name}() function`);
  const close = DEPLOY.indexOf('\n}\n', open.index);
  assert.notEqual(close, -1, `deploy.sh's ${name}() has no column-0 closing brace`);
  return DEPLOY.slice(open.index, close + 3);
}

function extractSchemaDecisionFragment() {
  const begin = /^[ \t]*# schema decision begin[ \t]*$/m.exec(DEPLOY);
  const end = /^[ \t]*# schema decision end[ \t]*$/m.exec(DEPLOY);
  assert.ok(begin, 'deploy.sh is missing the "# schema decision begin" marker');
  assert.ok(end, 'deploy.sh is missing the "# schema decision end" marker');
  assert.ok(end.index > begin.index, 'the schema decision begin marker must precede its end marker');
  const fragment = DEPLOY.slice(DEPLOY.indexOf('\n', begin.index) + 1, end.index);
  // Guard the fragment is the block we think it is, so a future refactor that
  // moves the markers somewhere harmless does not quietly empty this test.
  assert.match(fragment, /schema_migrations ledger already has rows/);
  assert.match(fragment, /baseline-existing-db\.js/);
  assert.match(fragment, /migrate-cli\.js/);
  assert.match(fragment, /verify-head-cli\.js/);
  return fragment;
}

// The four COMMAND_LEDGER_*_SHA256 pins exactly as deploy.sh declares them, so
// the harness stages against the shipped digests rather than recomputed ones.
function extractCommandLedgerPins() {
  const pins = DEPLOY.match(/^COMMAND_LEDGER_(?:HELPER|PACKAGE|INDEX|BINDING)_SHA256="[0-9a-f]{64}"$/gm) || [];
  assert.equal(pins.length, 4, 'deploy.sh must pin the installer, ledger package, ledger index and binding');
  return pins.join('\n');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const NODE_RED_SOURCE = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const LEDGER_FILES = [
  'osi-command-ledger/package.json',
  'osi-command-ledger/index.js',
  'osi-watermark-binding/canonicalization.js',
];
const ACTIVATED_TEXT = 'OK: command-ledger dependency pair activated after schema migration';
const activationCount = (stdout) => stdout.split(ACTIVATED_TEXT).length - 1;

// --- harness ---------------------------------------------------------------

const TRIPWIRE_MARKER = 'baseline-existing-db-was-called';

function buildHarness(root) {
  const dbDir = path.join(root, 'data', 'db');
  const tmpDir = path.join(root, 'tmp');
  const nodeRedRoot = path.join(root, 'node-red');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(nodeRedRoot, { recursive: true });

  const script = `set -eu
REPO_ROOT=${JSON.stringify(REPO)}
DB_DIR=${JSON.stringify(dbDir)}
DB_PATH="$DB_DIR/farming.db"
TMP_DIR=${JSON.stringify(tmpDir)}
SEED_DB_REL=${JSON.stringify(CANONICAL_SEED_DB_RELATIVE_PATH)}
GUI_ROOT="$TMP_DIR/gui"
backup_dir="$TMP_DIR/backups"
PAYLOADS_ROOT="$TMP_DIR/payloads"
DEPLOY_STAMP="test-stamp"
PAYLOAD_FLIPPED=0
mkdir -p "$backup_dir" "$PAYLOADS_ROOT"
# The real command-ledger staging and activation below run against a live
# root inside the temporary directory. Phases are separate processes, so the
# stage directory has a fixed name instead of deploy.sh's PID suffix.
NODE_RED_ROOT=${JSON.stringify(nodeRedRoot)}
COMMAND_LEDGER_STAGE_ROOT="$NODE_RED_ROOT"
COMMAND_LEDGER_STAGE="$COMMAND_LEDGER_STAGE_ROOT/.osi-command-ledger-stage.harness"
COMMAND_LEDGER_INSTALLER="$TMP_DIR/deploy-command-ledger-dependency.js"
COMMAND_LEDGER_ACTIVATED=0
${extractCommandLedgerPins()}

# Not schema: deploy.sh curls these through the SSH reverse tunnel; here they
# come straight off the working tree.
fetch() {
    mkdir -p "$(dirname "$2")"
    cp "$REPO_ROOT/$1" "$2"
}
fetch_required() {
    echo "--- $1 ---"
    fetch "$2" "$3"
    echo "OK"
}
# Not schema: the Node-RED service and the payload symlink flip.
restart_node_red() { echo "STUB restart_node_red"; return 0; }
swap_call() { echo "STUB swap_call $*"; return 0; }
write_payload_compatibility() { echo "STUB write_payload_compatibility $*"; return 0; }
fetch_reconciliation_assets() { echo "STUB fetch_reconciliation_assets"; return 0; }

${extractFunction('checkpoint_live_db')}
${extractFunction('seed_db_if_missing')}
${extractFunction('fetch_migration_runner')}
${extractFunction('stage_command_ledger_dependency')}
${extractFunction('activate_command_ledger_dependency')}
${extractFunction('command_ledger_live_hashes')}
${extractFunction('report_command_ledger_activation_failure')}
${extractFunction('keep_command_ledger_copy')}
${extractFunction('restore_command_ledger_copy')}
${extractFunction('command_ledger_live_pair_loads')}
${extractFunction('clear_command_ledger_hold')}
${extractFunction('check_command_ledger_hold')}
${extractFunction('command_ledger_none_live')}
${extractFunction('hold_for_unloadable_command_ledger')}
${extractFunction('check_fetched_manifest')}
${extractFunction('check_fetched_js_files')}

osi_schema_decision() {
${extractSchemaDecisionFragment()}
}

install_tripwire() {
    cat > "$TMP_DIR/scripts/baseline-existing-db.js" <<'TRIPWIRE'
// Test tripwire: the fresh-install path must never reach the Stage 0
// pre-ledger baseline. Fail loudly and instantly instead of rebuilding the
// whole reference chain.
require('node:fs').writeFileSync(process.env.OSI_TRIPWIRE_FILE, '${TRIPWIRE_MARKER}');
console.error('TRIPWIRE: baseline-existing-db.js was invoked by the fresh-install path');
process.exit(1);
TRIPWIRE
}

case "$1" in
    seed) seed_db_if_missing ;;
    prepare) fetch_migration_runner >/dev/null; install_tripwire ;;
    stage) stage_command_ledger_dependency ;;
    migrate) mkdir -p "$PAYLOADS_ROOT/$DEPLOY_STAMP"; migrations_dir="$TMP_DIR/database/migrations/ordered"; osi_schema_decision ;;
    *) echo "unknown phase: $1" >&2; exit 64 ;;
esac
`;
  return { script, dbDir, tmpDir, nodeRedRoot, dbPath: path.join(dbDir, 'farming.db') };
}

function assertLedgerPairLive(harness) {
  for (const file of LEDGER_FILES) {
    const live = path.join(harness.nodeRedRoot, file);
    assert.ok(fs.existsSync(live), `activation did not install ${file}`);
    assert.equal(sha256(live), sha256(path.join(NODE_RED_SOURCE, file)), `the activated ${file} is not the shipped file`);
  }
}

function assertLedgerPairStagedOnly(harness, staged) {
  assertPhaseOk(staged, 'stage_command_ledger_dependency', null);
  assert.match(staged.stdout, /OK: command-ledger dependency pair staged; activation deferred until schema migration/);
  for (const file of LEDGER_FILES) {
    assert.ok(fs.existsSync(path.join(harness.nodeRedRoot, '.osi-command-ledger-stage.harness', file)),
      `staging did not leave ${file} in the stage directory`);
  }
}

function runPhase(harness, phase, tripwireFile) {
  return spawnSync('sh', ['-c', harness.script, 'harness', phase], {
    encoding: 'utf8',
    env: { ...process.env, OSI_TRIPWIRE_FILE: tripwireFile },
  });
}

function sqlite(dbPath, sql) {
  return execFileSync('sqlite3', ['-noheader', dbPath, sql], { encoding: 'utf8' }).trim();
}

function withHarness(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-fresh-install-'));
  const tripwireFile = path.join(root, 'tripwire');
  try {
    return fn(buildHarness(root), tripwireFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPhaseOk(result, phase, tripwireFile) {
  if (tripwireFile && fs.existsSync(tripwireFile)) {
    assert.fail(`deploy.sh's ${phase} phase invoked baseline-existing-db.js - the fresh-install path fell back to the Stage 0 pre-ledger branch (>10 minutes on-device). Rebuild the bundled seed with 'node scripts/build-seed-db.js'.`);
  }
  assert.equal(result.status, 0,
    `deploy.sh's ${phase} phase exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

// --- tests -----------------------------------------------------------------

test('a fresh install seeds a database that is already stamped at the migration head', () => {
  withHarness((harness, tripwireFile) => {
    assert.equal(fs.existsSync(harness.dbPath), false, 'the temp DB_DIR must start with no database');

    const seeded = runPhase(harness, 'seed', tripwireFile);
    assertPhaseOk(seeded, 'seed_db_if_missing', tripwireFile);
    assert.match(seeded.stdout, /OK: seeded new database at/);
    assert.ok(fs.existsSync(harness.dbPath), 'seed_db_if_missing did not create the database');

    // The whole point of the fix: the ledger is present in the SEED, before
    // any migration has run on-device.
    assert.equal(
      sqlite(harness.dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'"),
      '1',
      'the bundled seed has no schema_migrations ledger, so a fresh gateway would fall into the Stage 0 baseline rebuild');
    assert.equal(
      sqlite(harness.dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_object_fingerprints'"),
      '1',
      'the bundled seed has no schema_object_fingerprints table');
    assert.equal(
      sqlite(harness.dbPath, "SELECT COUNT(*) FROM schema_migrations WHERE status='applied'"),
      String(EXPECTED_LEDGER_ROWS));
    assert.equal(
      sqlite(harness.dbPath, "SELECT MAX(version) FROM schema_migrations WHERE status='applied'"),
      String(EXPECTED_HEAD));
    assert.notEqual(
      sqlite(harness.dbPath, 'SELECT COUNT(*) FROM schema_object_fingerprints'),
      '0',
      'the bundled seed ships an empty fingerprint baseline');
  });
});

test('the fresh-install deploy path reaches head without the Stage 0 baseline, and is idempotent', () => {
  withHarness((harness, tripwireFile) => {
    assertPhaseOk(runPhase(harness, 'seed', tripwireFile), 'seed_db_if_missing', tripwireFile);
    assertPhaseOk(runPhase(harness, 'prepare', tripwireFile), 'fetch_migration_runner', tripwireFile);

    // deploy.sh stages the command-ledger pair with the other fetches and
    // activates it inside the schema phase, after the migration.
    assertLedgerPairStagedOnly(harness, runPhase(harness, 'stage', tripwireFile));
    for (const file of LEDGER_FILES) {
      assert.equal(fs.existsSync(path.join(harness.nodeRedRoot, file)), false,
        `staging must not install ${file} before the migration`);
    }

    const first = runPhase(harness, 'migrate', tripwireFile);
    assertPhaseOk(first, 'run_schema_migration', tripwireFile);
    assert.equal(activationCount(first.stdout), 1,
      'the schema phase must activate the staged command ledger exactly once');
    assert.ok(first.stdout.indexOf('OK: verify-head-cli confirmed') < first.stdout.indexOf(ACTIVATED_TEXT),
      'the command ledger must be activated after the migration is verified');
    assertLedgerPairLive(harness);
    assert.match(first.stdout, /SKIP: schema_migrations ledger already has rows/,
      'the fresh-install path did not take the ledger branch');
    // A seed stamped from main's own CHECKSUMS.json cannot look foreign-numbered,
    // so the reconcile probe must fall straight through.
    assert.doesNotMatch(first.stdout, /STUB fetch_reconciliation_assets/,
      'the fresh-install path triggered ledger numbering reconciliation');
    assert.doesNotMatch(first.stdout, /Foreign-numbered schema_migrations ledger detected/);
    assert.match(first.stdout, /OK: verify-head-cli confirmed the post-migration ledger and schema fingerprints/);
    assert.equal(
      sqlite(harness.dbPath, "SELECT MAX(version) || '/' || COUNT(*) FROM schema_migrations WHERE status='applied'"),
      `${EXPECTED_HEAD}/${EXPECTED_LEDGER_ROWS}`);

    const headCheck = spawnSync('node', [
      path.join(REPO, 'scripts/verify-head-cli.js'), harness.dbPath, '--migrations-dir', MIGRATIONS_DIR,
    ], { encoding: 'utf8' });
    assert.equal(headCheck.status, 0,
      `verify-head-cli rejected the freshly installed database:\n${headCheck.stdout}\n${headCheck.stderr}`);

    // Second run: re-seeding must preserve the database, and the schema
    // decision must be another no-op at head.
    const reseed = runPhase(harness, 'seed', tripwireFile);
    assertPhaseOk(reseed, 'seed_db_if_missing (second run)', tripwireFile);
    assert.match(reseed.stdout, /SKIP: existing live database preserved/);

    assertLedgerPairStagedOnly(harness, runPhase(harness, 'stage', tripwireFile));
    const second = runPhase(harness, 'migrate', tripwireFile);
    assertPhaseOk(second, 'run_schema_migration (second run)', tripwireFile);
    assert.equal(activationCount(second.stdout), 1,
      'the second schema phase must activate the restaged command ledger exactly once');
    assertLedgerPairLive(harness);
    assert.match(second.stdout, /SKIP: schema_migrations ledger already has rows/);
    assert.match(second.stdout, /OK: verify-head-cli confirmed the post-migration ledger and schema fingerprints/);
    assert.equal(
      sqlite(harness.dbPath, "SELECT MAX(version) || '/' || COUNT(*) FROM schema_migrations WHERE status='applied'"),
      `${EXPECTED_HEAD}/${EXPECTED_LEDGER_ROWS}`);
  });
});

test('the tripwire itself fires when the Stage 0 branch is taken', () => {
  // Negative self-test: strip the seed's ledger so the shipped fragment takes
  // the pre-ledger branch, and prove this harness reports that as a failure
  // rather than passing quietly (or spending ten minutes proving it).
  withHarness((harness, tripwireFile) => {
    assertPhaseOk(runPhase(harness, 'seed', tripwireFile), 'seed_db_if_missing', tripwireFile);
    assertPhaseOk(runPhase(harness, 'prepare', tripwireFile), 'fetch_migration_runner', tripwireFile);
    execFileSync('sqlite3', [harness.dbPath, 'DROP TABLE schema_migrations;']);
    assertLedgerPairStagedOnly(harness, runPhase(harness, 'stage', tripwireFile));

    const result = runPhase(harness, 'migrate', tripwireFile);
    assert.notEqual(result.status, 0, 'a ledger-less database must not sail through the schema decision');
    assert.equal(activationCount(result.stdout), 0, 'a failed schema phase must not activate the command ledger');
    for (const file of LEDGER_FILES) {
      assert.equal(fs.existsSync(path.join(harness.nodeRedRoot, file)), false,
        `a failed schema phase installed ${file}`);
    }
    assert.equal(fs.readFileSync(tripwireFile, 'utf8'), TRIPWIRE_MARKER,
      'the ledger-less database did not reach baseline-existing-db.js, so the tripwire proves nothing');
  });
});
