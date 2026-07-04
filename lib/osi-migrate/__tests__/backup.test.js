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

test('pruneBackups keeps only the newest N .bak- siblings', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { pruneBackups } = require('../backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'));
  const db = path.join(dir, 'farming.db');
  fs.writeFileSync(db, 'x');
  for (const s of ['01', '02', '03', '04', '05', '06', '07', '08']) {
    fs.writeFileSync(`${db}.bak-2026-01-${s}`, 's');
  }
  const removed = pruneBackups(db, 5);
  const left = fs.readdirSync(dir).filter((f) => f.startsWith('farming.db.bak-')).sort();
  assert.strictEqual(removed, 3);
  assert.deepStrictEqual(left, [
    'farming.db.bak-2026-01-04', 'farming.db.bak-2026-01-05',
    'farming.db.bak-2026-01-06', 'farming.db.bak-2026-01-07',
    'farming.db.bak-2026-01-08']);
});

test('backupDb prunes resiliently: one un-removable backup does not block the rest, and never fails the backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-bkprune-'));
  const db = path.join(dir, 'farming.db');
  await cliRunner(db).exec('CREATE TABLE t (x);');
  // Oldest backup is a DIRECTORY (unlinkSync throws EISDIR); plus 5 older files.
  fs.mkdirSync(`${db}.bak-2020-01-01`);
  for (const s of ['02', '03', '04', '05', '06']) fs.writeFileSync(`${db}.bak-2020-01-${s}`, 'x');
  // 6 existing + 1 new = 7, keep=5 → excess = the 2 oldest: [dir 01, file 02].
  const bk = await backupDb(db, { keep: 5 });
  assert.ok(fs.existsSync(bk), 'backup is created and returned despite the un-removable entry');
  // Per-file resilience: the removable stale FILE is pruned even though the dir before it failed.
  assert.equal(fs.existsSync(`${db}.bak-2020-01-02`), false, 'the removable stale backup is pruned');
  assert.ok(fs.existsSync(`${db}.bak-2020-01-01`), 'the un-removable directory is skipped, not fatal');
});
