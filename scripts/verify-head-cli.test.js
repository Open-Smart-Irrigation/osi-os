'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applyPending } = require('../lib/osi-migrate/runner');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-head-cli-')); }

function tinyMigrationsDir(root) {
  const dir = path.join(root, 'm');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  return dir;
}

test('exits 0 and prints ok:true for a fully-migrated, unstamped-drift-free DB', async () => {
  const root = scratch();
  const dir = tinyMigrationsDir(root);
  const db = path.join(root, 't.db');
  await applyPending(cliRunner(db), { migrationsDir: dir, appVersion: 'x' });

  const out = execFileSync('node', [path.join(__dirname, 'verify-head-cli.js'), db, '--migrations-dir', dir], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { ok: true });
});

test('exits 1 and prints ok:false for a DB with pending migrations', async () => {
  const root = scratch();
  const dir = tinyMigrationsDir(root);
  const db = path.join(root, 't.db');
  await applyPending(cliRunner(db), { migrationsDir: dir, appVersion: 'x' });
  fs.writeFileSync(path.join(dir, '0002__c.sql'), '-- risk: additive\nCREATE TABLE t2 (id INTEGER PRIMARY KEY);\n');

  let status = 0;
  let out = '';
  try {
    out = execFileSync('node', [path.join(__dirname, 'verify-head-cli.js'), db, '--migrations-dir', dir], { encoding: 'utf8' });
  } catch (e) {
    status = e.status;
    out = e.stdout;
  }
  assert.equal(status, 1);
  assert.equal(JSON.parse(out).ok, false);
});

test('exits 2 and does not create a file for a missing DB path', () => {
  const root = scratch();
  const missing = path.join(root, 'nope.db');
  let status = 0;
  try {
    execFileSync('node', [path.join(__dirname, 'verify-head-cli.js'), missing], { encoding: 'utf8' });
  } catch (e) { status = e.status; }
  assert.equal(status, 2);
  assert.equal(fs.existsSync(missing), false);
});
