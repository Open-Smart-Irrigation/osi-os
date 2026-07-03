'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPending, verifyHead } = require('../runner');
const { cliRunner } = require('../runner-iface');

function tmpMigrations() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const dir = path.join(root, 'm');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'),
    '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  return { db: path.join(root, 't.db'), dir };
}

test('a no-op applyPending refuses to launder out-of-band drift', async () => {
  const { db, dir } = tmpMigrations();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  await r.exec('ALTER TABLE t ADD COLUMN sneaky INTEGER;'); // out-of-band change

  const v1 = await verifyHead(r, { migrationsDir: dir });
  assert.strictEqual(v1.ok, false, 'drift must be detected');

  await assert.rejects(
    applyPending(r, { migrationsDir: dir, appVersion: 'x' }),
    /drift/i,
    'applyPending must fail closed on drift, not launder it');

  const v2 = await verifyHead(r, { migrationsDir: dir });
  assert.strictEqual(v2.ok, false, 'drift still visible after the refusal');
});

test('a no-op applyPending re-stamps when fingerprints are missing (crash self-heal)', async () => {
  const { db, dir } = tmpMigrations();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  // Simulate "migration committed but stamp never written" (crash between the two txns).
  await r.exec('DELETE FROM schema_object_fingerprints;');
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, false);

  await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // must re-stamp, not throw
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true,
    'empty-stamp state must self-heal on the next run');
});
