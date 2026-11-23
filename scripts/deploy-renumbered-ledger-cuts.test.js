'use strict';

// #759: a deploy cut between the ledger renumber (reconcile-ledger-numbering)
// and main's last migration. The gateway ran a release line that shipped
// main's 0084 under its own number 81; main's deploy renumbers that row to 84
// (ledger ...,80,84) and then applies 81, 82 and 83. States, named as in the
// issue trace:
// - R1/R2: renumber committed, 0081 not yet;
// - R3: 0081 committed, not stamped (ledger ...,80,81,84);
// - R4: 0081 stamped;
// - R5: 0082 committed, not stamped;
// - R7: 0083 committed, not stamped (the ledger is complete).
// Each is built with the real reconcile, the real migrate-cli (killed with
// helpers/kill-after-migration-commit.js), node-red.init's own boot step, and
// deploy.sh's own restore_as_found/restart_previous_payload text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const swap = require('./deploy-payload-swap');
const { buildReference } = require('./baseline-existing-db');
const { runReconcile } = require('./reconcile-ledger-numbering');
const { applyPending } = require('../lib/osi-migrate/runner');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { readMigrationManifest, loadMigrationCorpus, materializeMigrations } = require('../lib/osi-migrate/migrations-loader');
const { pendingBootOwnedFingerprints } = require('../lib/osi-migrate/boot-owned-fingerprints');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(REPO, 'database', 'migrations', 'ordered');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const INSTALLED_FLOWS = JSON.parse(fs.readFileSync(path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
const INIT = fs.readFileSync(path.join(REPO, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'), 'utf8');
const LEDGER_SQL = "SELECT COALESCE((SELECT MAX(version) FROM schema_migrations WHERE status='applied'),0) || '|' || COALESCE((SELECT group_concat(version || ':' || checksum, ',') FROM (SELECT version, checksum FROM schema_migrations WHERE status='applied' ORDER BY version)), '')";
// The old line's head is 80 plus its own 81, which is main's 0084 byte for byte.
const BASE = 80;
const MOVED = 84;
const FOREIGN_NAME = '0081__schedule_insert_outbox_trigger.sql';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-renumber-cut-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

function sqlite(db, sql) {
  const run = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function schema(db) {
  const value = sqlite(db, LEDGER_SQL);
  return { head: value.slice(0, value.indexOf('|')), ledger: value.slice(value.indexOf('|') + 1), raw: value };
}

function target() {
  const manifest = [...readMigrationManifest(MIGRATIONS)].sort((a, b) => a.version - b.version);
  return { head: String(manifest[manifest.length - 1].version), ledger: manifest.map((m) => `${m.version}:${m.checksum}`).join(',') };
}

function storedFingerprints(db) {
  return new Map(JSON.parse(spawnSync('sqlite3', ['-json', db, 'SELECT object_type, object_name, fingerprint FROM schema_object_fingerprints'], { encoding: 'utf8' }).stdout || '[]')
    .map((r) => [`${r.object_type} ${r.object_name}`, r.fingerprint]));
}

function appliedVersions(db) {
  return sqlite(db, "SELECT group_concat(version) FROM (SELECT version FROM schema_migrations WHERE status='applied' ORDER BY version)").split(',').map(Number);
}

// The old line's database: reference(80), then main's 0084 applied under the
// old line's name 0081 (same bytes, same checksum), stamped as its runner does.
let oldLine = null;
async function oldLineDatabase() {
  if (!oldLine) {
    fs.mkdirSync(path.join(scratch, 'chain'), { recursive: true });
    const ref = await buildReference(MIGRATIONS, BASE, path.join(scratch, 'chain'));
    oldLine = path.join(scratch, 'old-line.db');
    fs.copyFileSync(ref, oldLine);
    const corpus = loadMigrationCorpus(MIGRATIONS);
    const selections = corpus.migrations.filter((m) => m.version <= BASE).map((m) => ({ corpus, name: m.name }));
    selections.push({ corpus, name: corpus.migrations.find((m) => m.version === MOVED).name, asName: FOREIGN_NAME });
    const oldCorpus = materializeMigrations(path.join(scratch, 'old-line-migrations'), selections);
    await applyPending(cliRunner(oldLine), { migrationsDir: oldCorpus.dir, corpus: oldCorpus, appVersion: 'old-line', writersStopped: true });
    const s = schema(oldLine);
    assert.equal(s.head, '81');
    assert.ok(s.ledger.endsWith(`,81:${corpus.migrations.find((m) => m.version === MOVED).checksum}`), 'the old line\'s 81 is main\'s 0084');
  }
  return oldLine;
}

function writeModule(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: path.basename(dir), version: '1.0.0', main: 'index.js' })}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), `exports.marker = ${JSON.stringify(marker)};\n`);
}

function stage(root, stamp) {
  const flows = path.join(root, `flows-${stamp}.json`);
  const gui = path.join(root, `gui-${stamp}`);
  fs.writeFileSync(flows, JSON.stringify([{ id: 'x', stamp }]));
  fs.mkdirSync(gui);
  fs.writeFileSync(path.join(gui, 'index.html'), `<title>${stamp}</title>\n`);
  swap.stagePayload(root, stamp, flows, gui, 'staged');
  writeModule(path.join(root, 'payloads', stamp, 'modules', 'osi-a'), `a@${stamp}`);
  swap.sealModules(root, stamp);
}

function bootOwnedFor(db) {
  return pendingBootOwnedFingerprints({
    flows: INSTALLED_FLOWS, migrations: loadMigrationCorpus(MIGRATIONS).migrations, applied: appliedVersions(db), current: storedFingerprints(db),
  });
}

// The gateway main's deploy found: payloads/old active, recorded for the old
// line's ledger and healthy; payloads/new staged. Then the deploy's steps up
// to migrate-cli: the reconcile (with its planned-ledger file) and, unless
// <record> is false, the pending switch.
async function gateway({ record = true } = {}) {
  const root = fs.mkdtempSync(path.join(scratch, 'gw-'));
  const guiRoot = path.join(root, 'gui');
  fs.mkdirSync(path.join(root, 'payloads'));
  const db = path.join(root, 'farming.db');
  fs.copyFileSync(await oldLineDatabase(), db);
  const found = schema(db);
  stage(root, 'old');
  swap.writeCompatibility(root, 'old', found.head, found.ledger);
  swap.flipTo(root, 'old', guiRoot);
  swap.markHealthy(root, 'old');
  swap.writePayloadState(root, 'old', 'healthy', 'fixture');
  stage(root, 'new');
  fs.copyFileSync(path.join(__dirname, 'deploy-payload-swap.js'), path.join(root, '.payload-swap.js'));
  const planned = path.join(root, 'reconcile-planned-schema');
  const res = await runReconcile({ dbPath: db, migrationsDir: MIGRATIONS, backupDir: path.join(root, 'backups'), apply: true, writersStopped: true, plannedSchemaOut: planned, log: () => {} });
  assert.equal(res.applied, true);
  const renumbered = schema(db);
  assert.equal(renumbered.head, String(MOVED));
  const g = { root, guiRoot, db, to: target(), found, renumbered, planned };
  if (record) writeRecord(g, 'new');
  return g;
}

function writeRecord(g, stamp) {
  const from = schema(g.db);
  swap.writePendingSwitch(g.root, stamp, g.to.head, g.to.ledger, from.head, from.ledger, JSON.stringify(bootOwnedFor(g.db)));
  swap.clearOtherPendingSwitches(g.root, stamp);
  g.record = swap.readPendingSwitches(g.root).find((r) => r.payload_stamp === stamp);
}

// cut: { commit: k } kills after the k-th migration's COMMIT (before its
// stamp), { stamp: k } after its fingerprint stamp.
function migrate(db, cut = null) {
  const args = cut ? ['-r', path.join(__dirname, 'helpers/kill-after-migration-commit.js')] : [];
  return spawnSync(process.execPath, [...args, path.join(REPO, 'scripts/migrate-cli.js'), db, '--backup-dir', path.join(path.dirname(db), 'backups'), '--migrations-dir', MIGRATIONS], {
    encoding: 'utf8',
    env: { ...process.env, KILL_AFTER_COMMIT: String((cut && cut.commit) || 0), KILL_AFTER_STAMP: String((cut && cut.stamp) || 0) },
  });
}

function appliedBy(run) {
  return JSON.parse(/\[migrate\] applied: (\[[^\]]*\])/.exec(run.stdout + run.stderr)[1]);
}

// node-red.init's start, up to the point where Node-RED is launched.
function boot(g) {
  const begin = INIT.indexOf('# payload switch repair begin');
  const end = INIT.indexOf('# payload switch repair end');
  const block = INIT.slice(begin, end).split('/srv/$PACKAGE_NAME').join(g.root).split('/usr/lib/node-red/gui').join(g.guiRoot);
  const bin = path.join(g.root, 'boot-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.rmSync(path.join(g.root, 'boot.log'), { force: true });
  fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\nshift 2\necho "$*" >> ${JSON.stringify(path.join(g.root, 'boot.log'))}\n`, { mode: 0o755 });
  const run = spawnSync('sh', ['-c', `${block}\npayload_switch_repair\nif ! payload_schema_check; then echo NODE_RED_HELD; elif payload_hold_check; then echo NODE_RED_STARTS; else echo NODE_RED_HELD; fi`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, OSI_DB_PATH: g.db },
  });
  assert.equal(run.status, 0, run.stderr);
  return { started: run.stdout.includes('NODE_RED_STARTS'), log: fs.existsSync(path.join(g.root, 'boot.log')) ? fs.readFileSync(path.join(g.root, 'boot.log'), 'utf8') : '' };
}

// The deploy run again: its own stage and record, the rest of the
// migrations, verifyHead and the switch.
function retryCompletes(g, expectedApplied) {
  stage(g.root, 'retry');
  writeRecord(g, 'retry');
  const run = migrate(g.db);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(appliedBy(run), expectedApplied);
  const verify = spawnSync(process.execPath, [path.join(REPO, 'scripts/verify-head-cli.js'), g.db, '--migrations-dir', MIGRATIONS], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.equal(schema(g.db).ledger, g.to.ledger);
  return run;
}

// deploy.sh's own shell functions, extracted by name.
function shellFunction(name) {
  const start = DEPLOY.indexOf(`\n${name}() {\n`);
  assert.ok(start !== -1, `deploy.sh defines ${name}`);
  const end = DEPLOY.indexOf('\n}\n', start + 1);
  return DEPLOY.slice(start + 1, end + 3);
}

function shellBlock(beginMarker, endMarker) {
  const begin = DEPLOY.indexOf(beginMarker);
  const end = DEPLOY.indexOf(endMarker);
  assert.ok(begin !== -1 && end > begin, `deploy.sh has ${beginMarker}`);
  return DEPLOY.slice(DEPLOY.indexOf('\n', begin) + 1, end);
}

// deploy_exit_handler's refusal branch: as found first, else the rollback
// payload, else held. <env>: PRE_STOP_SCHEMA and RECONCILE_PLANNED_SCHEMA.
function exitPath(g, env, before = '') {
  const fns = ['swap_call', 'schema_compatibility_metadata', 'verify_payload_db_compatibility', 'restore_as_found', 'restart_previous_payload'].map(shellFunction).join('\n');
  const script = `${fns}
repair_health_start() { echo "(stub) Node-RED restarted on $(swap_call currentStamp)"; }
wait_for_node_red_health() { return 0; }
restore_previous_firmware_version() { :; }
PRE_STOP_ACTIVE="$(swap_call currentStamp)"
PREV_STAMP="$PRE_STOP_ACTIVE"
${before}
if restore_as_found; then echo "RESULT: as found"; elif restart_previous_payload; then echo "RESULT: rollback payload"; else echo "RESULT: HELD"; fi
`;
  const run = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, SWAP_ROOT: g.root, SWAP_JS: path.join(__dirname, 'deploy-payload-swap.js'), DB_PATH: g.db, GUI_ROOT: g.guiRoot,
      TMP_DIR: path.join(g.root, 'no-tmp'), migrations_dir: MIGRATIONS, DEPLOY_STAMP: 'new', PRE_STOP_RUNNING: '1', ...env,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  return { result: /RESULT: (.*)/.exec(run.stdout)[1], out: run.stdout + run.stderr };
}

test('the reconcile announces exactly the ledger it commits, in schema_compatibility_metadata\'s format', async () => {
  const g = await gateway();
  assert.equal(fs.readFileSync(g.planned, 'utf8').trim(), g.renumbered.raw);
  const metadata = spawnSync('sh', ['-c', `${shellFunction('schema_compatibility_metadata')}\nschema_compatibility_metadata`], { encoding: 'utf8', env: { PATH: process.env.PATH, DB_PATH: g.db } });
  assert.equal(metadata.stdout.trim(), g.renumbered.raw);
  assert.notEqual(g.renumbered.raw, g.found.raw);
});

test('R2p: a deploy cut or refused after the renumber, before 0081 commits, returns to the payload it found', async () => {
  const g = await gateway();
  // Signal during the reconcile itself (PRE_STOP_SCHEMA still the ledger as
  // found, the planned-ledger file in place).
  const during = exitPath(g, { PRE_STOP_SCHEMA: g.found.raw, RECONCILE_PLANNED_SCHEMA: g.planned });
  assert.equal(during.result, 'as found', during.out);
  assert.match(during.out, /renumbered ledger rows only/);
  // Signal or refusal after it: deploy.sh's own re-read runs first.
  const after = exitPath(g, { PRE_STOP_SCHEMA: g.found.raw, RECONCILE_PLANNED_SCHEMA: g.planned, schema_compatibility_metadata_raw: '' },
    shellBlock('# reconcile as-found begin', '# reconcile as-found end'));
  assert.equal(after.result, 'as found', after.out);
  // Without either (main before #759): held.
  const before = exitPath(g, { PRE_STOP_SCHEMA: g.found.raw });
  assert.equal(before.result, 'HELD', before.out);
});

test('restore_as_found refuses a database whose ledger reads but whose pages do not pass quick_check', async () => {
  const g = await gateway();
  // Damage pages away from the ledger: the second half of the file.
  const size = fs.statSync(g.db).size;
  const fd = fs.openSync(g.db, 'r+');
  fs.writeSync(fd, Buffer.alloc(8192, 0xff), 0, 8192, Math.floor(size / 2 / 4096) * 4096);
  fs.closeSync(fd);
  assert.equal(schema(g.db).raw, g.renumbered.raw, 'precondition: the ledger still reads');
  const cut = exitPath(g, { PRE_STOP_SCHEMA: g.renumbered.raw });
  assert.equal(cut.result, 'HELD', cut.out);
  assert.match(cut.out, /fails PRAGMA quick_check/);
});

test('a planned-ledger file does not excuse a committed migration: R3 after a signal still holds', async () => {
  const g = await gateway();
  assert.equal(migrate(g.db, { commit: 1 }).signal, 'SIGKILL');
  const cut = exitPath(g, { PRE_STOP_SCHEMA: g.found.raw, RECONCILE_PLANNED_SCHEMA: g.planned });
  assert.equal(cut.result, 'HELD', cut.out);
});

test('R1/R2: power cut after the renumber: the boot starts the old payload unverified; the retry applies 81 to 83', async () => {
  const g = await gateway({ record: false });
  const first = boot(g);
  assert.equal(first.started, true, first.log);
  assert.match(first.log, /recorded for schema 81, the database is at schema 84/);
  assert.equal(swap.readPayloadState(g.root).state, 'unverified');
  assert.equal(swap.currentStamp(g.root), 'old');
  retryCompletes(g, [81, 82, 83]);
});

test('R2p: power cut after the pending record: not an interrupted migration; the old payload starts unverified', async () => {
  const g = await gateway();
  const first = boot(g);
  assert.equal(first.started, true, first.log);
  assert.doesNotMatch(first.log, /cut during its migration/);
  assert.equal(swap.readPayloadState(g.root).state, 'unverified');
  retryCompletes(g, [81, 82, 83]);
});

for (const [name, cut, applied, rest] of [
  ['R3, 0081 committed and not stamped', { commit: 1 }, '81', [82, 83]],
  ['R5, 0082 committed and not stamped', { commit: 2 }, '81,82', [83]],
]) {
  test(`${name}: the boot reads it as a cut migration; the retry restamps and finishes instead of refusing on drift`, async () => {
    const g = await gateway();
    const run = migrate(g.db, cut);
    assert.equal(run.signal, 'SIGKILL', run.stdout + run.stderr);
    assert.equal(appliedVersions(g.db).filter((v) => v > BASE).join(','), `${applied},${MOVED}`);
    const first = boot(g);
    assert.equal(first.started, true, first.log);
    assert.match(first.log, /was cut during its migration; running the deploy again completes it/);
    const retry = retryCompletes(g, rest);
    assert.match(retry.stdout + retry.stderr, /drift preflight: .*restamping and proceeding/);
  });
}

test('F0: R3 cut by a signal holds; the deploy run again clears the hold instead of refusing', async () => {
  const g = await gateway();
  assert.equal(migrate(g.db, { commit: 1 }).signal, 'SIGKILL');
  const exit = exitPath(g, { PRE_STOP_SCHEMA: g.renumbered.raw });
  assert.equal(exit.result, 'HELD', exit.out);
  retryCompletes(g, [82, 83]);
});

test('R4: 0081 stamped: the retry applies 82 and 83 without a drift check', async () => {
  const g = await gateway();
  assert.equal(migrate(g.db, { stamp: 1 }).signal, 'SIGKILL');
  const retry = retryCompletes(g, [82, 83]);
  assert.doesNotMatch(retry.stdout + retry.stderr, /drift preflight/);
});

for (const [name, cut] of [['R7, 0083 committed and not stamped', { commit: 3 }], ['R8, 0083 stamped', { stamp: 3 }]]) {
  test(`${name}: the boot switches forward; the next deploy finds nothing pending and verifyHead passes`, async () => {
    const g = await gateway();
    assert.equal(migrate(g.db, cut).signal, 'SIGKILL');
    assert.equal(schema(g.db).ledger, g.to.ledger);
    const first = boot(g);
    assert.equal(first.started, true, first.log);
    assert.match(first.log, /switched forward to payloads\/new/);
    retryCompletes(g, []);
  });
}

test('control, an in-order ledger: 0081 committed and not stamped; the retry applies 82 to 84', async () => {
  fs.mkdirSync(path.join(scratch, 'chain'), { recursive: true });
  const db = path.join(fs.mkdtempSync(path.join(scratch, 'ctrl-')), 'farming.db');
  fs.copyFileSync(await buildReference(MIGRATIONS, BASE, path.join(scratch, 'chain')), db);
  assert.equal(migrate(db, { commit: 1 }).signal, 'SIGKILL');
  const run = migrate(db);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(appliedBy(run), [82, 83, 84]);
});
