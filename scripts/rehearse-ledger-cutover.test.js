'use strict';
// scripts/rehearse-ledger-cutover.js: path guards, the snapshot comparison,
// and full rehearsals against
//   - a gateway database on an earlier lineage's numbering (ledger at 53, with
//     synthetic rows in every table the pending migrations touch), including
//     an interrupted run and its clean restart;
//   - a database already on main's numbering at head (both passes no-ops);
//   - corrupted ledgers (refused before any write).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const {
  parseArgs, checkLedgerShape, snapshotTables, compareSnapshots, rulesFor, EXPECTED_CHANGES, WORK_MARKER, REPORT_NAME,
  gitState, checkoutProvenance,
} = require('./rehearse-ledger-cutover');
const { buildEarlierLineageGatewayDb } = require('./fixtures/earlier-lineage-gateway-db');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(__dirname, 'rehearse-ledger-cutover.js');
const BUNDLED_DB = path.join(REPO, 'database/farming.db');
const MIGRATIONS = loadMigrations(path.join(REPO, 'database/migrations/ordered'));
const HEAD = MIGRATIONS[MIGRATIONS.length - 1].version;

// The integration runs below use the real default (a dirty checkout fails)
// in CI, where the checkout is clean, and --allow-dirty only while this
// checkout has uncommitted work.
const DIRTY_ARGS = execFileSync('git', ['-C', path.resolve(__dirname, '..'), 'status', '--porcelain'], { encoding: 'utf8' }).trim() ? ['--allow-dirty'] : [];

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-cutover-test-')); }
function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sql(db, text) { execFileSync('sqlite3', ['-bail', db], { input: text, encoding: 'utf8' }); }

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, ...DIRTY_ARGS], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readReport(work) { return JSON.parse(fs.readFileSync(path.join(work, REPORT_NAME), 'utf8')); }

function stepOf(report, pass, name) {
  const p = report.passes.find((x) => x.pass === pass);
  return p && p.steps.find((s) => s.name === name);
}

// --- argument and path guards (nothing written) -----------------------------

test('parseArgs requires --db and --work and validates --gateway-eui', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--db', 'a.db']), /usage/);
  assert.throws(() => parseArgs(['--db', 'a.db', '--work', 'w', '--gateway-eui', 'xyz']), /16 hex/);
  assert.throws(() => parseArgs(['--db', 'a.db', '--work', 'w', '--bogus']), /unknown argument/);
  assert.deepEqual(parseArgs(['--db', 'a.db', '--work', 'w', '--json']), { db: 'a.db', work: 'w', gatewayEui: null, json: true, allowDirty: false, requireFreeze: false });
  assert.equal(parseArgs(['--db', 'a.db', '--work', 'w', '--require-freeze']).requireFreeze, true);
  assert.equal(parseArgs(['--db', 'a.db', '--work', 'w', '--allow-dirty']).allowDirty, true);
});

test('gitState reports the head and whether the checkout is dirty, untracked files included', () => {
  const root = scratch();
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'a');
  let st = gitState(root);
  assert.equal(st.head, git('rev-parse', 'HEAD').trim());
  assert.equal(st.dirty, false);
  fs.writeFileSync(path.join(root, 'a.txt'), 'b');
  st = gitState(root);
  assert.equal(st.dirty, true);
  assert.deepEqual(st.porcelain, [' M a.txt']);
  git('checkout', '-q', 'a.txt');
  fs.writeFileSync(path.join(root, '0071__new.sql'), '-- risk: additive');
  assert.equal(gitState(root).dirty, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkoutProvenance hashes what the rehearsal runs', () => {
  const p = checkoutProvenance();
  const flows = JSON.parse(fs.readFileSync(path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
  const boot = flows.find((n) => n.id === 'sync-init-fn').func;
  assert.equal(p.checksumsJsonSha256, sha(path.join(REPO, 'database/migrations/ordered/CHECKSUMS.json')));
  assert.equal(p.seedSha256, sha(path.join(REPO, 'database/seed-blank.sql')));
  assert.equal(p.bootNodeSha256, crypto.createHash('sha256').update(boot).digest('hex'));
  assert.equal(p.toolSha256, sha(CLI));
  assert.equal(p.node, process.version);
  assert.match(p.sqlite3Cli, /^3\.\d+/);
  assert.match(p.nodeSqlite, /^3\.\d+/);
  assert.ok(Object.keys(p.lineageFixtures).length >= 1);
});

test('a wrong --work or --db path is refused with exit 2 and nothing written', () => {
  const root = scratch();
  const db = path.join(root, 'copy.db');
  fs.copyFileSync(BUNDLED_DB, db);
  const dbSha = sha(db);

  // Not empty and not created by the script.
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'keep me');
  let r = runCli(['--db', db, '--work', foreign]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not empty and was not created by this script/);
  assert.deepEqual(fs.readdirSync(foreign), ['notes.txt']);

  // A file, not a directory.
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'x');
  r = runCli(['--db', db, '--work', file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a file|scratch directory/);

  // Under the live database directory, directly and through a symbolic link.
  r = runCli(['--db', db, '--work', '/data/db/rehearsal']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing a path under \/data\/db/);
  const link = path.join(root, 'live-link');
  fs.symlinkSync('/data/db', link);
  r = runCli(['--db', db, '--work', path.join(link, 'w')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing a path under \/data\/db/);
  r = runCli(['--db', '/data/db/farming.db', '--work', path.join(root, 'w1')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing a path under \/data\/db/);
  r = runCli(['--db', path.join(link, 'farming.db'), '--work', path.join(root, 'w1')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing a path under \/data\/db/);

  // --db inside --work, and a --db that is not a database.
  const work = path.join(root, 'w2');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, WORK_MARKER), '');
  fs.copyFileSync(BUNDLED_DB, path.join(work, 'inside.db'));
  r = runCli(['--db', path.join(work, 'inside.db'), '--work', work]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must not contain --db/);
  r = runCli(['--db', file, '--work', path.join(root, 'w3')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not an SQLite database/);

  assert.equal(fs.existsSync(path.join(root, 'w1')), false);
  assert.equal(fs.existsSync(path.join(root, 'w3')), false);
  assert.equal(sha(db), dbSha);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a second run is refused while a live run holds --work; the source -wal is hashed', () => {
  const root = scratch();
  const db = path.join(root, 'copy.db');
  fs.copyFileSync(BUNDLED_DB, db);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, WORK_MARKER), '');
  fs.writeFileSync(path.join(work, 'notes-of-the-live-run'), 'x');
  // This test process stands in for the live run.
  fs.writeFileSync(path.join(work, 'run-state.json'), JSON.stringify({ status: 'running', pid: process.pid }));
  const r = runCli(['--db', db, '--work', work]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`another run \\(pid ${process.pid}\\) is using --work`));
  assert.ok(fs.existsSync(path.join(work, 'notes-of-the-live-run')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'run-state.json'), 'utf8')).pid, process.pid);

  const { sourceHashes } = require('./rehearse-ledger-cutover');
  fs.writeFileSync(db + '-wal', 'wal bytes');
  const h = sourceHashes(db);
  assert.equal(h.sha256, sha(db));
  assert.equal(h.walSha256, sha(db + '-wal'));
  fs.rmSync(db + '-wal');
  assert.equal(sourceHashes(db).walSha256, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkLedgerShape refuses non-applied rows, bad checksums and bad versions', () => {
  const ok = { version: 1, name: '0001__a.sql', checksum: 'a'.repeat(64), status: 'applied' };
  assert.deepEqual(checkLedgerShape([ok]), []);
  assert.equal(checkLedgerShape([{ ...ok, status: 'repair_required' }]).length, 1);
  assert.equal(checkLedgerShape([{ ...ok, checksum: 'abc' }]).length, 1);
  assert.equal(checkLedgerShape([{ ...ok, version: 0 }]).length, 1);
});

// --- snapshot comparison -------------------------------------------------------

function tinyDb(root, name, statements) {
  const p = path.join(root, name);
  const db = new DatabaseSync(p);
  db.exec(statements);
  db.close();
  return p;
}

const zonesDdl = (linked) => `CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY AUTOINCREMENT, zone_uuid TEXT, name TEXT, phenological_stage TEXT, sync_version INTEGER, updated_at TEXT, deleted_at TEXT);
CREATE TABLE sync_outbox (event_uuid TEXT PRIMARY KEY, aggregate_type TEXT, aggregate_key TEXT, op TEXT, payload_json TEXT, sync_version INTEGER, gateway_device_eui TEXT);
CREATE TABLE sync_link_state (peer_node TEXT PRIMARY KEY, linked INTEGER, gateway_device_eui TEXT);
INSERT INTO sync_link_state VALUES ('cloud', ${linked}, '0016C001F1000001');
CREATE TABLE device_data (id INTEGER PRIMARY KEY, deveui TEXT, swt_wm1 REAL);
CREATE TABLE app_notes (id INTEGER PRIMARY KEY, v);
INSERT INTO app_notes (v) VALUES (13);
INSERT INTO irrigation_zones (zone_uuid, name, phenological_stage, sync_version, updated_at) VALUES ('z1', 'A', 'veraison', 3, 't0'), ('z2', 'B', 'initial', 1, 't0');
INSERT INTO device_data (deveui, swt_wm1) VALUES ('A840410000000001', 12.5), ('A840410000000001', 13);`;
const ZONES_DDL = zonesDdl(1);
const STAGE_Z1 = "UPDATE irrigation_zones SET phenological_stage='mid_season', sync_version=4, updated_at='t1' WHERE zone_uuid='z1';";
// The event 0058's trg_sync_zones_outbox_au writes for that update.
const zoneEvent = ({ id = 'e1', zone = 'z1', op = 'ZONE_CONFIG_UPSERTED', eui = '0016C001F1000001', stage = 'mid_season', version = 4 } = {}) =>
  `INSERT INTO sync_outbox VALUES ('${id}', 'ZONE', '${zone}', '${op}', '${JSON.stringify({ contract_version: 1, zone_uuid: zone, phenological_stage: stage, sync_version: version })}', ${version}, ${eui === null ? 'NULL' : `'${eui}'`});`;

test('compareSnapshots accepts exactly the 0064 design and flags anything else', () => {
  const root = scratch();
  const before = tinyDb(root, 'before.db', ZONES_DDL);
  const good = tinyDb(root, 'good.db', ZONES_DDL + '\n' + STAGE_Z1 + '\n' + zoneEvent());
  const snapBefore = snapshotTables(before);
  const rules = rulesFor([64]);

  let cmp = compareSnapshots(snapBefore, snapshotTables(good, { columnsFrom: snapBefore }), { rules });
  assert.equal(cmp.ok, true, JSON.stringify(cmp.unexpected));
  assert.deepEqual(cmp.changedByDesign.map((c) => [c.table, c.rowsChanged, c.rowsAdded]).sort(),
    [['irrigation_zones', 1, 0], ['sync_outbox', 0, 1]]);
  assert.ok(cmp.unchanged.includes('device_data'));

  // Without the 0064 rule the same change is unexpected.
  cmp = compareSnapshots(snapBefore, snapshotTables(good, { columnsFrom: snapBefore }), {});
  assert.equal(cmp.ok, false);

  const cases = {
    'wrong FAO key': `UPDATE irrigation_zones SET phenological_stage='initial', sync_version=4 WHERE zone_uuid='z1';` + zoneEvent({ stage: 'initial' }),
    'version not +1': `UPDATE irrigation_zones SET phenological_stage='mid_season', sync_version=9 WHERE zone_uuid='z1';` + zoneEvent({ version: 9 }),
    'other column': `UPDATE irrigation_zones SET name='renamed' WHERE zone_uuid='z2';`,
    'telemetry changed': `UPDATE device_data SET swt_wm1=99 WHERE id=1;`,
    'telemetry lost': `DELETE FROM device_data WHERE id=2;`,
    'zone changed, no event while linked': STAGE_Z1,
    'two events for one zone': STAGE_Z1 + zoneEvent() + zoneEvent({ id: 'e9' }),
    'event with another op': STAGE_Z1 + zoneEvent({ op: 'ZONE_UPSERTED' }),
    'event without EUI': STAGE_Z1 + zoneEvent({ eui: null }),
    'event with a foreign EUI': STAGE_Z1 + zoneEvent({ eui: '0016C001F1000099' }),
    'event payload with another stage': STAGE_Z1 + zoneEvent({ stage: 'development' }),
    'event payload with another version': STAGE_Z1 + zoneEvent({ version: 3 }),
    'event for an unchanged zone': STAGE_Z1 + zoneEvent() + zoneEvent({ id: 'e2', zone: 'z2', stage: 'initial', version: 1 }),
    'outbox other type': `INSERT INTO sync_outbox VALUES ('e2', 'DEVICE', 'A840410000000001', 'DEVICE_UPSERTED', '{}', 1, '0016C001F1000001');`,
    'table dropped': 'DROP TABLE device_data;',
    'integer became text': `UPDATE app_notes SET v='13' WHERE id=1;`,
  };
  for (const [label, change] of Object.entries(cases)) {
    const after = tinyDb(root, label.replace(/\W/g, '_') + '.db', ZONES_DDL + '\n' + change);
    const res = compareSnapshots(snapBefore, snapshotTables(after, { columnsFrom: snapBefore }), { rules });
    assert.equal(res.ok, false, label);
    assert.ok(res.unexpected.length > 0, label);
  }

  // Not linked: the trigger stays silent, so a changed zone has no event and
  // an event would be unexpected.
  const unlinkedBefore = snapshotTables(tinyDb(root, 'unlinked-before.db', zonesDdl(0)));
  const unlinkedQuiet = tinyDb(root, 'unlinked-quiet.db', zonesDdl(0) + '\n' + STAGE_Z1);
  cmp = compareSnapshots(unlinkedBefore, snapshotTables(unlinkedQuiet, { columnsFrom: unlinkedBefore }), { rules });
  assert.equal(cmp.ok, true, JSON.stringify(cmp.unexpected));
  const unlinkedEvent = tinyDb(root, 'unlinked-event.db', zonesDdl(0) + '\n' + STAGE_Z1 + '\n' + zoneEvent());
  cmp = compareSnapshots(unlinkedBefore, snapshotTables(unlinkedEvent, { columnsFrom: unlinkedBefore }), { rules });
  assert.equal(cmp.ok, false);

  // A rebuilt table with an extra column and a new physical order compares equal.
  const rebuilt = tinyDb(root, 'rebuilt.db', ZONES_DDL + `
CREATE TABLE device_data_next (swt_wm1 REAL, deveui TEXT, id INTEGER PRIMARY KEY, extra TEXT);
INSERT INTO device_data_next (id, deveui, swt_wm1) SELECT id, deveui, swt_wm1 FROM device_data;
DROP TABLE device_data; ALTER TABLE device_data_next RENAME TO device_data;`);
  cmp = compareSnapshots(snapBefore, snapshotTables(rebuilt, { columnsFrom: snapBefore }), {});
  assert.equal(cmp.ok, true, JSON.stringify(cmp.unexpected));
  assert.deepEqual(cmp.addedColumns, [{ table: 'device_data', columns: ['extra'] }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('compareSnapshots requires pre-existing rows to carry an added column\'s declared default', () => {
  const root = scratch();
  const base = "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT); INSERT INTO t (a) VALUES ('x'), ('y');";
  const snapBefore = snapshotTables(tinyDb(root, 'before.db', base));
  const cases = [
    ['default kept', "ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0;", true],
    ['text default kept', "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'auto';", true],
    ['no default, NULL', 'ALTER TABLE t ADD COLUMN b TEXT;', true],
    ['backfilled', "ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0; UPDATE t SET b = 5 WHERE id = 1;", false],
    ['backfilled text', "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'auto'; UPDATE t SET b = 'manual';", false],
    ['backfilled from NULL', 'ALTER TABLE t ADD COLUMN b TEXT; UPDATE t SET b = a;', false],
  ];
  for (const [label, change, ok] of cases) {
    const after = tinyDb(root, label.replace(/\W/g, '_') + '.db', base + change);
    const res = compareSnapshots(snapBefore, snapshotTables(after, { columnsFrom: snapBefore }), {});
    assert.equal(res.ok, ok, label + ' ' + JSON.stringify(res.unexpected));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('compareSnapshots allows new tables only empty unless a rule lists them', () => {
  const root = scratch();
  const base = "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);";
  const snapBefore = snapshotTables(tinyDb(root, 'before.db', base));
  let res = compareSnapshots(snapBefore, snapshotTables(tinyDb(root, 'empty.db', base + 'CREATE TABLE fresh (id INTEGER PRIMARY KEY);'), { columnsFrom: snapBefore }), {});
  assert.equal(res.ok, true, JSON.stringify(res.unexpected));
  assert.deepEqual(res.newTables, [{ table: 'fresh', count: 0 }]);
  res = compareSnapshots(snapBefore, snapshotTables(tinyDb(root, 'filled.db', base + 'CREATE TABLE fresh (id INTEGER PRIMARY KEY); INSERT INTO fresh VALUES (1);'), { columnsFrom: snapBefore }), {});
  assert.equal(res.ok, false);
  assert.match(res.unexpected[0].reason, /new table with 1 row/);
  fs.rmSync(root, { recursive: true, force: true });
});

// A gateway outbox keeps delivered rows for 30 days up to 50,000 rows, so the
// 0064 ZONE event can land in an outbox far above the row-values limit.
test('the 0064 change validates in an outbox larger than the row-values limit', () => {
  const root = scratch();
  const big = `CREATE TABLE irrigation_zones (id INTEGER PRIMARY KEY AUTOINCREMENT, zone_uuid TEXT, name TEXT, phenological_stage TEXT, sync_version INTEGER, updated_at TEXT, deleted_at TEXT);
CREATE TABLE sync_outbox (event_uuid TEXT PRIMARY KEY, aggregate_type TEXT, aggregate_key TEXT, op TEXT, payload_json TEXT, sync_version INTEGER, gateway_device_eui TEXT);
CREATE TABLE sync_link_state (peer_node TEXT PRIMARY KEY, linked INTEGER, gateway_device_eui TEXT);
INSERT INTO sync_link_state VALUES ('cloud', 1, '0016C001F1000001');
INSERT INTO irrigation_zones (zone_uuid, name, phenological_stage, sync_version, updated_at) VALUES ('z1', 'A', 'veraison', 3, 't0');
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20035)
INSERT INTO sync_outbox SELECT printf('e%05d', i), 'DEVICE_DATA', 'A840410000000001', 'DEVICE_DATA_APPENDED', '{"i":' || i || '}', 1, '0016C001F1000001' FROM n;`;
  const before = tinyDb(root, 'before.db', big);
  const after = tinyDb(root, 'after.db', big + `
UPDATE irrigation_zones SET phenological_stage='mid_season', sync_version=4, updated_at='t1' WHERE zone_uuid='z1';
INSERT INTO sync_outbox VALUES ('zone-event', 'ZONE', 'z1', 'ZONE_CONFIG_UPSERTED', '{"zone_uuid":"z1","phenological_stage":"mid_season","sync_version":4}', 4, '0016C001F1000001');`);
  const snapBefore = snapshotTables(before);
  const cmp = compareSnapshots(snapBefore, snapshotTables(after, { columnsFrom: snapBefore }), { rules: rulesFor([64]) });
  assert.equal(cmp.ok, true, JSON.stringify(cmp.unexpected));
  assert.deepEqual(cmp.changedByDesign.map((c) => [c.table, c.rowsChanged, c.rowsAdded]).sort(),
    [['irrigation_zones', 1, 0], ['sync_outbox', 0, 1]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('EXPECTED_CHANGES names real migrations at their versions', () => {
  for (const [version, entry] of Object.entries(EXPECTED_CHANGES)) {
    const m = MIGRATIONS.find((x) => x.version === Number(version));
    assert.ok(m, `no migration at ${version}`);
    assert.equal(m.name, entry.name);
    assert.notEqual(m.risk, 'additive', `${m.name}: only data/destructive migrations change rows`);
  }
});

// --- full rehearsals ---------------------------------------------------------

test('a database already on main numbering at head: both passes are no-ops', { timeout: 900_000 }, () => {
  const root = scratch();
  const db = path.join(root, 'main-lineage.db');
  fs.copyFileSync(BUNDLED_DB, db);
  sql(db, `INSERT INTO users (id, username, password_hash, created_at, user_uuid, auth_mode, server_offline_verifier_version) VALUES (1, 'owner', 'x', '2026-09-01T00:00:00Z', 'aaaaaaaa000000000000000000000001', 'local', 0);
INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, gateway_device_eui, sync_version, scheduling_mode, phenological_stage, prediction_card_enabled) VALUES (1, 'Zone A', 1, 'bbbbbbbb000000000000000000000001', '0016C001F1000001', 1, 'local', 'initial', 0);`);
  fs.chmodSync(db, 0o444);
  const dbSha = sha(db);
  const work = path.join(root, 'work');
  const r = runCli(['--db', db, '--work', work]);
  assert.equal(r.status, 0, r.stderr.slice(-3000));
  const report = readReport(work);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.source.sha256After, dbSha);
  assert.deepEqual(report.warnings, ['no cloud link row with a gateway EUI']);
  assert.equal(report.checkout.head, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(report.checkout.dirty, DIRTY_ARGS.length > 0);
  assert.equal(report.checkout.checksumsJsonSha256, sha(path.join(REPO, 'database/migrations/ordered/CHECKSUMS.json')));
  assert.equal(stepOf(report, 0, 'checkout').ok, true);
  // Resource use, sampled at every step boundary.
  assert.ok(report.resources.maxRssKb > 0);
  assert.ok(report.resources.peakWorkTmpBytes >= 0);
  assert.ok(report.resources.minMemAvailableMb > 0);
  assert.ok(stepOf(report, 1, 'reconcile-report').resources.workTmpBytes >= 0);
  for (const pass of [1, 2]) {
    assert.deepEqual(stepOf(report, pass, 'reconcile-report').result.summary, { total: HEAD, match: HEAD, remapExact: 0, remapHeaderStripped: 0, refused: 0 });
    assert.equal(stepOf(report, pass, 'reconcile-apply').skipped, true);
    assert.deepEqual(stepOf(report, pass, 'migrate-cli').result.applied, []);
    assert.equal(stepOf(report, pass, 'verify-head').result.fingerprintsExact, true);
  }
  const compare = stepOf(report, 1, 'data-compare').result;
  assert.deepEqual(compare.migrationPhase.changedByDesign, []);
  assert.deepEqual(compare.migrationPhase.unexpected, []);
  assert.equal(stepOf(report, 2, 'second-run-no-op').ok, true);
  assert.equal(sha(db), dbSha);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a corrupted ledger is refused before any write', { timeout: 300_000 }, () => {
  const root = scratch();
  // A checksum no migration and no vendored lineage carries: reconcile refuses.
  const unknown = path.join(root, 'unknown-checksum.db');
  fs.copyFileSync(BUNDLED_DB, unknown);
  sql(unknown, `UPDATE schema_migrations SET checksum='${'0'.repeat(64)}' WHERE version=40;`);
  const unknownSha = sha(unknown);
  let work = path.join(root, 'work-unknown');
  let r = runCli(['--db', unknown, '--work', work]);
  assert.equal(r.status, 1, r.stderr.slice(-3000));
  let report = readReport(work);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.failedStep, 'pass 1 reconcile-report');
  const recon = stepOf(report, 1, 'reconcile-report').result;
  assert.equal(recon.refused, true);
  assert.equal(recon.databaseUnchanged, true);
  assert.deepEqual(recon.refusedRows.map((x) => x.from), [40]);
  assert.equal(report.workingCopySha256, unknownSha, 'the working copy was written');
  assert.deepEqual(fs.readdirSync(path.join(work, 'backups')), []);
  assert.equal(sha(unknown), unknownSha);

  // A row left repair_required: refused by the preflight, before reconcile.
  const wedged = path.join(root, 'wedged.db');
  fs.copyFileSync(BUNDLED_DB, wedged);
  sql(wedged, "UPDATE schema_migrations SET status='repair_required' WHERE version=12;");
  const wedgedSha = sha(wedged);
  work = path.join(root, 'work-wedged');
  r = runCli(['--db', wedged, '--work', work]);
  assert.equal(r.status, 1);
  report = readReport(work);
  assert.equal(report.failedStep, 'pass 1 preflight');
  assert.match(stepOf(report, 1, 'preflight').result.problems.join('\n'), /v12 .*status 'repair_required'/);
  assert.equal(report.workingCopySha256, wedgedSha);
  assert.equal(stepOf(report, 1, 'reconcile-report'), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('--require-freeze fails the preflight when the cutover freeze does not hold', { timeout: 300_000 }, () => {
  const root = scratch();
  const db = path.join(root, 'unlinked.db');
  fs.copyFileSync(BUNDLED_DB, db);
  sql(db, `INSERT INTO sync_outbox (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at) VALUES ('dddddddd000000000000000000000001', 'ZONE', 'bbbbbbbb000000000000000000000001', 'ZONE_UPSERTED', '{}', 1, '2026-09-01T00:00:00Z');`);
  const work = path.join(root, 'work');
  const r = runCli(['--db', db, '--work', work, '--require-freeze']);
  assert.equal(r.status, 1, r.stderr.slice(-2000));
  const report = readReport(work);
  assert.equal(report.failedStep, 'pass 1 preflight');
  const pre = stepOf(report, 1, 'preflight').result;
  assert.match(pre.problems.join('\n'), /1 outbox event\(s\) pending/);
  assert.match(pre.problems.join('\n'), /no cloud link row with a gateway EUI/);
  assert.equal(report.workingCopySha256, sha(db));
  fs.rmSync(root, { recursive: true, force: true });
});

// Kills the CLI once pass 1 has started migrating, then runs it again in the
// same --work directory: the restart begins from the pristine copy and must
// pass, with exactly the row changes the migrations make by design.
test('earlier lineage at 53 with data: interrupted run, clean restart, designed changes only, second pass a no-op', { timeout: 2_400_000 }, async () => {
  const root = scratch();
  const db = path.join(root, 'earlier-lineage.db');
  const built = await buildEarlierLineageGatewayDb(db, { scratchDir: root });
  assert.equal(built.applied.length, 53);
  fs.chmodSync(db, 0o444);
  const dbSha = sha(db);
  const work = path.join(root, 'work');

  const killedAt = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--db', db, '--work', work, ...DIRTY_ARGS], { stdio: ['ignore', 'ignore', 'pipe'] });
    let buf = '';
    let killed = null;
    child.stderr.on('data', (d) => {
      buf += d;
      if (!killed && /pass 1 step migrate-cli start/.test(buf)) {
        killed = 'migrate-cli';
        child.kill('SIGKILL');
      }
    });
    child.on('error', reject);
    child.on('exit', () => resolve(killed));
  });
  assert.equal(killedAt, 'migrate-cli');
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'run-state.json'), 'utf8')).status, 'running');
  // Let any sqlite3 child of the killed process finish.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const r = runCli(['--db', db, '--work', work]);
  const report = readReport(work);
  assert.equal(r.status, 0, JSON.stringify(report.passes.flatMap((p) => p.steps.filter((s) => !s.ok)), null, 1).slice(0, 6000));
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.previousRunInterrupted, true);
  assert.equal(report.source.sha256Before, dbSha);
  assert.equal(report.source.sha256After, dbSha);
  assert.equal(sha(db), dbSha);
  assert.equal(stepOf(report, 0, 'copy-source').result.gatewayEuiSource, 'sync_link_state');
  assert.deepEqual(report.warnings, []);

  // Reconcile and migrate: exactly the mapping and holes of the lineage.
  const recon = stepOf(report, 1, 'reconcile-report').result;
  assert.deepEqual(recon.summary, { total: 53, match: 21, remapExact: 22, remapHeaderStripped: 10, refused: 0 });
  assert.equal(recon.databaseUnchanged, true);
  const tail = Object.fromEntries(recon.remaps.filter((m) => m.from >= 50).map((m) => [m.from, m.to]));
  assert.deepEqual(tail, { 50: 69, 51: 70, 52: 61, 53: 68 });
  const holes = [22, 23, 24, 25, 54, 55, 56, 57, 58, 59, 60, 62, 63, 64, 65, 66, 67];
  assert.deepEqual(recon.pendingAfterReconcile, holes);
  assert.equal(stepOf(report, 1, 'reconcile-apply').result.applied, true);
  assert.deepEqual(stepOf(report, 1, 'migrate-cli').result.applied, holes);
  assert.equal(stepOf(report, 1, 'verify-head').result.ledger.head, HEAD);
  assert.equal(stepOf(report, 1, 'devices-rebuild-1').result.guardSkippedRebuild, true);
  assert.equal(stepOf(report, 1, 'devices-rebuild-2').result.guardSkippedRebuild, true);
  assert.equal(stepOf(report, 1, 'boot-node').result.devicesRebuilt, false);
  assert.deepEqual(stepOf(report, 1, 'schema-compare').result.diffs, []);

  // Data: only the designed changes.
  const compare = stepOf(report, 1, 'data-compare').result;
  assert.deepEqual(compare.migrationPhase.unexpected, []);
  assert.deepEqual(compare.bootPhase.unexpected, []);
  const byDesign = Object.fromEntries(compare.migrationPhase.changedByDesign.map((c) => [c.table, c]));
  assert.equal(byDesign.irrigation_zones.rowsChanged, 1);
  assert.deepEqual(byDesign.irrigation_zones.changedColumns, ['phenological_stage', 'sync_version', 'updated_at']);
  assert.equal(byDesign.sync_outbox.rowsAdded, 1);
  assert.equal(byDesign.sync_outbox.rowsChanged, 0);
  const unchanged = new Set(compare.migrationPhase.unchangedTables);
  for (const table of ['users', 'devices', 'device_data', 'chameleon_readings', 'dendrometer_readings', 'watermark_calibrations',
    'watermark_readings', 'journal_plots', 'journal_entries', 'journal_edge_mutations', 'journal_replication_applied',
    'user_zone_assignments', 'sync_link_state', 'sync_history_dirty_keys', 'sync_history_cursors', 'irrigation_schedules',
    'dendro_baselines', 'weather_station_zones', 'weather_station_zone_state', 'zone_valve_assignments', 'sdi12_recipe_deployments',
    'sdi12_identify_attempts', 'valve_actuation_expectations', 'applied_commands', 'command_ack_outbox', 'dendrometer_daily',
    'zone_daily_environment', 'zone_daily_recommendations']) {
    assert.ok(unchanged.has(table), `${table} changed`);
    assert.ok(compare.tables[table].before.count > 0, `${table} has no fixture rows`);
  }
  const op = compare.operational;
  assert.deepEqual(op.outboxPendingByType, [{ aggregate_type: 'ZONE', op: op.outboxPendingByType[0].op, n: 1, without_gateway_eui: 0 }]);
  assert.equal(op.historyInFlight, 0);

  // Second pass: nothing to reconcile, nothing to apply, nothing changed.
  assert.deepEqual(stepOf(report, 2, 'reconcile-report').result.summary, { total: HEAD, match: HEAD, remapExact: 0, remapHeaderStripped: 0, refused: 0 });
  assert.deepEqual(stepOf(report, 2, 'migrate-cli').result.applied, []);
  assert.equal(stepOf(report, 2, 'data-compare').ok, true);
  assert.equal(stepOf(report, 2, 'second-run-no-op').ok, true);
  for (const p of report.passes) for (const s of p.steps) assert.equal(typeof s.durationMs, 'number');
  fs.rmSync(root, { recursive: true, force: true });
});
