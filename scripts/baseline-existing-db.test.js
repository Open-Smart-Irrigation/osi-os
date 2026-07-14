'use strict';
// Gate-pass, gate-fail-stamps-nothing, checksum-source, idempotency, and the
// end-to-end kaba100-shaped scenario. Uses the real repo migrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('../lib/osi-migrate');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { runBaseline, buildReference } = require('./baseline-existing-db');

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

async function makePreLedgerDeviceAt(n, extraSql = '') {
  const refDb = await buildReference(MIGRATIONS_DIR, n, scratch());
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
  const head = loadMigrations(MIGRATIONS_DIR).at(-1).version;
  const db = await makePreLedgerDeviceAt(head);
  assert.equal((await runBaseline({ dbPath: db, log: () => {} })).matched, head);
  assert.equal((await runBaseline({ dbPath: db, log: () => {} })).matched, head);
  const rows = await cliRunner(db).all('SELECT version, status, app_version FROM schema_migrations ORDER BY version');
  assert.equal(rows.length, head);
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
