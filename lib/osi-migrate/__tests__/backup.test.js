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

test('pruneByPrefix keeps only the newest N .premigrate- siblings, per-file resilient', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { pruneByPrefix } = require('../backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premig-'));
  const db = path.join(dir, 'farming.db');
  fs.writeFileSync(db, 'x');
  const prefix = `${path.basename(db)}.premigrate-`;
  for (const s of ['01', '02', '03', '04', '05', '06', '07', '08']) {
    fs.writeFileSync(path.join(dir, `${prefix}2026-01-${s}`), 's');
  }
  // Oldest is un-removable (a directory); pruning the rest must not stop there.
  fs.rmSync(path.join(dir, `${prefix}2026-01-01`), { force: true });
  fs.mkdirSync(path.join(dir, `${prefix}2026-01-01`));
  const removed = pruneByPrefix(dir, prefix, 3);
  const left = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  // 8 siblings, keep=3 → excess is the 5 oldest; the un-removable dir (01) is
  // skipped non-fatally, the 4 removable files among the excess are pruned.
  assert.strictEqual(removed, 4);
  assert.deepStrictEqual(left, [
    `${prefix}2026-01-01`, `${prefix}2026-01-06`,
    `${prefix}2026-01-07`, `${prefix}2026-01-08`]);
});

test('pruneByPrefix excludes a caller-specified basename regardless of keep', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { pruneByPrefix } = require('../backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premig-excl-'));
  const db = path.join(dir, 'farming.db');
  fs.writeFileSync(db, 'x');
  const prefix = `${path.basename(db)}.premigrate-`;
  // The "just-created" file is deliberately the OLDEST name so it would be the
  // first thing a naive prune would delete under keep=0.
  const justCreated = `${prefix}2020-01-01`;
  fs.writeFileSync(path.join(dir, justCreated), 's');
  for (const s of ['02', '03'] ) fs.writeFileSync(path.join(dir, `${prefix}2020-01-${s}`), 's');
  const removed = pruneByPrefix(dir, prefix, 0, justCreated);
  const left = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  assert.strictEqual(removed, 2);
  assert.deepStrictEqual(left, [justCreated]);
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

// Retention counts backups, not files: SQLite leaves `-wal`, `-shm` and
// `-journal` side files next to a backup that was opened in place. They share
// the backup's prefix but are part of that backup, not backups of their own.
function sideFileScratch(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premig-side-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), 's');
  return dir;
}
const PM = 'farming.db.premigrate-';
const OLD = `${PM}2026-01-05T10-50-05-720Z`;
const MID = `${PM}2026-01-09T22-48-02-472Z`;
const NEW = `${PM}2026-01-17T20-54-56-162Z`;

test('pruneByPrefix: side files of a backup do not take keep slots (3 backups + 2 side files, keep 3)', () => {
  const { pruneByPrefix } = require('../backup');
  const dir = sideFileScratch([OLD, MID, NEW, `${NEW}-shm`, `${NEW}-wal`]);
  const removed = pruneByPrefix(dir, PM, 3, undefined, () => {});
  assert.strictEqual(removed, 0);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [OLD, MID, NEW, `${NEW}-shm`, `${NEW}-wal`].sort());
});

test('pruneByPrefix: a 4th backup removes only the oldest backup, never the newest 3 or their side files', () => {
  const { pruneByPrefix } = require('../backup');
  const NEWEST = `${PM}2026-01-20T08-00-00-000Z`;
  const dir = sideFileScratch([OLD, MID, NEW, `${NEW}-shm`, `${NEW}-wal`, NEWEST]);
  const removed = pruneByPrefix(dir, PM, 3, undefined, () => {});
  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [MID, NEW, `${NEW}-shm`, `${NEW}-wal`, NEWEST].sort());
});

test('pruneByPrefix: a pruned backup goes together with its side files, and each removal is logged', () => {
  const { pruneByPrefix } = require('../backup');
  const dir = sideFileScratch([OLD, `${OLD}-wal`, `${OLD}-shm`, `${OLD}-journal`, MID, NEW]);
  const lines = [];
  const removed = pruneByPrefix(dir, PM, 2, undefined, (l) => lines.push(l));
  assert.strictEqual(removed, 1, 'one backup removed (counted once, not per file)');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [MID, NEW].sort());
  for (const f of [OLD, `${OLD}-wal`, `${OLD}-shm`, `${OLD}-journal`]) {
    assert.ok(lines.some((l) => l.includes(f) && /removed/.test(l)), `removal of ${f} is logged: ${JSON.stringify(lines)}`);
  }
});

test('pruneByPrefix: fewer than keep backups with side files present removes nothing', () => {
  const { pruneByPrefix } = require('../backup');
  const dir = sideFileScratch([MID, `${MID}-wal`, `${MID}-shm`, NEW, `${NEW}-wal`, `${NEW}-shm`]);
  const lines = [];
  const removed = pruneByPrefix(dir, PM, 3, undefined, (l) => lines.push(l));
  assert.strictEqual(removed, 0);
  assert.strictEqual(fs.readdirSync(dir).length, 6);
  assert.deepStrictEqual(lines, []);
});

test('pruneByPrefix: exactly keep backups, each with side files, removes nothing', () => {
  const { pruneByPrefix } = require('../backup');
  const names = [];
  for (const b of [OLD, MID, NEW]) names.push(b, `${b}-wal`, `${b}-shm`);
  const dir = sideFileScratch(names);
  const removed = pruneByPrefix(dir, PM, 3, undefined, () => {});
  assert.strictEqual(removed, 0);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), names.sort());
});

test('pruneByPrefix: a side file whose backup is gone is neither counted nor removed', () => {
  const { pruneByPrefix } = require('../backup');
  const GONE = `${PM}2026-01-01T00-00-00-000Z`;
  const dir = sideFileScratch([`${GONE}-wal`, `${GONE}-shm`, MID, NEW]);
  const removed = pruneByPrefix(dir, PM, 2, undefined, () => {});
  assert.strictEqual(removed, 0);
  assert.strictEqual(fs.readdirSync(dir).length, 4);
});

test('pruneByPrefix: an excluded backup keeps its side files too', () => {
  const { pruneByPrefix } = require('../backup');
  const dir = sideFileScratch([OLD, `${OLD}-wal`, MID, NEW]);
  const removed = pruneByPrefix(dir, PM, 0, OLD, () => {});
  assert.strictEqual(removed, 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [OLD, `${OLD}-wal`].sort());
});

test('pruneByPrefix: a backup file that cannot be removed keeps its side files', () => {
  const { pruneByPrefix } = require('../backup');
  const dir = sideFileScratch([`${OLD}-wal`, MID, NEW]);
  fs.mkdirSync(path.join(dir, OLD)); // unlinkSync throws on a directory
  const removed = pruneByPrefix(dir, PM, 2, undefined, () => {});
  assert.strictEqual(removed, 0);
  assert.ok(fs.existsSync(path.join(dir, `${OLD}-wal`)), 'the side file stays with its un-removable backup');
});
