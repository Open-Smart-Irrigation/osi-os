'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { applyPending, verifyHead } = require('../index');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-vh-'));
  const dir = path.join(root, 'migrations'); fs.mkdirSync(dir);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { db: path.join(root, 't.db'), dir };
}
const THREE = {
  '0001__a.sql': '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n',
  '0002__b.sql': '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\n',
  '0003__c.sql': '-- risk: additive\nCREATE TABLE c (id INTEGER PRIMARY KEY);\n',
};

test('verifyHead detects a missing middle migration even when the head matches', async () => {
  const { db, dir } = fixture(THREE);
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  await r.exec('DELETE FROM schema_migrations WHERE version=2;'); // applied=[1,3], head still 3
  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false);
  assert.match(v.reason, /match|expected|gap/i);
});

test('verifyHead detects a checksum mismatch on an applied version', async () => {
  const { db, dir } = fixture(THREE);
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  await r.exec("UPDATE schema_migrations SET checksum='deadbeef' WHERE version=2;");
  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false);
});

test('verifyHead is ok on a complete, matching ledger', async () => {
  const { db, dir } = fixture(THREE);
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.equal((await verifyHead(r, { migrationsDir: dir })).ok, true);
});
