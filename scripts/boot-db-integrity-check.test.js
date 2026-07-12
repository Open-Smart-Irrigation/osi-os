'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SQLITE_EXEC_OPTIONS } = require('../lib/osi-migrate/runner-iface');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dbint-')); }

function makeDb(dir, name = 'farming.db') {
  const dbPath = path.join(dir, name);
  execFileSync('sqlite3', [dbPath, 'CREATE TABLE t (x TEXT); INSERT INTO t VALUES (1);'], SQLITE_EXEC_OPTIONS);
  return dbPath;
}

function makeWalDb(dir, name = 'farming.db') {
  const dbPath = path.join(dir, name);
  execFileSync('sqlite3', [dbPath, 'PRAGMA journal_mode=WAL; CREATE TABLE t (x TEXT); INSERT INTO t VALUES (1);'], SQLITE_EXEC_OPTIONS);
  return dbPath;
}

function corrupt(dbPath) {
  const buf = fs.readFileSync(dbPath);
  buf.fill(0xFF, 100, Math.min(200, buf.length));
  fs.writeFileSync(dbPath, buf);
}

function makeBackup(dbPath, stamp) {
  const backupPath = `${dbPath}.bak-${stamp}`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function makeCorruptBackup(dbPath, stamp) {
  const backupPath = `${dbPath}.bak-${stamp}`;
  fs.writeFileSync(backupPath, Buffer.alloc(512, 0xFF));
  return backupPath;
}

const { runBootIntegrityCheck } = require('./boot-db-integrity-check');

test('healthy DB: status ok, opportunistic backup taken', async () => {
  const dir = scratch();
  const dbPath = makeDb(dir);
  const result = await runBootIntegrityCheck(dbPath, { recentBackupMaxAgeMs: 0, now: Date.now() });
  assert.equal(result.status, 'ok');
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('farming.db.bak-'));
  assert.ok(backups.length >= 1, 'opportunistic backup should be created');
});

test('healthy DB: backup skipped when recent backup exists', async () => {
  const dir = scratch();
  const dbPath = makeDb(dir);
  const now = Date.now();
  makeBackup(dbPath, new Date(now - 1000).toISOString().replace(/[:.]/g, '-'));
  const backupsBefore = fs.readdirSync(dir).filter(f => f.startsWith('farming.db.bak-'));
  const result = await runBootIntegrityCheck(dbPath, { recentBackupMaxAgeMs: 24 * 3600 * 1000, now });
  assert.equal(result.status, 'ok');
  const backupsAfter = fs.readdirSync(dir).filter(f => f.startsWith('farming.db.bak-'));
  assert.equal(backupsAfter.length, backupsBefore.length, 'no new backup when recent exists');
});

test('corrupt DB + passing backup: recovered', async () => {
  const dir = scratch();
  const dbPath = makeDb(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  makeBackup(dbPath, stamp);
  corrupt(dbPath);
  const result = await runBootIntegrityCheck(dbPath, { now: Date.now() });
  assert.equal(result.status, 'recovered');
  assert.ok(result.restoredFrom);
  assert.ok(result.quarantinedTo);
  assert.ok(result.stampPath);
  assert.ok(fs.existsSync(result.quarantinedTo), 'corrupt file quarantined, not deleted');
  const check = execFileSync('sqlite3', [dbPath, 'PRAGMA quick_check;'], SQLITE_EXEC_OPTIONS).trim();
  assert.equal(check, 'ok', 'restored DB passes quick_check');
  const stamp_data = JSON.parse(fs.readFileSync(result.stampPath, 'utf8'));
  assert.ok(stamp_data.restoredFrom);
  assert.ok(stamp_data.quarantinedTo);
});

test('corrupt DB + newest backup also corrupt, older one passes: restores older', async () => {
  const dir = scratch();
  const dbPath = makeDb(dir);
  const goodStamp = '2026-01-01T00-00-00-000Z';
  makeBackup(dbPath, goodStamp);
  const badStamp = '2026-07-01T00-00-00-000Z';
  makeCorruptBackup(dbPath, badStamp);
  corrupt(dbPath);
  const result = await runBootIntegrityCheck(dbPath, { now: Date.now() });
  assert.equal(result.status, 'recovered');
  assert.ok(result.restoredFrom.includes(goodStamp), `should restore from older good backup, got: ${result.restoredFrom}`);
});

test('corrupt DB + no passing backup: unrecoverable', async () => {
  const dir = scratch();
  const dbPath = makeDb(dir);
  corrupt(dbPath);
  const result = await runBootIntegrityCheck(dbPath, { now: Date.now() });
  assert.equal(result.status, 'unrecoverable');
  assert.ok(result.quarantinedTo);
  assert.ok(result.stampPath);
  assert.ok(!fs.existsSync(dbPath), 'DB absent after unrecoverable (no fabrication)');
  assert.ok(fs.existsSync(result.quarantinedTo), 'corrupt file quarantined');
});

test('missing DB: ok-missing, no side effects', async () => {
  const dir = scratch();
  const dbPath = path.join(dir, 'farming.db');
  const result = await runBootIntegrityCheck(dbPath, { now: Date.now() });
  assert.equal(result.status, 'ok-missing');
  assert.ok(!fs.existsSync(dbPath), 'no DB fabricated');
});

test('corrupt WAL DB: sidecars quarantined alongside main file', async () => {
  const dir = scratch();
  const dbPath = makeWalDb(dir);
  const walPath = dbPath + '-wal';
  const shmPath = dbPath + '-shm';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  makeBackup(dbPath, stamp);
  corrupt(dbPath);
  if (!fs.existsSync(walPath)) fs.writeFileSync(walPath, 'wal');
  if (!fs.existsSync(shmPath)) fs.writeFileSync(shmPath, 'shm');
  const result = await runBootIntegrityCheck(dbPath, { now: Date.now() });
  assert.equal(result.status, 'recovered');
  const quarantined = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'));
  assert.ok(quarantined.length >= 1, 'corrupt files moved');
  assert.ok(!fs.existsSync(walPath), 'WAL moved');
  assert.ok(!fs.existsSync(shmPath), 'SHM moved');
});
