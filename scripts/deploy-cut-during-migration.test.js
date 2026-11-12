'use strict';

// #636, item 3: a deploy cut between its migration's first commit and its
// payload switch. Rows of the kill matrix, each on a real database migrated
// by the real runner (scripts/migrate-cli.js), with node-red.init's own boot
// step (payload_schema_check, then payload_hold_check):
// - (g) a cut after commit k of the ten (71 to 80), k = 1..9: the boot holds,
//   the old payload never starts, and the deploy run again applies the rest
//   and switches;
// - (a) a cut after the last commit: the boot switches forward to the
//   payload the database was migrated for;
// - a cut before the first commit: the old payload fits and starts, the
//   record is removed.
// The cut is a SIGKILL right after a migration's COMMIT returns, before its
// fingerprint stamp (helpers/kill-after-migration-commit.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const swap = require('./deploy-payload-swap');
const { buildReference } = require('./baseline-existing-db');
const { readMigrationManifest } = require('../lib/osi-migrate/migrations-loader');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(REPO, 'database', 'migrations', 'ordered');
const INIT = fs.readFileSync(path.join(REPO, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'), 'utf8');
const LEDGER_SQL = "SELECT COALESCE((SELECT MAX(version) FROM schema_migrations WHERE status='applied'),0) || '|' || COALESCE((SELECT group_concat(version || ':' || checksum, ',') FROM (SELECT version, checksum FROM schema_migrations WHERE status='applied' ORDER BY version)), '')";
const FROM = 70;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-cut-migration-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

function sqlite(db, sql) {
  const run = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function schema(db) {
  const value = sqlite(db, LEDGER_SQL);
  return { head: value.slice(0, value.indexOf('|')), ledger: value.slice(value.indexOf('|') + 1) };
}

function target() {
  const manifest = [...readMigrationManifest(MIGRATIONS)].sort((a, b) => a.version - b.version);
  return { head: String(manifest[manifest.length - 1].version), ledger: manifest.map((m) => `${m.version}:${m.checksum}`).join(',') };
}

// A database at 70, stamped as a gateway's is (ledger rows and fingerprints).
let base70 = null;
async function databaseAt70() {
  if (!base70) {
    fs.mkdirSync(path.join(scratch, 'chain'), { recursive: true });
    const ref = await buildReference(MIGRATIONS, FROM, path.join(scratch, 'chain'));
    base70 = path.join(scratch, 'base70.db');
    fs.copyFileSync(ref, base70);
    const run = spawnSync(process.execPath, [path.join(REPO, 'scripts/baseline-existing-db.js'), base70, '--migrations-dir', MIGRATIONS], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(schema(base70).head, String(FROM));
  }
  return base70;
}

function migrate(db, killAfter = 0) {
  const args = killAfter ? ['-r', path.join(__dirname, 'helpers/kill-after-migration-commit.js')] : [];
  return spawnSync(process.execPath, [...args, path.join(REPO, 'scripts/migrate-cli.js'), db, '--backup-dir', path.join(path.dirname(db), 'backups'), '--migrations-dir', MIGRATIONS], {
    encoding: 'utf8',
    env: { ...process.env, KILL_AFTER_COMMIT: String(killAfter) },
  });
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

// The gateway the deploy was cut on: payloads/old active, recorded for 70 and
// healthy; payloads/new staged, sealed, with the pending switch the deploy
// writes before migrate-cli; the database copied at 70.
async function gateway() {
  const root = fs.mkdtempSync(path.join(scratch, 'gw-'));
  const guiRoot = path.join(root, 'gui');
  fs.mkdirSync(path.join(root, 'payloads'));
  const db = path.join(root, 'farming.db');
  fs.copyFileSync(await databaseAt70(), db);
  const from = schema(db);
  const to = target();
  stage(root, 'old');
  swap.writeCompatibility(root, 'old', from.head, from.ledger);
  swap.flipTo(root, 'old', guiRoot);
  swap.markHealthy(root, 'old');
  swap.writePayloadState(root, 'old', 'healthy', 'fixture');
  stage(root, 'new');
  swap.writePendingSwitch(root, 'new', to.head, to.ledger, from.head, from.ledger);
  fs.copyFileSync(path.join(__dirname, 'deploy-payload-swap.js'), path.join(root, '.payload-swap.js'));
  return { root, guiRoot, db, to };
}

// node-red.init's start, up to the point where Node-RED is launched.
function boot(g) {
  const begin = INIT.indexOf('# payload switch repair begin');
  const end = INIT.indexOf('# payload switch repair end');
  const block = INIT.slice(begin, end).split('/srv/$PACKAGE_NAME').join(g.root).split('/usr/lib/node-red/gui').join(g.guiRoot);
  const bin = path.join(g.root, 'boot-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\nshift 2\necho "$*" >> ${JSON.stringify(path.join(g.root, 'boot.log'))}\n`, { mode: 0o755 });
  const run = spawnSync('sh', ['-c', `${block}\npayload_switch_repair\npayload_schema_check\nif payload_hold_check; then echo NODE_RED_STARTS; else echo NODE_RED_HELD; fi`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, OSI_DB_PATH: g.db },
  });
  assert.equal(run.status, 0, run.stderr);
  return { started: run.stdout.includes('NODE_RED_STARTS'), log: fs.existsSync(path.join(g.root, 'boot.log')) ? fs.readFileSync(path.join(g.root, 'boot.log'), 'utf8') : '' };
}

// What the deploy run again does after its migration: verify the head, record
// the payload's schema, switch, and its pending switch is removed.
function completeDeploy(g, stamp) {
  const verify = spawnSync(process.execPath, [path.join(REPO, 'scripts/verify-head-cli.js'), g.db, '--migrations-dir', MIGRATIONS], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  const now = schema(g.db);
  swap.writeCompatibility(g.root, stamp, now.head, now.ledger);
  swap.markActivated(g.root, stamp);
  swap.flipTo(g.root, stamp, g.guiRoot);
  swap.writePayloadState(g.root, stamp, 'unverified', 'switched in by this deploy; its health check is pending');
  swap.clearPendingSwitch(g.root, stamp);
}

for (let k = 1; k <= 9; k += 1) {
  test(`(g) a cut after commit ${k} of 10: the boot holds, the old code never starts, the deploy run again completes`, async () => {
    const g = await gateway();
    const cut = migrate(g.db, k);
    assert.equal(cut.signal, 'SIGKILL', cut.stdout + cut.stderr);
    assert.equal(schema(g.db).head, String(FROM + k));

    const first = boot(g);
    assert.equal(first.started, false, first.log);
    assert.match(first.log, /interrupted while the database was being updated/);
    const held = fs.readFileSync(path.join(g.root, 'DEPLOY-HELD'), 'utf8');
    assert.match(held, /Run the deploy again/);
    assert.doesNotMatch(held, /[Rr]estore/);
    assert.equal(swap.currentStamp(g.root), 'old');
    assert.equal(boot(g).started, false, 'held again after a reboot');

    // The deploy run again (a new stamp; its record replaces the old one).
    stage(g.root, 'retry');
    const from = schema(g.db);
    swap.writePendingSwitch(g.root, 'retry', g.to.head, g.to.ledger, from.head, from.ledger);
    swap.clearOtherPendingSwitches(g.root, 'retry');
    const retry = migrate(g.db);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    const applied = JSON.parse(/\[migrate\] applied: (\[[^\]]*\])/.exec(retry.stdout + retry.stderr)[1]);
    assert.deepEqual(applied, Array.from({ length: 10 - k }, (_, i) => FROM + k + 1 + i));
    completeDeploy(g, 'retry');
    fs.rmSync(path.join(g.root, 'DEPLOY-HELD'), { force: true });

    const after = boot(g);
    assert.equal(after.started, true, after.log);
    assert.equal(swap.currentStamp(g.root), 'retry');
    assert.deepEqual(swap.readPendingSwitches(g.root), []);
  });
}

test('(a) a cut after the last commit: the boot switches forward to the payload the database was migrated for', async () => {
  const g = await gateway();
  const cut = migrate(g.db, 10);
  assert.equal(cut.signal, 'SIGKILL');
  assert.equal(schema(g.db).ledger, g.to.ledger);
  const first = boot(g);
  assert.equal(first.started, true, first.log);
  assert.match(first.log, /switched forward to payloads\/new/);
  assert.equal(swap.currentStamp(g.root), 'new');
  assert.equal(swap.readHealth(g.root, 'new').state, 'activated', 'its health check is owed');
  assert.equal(swap.readPayloadState(g.root).state, 'unverified');
  assert.equal(swap.verifyCompatibility(g.root, 'new', g.to.head, g.to.ledger), true);
  assert.deepEqual(swap.readPendingSwitches(g.root), []);
  // The next deploy finds the head: nothing to apply, the drift check passes.
  const next = migrate(g.db);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.equal(boot(g).started, true);
});

test('a cut before the first commit: the old payload fits and starts; the record is removed', async () => {
  const g = await gateway();
  const first = boot(g);
  assert.equal(first.started, true, first.log);
  assert.equal(swap.currentStamp(g.root), 'old');
  assert.deepEqual(swap.readPendingSwitches(g.root), []);
});
