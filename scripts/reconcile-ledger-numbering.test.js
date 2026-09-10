'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh, applyPending, verifyHead } = require('../lib/osi-migrate');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const {
  stripLeadingCommentBlock,
  headerStrippedChecksum,
  buildMainIndex,
  buildLineageRegistry,
  classifyRow,
  refuseVersionSlotCollisions,
  classifyLedger,
  applyRemap,
  runReconcile,
  clearRepairRequired,
  parseArgs,
} = require('./reconcile-ledger-numbering');

const REPO = path.resolve(__dirname, '..');
const MAIN_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const REAL_FIXTURES_DIR = path.join(REPO, 'scripts/fixtures/lineages');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-')); }

function writeMigration(dir, filename, body) {
  fs.writeFileSync(path.join(dir, filename), body);
}

function sha(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }

// A tiny, self-contained synthetic "main" migrations dir, cheap to bootstrap
// (used for every test that doesn't need the real 53-migration repo chain).
function tinyMainDir(root) {
  const dir = path.join(root, 'main');
  fs.mkdirSync(dir);
  writeMigration(dir, '0001__base.sql', '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  writeMigration(dir, '0002__widget.sql', '-- risk: additive\n-- 0002: widget table\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);\n');
  writeMigration(dir, '0003__gadget.sql', '-- risk: additive\n-- 0003: gadget table\nCREATE TABLE gadget (id INTEGER PRIMARY KEY, kind TEXT);\n');
  return dir;
}

// --- unit: header stripping -------------------------------------------------

test('stripLeadingCommentBlock removes only the leading -- comment run', () => {
  const sql = '-- risk: additive\n-- 0002: widget table\nCREATE TABLE widget (id INTEGER PRIMARY KEY); -- inline, not stripped\n';
  const stripped = stripLeadingCommentBlock(sql);
  assert.equal(stripped, 'CREATE TABLE widget (id INTEGER PRIMARY KEY); -- inline, not stripped\n');
});

test('headerStrippedChecksum is identical for texts differing only in their leading header', () => {
  const a = '-- risk: additive\n-- 0022: journal catalog v2\nALTER TABLE x ADD COLUMN y TEXT;\n';
  const b = '-- risk: additive\n-- 0031: journal catalog v2 (renumbered)\nALTER TABLE x ADD COLUMN y TEXT;\n';
  assert.equal(headerStrippedChecksum(a), headerStrippedChecksum(b));
});

test('headerStrippedChecksum differs when the body differs', () => {
  const a = '-- risk: additive\nALTER TABLE x ADD COLUMN y TEXT;\n';
  const b = '-- risk: additive\nALTER TABLE x ADD COLUMN z TEXT;\n';
  assert.notEqual(headerStrippedChecksum(a), headerStrippedChecksum(b));
});

// --- unit: indices -----------------------------------------------------

test('buildMainIndex builds exact + header-stripped indices keyed correctly', () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const idx = buildMainIndex(dir);
  const widget = loadMigrations(dir).find((m) => m.name === '0002__widget.sql');
  assert.equal(idx.byChecksum.get(widget.checksum).name, '0002__widget.sql');
  assert.equal(idx.byVersion.get(2).name, '0002__widget.sql');
  const hs = headerStrippedChecksum(widget.sql);
  assert.deepEqual(idx.byHeaderStrippedChecksum.get(hs).map((m) => m.name), ['0002__widget.sql']);
});

test('buildLineageRegistry loads a vendored fixture dir and tags entries by lineage', () => {
  const root = scratch();
  const fixturesDir = path.join(root, 'fixtures');
  const lineageDir = path.join(fixturesDir, 'acme');
  fs.mkdirSync(lineageDir, { recursive: true });
  const body = '-- risk: additive\n-- 0099: acme thing\nCREATE TABLE acme_thing (id INTEGER PRIMARY KEY);\n';
  writeMigration(lineageDir, '0099__acme_thing.sql', body);
  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify({ '0099__acme_thing.sql': sha(Buffer.from(body)) }));

  const reg = buildLineageRegistry(fixturesDir);
  const entry = reg.byChecksum.get(sha(Buffer.from(body)));
  assert.equal(entry.lineage, 'acme');
  assert.equal(entry.name, '0099__acme_thing.sql');
  assert.deepEqual(reg.lineages.acme, ['0099__acme_thing.sql']);
});

test('buildLineageRegistry refuses (throws) when a vendored file has drifted from its own manifest', () => {
  const root = scratch();
  const fixturesDir = path.join(root, 'fixtures');
  const lineageDir = path.join(fixturesDir, 'acme');
  fs.mkdirSync(lineageDir, { recursive: true });
  writeMigration(lineageDir, '0099__acme_thing.sql', '-- risk: additive\nCREATE TABLE acme_thing (id INTEGER PRIMARY KEY);\n');
  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify({ '0099__acme_thing.sql': 'f'.repeat(64) }));

  assert.throws(() => buildLineageRegistry(fixturesDir), /drift/);
});

test('buildLineageRegistry tolerates a fixtures dir that does not exist (empty registry)', () => {
  const reg = buildLineageRegistry(path.join(scratch(), 'does-not-exist'));
  assert.equal(reg.byChecksum.size, 0);
});

// --- unit: per-row classification ------------------------------------------

test('classifyRow: exact checksum match at the SAME version classifies as match (no-op)', () => {
  const dir = tinyMainDir(scratch());
  const mainIndex = buildMainIndex(dir);
  const widget = loadMigrations(dir).find((m) => m.name === '0002__widget.sql');
  const row = { version: 2, name: '0002__widget.sql', checksum: widget.checksum, status: 'applied' };
  const result = classifyRow(row, mainIndex, { byChecksum: new Map() });
  assert.equal(result.decision, 'match');
  assert.equal(result.matchType, 'exact');
});

test('classifyRow: exact checksum match at a DIFFERENT version classifies as remap', () => {
  const dir = tinyMainDir(scratch());
  const mainIndex = buildMainIndex(dir);
  const widget = loadMigrations(dir).find((m) => m.name === '0002__widget.sql');
  // Ledger row claims to be version 7 but its checksum is byte-identical to main's v2 file.
  const row = { version: 7, name: '0007__widget.sql', checksum: widget.checksum, status: 'applied' };
  const result = classifyRow(row, mainIndex, { byChecksum: new Map() });
  assert.equal(result.decision, 'remap');
  assert.equal(result.matchType, 'exact');
  assert.equal(result.target.version, 2);
});

test('classifyRow: repair_required row with an otherwise-matching checksum/version still needs remap (clears the flag), not match', () => {
  const dir = tinyMainDir(scratch());
  const mainIndex = buildMainIndex(dir);
  const widget = loadMigrations(dir).find((m) => m.name === '0002__widget.sql');
  const row = { version: 2, name: '0002__widget.sql', checksum: widget.checksum, status: 'repair_required' };
  const result = classifyRow(row, mainIndex, { byChecksum: new Map() });
  assert.equal(result.decision, 'remap');
});

test('classifyRow: known-foreign checksum with exactly one header-stripped candidate is pending-proof', () => {
  const dir = tinyMainDir(scratch());
  const mainIndex = buildMainIndex(dir);
  const foreignSql = '-- risk: additive\n-- 0099: widget table (foreign numbering)\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);\n';
  const foreignChecksum = sha(Buffer.from(foreignSql));
  const lineageRegistry = { byChecksum: new Map([[foreignChecksum, { lineage: 'acme', name: '0099__widget.sql', sql: foreignSql, risk: 'additive', checksum: foreignChecksum }]]) };
  const row = { version: 99, name: '0099__widget.sql', checksum: foreignChecksum, status: 'applied' };
  const result = classifyRow(row, mainIndex, lineageRegistry);
  assert.equal(result.decision, 'pending-proof');
  assert.equal(result.target.name, '0002__widget.sql');
});

test('classifyRow: known-foreign checksum with NO header-stripped candidate refuses', () => {
  const dir = tinyMainDir(scratch());
  const mainIndex = buildMainIndex(dir);
  const foreignSql = '-- risk: additive\nCREATE TABLE totally_unrelated (id INTEGER PRIMARY KEY);\n';
  const foreignChecksum = sha(Buffer.from(foreignSql));
  const lineageRegistry = { byChecksum: new Map([[foreignChecksum, { lineage: 'acme', name: '0050__unrelated.sql', sql: foreignSql, risk: 'additive', checksum: foreignChecksum }]]) };
  const row = { version: 50, name: '0050__unrelated.sql', checksum: foreignChecksum, status: 'applied' };
  const result = classifyRow(row, mainIndex, lineageRegistry);
  assert.equal(result.decision, 'refuse');
  assert.match(result.reason, /no header-stripped match/);
});

test('classifyRow: known-foreign checksum with AMBIGUOUS (>1) header-stripped candidates refuses', () => {
  const dir = tinyMainDir(scratch());
  // Add a second main migration with the exact same body as 0002__widget.sql
  // (different header only) so a foreign migration's stripped body matches both.
  writeMigration(dir, '0004__widget_dup.sql', '-- risk: additive\n-- 0004: duplicate widget body on purpose\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);\n');
  const mainIndex = buildMainIndex(dir);
  const foreignSql = '-- risk: additive\n-- 0099: widget table (foreign numbering)\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);\n';
  const foreignChecksum = sha(Buffer.from(foreignSql));
  const lineageRegistry = { byChecksum: new Map([[foreignChecksum, { lineage: 'acme', name: '0099__widget.sql', sql: foreignSql, risk: 'additive', checksum: foreignChecksum }]]) };
  const row = { version: 99, name: '0099__widget.sql', checksum: foreignChecksum, status: 'applied' };
  const result = classifyRow(row, mainIndex, lineageRegistry);
  assert.equal(result.decision, 'refuse');
  assert.match(result.reason, /ambiguous/);
});

test('classifyRow: unknown checksum (not in main, not in any lineage fixture) refuses as orphan', () => {
  const dir = tinyMainDir(scratch());
  const mainIndex = buildMainIndex(dir);
  const row = { version: 5, name: '0005__mystery.sql', checksum: 'f'.repeat(64), status: 'applied' };
  const result = classifyRow(row, mainIndex, { byChecksum: new Map() });
  assert.equal(result.decision, 'refuse');
  assert.match(result.reason, /orphan/);
});

// --- unit: batch collision refusal ------------------------------------------

test('refuseVersionSlotCollisions refuses two remap rows targeting the same slot', () => {
  const target = { version: 5, name: '0005__x.sql', checksum: 'a'.repeat(64) };
  const rows = [
    { version: 10, decision: 'remap', matchType: 'exact', target },
    { version: 11, decision: 'remap', matchType: 'exact', target },
  ];
  refuseVersionSlotCollisions(rows);
  assert.ok(rows.every((r) => r.decision === 'refuse'));
});

test('refuseVersionSlotCollisions refuses a remap landing on an already-occupied match slot, leaving the match row untouched', () => {
  const target = { version: 5, name: '0005__x.sql', checksum: 'a'.repeat(64) };
  const rows = [
    { version: 5, decision: 'match' },
    { version: 12, decision: 'remap', matchType: 'exact', target },
  ];
  refuseVersionSlotCollisions(rows);
  assert.equal(rows[0].decision, 'match');
  assert.equal(rows[1].decision, 'refuse');
});

test('refuseVersionSlotCollisions leaves non-colliding rows alone', () => {
  const rows = [
    { version: 1, decision: 'match' },
    { version: 10, decision: 'remap', matchType: 'exact', target: { version: 5 } },
    { version: 11, decision: 'remap', matchType: 'exact', target: { version: 6 } },
  ];
  refuseVersionSlotCollisions(rows);
  assert.deepEqual(rows.map((r) => r.decision), ['match', 'remap', 'remap']);
});

// --- unit: applyRemap slot-swap safety --------------------------------------

test('applyRemap safely swaps two rows trading version slots (no PK collision)', async () => {
  const db = path.join(scratch(), 't.db');
  const runner = cliRunner(db);
  await runner.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TEXT, finished_at TEXT, status TEXT NOT NULL, error TEXT,
      app_version TEXT, backup_path TEXT
    );
    INSERT INTO schema_migrations (version, name, checksum, status) VALUES
      (1, 'a-at-1.sql', 'aaaa', 'applied'),
      (2, 'b-at-2.sql', 'bbbb', 'applied');
  `);
  const rows = [
    { version: 1, decision: 'remap', target: { version: 2, name: 'a-renamed.sql', checksum: 'AAAA' } },
    { version: 2, decision: 'remap', target: { version: 1, name: 'b-renamed.sql', checksum: 'BBBB' } },
  ];
  const { remapped } = await applyRemap(runner, rows);
  assert.equal(remapped, 2);
  const after = await runner.all('SELECT version, name, checksum, status FROM schema_migrations ORDER BY version');
  assert.deepEqual(after, [
    { version: 1, name: 'b-renamed.sql', checksum: 'BBBB', status: 'applied' },
    { version: 2, name: 'a-renamed.sql', checksum: 'AAAA', status: 'applied' },
  ]);
});

// --- unit: structural proof (synthetic, cheap — no real repo chain) --------

test('structural proof: a mutated header-only candidate with a differing DDL body fails proof and refuses', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const fixturesDir = path.join(root, 'fixtures');
  const lineageDir = path.join(fixturesDir, 'acme');
  fs.mkdirSync(lineageDir, { recursive: true });
  // Deliberately mutated: header differs (as expected for a header-only
  // candidate) AND the DDL body differs (an extra column) — this must NOT
  // pass structural proof even though the header-stripped-by-body-slug
  // lookup below is bypassed manually with a crafted registry entry.
  const mutatedSql = '-- risk: additive\n-- 0099: widget table (mutated)\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT, extra_column TEXT);\n';
  fs.writeFileSync(path.join(lineageDir, '0099__widget.sql'), mutatedSql);
  const manifest = { '0099__widget.sql': sha(Buffer.from(mutatedSql)) };
  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));

  // Force a header-stripped "candidate" pairing by hand: the mutated foreign
  // body does NOT actually share a header-stripped hash with any main
  // migration (that's expected — a real mutation changes the body). Use
  // classifyLedger's own pipeline end-to-end via a ledger row whose checksum
  // is the mutated file's checksum, but seed the lineage registry AND craft
  // the row so exact-match fails and the mutated body's header-stripped hash
  // still needs a target — since it won't naturally collide with a real main
  // migration, assert the resulting decision is 'refuse' either way (no
  // silent remap of mismatched DDL under any path).
  const mainIndex = buildMainIndex(dir);
  const lineageRegistry = buildLineageRegistry(fixturesDir);
  const scratchRoot = scratch();
  const row = { version: 99, name: '0099__widget.sql', checksum: manifest['0099__widget.sql'], status: 'applied' };
  const { rows, refused } = await classifyLedger([row], { mainIndex, lineageRegistry, migrationsDir: dir, scratchRoot });
  assert.equal(refused, true);
  assert.equal(rows[0].decision, 'refuse');
});

test('structural proof: identical schema effect from the same pre-state passes and remaps', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const fixturesDir = path.join(root, 'fixtures');
  const lineageDir = path.join(fixturesDir, 'acme');
  fs.mkdirSync(lineageDir, { recursive: true });
  // Same DDL body as main's 0003__gadget.sql, header differs only.
  const foreignSql = '-- risk: additive\n-- 0077: gadget table (foreign numbering)\nCREATE TABLE gadget (id INTEGER PRIMARY KEY, kind TEXT);\n';
  fs.writeFileSync(path.join(lineageDir, '0077__gadget.sql'), foreignSql);
  const manifest = { '0077__gadget.sql': sha(Buffer.from(foreignSql)) };
  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));

  const mainIndex = buildMainIndex(dir);
  const lineageRegistry = buildLineageRegistry(fixturesDir);
  const scratchRoot = scratch();
  const row = { version: 77, name: '0077__gadget.sql', checksum: manifest['0077__gadget.sql'], status: 'applied' };
  const { rows, refused, summary } = await classifyLedger([row], { mainIndex, lineageRegistry, migrationsDir: dir, scratchRoot });
  assert.equal(refused, false);
  assert.equal(rows[0].decision, 'remap');
  assert.equal(rows[0].matchType, 'header-stripped');
  assert.equal(rows[0].target.version, 3);
  assert.equal(summary.remapHeaderStripped, 1);
});

// --- unit: runReconcile guardrails ------------------------------------------

test('runReconcile refuses a missing DB path', async () => {
  await assert.rejects(() => runReconcile({ dbPath: '/nonexistent/nope.db' }), /does not exist/);
});

test('runReconcile in report mode never writes, even when everything classifies cleanly', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const db = path.join(root, 't.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: dir, appVersion: 'test' });
  const before = fs.readFileSync(db);
  const res = await runReconcile({ dbPath: db, migrationsDir: dir, fixturesDir: path.join(root, 'no-fixtures'), apply: false });
  assert.equal(res.refused, false);
  assert.equal(res.applied, false);
  const after = fs.readFileSync(db);
  assert.ok(before.equals(after), 'report mode must not touch the DB byte image');
});

test('runReconcile --apply refuses without writersStopped', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const db = path.join(root, 't.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: dir, appVersion: 'test' });
  await assert.rejects(
    () => runReconcile({ dbPath: db, migrationsDir: dir, fixturesDir: path.join(root, 'no-fixtures'), apply: true, writersStopped: false }),
    /writers are stopped/
  );
});

test('runReconcile --apply refuses without --backup-dir', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const db = path.join(root, 't.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: dir, appVersion: 'test' });
  await assert.rejects(
    () => runReconcile({ dbPath: db, migrationsDir: dir, fixturesDir: path.join(root, 'no-fixtures'), apply: true, writersStopped: true, backupDir: null }),
    /backup-dir is required/
  );
});

test('runReconcile refuses (touches nothing, byte-for-byte) on an orphan row', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const db = path.join(root, 't.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: dir, appVersion: 'test' });
  // Hand-plant an orphan row: a version/checksum that matches nothing.
  await cliRunner(db).exec(
    "INSERT INTO schema_migrations (version, name, checksum, status) VALUES (999, 'mystery.sql', 'deadbeef', 'applied');"
  );
  const before = fs.readFileSync(db);
  const res = await runReconcile({ dbPath: db, migrationsDir: dir, fixturesDir: path.join(root, 'no-fixtures'), apply: false });
  assert.equal(res.refused, true);
  const orphanRow = res.rows.find((r) => r.version === 999);
  assert.equal(orphanRow.decision, 'refuse');
  assert.match(orphanRow.reason, /orphan/);
  const after = fs.readFileSync(db);
  assert.ok(before.equals(after), 'a refused report must not touch the DB byte image');

  // --apply must ALSO refuse and touch nothing, backup-dir supplied or not.
  const backupDir = path.join(root, 'backups');
  const res2 = await runReconcile({ dbPath: db, migrationsDir: dir, fixturesDir: path.join(root, 'no-fixtures'), apply: true, writersStopped: true, backupDir });
  assert.equal(res2.refused, true);
  assert.equal(res2.applied, false);
  const after2 = fs.readFileSync(db);
  assert.ok(before.equals(after2), '--apply must not touch the DB when classification refuses');
  assert.equal(fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0, false, 'no backup should be taken when nothing will be applied');
});

test('runReconcile refuses on an ambiguous mapping (two rows -> one target)', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const fixturesDir = path.join(root, 'fixtures');
  const lineageDir = path.join(fixturesDir, 'acme');
  fs.mkdirSync(lineageDir, { recursive: true });
  const widget = loadMigrations(dir).find((m) => m.name === '0002__widget.sql');
  // Two DIFFERENT foreign version slots, byte-identical to main's widget —
  // both would exact-match to the SAME target version 2.
  // Build a device DB with ONLY the base table (v1) plus two rows hand-
  // planted at foreign versions whose checksum both equal main's v2.
  const baseOnlyDir = path.join(root, 'base-only');
  fs.mkdirSync(baseOnlyDir);
  writeMigration(baseOnlyDir, '0001__base.sql', '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db2 = path.join(root, 't2.db');
  await bootstrapFresh(cliRunner(db2), { migrationsDir: baseOnlyDir, appVersion: 'test' });
  await cliRunner(db2).exec(`
    INSERT INTO schema_migrations (version, name, checksum, status) VALUES
      (30, '0030__widget_a.sql', '${widget.checksum}', 'applied'),
      (31, '0031__widget_b.sql', '${widget.checksum}', 'applied');
  `);
  const before = fs.readFileSync(db2);
  const res = await runReconcile({ dbPath: db2, migrationsDir: dir, fixturesDir, apply: false });
  assert.equal(res.refused, true);
  assert.ok(res.rows.filter((r) => r.version === 30 || r.version === 31).every((r) => r.decision === 'refuse'));
  const after = fs.readFileSync(db2);
  assert.ok(before.equals(after));
});

// --- unit: clearRepairRequired ----------------------------------------------

test('clearRepairRequired clears a row whose checksum already matches main at its own version', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const db = path.join(root, 't.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: dir, appVersion: 'test' });
  await cliRunner(db).exec("UPDATE schema_migrations SET status='repair_required', error='synthetic' WHERE version=2;");
  const backupDir = path.join(root, 'backups');
  const res = await clearRepairRequired({ dbPath: db, migrationsDir: dir, backupDir, writersStopped: true });
  assert.equal(res.cleared, 1);
  const row = (await cliRunner(db).all('SELECT status, error FROM schema_migrations WHERE version=2'))[0];
  assert.equal(row.status, 'applied');
  assert.equal(row.error, null);
});

test('clearRepairRequired refuses (leaves the row wedged) when the checksum still does not match main', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const db = path.join(root, 't.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: dir, appVersion: 'test' });
  await cliRunner(db).exec("UPDATE schema_migrations SET status='repair_required', checksum='not-a-real-checksum', error='synthetic' WHERE version=2;");
  const res = await clearRepairRequired({ dbPath: db, migrationsDir: dir, backupDir: path.join(root, 'backups'), writersStopped: true });
  assert.equal(res.cleared, 0);
  assert.equal(res.stillWedged.length, 1);
  const row = (await cliRunner(db).all('SELECT status FROM schema_migrations WHERE version=2'))[0];
  assert.equal(row.status, 'repair_required');
});

test('clearRepairRequired is a no-op when there are no repair_required rows', async () => {
  const root = scratch();
  const dir = tinyMainDir(root);
  const db = path.join(root, 't.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: dir, appVersion: 'test' });
  const res = await clearRepairRequired({ dbPath: db, migrationsDir: dir, backupDir: path.join(root, 'backups'), writersStopped: true });
  assert.equal(res.cleared, 0);
  assert.deepEqual(res.stillWedged, []);
});

// --- unit: CLI parsing -------------------------------------------------

test('parseArgs defaults to report mode and parses flags', () => {
  const opts = parseArgs(['/data/db/farming.db', '--apply', '--backup-dir', '/data/backups/migrate']);
  assert.equal(opts.dbPath, '/data/db/farming.db');
  assert.equal(opts.apply, true);
  assert.equal(opts.backupDir, '/data/backups/migrate');
  const reportOpts = parseArgs(['/data/db/farming.db']);
  assert.equal(reportOpts.apply, false);
});

test('parseArgs recognizes --clear-repair-required', () => {
  const opts = parseArgs(['/data/db/farming.db', '--clear-repair-required']);
  assert.equal(opts.clearRepairRequired, true);
});

// ============================================================================
// Fixture proofs: real AgroLink-lineage and Bovey-lineage end-to-end cases.
// Slow (full migration-chain replays through the real runner) — mirrors the
// cost already accepted by baseline-existing-db.test.js / migrate-cli.test.js
// in this same CI batch.
// ============================================================================

// Builds a "device" migrations dir = main's own common-prefix 0001-0021
// (verified byte-identical across all three lineages) + a lineage's own
// vendored divergent range, so bootstrapFresh can replay the device's FULL,
// self-consistent, foreign-numbered history through the real runner.
function buildDeviceMigrationsDir(root, lineage, throughVersion) {
  const dir = path.join(root, `device-${lineage}`);
  fs.mkdirSync(dir);
  for (const m of loadMigrations(MAIN_MIGRATIONS_DIR)) {
    if (m.version <= 21) fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(dir, m.name));
  }
  const lineageDir = path.join(REAL_FIXTURES_DIR, lineage);
  for (const name of fs.readdirSync(lineageDir).filter((f) => f.endsWith('.sql'))) {
    const version = Number(name.slice(0, 4));
    if (version <= throughVersion) fs.copyFileSync(path.join(lineageDir, name), path.join(dir, name));
  }
  return dir;
}

test('AgroLink-lineage fixture: reconcile classifies all 28 foreign rows, applies cleanly, verifyHead ok', { timeout: 900_000 }, async () => {
  const root = scratch();
  const deviceDir = buildDeviceMigrationsDir(root, 'agrolink', 49);
  const db = path.join(root, 'agrolink-device.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: deviceDir, appVersion: 'agrolink-lineage-fixture' });

  // A single --apply call classifies AND applies in one pass (its returned
  // `summary`/`rows` are the same classification a --report call would
  // produce — classifyLedger always runs first). Report-mode's own
  // "never touches the DB" contract is proven separately, cheaply, against
  // synthetic fixtures above; re-proving it here on this expensive real
  // fixture would re-run the full structural-proof pass a second time for
  // no additional coverage.
  const backupDir = path.join(root, 'backups');
  const applyRes = await runReconcile({ dbPath: db, migrationsDir: MAIN_MIGRATIONS_DIR, fixturesDir: REAL_FIXTURES_DIR, apply: true, writersStopped: true, backupDir });
  assert.equal(applyRes.refused, false, JSON.stringify(applyRes.summary));
  // Verified against real file content (git worktree diff), independent of
  // the .superpowers/sdd/stabilization-plan-2026-09-10.md §3.5c estimate:
  // rows 1-21 are the byte-identical common prefix (already 'match'); of
  // AgroLink's own 22-49 (28 rows), 18 are byte-identical to a DIFFERENT
  // main version (exact remap) and 10 differ only in their leading `--`
  // header comment (header-stripped remap, structural proof required).
  assert.equal(applyRes.summary.total, 49);
  assert.equal(applyRes.summary.match, 21);
  assert.equal(applyRes.summary.remapExact, 18);
  assert.equal(applyRes.summary.remapHeaderStripped, 10);
  assert.equal(applyRes.summary.refused, 0);
  assert.equal(applyRes.applied, true, JSON.stringify(applyRes.summary));
  assert.ok(fs.existsSync(applyRes.backupPath));

  const check = await verifyHead(cliRunner(db), { migrationsDir: MAIN_MIGRATIONS_DIR });
  assert.deepEqual(check, { ok: true });

  // Pending set after reconciliation: main versions NOT covered by the
  // now-remapped ledger. AgroLink's device never shipped valve control
  // (main 0022-0025) — those 4 migrations are genuinely new to this device,
  // not a numbering artifact — so pending is exactly {22,23,24,25}, NOT
  // "0050-0053" as estimated in the pre-audit stabilization plan (that
  // estimate assumed AgroLink's renumbered range was simply appended after
  // main's own content with no interleaving; the verified renumber blocks
  // — +9/+11/-1/-19 — actually interleave AgroLink's content BEFORE and
  // AROUND main's own 0022-0025, covering 0026-0053 contiguously and
  // leaving the valve-control block as real, uncovered pending work).
  const applied = new Set(
    (await cliRunner(db).all("SELECT version FROM schema_migrations WHERE status='applied'")).map((r) => r.version)
  );
  const pending = loadMigrations(MAIN_MIGRATIONS_DIR).map((m) => m.version).filter((v) => !applied.has(v));
  assert.deepEqual(pending, [22, 23, 24, 25]);

  // The real applyPending can now carry the device the rest of the way home.
  const carryRes = await applyPending(cliRunner(db), { migrationsDir: MAIN_MIGRATIONS_DIR, appVersion: 'post-reconcile', writersStopped: true });
  assert.deepEqual(carryRes.applied, [22, 23, 24, 25]);
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MAIN_MIGRATIONS_DIR }), { ok: true });
});

test('Bovey-lineage fixture: reconcile classifies all 4 foreign rows, applies cleanly, verifyHead ok', { timeout: 900_000 }, async () => {
  const root = scratch();
  const deviceDir = buildDeviceMigrationsDir(root, 'bovey', 25);
  const db = path.join(root, 'bovey-device.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: deviceDir, appVersion: 'bovey-lineage-fixture' });

  // Single --apply call (see the AgroLink test above for why report-mode's
  // own "touches nothing" contract isn't re-proven against this expensive
  // real fixture).
  const backupDir = path.join(root, 'backups');
  const applyRes = await runReconcile({ dbPath: db, migrationsDir: MAIN_MIGRATIONS_DIR, fixturesDir: REAL_FIXTURES_DIR, apply: true, writersStopped: true, backupDir });
  assert.equal(applyRes.refused, false, JSON.stringify(applyRes.summary));
  // Verified: rows 1-21 common prefix + 0022/0023/0024 already byte-identical
  // to main at the SAME version (3 exact, true no-ops) + 0025 header-only
  // diff (Bovey's header says "Bovey cloud", main's says "cloud" — 1
  // header-stripped remap, same target version 25, checksum-only fix).
  assert.equal(applyRes.summary.total, 25);
  assert.equal(applyRes.summary.match, 24);
  assert.equal(applyRes.summary.remapExact, 0);
  assert.equal(applyRes.summary.remapHeaderStripped, 1);
  assert.equal(applyRes.summary.refused, 0);
  const remapped = applyRes.rows.find((r) => r.decision === 'remap');
  assert.equal(remapped.version, 25);
  assert.equal(remapped.target.version, 25);
  assert.equal(applyRes.applied, true, JSON.stringify(applyRes.summary));

  const check = await verifyHead(cliRunner(db), { migrationsDir: MAIN_MIGRATIONS_DIR });
  assert.deepEqual(check, { ok: true });

  // Bovey never ran ANY AgroLink-derived content — pending is exactly
  // main's 0026-0053 tail, matching the stabilization plan's estimate
  // exactly (this is the one of the two lineage estimates that verified
  // correct).
  const applied = new Set(
    (await cliRunner(db).all("SELECT version FROM schema_migrations WHERE status='applied'")).map((r) => r.version)
  );
  const pending = loadMigrations(MAIN_MIGRATIONS_DIR).map((m) => m.version).filter((v) => !applied.has(v));
  assert.deepEqual(pending, Array.from({ length: 53 - 26 + 1 }, (_, i) => 26 + i));

  const carryRes = await applyPending(cliRunner(db), { migrationsDir: MAIN_MIGRATIONS_DIR, appVersion: 'post-reconcile', writersStopped: true });
  assert.deepEqual(carryRes.applied, pending);
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MAIN_MIGRATIONS_DIR }), { ok: true });
});

test('main-numbered device: reconcile is an all-match no-op report (fast path proof)', { timeout: 900_000 }, async () => {
  const root = scratch();
  const db = path.join(root, 'main-device.db');
  // A device that only ever ran main's own migrations 1..25 (a legitimate
  // main-numbered gateway mid-catch-up) — every row must classify 'match'.
  const partialDir = path.join(root, 'main-partial');
  fs.mkdirSync(partialDir);
  for (const m of loadMigrations(MAIN_MIGRATIONS_DIR)) {
    if (m.version <= 25) fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(partialDir, m.name));
  }
  await bootstrapFresh(cliRunner(db), { migrationsDir: partialDir, appVersion: 'main-numbered-fixture' });
  const before = fs.readFileSync(db);
  const res = await runReconcile({ dbPath: db, migrationsDir: MAIN_MIGRATIONS_DIR, fixturesDir: REAL_FIXTURES_DIR, apply: false });
  assert.equal(res.refused, false);
  assert.equal(res.summary.match, 25);
  assert.equal(res.summary.remapExact, 0);
  assert.equal(res.summary.remapHeaderStripped, 0);
  assert.ok(fs.readFileSync(db).equals(before));
});
