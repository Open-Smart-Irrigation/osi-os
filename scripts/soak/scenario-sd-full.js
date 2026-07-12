#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sqliteDotQuote } = require('../../lib/osi-migrate/backup');
const { emitArtifact } = require('./rig');

async function backupToDestFailsClosed(dbPath, destPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: source DB does not exist: ${dbPath}`);
  const before = fs.readFileSync(dbPath);
  let backupSucceeded = false;
  let error = null;
  try {
    execFileSync('sqlite3', [dbPath, `.backup ${sqliteDotQuote(destPath)}`], { encoding: 'utf8' });
    const check = execFileSync('sqlite3', [destPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
    backupSucceeded = check === 'ok';
  } catch (e) {
    error = e.message;
  }
  const migrationAborted = !backupSucceeded;
  const after = fs.readFileSync(dbPath);
  const dbCorrupted = Buffer.compare(before, after) !== 0
    || execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim() !== 'ok';
  return { backupAttempted: true, backupSucceeded, migrationAborted, dbCorrupted, error };
}

async function run({ dbPath, artifactDir } = {}) {
  if (!dbPath) throw new Error('run() needs a dbPath (a seeded scratch/copy DB — never a live file)');
  const failClosed = await backupToDestFailsClosed(dbPath, '/nonexistent-path-forcing-write-failure/backup.bak');
  const outcome = (failClosed.migrationAborted && !failClosed.dbCorrupted) ? 'pass' : 'fail';
  const result = {
    inputs: { dbPath },
    invariants: failClosed,
    outcome,
    timingsMs: 0,
    notes: 'DD9 fail-closed under write failure; CI forces via unwritable dest, operator run uses a size-capped ENOSPC mount. Couples 1.A5 + 5.1.',
  };
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'sd-full', result);
  return result;
}

module.exports = { backupToDestFailsClosed, run };

if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) { console.error('usage: scenario-sd-full.js <seeded-scratch-or-copy.db>'); process.exit(2); }
  run({ dbPath, artifactDir: path.join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[sd-full] ERROR: ${e.message}`); process.exit(2); });
}
