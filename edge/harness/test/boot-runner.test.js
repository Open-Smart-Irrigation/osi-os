'use strict';
// edge/boot: the standalone sync-init-fn runner. Fresh seed only; aged
// databases go through `node edge/boot/parity.js` with their paths as
// arguments. Needs Node >= 22.5 for node:sqlite (db-compare.js); the runner
// and the oracle run on the release-smoke Node (skipped when it is absent).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const BOOT = path.join(ROOT, 'edge/boot');
const SQLITE_NODE = path.join(ROOT, 'scripts/fixtures/release-smoke/node_modules/node-red-node-sqlite');
const { build } = require(path.join(BOOT, 'gen-sync-init.js'));
const { snapshot, diff } = require(path.join(BOOT, 'db-compare.js'));
const parity = require(path.join(BOOT, 'parity.js'));

let pinned = null;
try { pinned = parity.pinnedNode(); } catch { /* skipped below */ }
const haveRuntime = pinned && fs.existsSync(path.join(SQLITE_NODE, 'sqlite.js'));
const skip = haveRuntime ? false : 'needs the release-smoke Node and `npm ci --prefix scripts/fixtures/release-smoke`';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.cwd(), 'boot-runner-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runner(dir, env, script = path.join(BOOT, 'run-sync-init.js')) {
  const r = spawnSync(pinned || process.execPath, [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TZ: 'UTC', DEVICE_EUI: '0016C001F1000001', OSI_BOOT_NODE_RED_DIR: path.join(dir, 'userdir'), OSI_BOOT_SQLITE_NODE_DIR: SQLITE_NODE, ...env },
  });
  return { status: r.status, log: r.stdout + r.stderr };
}

function freshSeed(dir) {
  const db = path.join(dir, 'seed.db');
  const r = spawnSync(pinned, ['scripts/build-seed-db.js', '--out', db], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return db;
}

test('the generated body matches flows.json, both profiles and the pin', () => {
  const r = spawnSync(process.execPath, [path.join(BOOT, 'gen-sync-init.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a different pin fails the build', (t) => {
  const dir = tempDir(t);
  const pin = path.join(dir, 'sync-init.pin');
  fs.writeFileSync(pin, 'sync-init-fn sha256 ' + '0'.repeat(64) + '\n');
  const { problems } = build(ROOT, pin);
  assert.ok(problems.some((p) => /differs from sync-init\.pin/.test(p)), problems.join('\n'));
});

test('a changed body fails the runner before it opens anything', { skip }, (t) => {
  const dir = tempDir(t);
  const copy = path.join(dir, 'boot');
  fs.mkdirSync(copy);
  for (const f of ['run-sync-init.js', 'gen-sync-init.js', 'sync-init.pin']) fs.copyFileSync(path.join(BOOT, f), path.join(copy, f));
  const generated = JSON.parse(fs.readFileSync(path.join(BOOT, 'sync-init-fn.generated.json'), 'utf8'));
  generated.func = generated.func.replace('CREATE TABLE IF NOT EXISTS sync_inbox', 'CREATE TABLE IF NOT EXISTS sync_inbox_x');
  fs.writeFileSync(path.join(copy, 'sync-init-fn.generated.json'), JSON.stringify(generated));
  parity.makeUserDir(path.join(dir, 'userdir'));
  const db = path.join(dir, 'never-opened.db');
  fs.writeFileSync(db, 'x');
  const r = runner(dir, { OSI_BOOT_DB: db }, path.join(copy, 'run-sync-init.js'));
  assert.equal(r.status, 2, r.log);
  assert.match(r.log, /pinned body mismatch/);
  assert.equal(fs.readFileSync(db, 'utf8'), 'x');
});

test('a missing or relative database path is refused, and nothing is created', { skip }, (t) => {
  const dir = tempDir(t);
  parity.makeUserDir(path.join(dir, 'userdir'));
  const missing = path.join(dir, 'missing.db');
  const a = runner(dir, { OSI_BOOT_DB: missing });
  assert.equal(a.status, 2, a.log);
  assert.equal(fs.existsSync(missing), false);
  const b = runner(dir, { OSI_BOOT_DB: 'farming.db' });
  assert.equal(b.status, 2, b.log);
  const c = runner(dir, {});
  assert.equal(c.status, 2, c.log);
});

test('a fresh seed: exit 0, complete, and a second run changes nothing', { skip }, (t) => {
  const dir = tempDir(t);
  parity.makeUserDir(path.join(dir, 'userdir'));
  const db = path.join(dir, 'farming.db');
  fs.copyFileSync(freshSeed(dir), db);
  const first = runner(dir, { OSI_BOOT_DB: db, OSI_BOOT_REPORT: path.join(dir, 'r1.json') });
  assert.equal(first.status, 0, first.log);
  assert.match(first.log, /sync-init: schema init complete/);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'r1.json'), 'utf8'));
  assert.equal(report.sqlite_addons.length, 1);
  assert.deepEqual(Object.keys(report.failed_by_class).filter((k) => !['duplicate_column', 'no_such_table'].includes(k)), []);
  const after1 = snapshot(db);
  assert.equal(after1.pragmas.journal_mode, 'wal');
  const second = runner(dir, { OSI_BOOT_DB: db });
  assert.equal(second.status, 0, second.log);
  assert.deepEqual(diff(after1, snapshot(db)), []);
});

test('a fresh seed: the runner leaves the database the Node-RED oracle leaves', { skip }, async (t) => {
  const dir = tempDir(t);
  const userDir = parity.makeUserDir(path.join(dir, 'userdir'));
  const r = await parity.paritySource('fresh-seed', freshSeed(dir), dir, { node: pinned, userDir, oracleRuns: 1 });
  assert.equal(r.runner.exit, 0);
  assert.equal(r.residual, 0, JSON.stringify(r.residual_detail, null, 1));
  assert.equal(r.pass, true);
  assert.deepEqual(r.oracle_engine.map((e) => e.sqlite), [r.runner.sqlite]);
});
