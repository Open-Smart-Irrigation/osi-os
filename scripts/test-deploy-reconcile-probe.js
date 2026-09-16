'use strict';
// Behavioral proof for deploy.sh's foreign-numbered ledger reconciliation
// probe (osi-os stabilization program PR-L / external consult Q1,
// 2026-09-16, https://github.com/Open-Smart-Irrigation/osi-os deploy.sh
// run_schema_migration()).
//
// The probe used to compare ONLY the ledger's MIN(version) WHERE version > 21
// against main's checksum at that one version. A lineage whose early
// foreign-numbered versions happen to be byte-identical to main's own
// migrations at those same numbers never trips that single-row probe: Bovey's
// 0022-0024 collide with AND byte-match main's 0022-0024; only 0025 differs
// (a header-comment-only checksum difference). deploy.sh never ran
// reconciliation for that ledger, and lib/osi-migrate/runner.js later refused
// applyPending with repair_required at version 25 (the deploy wrapper then
// restores its pre-migration backup - a repeatable deploy refusal, not data
// loss, but the deploy cannot complete).
//
// This test does not reimplement the probe's decision logic in JS. It
// extracts the ACTUAL shell fragment out of deploy.sh (between its own
// "# reconcile probe begin/end" markers) and runs it with a real sqlite3
// fixture ledger and real node, exactly as deploy.sh would on a gateway.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const MAIN_MANIFEST = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'CHECKSUMS.json'), 'utf8'));
const BOVEY_FIXTURE_DIR = path.join(REPO, 'scripts/fixtures/lineages/bovey');
const BOVEY_MANIFEST = JSON.parse(fs.readFileSync(path.join(BOVEY_FIXTURE_DIR, 'CHECKSUMS.json'), 'utf8'));

function extractProbeFragment() {
  const beginMatch = /^[ \t]*# reconcile probe begin[ \t]*$/m.exec(DEPLOY);
  const endMatch = /^[ \t]*# reconcile probe end[ \t]*$/m.exec(DEPLOY);
  assert.ok(beginMatch, 'deploy.sh is missing the "# reconcile probe begin" marker');
  assert.ok(endMatch, 'deploy.sh is missing the "# reconcile probe end" marker');
  assert.ok(endMatch.index > beginMatch.index, 'the reconcile probe begin marker must precede its end marker');
  const fragmentStart = DEPLOY.indexOf('\n', beginMatch.index) + 1;
  return DEPLOY.slice(fragmentStart, endMatch.index);
}

function versionOf(name) {
  return Number(name.slice(0, 4));
}

// Builds a real sqlite3 schema_migrations ledger (version, name, checksum,
// status) from the given rows, in a scratch directory outside the repo.
function buildLedgerDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-recon-probe-'));
  const dbPath = path.join(dir, 'farming.db');
  const statements = [
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, status TEXT);',
    ...rows.map((r) => (
      `INSERT INTO schema_migrations (version, name, checksum, status) VALUES (${r.version}, '${r.name}', '${r.checksum}', 'applied');`
    )),
  ].join('\n');
  execFileSync('sqlite3', [dbPath], { input: statements });
  return dbPath;
}

// Runs the extracted probe fragment against a fixture DB with real sqlite3 +
// node, and returns the decided recon_probe_version ('' when the probe finds
// no mismatch and falls through the fast path untouched).
function runProbe(dbPath) {
  const fragment = extractProbeFragment();
  const script = `${fragment}\nprintf 'RECON_PROBE_VERSION=%s\\n' "$recon_probe_version"\n`;
  const result = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, migrations_dir: MIGRATIONS_DIR },
  });
  assert.equal(result.status, 0, `probe fragment exited nonzero (${result.status}): stderr=${result.stderr}`);
  const match = /RECON_PROBE_VERSION=(.*)/.exec(result.stdout);
  assert.ok(match, `probe fragment did not print RECON_PROBE_VERSION: stdout=${JSON.stringify(result.stdout)}`);
  return match[1].trim();
}

test('reconcile probe: Bovey lineage (0022-0024 byte-match main, only 0025 differs) decides to reconcile at v25', () => {
  const names = ['0022__valve_control.sql', '0023__app_settings.sql', '0024__valve_schedule_sync_triggers.sql', '0025__valve_settings_sync_triggers.sql'];
  const rows = names.map((name) => ({ version: versionOf(name), name, checksum: BOVEY_MANIFEST[name] }));

  // Guard the fixture's own premise before trusting a result built on it:
  // this is exactly the collision the external consult (Q1) measured.
  assert.equal(rows[0].checksum, MAIN_MANIFEST['0022__valve_control.sql'], 'fixture premise: 0022 must byte-match main');
  assert.equal(rows[1].checksum, MAIN_MANIFEST['0023__app_settings.sql'], 'fixture premise: 0023 must byte-match main');
  assert.equal(rows[2].checksum, MAIN_MANIFEST['0024__valve_schedule_sync_triggers.sql'], 'fixture premise: 0024 must byte-match main');
  assert.notEqual(rows[3].checksum, MAIN_MANIFEST['0025__valve_settings_sync_triggers.sql'], 'fixture premise: 0025 must differ from main');

  const dbPath = buildLedgerDb(rows);
  const decided = runProbe(dbPath);
  assert.equal(decided, '25', 'the probe must decide to reconcile at the FIRST mismatching version (25) by checking every applied row, not stop at MIN(version)=22');
});

test('reconcile probe: a main-numbered ledger (every row already matches main) takes the untouched fast path', () => {
  const names = Object.keys(MAIN_MANIFEST).filter((name) => versionOf(name) > 21).sort();
  assert.ok(names.length > 0, 'main manifest must have at least one migration above version 21 for this test to be meaningful');
  const rows = names.map((name) => ({ version: versionOf(name), name, checksum: MAIN_MANIFEST[name] }));

  const dbPath = buildLedgerDb(rows);
  const decided = runProbe(dbPath);
  assert.equal(decided, '', 'a main-numbered ledger (every checksum already matches) must not trigger reconciliation');
});

test('reconcile probe: a mismatch anywhere past the first row is still caught (not just a two-row edge case)', () => {
  // Regression guard against a fix that special-cases "first vs second row"
  // instead of genuinely walking every applied row: take main's own rows
  // above version 21, and corrupt only the LAST one's stored checksum.
  const names = Object.keys(MAIN_MANIFEST).filter((name) => versionOf(name) > 21).sort();
  assert.ok(names.length >= 3, 'need at least 3 post-21 migrations on main for this regression guard to be meaningful');
  const rows = names.map((name) => ({ version: versionOf(name), name, checksum: MAIN_MANIFEST[name] }));
  const lastIdx = rows.length - 1;
  rows[lastIdx] = { ...rows[lastIdx], checksum: 'deadbeef'.repeat(8) };

  const dbPath = buildLedgerDb(rows);
  const decided = runProbe(dbPath);
  assert.equal(decided, String(rows[lastIdx].version), 'a mismatch on the LAST applied row must still be found and decided upon');
});
