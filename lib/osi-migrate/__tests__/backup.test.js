'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { backupDb } = require('../backup');

test('backupDb makes an integrity-passing copy that round-trips data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-bk-'));
  const db = path.join(dir, 'farming.db');
  const r = cliRunner(db);
  await r.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('x');");
  const bk = await backupDb(db);
  assert.ok(fs.existsSync(bk), 'backup file exists');
  const rows = await cliRunner(bk).all('SELECT v FROM t');
  assert.deepEqual(rows, [{ v: 'x' }]);
});

test('backupDb captures data on a WAL-mode DB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-bkwal-'));
  const db = path.join(dir, 'farming.db');
  const r = cliRunner(db);
  await r.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('wal');");
  const bk = await backupDb(db);
  assert.deepEqual(await cliRunner(bk).all('SELECT v FROM t'), [{ v: 'wal' }]);
});

test('backupDb refuses a missing source DB (an empty fresh DB is not a real backup)', async () => {
  await assert.rejects(() => backupDb('/nonexistent/dir/farming.db'), /does not exist/);
});

test('backupDb handles source paths containing single quotes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osimig-bk-quote-'"));
  const db = path.join(dir, "farm'ing.db");
  const r = cliRunner(db);
  await r.exec("CREATE TABLE t (v TEXT); INSERT INTO t (v) VALUES ('quoted');");
  const bk = await backupDb(db);
  assert.deepEqual(await cliRunner(bk).all('SELECT v FROM t'), [{ v: 'quoted' }]);
});
