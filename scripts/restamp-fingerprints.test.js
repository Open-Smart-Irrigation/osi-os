'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applyPending, verifyHead } = require('../lib/osi-migrate/runner');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

test('restamp-fingerprints re-baselines a stale stamp', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  // Introduce a "known-correct" out-of-band change + a stale stamp.
  await r.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY);');
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, false);

  execFileSync('node', [path.join(__dirname, 'restamp-fingerprints.js'), db], { encoding: 'utf8' });

  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true,
    'restamp makes the live schema the new baseline');
});

test('restamp-fingerprints refuses a nonexistent DB path (does not create/stamp an empty file)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-missing-'));
  const missing = path.join(root, 'nope.db');
  let status = 0;
  try {
    execFileSync('node', [path.join(__dirname, 'restamp-fingerprints.js'), missing], { encoding: 'utf8' });
  } catch (e) { status = e.status; }
  assert.strictEqual(status, 2, 'must exit 2 for a missing DB');
  assert.strictEqual(fs.existsSync(missing), false, 'must NOT create the file');
});
