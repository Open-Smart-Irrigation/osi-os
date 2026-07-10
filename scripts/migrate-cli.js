#!/usr/bin/env node
'use strict';
// Option B Stage 1 deploy-time runner entrypoint.
// Wraps lib/osi-migrate applyPending with a persistent fsync'd pre-migration
// backup and byte-image restore on failure. deploy.sh owns Node-RED stop/start.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending } = require('../lib/osi-migrate');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { ensureLedger, getApplied } = require('../lib/osi-migrate/ledger');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function fsyncPath(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function offDeviceBackup(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `${path.basename(dbPath)}.premigrate-${stamp}`);
  fs.copyFileSync(dbPath, dest);
  const integrity = execFileSync('sqlite3', [dest, 'PRAGMA integrity_check'], {
    encoding: 'utf8',
  }).trim();
  if (integrity !== 'ok') {
    throw new Error(`off-device backup integrity_check failed: ${integrity}`);
  }
  fsyncPath(dest);
  fsyncPath(backupDir);
  return dest;
}

async function pendingRisksAfterApplied(dbPath, migrationsDir) {
  const runner = cliRunner(dbPath);
  await ensureLedger(runner);
  const appliedOk = new Set(
    (await getApplied(runner)).filter((m) => m.status === 'applied').map((m) => m.version)
  );
  return loadMigrations(migrationsDir)
    .filter((m) => !appliedOk.has(m.version))
    .map((m) => m.risk);
}

function restoreByteImage(dbPath, backupPath) {
  for (const sidecar of ['-wal', '-shm', '-journal']) {
    fs.rmSync(dbPath + sidecar, { force: true });
  }
  fs.copyFileSync(backupPath, dbPath);
  fsyncPath(dbPath);
  const integrity = execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check'], {
    encoding: 'utf8',
  }).trim();
  return integrity === 'ok';
}

async function runMigrateCli({ dbPath, backupDir, migrationsDir = DEFAULT_MIGRATIONS_DIR, log = console.error }) {
  if (!dbPath) {
    throw new Error('usage: migrate-cli.js <db> --backup-dir <dir> [--migrations-dir <dir>]');
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  if (!backupDir) {
    throw new Error('refusing: --backup-dir is required (persistent pre-migration backup)');
  }

  const risks = await pendingRisksAfterApplied(dbPath, migrationsDir);
  const needsBackup = risks.some((r) => r === 'destructive' || r === 'data');
  let offDevice = null;
  if (needsBackup) {
    offDevice = offDeviceBackup(dbPath, backupDir);
    log(`[migrate] persistent pre-migration backup: ${offDevice} (fsync'd, integrity ok)`);
  } else {
    log('[migrate] no destructive/data migration pending; persistent backup not required');
  }

  try {
    const res = await applyPending(cliRunner(dbPath), {
      migrationsDir,
      appVersion: 'stage1-deploy',
      writersStopped: true,
    });
    log(`[migrate] applied: ${JSON.stringify(res.applied)}`);
    return { applied: res.applied, offDeviceBackup: offDevice, restored: false };
  } catch (err) {
    log(`[migrate] FAILED during applyPending: ${err.message}`);
    if (!offDevice) {
      log('[migrate] additive-only failure; runner rolled back, no byte-image restore needed');
      throw err;
    }
    log(`[migrate] restoring pre-migration byte image from ${offDevice}`);
    const ok = restoreByteImage(dbPath, offDevice);
    if (!ok) {
      const e = new Error(`migration failed AND restore integrity_check failed; backup at ${offDevice}`);
      e.code = 3;
      throw e;
    }
    const e = new Error(`migration failed; DB restored from ${offDevice}: ${err.message}`);
    e.code = 1;
    e.restored = true;
    throw e;
  }
}

function parseArgs(argv) {
  const opts = { dbPath: null, backupDir: null, migrationsDir: DEFAULT_MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backup-dir') {
      opts.backupDir = argv[++i];
    } else if (arg === '--migrations-dir') {
      opts.migrationsDir = path.resolve(argv[++i] || '');
    } else if (!opts.dbPath) {
      opts.dbPath = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

if (require.main === module) {
  (async () => {
    try {
      await runMigrateCli(parseArgs(process.argv.slice(2)));
      process.exit(0);
    } catch (err) {
      console.error(`[migrate] ${err.message}`);
      process.exit(Number.isInteger(err.code) ? err.code : 2);
    }
  })();
}

module.exports = { runMigrateCli, parseArgs };
