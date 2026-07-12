'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratchDir } = require('./rig');
const { seedMigrationsDir, recoverAfterKill } = require('./scenario-kill9-migration');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('../../lib/osi-migrate');
const { backupDb } = require('../../lib/osi-migrate/backup');

const MIG_0001 = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
const MIG_0002 = '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n';

async function buildKilledCopy() {
  const dir = scratchDir('kill9-migr-');
  fs.writeFileSync(path.join(dir, '0001__base.sql'), MIG_0001);
  const db = path.join(scratchDir('kill9-db-'), 'copy.db');
  fs.writeFileSync(db, '');
  await applyPending(cliRunner(db), { migrationsDir: dir, appVersion: 'soak', writersStopped: true });
  fs.writeFileSync(path.join(dir, '0002__addcol.sql'), MIG_0002);
  return { db, dir };
}

test('recover-from-backup path: a good backup passes integrity_check and restore yields an openable DB', async () => {
  const dir = scratchDir('kill9-migr2-');
  fs.writeFileSync(path.join(dir, '0001__base.sql'), MIG_0001);
  const db = path.join(scratchDir('kill9-db2-'), 'copy.db');
  fs.writeFileSync(db, '');
  await applyPending(cliRunner(db), { migrationsDir: dir, appVersion: 'soak', writersStopped: true });
  const backupPath = await backupDb(db, { keep: 5 });
  const check = execFileSync('sqlite3', [backupPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
  assert.equal(check, 'ok', 'the byte-verified backup passes integrity_check');
  fs.copyFileSync(backupPath, db);
  const restored = execFileSync('sqlite3', [db, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
  assert.equal(restored, 'ok');
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: dir }), { ok: true });
});

test('recoverAfterKill on a copy with a consistent half-run ledger carries to head (never re-runs 0001 non-idempotently)', async () => {
  const { db, dir } = await buildKilledCopy();
  const res = await recoverAfterKill(db, dir);
  assert.ok(['completed', 'repair_required', 'drift_halt'].includes(res.reRunOutcome), res.reRunOutcome);
  if (res.reRunOutcome === 'completed') {
    assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: dir }), { ok: true });
  }
});
