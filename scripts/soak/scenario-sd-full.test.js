'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratchDir } = require('./rig');
const { backupToDestFailsClosed } = require('./scenario-sd-full');

function seedDb(dir) {
  const db = path.join(dir, 'farming.db');
  execFileSync('sqlite3', [db], { input: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'row\');' });
  return db;
}

test('backup to an unwritable destination fails closed and does NOT corrupt the source DB', async () => {
  const db = seedDb(scratchDir('sdfull-db-'));
  const before = fs.readFileSync(db);
  const res = await backupToDestFailsClosed(db, '/nonexistent-path-forcing-write-failure/backup.bak');
  assert.equal(res.backupSucceeded, false, 'a failed backup must be reported as failed, never a silent success');
  assert.equal(res.migrationAborted, true, 'DD9: no good backup => the migration must refuse to proceed');
  assert.deepEqual(fs.readFileSync(db), before, 'source DB bytes unchanged after the failed backup');
  const check = execFileSync('sqlite3', [db, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
  assert.equal(check, 'ok');
});

test('a healthy backup to a writable destination succeeds (control: the guard is not always-fail)', async () => {
  const db = seedDb(scratchDir('sdfull-db2-'));
  const dest = path.join(scratchDir('sdfull-dest-'), 'good.bak');
  const res = await backupToDestFailsClosed(db, dest);
  assert.equal(res.backupSucceeded, true);
  assert.equal(res.migrationAborted, false);
});
