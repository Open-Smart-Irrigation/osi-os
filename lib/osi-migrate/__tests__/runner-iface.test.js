'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../runner-iface');

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-')), 'test.db');
}

test('cliRunner exec creates schema and all() returns rows as objects', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await r.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'),('b');");
  const rows = await r.all('SELECT id, name FROM t ORDER BY id');
  assert.deepEqual(rows, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
});

test('cliRunner all() returns [] for empty result', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await r.exec('CREATE TABLE t (id INTEGER);');
  assert.deepEqual(await r.all('SELECT * FROM t'), []);
});

test('cliRunner exec throws on bad SQL', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await assert.rejects(() => r.exec('CREATE TABLE ;'));
});

test('exec is fail-fast: a mid-script error rolls back the whole transaction (no partial commit)', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await assert.rejects(() =>
    r.exec('BEGIN;\nCREATE TABLE a (x);\nINSERT INTO nonexist VALUES (1);\nCREATE TABLE b (y);\nCOMMIT;'));
  const tables = await r.all("SELECT name FROM sqlite_master WHERE type='table'");
  assert.deepEqual(tables, [], 'neither table created — -bail prevented fall-through to COMMIT');
});
