'use strict';
// Gate-pass, gate-fail-stamps-nothing, checksum-source, idempotency, and the
// end-to-end kaba100-shaped scenario. Uses the real repo migrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('../lib/osi-migrate');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { runBaseline, buildReference, referenceSnapshot } = require('./baseline-existing-db');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-')); }

function migrationVersionsAfter(version) {
  return loadMigrations(MIGRATIONS_DIR)
    .map((m) => m.version)
    .filter((v) => v > version);
}

// deploy.sh ensure_analysis_views_schema shape - live early-arrived content
// deliberately indented differently from migration 0007 to prove semantic,
// not textual, matching.
const LIVE_ANALYSIS_VIEWS = `CREATE TABLE IF NOT EXISTS analysis_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    owner_user_uuid TEXT,
    name TEXT NOT NULL,
    view_json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`;

// Several test cases below need a pre-ledger device "at N" for the SAME N
// (most need N=3; one needs N=head). buildReference() bootstraps a fresh DB
// by replaying migrations 1..N through the real runner (same fingerprint
// stamping a live bootstrap would do), which is the expensive part at N=head
// - so build each distinct N once per test-process run and snapshot-copy the
// resulting file per test case, rather than re-bootstrapping from scratch
// for every test that happens to want the same N. (baseline-existing-db.js
// also memoizes buildReference() internally, so this is defense-in-depth,
// not the only thing making this fast - but it keeps the test's own
// performance legible without depending on that internal detail.)
const referenceDbCache = new Map(); // n -> Promise<string dbPath>
function referenceDbAt(n) {
  if (!referenceDbCache.has(n)) referenceDbCache.set(n, buildReference(MIGRATIONS_DIR, n, scratch()));
  return referenceDbCache.get(n);
}

async function makePreLedgerDeviceAt(n, extraSql = '') {
  const refDb = await referenceDbAt(n);
  const db = path.join(scratch(), 'device.db');
  fs.copyFileSync(refDb, db);
  const r = cliRunner(db);
  await r.exec('DROP TABLE IF EXISTS schema_migrations;\nDROP TABLE IF EXISTS schema_object_fingerprints;');
  if (extraSql) await r.exec(extraSql);
  return db;
}

test('kaba100-shaped device (reference(3) + early analysis_views) baselines at N=3; applyPending then carries it to head', async () => {
  const db = await makePreLedgerDeviceAt(3, LIVE_ANALYSIS_VIEWS);
  const logs = [];
  const { matched } = await runBaseline({ dbPath: db, log: (l) => logs.push(l) });
  assert.equal(matched, 3, logs.join('\n'));
  assert.match(logs.join('\n'), /extra_forward:table:analysis_views/);
  const res = await applyPending(cliRunner(db), {
    migrationsDir: MIGRATIONS_DIR, appVersion: 'test', writersStopped: true,
  });
  assert.deepEqual(res.applied, migrationVersionsAfter(3));
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

test('gate failure stamps NOTHING (no ledger tables created)', async () => {
  const db = await makePreLedgerDeviceAt(3, 'CREATE TABLE rogue (x TEXT);');
  const { matched } = await runBaseline({ dbPath: db, log: () => {} });
  assert.equal(matched, null);
  const tables = await cliRunner(db).all(
    "SELECT name FROM sqlite_master WHERE name IN ('schema_migrations','schema_object_fingerprints')");
  assert.deepEqual(tables, []);
});

test('clean head-shaped device baselines at head, idempotently, distinguishably tagged', async () => {
  const allMigrations = loadMigrations(MIGRATIONS_DIR);
  const head = allMigrations.at(-1).version;
  const db = await makePreLedgerDeviceAt(head);
  assert.equal((await runBaseline({ dbPath: db, log: () => {} })).matched, head);
  assert.equal((await runBaseline({ dbPath: db, log: () => {} })).matched, head);
  const rows = await cliRunner(db).all('SELECT version, status, app_version FROM schema_migrations ORDER BY version');
  // One ledger row per migration FILE, not per version number up to head -
  // on a tree with a version gap (this branch's own missing 0059,
  // renumbered to 0060 because main owns 0059, #351) those differ: head=60
  // but only 59 migration files exist. On a contiguous tree this is the
  // same value as `head`.
  assert.equal(rows.length, allMigrations.length);
  assert.ok(rows.every((r) => r.status === 'applied' && r.app_version === 'baseline-existing-db'));
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

test('report mode walks all N and stamps nothing', async () => {
  const db = await makePreLedgerDeviceAt(3, LIVE_ANALYSIS_VIEWS);
  const logs = [];
  const { matched } = await runBaseline({ dbPath: db, report: true, log: (l) => logs.push(l) });
  assert.equal(matched, 3);
  assert.match(logs.join('\n'), /report mode: best match N=3; nothing stamped/);
  const tables = await cliRunner(db).all("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'");
  assert.deepEqual(tables, []);
});

test('checksum manifest divergence from disk refuses before comparing', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, '0001__x.sql'), '-- risk: additive\nCREATE TABLE a (x TEXT);\n');
  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), JSON.stringify({ '0001__x.sql': 'f'.repeat(64) }, null, 2));
  const db = path.join(scratch(), 'd.db');
  await cliRunner(db).exec('CREATE TABLE a (x TEXT);');
  await assert.rejects(
    () => runBaseline({ dbPath: db, migrationsDir: dir, log: () => {} }),
    /manifest mismatch/
  );
});

test('refuses a missing db path (anti-typo)', async () => {
  await assert.rejects(() => runBaseline({ dbPath: '/nonexistent/nope.db', log: () => {} }), /does not exist/);
});

test('reference chain retry rebuilds from the last published snapshot after a migration failure', async () => {
  const dir = path.join(scratch(), 'migrations');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, '0002__bad.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\nNOT VALID SQL;\n');
  await assert.rejects(() => buildReference(dir, 2, scratch()), /syntax error|SQLITE_ERROR/);
  fs.writeFileSync(path.join(dir, '0002__bad.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\n');
  const db = await buildReference(dir, 2, scratch());
  assert.deepEqual(await cliRunner(db).all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"), [
    { name: 'a' }, { name: 'b' }, { name: 'schema_migrations' },
    { name: 'schema_object_fingerprints' },
  ]);
});

test('reference chain uses the persistent adapter without spawning sqlite3', () => {
  const dir = path.join(scratch(), 'migrations');
  fs.mkdirSync(dir);
  for (const version of [1, 2, 3]) {
    fs.writeFileSync(path.join(dir, `000${version}__a${version}.sql`),
      `-- risk: additive\nCREATE TABLE a${version} (id INTEGER PRIMARY KEY);\n`);
  }
  const script = `
    const cp = require('node:child_process');
    let sqlite3Calls = 0;
    const execFileSync = cp.execFileSync;
    cp.execFileSync = (...args) => { if (args[0] === 'sqlite3') sqlite3Calls++; return execFileSync(...args); };
    const { buildReference } = require(${JSON.stringify(path.join(REPO, 'scripts/baseline-existing-db.js'))});
    buildReference(process.env.MIGRATIONS_DIR, 3, process.env.SCRATCH_ROOT)
      .then(() => process.stdout.write(String(sqlite3Calls)))
      .catch((err) => { console.error(err); process.exitCode = 1; });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, OSI_BASELINE_RUNNER: 'node-sqlite', MIGRATIONS_DIR: dir, SCRATCH_ROOT: scratch() },
  });
  assert.equal(out, '0');
});

test('reference chain defaults to cliRunner when no persistent runner opt-in is set', () => {
  const dir = path.join(scratch(), 'migrations');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
  const script = `
    const cp = require('node:child_process');
    let sqlite3Calls = 0;
    const execFileSync = cp.execFileSync;
    cp.execFileSync = (...args) => { if (args[0] === 'sqlite3') sqlite3Calls++; return execFileSync(...args); };
    const { buildReference } = require(${JSON.stringify(path.join(REPO, 'scripts/baseline-existing-db.js'))});
    buildReference(process.env.MIGRATIONS_DIR, 1, process.env.SCRATCH_ROOT)
      .then(() => process.stdout.write(String(sqlite3Calls)))
      .catch((err) => { console.error(err); process.exitCode = 1; });
  `;
  const env = { ...process.env, MIGRATIONS_DIR: dir, SCRATCH_ROOT: scratch() };
  delete env.OSI_BASELINE_RUNNER;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
  assert.notEqual(out, '0');
});

// --- regression: candidate scan across a migrations-dir version gap, and --
// --- strict reference resolution -------------------------------------------
// Mirrors this branch's own real gap (renumbered field-tester migration
// 0059 -> 0060 because main owns 0059, #351): database/migrations/ordered/
// goes ...0057, 0058, 0060 with no 0059 file. Before the fix, runBaseline's
// default candidate scan walked every bare integer down from head
// (Array.from({length: head}, ...)), so it called referenceSnapshot(dir, 59,
// ...) directly - and byVersion, keyed only by versions that exist as
// files, had no entry for 59, so `.snap` on undefined threw a TypeError and
// the whole scan crashed before ever reaching a real, lower matching
// version. A synthetic tiny gap (no 0003, only 0001/0002/0004) reproduces
// the same crash cheaply without needing this repo's real ~60-migration
// chain.
//
// The fix keeps the candidate SCAN safe by only ever walking versions that
// exist as migration files (runBaseline never asks referenceSnapshot/
// buildReference for a gap version, including for an explicit --version -
// see the "--version has no migration file" checks in runBaseline).
// referenceSnapshot()/buildReference() themselves stay STRICT and throw for
// any n with no migration file, whether an interior gap or n > the last
// present version: the third caller of buildReference,
// lib/osi-migrate/runner.js's isBootOwnedTriggerBodyDrift (the live
// runner's drift-grace path, reached from applyPending/verifyHead), calls
// it with the DEVICE's highest *applied* version - which this tree's files
// may not cover at all - and relies on that throw to fail closed instead of
// silently comparing against a reference missing a migration the device
// actually ran.
test('candidate scan across a migrations-dir version gap matches at the highest present version below the gap, without crashing; buildReference/referenceSnapshot stay strict for a gap version and for n > head', async () => {
  const dir = path.join(scratch(), 'gapped-migrations');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, '0002__widget.sql'), '-- risk: additive\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);\n');
  // Deliberate gap: no 0003 file on disk. Head is 0004.
  fs.writeFileSync(path.join(dir, '0004__gadget.sql'), '-- risk: additive\nCREATE TABLE gadget (id INTEGER PRIMARY KEY, kind TEXT);\n');
  const manifest = {};
  for (const m of loadMigrations(dir)) manifest[m.name] = m.checksum;
  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), JSON.stringify(manifest));

  // Pre-ledger device DB shaped exactly like reference(2): only migrations
  // 1-2 applied, nothing at or past the gap.
  const refDb2 = await buildReference(dir, 2, scratch());
  const db = path.join(scratch(), 'device.db');
  fs.copyFileSync(refDb2, db);
  await cliRunner(db).exec('DROP TABLE IF EXISTS schema_migrations;\nDROP TABLE IF EXISTS schema_object_fingerprints;');

  const logs = [];
  const { matched } = await runBaseline({ dbPath: db, migrationsDir: dir, log: (l) => logs.push(l) });
  assert.equal(matched, 2, logs.join('\n'));
  // The reported match is a real migration version - not a phantom "3".
  assert.ok(loadMigrations(dir).some((m) => m.version === matched));

  // buildReference/referenceSnapshot must THROW for a version with no
  // migration file - both the interior gap (3) and past head (5, head=4) -
  // not silently resolve down to reference(2)/reference(4). This is the
  // exact behaviour lib/osi-migrate/runner.js's isBootOwnedTriggerBodyDrift
  // depends on to fail closed on a device-applied version this tree cannot
  // account for.
  await assert.rejects(() => buildReference(dir, 3, scratch()));
  await assert.rejects(() => buildReference(dir, 5, scratch()));
  await assert.rejects(() => referenceSnapshot(dir, 3, scratch()));
  await assert.rejects(() => referenceSnapshot(dir, 5, scratch()));

  // An explicit --version request for a gap version must also refuse, up
  // front, rather than reaching referenceSnapshot at all.
  await assert.rejects(
    () => runBaseline({ dbPath: db, migrationsDir: dir, version: 3, log: () => {} }),
    /--version 3 has no migration file/,
  );
});
