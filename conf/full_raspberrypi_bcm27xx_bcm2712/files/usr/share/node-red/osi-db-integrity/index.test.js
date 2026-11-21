'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXEC_OPTS = { encoding: 'utf8', timeout: 30_000 };

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dbint-')); }

function makeDb(dir, name = 'farming.db') {
  const dbPath = path.join(dir, name);
  execFileSync('sqlite3', [dbPath, 'CREATE TABLE t (x TEXT); INSERT INTO t VALUES (1);'], EXEC_OPTS);
  return dbPath;
}

function makeWalDb(dir, name = 'farming.db') {
  const dbPath = path.join(dir, name);
  execFileSync('sqlite3', [dbPath, 'PRAGMA journal_mode=WAL; CREATE TABLE t (x TEXT); INSERT INTO t VALUES (1);'], EXEC_OPTS);
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

const { runBootIntegrityCheck } = require('./index');

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

test('a killed DELETE-journal writer rolls back without replacing the latest committed row', async t => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = makeDb(dir);
  makeBackup(dbPath, '2026-01-01T00-00-00-000Z');
  const run = sql => execFileSync('sqlite3', ['-batch', '-bail', dbPath], { ...EXEC_OPTS, input: sql });
  run(`PRAGMA journal_mode=DELETE;
CREATE TABLE spill (data BLOB);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 160)
INSERT INTO spill SELECT randomblob(7500) FROM n;
UPDATE t SET x = 'latest committed';
`);
  assert.throws(() => run(`PRAGMA cache_size=7;
PRAGMA cache_spill=ON;
BEGIN IMMEDIATE;
UPDATE t SET x = 'uncommitted';
UPDATE spill SET data = randomblob(7500);
.shell kill -KILL $PPID
`), error => error.signal === 'SIGKILL');
  assert.ok(fs.statSync(dbPath + '-journal').size > 512, 'dirty pages spilled to a hot journal');
  assert.throws(() => execFileSync('sqlite3', ['-readonly', dbPath, 'PRAGMA quick_check;'],
    { ...EXEC_OPTS, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal((await runBootIntegrityCheck(dbPath)).status, 'ok');
  assert.equal(run('SELECT x FROM t;').trim(), 'latest committed');
  assert.equal(fs.existsSync(dbPath + '.osi-recovery'), false);
  assert.ok(!fs.readdirSync(dir).some(name => name.includes('.corrupt-')));
});

test('an SQLite open or lock failure never selects an older backup', async t => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = makeDb(dir);
  makeBackup(dbPath, '2026-01-01T00-00-00-000Z');
  const original = fs.readFileSync(dbPath);
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  process.env.PATH = dir + ':' + previousPath;
  for (const result of ['database is locked (5)', 'unable to open database file (14)']) {
    fs.writeFileSync(path.join(dir, 'sqlite3'), `#!/bin/sh\nprintf '%s\n' 'Error: ${result}' >&2\nexit 1\n`, { mode: 0o755 });
    await assert.rejects(runBootIntegrityCheck(dbPath), /restoration refused/);
    assert.deepEqual(fs.readFileSync(dbPath), original);
    assert.equal(fs.existsSync(dbPath + '.osi-recovery'), false);
  }
});

test('the live SQLite open cannot create a database that disappeared after the path check', async t => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = makeDb(dir, 'farming?fixture.db');
  const stat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (filename, ...options) => {
    const result = stat(filename, ...options);
    if (filename === dbPath) fs.unlinkSync(dbPath);
    return result;
  });
  await assert.rejects(runBootIntegrityCheck(dbPath), /restoration refused/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(dbPath + '.osi-recovery'), false);
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
  const check = execFileSync('sqlite3', [dbPath, 'PRAGMA quick_check;'], EXEC_OPTS).trim();
  assert.equal(check, 'ok', 'restored DB passes quick_check');
  const stamp_data = JSON.parse(fs.readFileSync(result.stampPath, 'utf8'));
  assert.ok(stamp_data.restoredFrom);
  assert.ok(stamp_data.quarantinedTo);
});

test('an interrupted restore copy cannot publish a partial database', async t => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = makeWalDb(dir);
  const backup = makeBackup(dbPath, '2026-01-01T00-00-00-000Z');
  corrupt(dbPath);
  const original = fs.readFileSync(dbPath);
  t.mock.method(fs, 'copyFileSync', (source, target) => {
    assert.equal(source, backup);
    fs.writeFileSync(target, Buffer.alloc(512));
    throw new Error('injected copy failure');
  });
  await assert.rejects(runBootIntegrityCheck(dbPath), /injected copy failure/);
  assert.deepEqual(fs.readFileSync(dbPath), original);
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(fs.existsSync(backup + suffix), false);
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.integrity-restore-')), false);
  assert.equal((await runBootIntegrityCheck(dbPath)).status, 'held');
});

test('a late recovery hold cannot replace a database that another restore already repaired', async t => {
  const dir = scratch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = makeDb(dir);
  makeBackup(dbPath, '2026-01-01T00-00-00-000Z');
  const repaired = makeDb(dir, 'repaired.db');
  execFileSync('sqlite3', [repaired, "UPDATE t SET x = 'latest committed';"], EXEC_OPTS);
  corrupt(dbPath);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (file === dbPath + '.osi-recovery' && flags === 'wx') fs.copyFileSync(repaired, dbPath);
    return open(file, flags, ...args);
  });
  assert.equal((await runBootIntegrityCheck(dbPath)).status, 'ok');
  assert.equal(fs.existsSync(dbPath + '.osi-recovery'), false);
  assert.ok(!fs.readdirSync(dir).some(name => name.includes('.corrupt-')));
  assert.equal(execFileSync('sqlite3', [dbPath, 'SELECT x FROM t;'], EXEC_OPTS).trim(), 'latest committed');
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
  assert.ok(result.stampPath);
  assert.ok(fs.existsSync(dbPath), 'preserve the original when there is no validated replacement');
  assert.equal((await runBootIntegrityCheck(dbPath)).status, 'held');
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

for (const failure of ['candidate fsync', 'post-quarantine fsync', 'post-publication fsync']) {
  test(`${failure} leaves recovery held on reboot`, async t => {
    const dir = scratch();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = makeDb(dir);
    makeBackup(dbPath, '2026-01-01T00-00-00-000Z');
    corrupt(dbPath);
    const original = fs.readFileSync(dbPath);
    const sync = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', fd => {
      const target = fs.readlinkSync('/proc/self/fd/' + fd);
      const quarantined = fs.readdirSync(dir).some(name => name.startsWith('farming.db.corrupt-'));
      if ((failure === 'candidate fsync' && target.endsWith('/candidate')) ||
          (target === dir && quarantined && fs.existsSync(dbPath) === (failure === 'post-publication fsync'))) {
        throw new Error('injected ' + failure);
      }
      return sync(fd);
    });
    await assert.rejects(runBootIntegrityCheck(dbPath), new RegExp('injected ' + failure));
    assert.equal((await runBootIntegrityCheck(dbPath)).status, 'held');
    if (failure === 'candidate fsync') assert.deepEqual(fs.readFileSync(dbPath), original);
    if (failure === 'post-quarantine fsync') assert.equal(fs.existsSync(dbPath), false);
  });
}

test('the service wrapper propagates the check failure even when logger succeeds', () => {
  const { spawnSync } = require('node:child_process');
  const source = fs.readFileSync(path.join(__dirname, '../../../../etc/init.d/osi-db-integrity'), 'utf8');
  const result = spawnSync('sh', ['-c', source + '\nnode() { return 47; }; logger() { :; }; start']);
  assert.equal(result.status, 47);
});
