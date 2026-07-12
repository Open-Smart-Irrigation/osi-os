#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SQLITE_TIMEOUT_MS = 120_000;
const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;
const SQLITE_EXEC_OPTIONS = {
  encoding: 'utf8',
  timeout: SQLITE_TIMEOUT_MS,
  maxBuffer: SQLITE_MAX_BUFFER,
};

function sqliteDotQuote(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error('sqlite .backup path must not contain a newline');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function pruneBackups(dbPath, keep = 5) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-`;
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  let removed = 0;
  for (const f of excess) {
    try {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    } catch (err) {
      console.error(`[backup] failed to prune ${f} (non-fatal): ${err.message || err}`);
    }
  }
  return removed;
}

function backupDb(dbPath, { keep = 5 } = {}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing to back up: source DB does not exist: ${dbPath}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  execFileSync('sqlite3', [dbPath, `.backup ${sqliteDotQuote(backupPath)}`], SQLITE_EXEC_OPTIONS);
  const check = execFileSync('sqlite3', [backupPath, 'PRAGMA integrity_check;'], SQLITE_EXEC_OPTIONS).trim();
  if (check !== 'ok') throw new Error(`backup integrity_check failed: ${check}`);
  try {
    pruneBackups(dbPath, keep);
  } catch (err) {
    console.error(`[backup] pruneBackups failed (non-fatal): ${err.message || err}`);
  }
  return backupPath;
}

function quickCheck(dbPath) {
  try {
    const out = execFileSync('sqlite3', [dbPath, 'PRAGMA quick_check;'], SQLITE_EXEC_OPTIONS).trim();
    return out === 'ok';
  } catch {
    return false;
  }
}

function newestBackupAge(dbPath, now) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-`;
  const backups = fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
  if (backups.length === 0) return Infinity;
  const newest = backups[backups.length - 1];
  const stat = fs.statSync(path.join(dir, newest));
  return now - stat.mtimeMs;
}

function quarantine(dbPath, stamp) {
  const quarantinedTo = `${dbPath}.corrupt-${stamp}`;
  fs.renameSync(dbPath, quarantinedTo);
  for (const ext of ['-wal', '-shm', '-journal']) {
    const sidecar = dbPath + ext;
    if (fs.existsSync(sidecar)) {
      fs.renameSync(sidecar, quarantinedTo + ext);
    }
  }
  return quarantinedTo;
}

function findPassingBackup(dbPath) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-`;
  const backups = fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort().reverse();
  for (const f of backups) {
    const p = path.join(dir, f);
    if (quickCheck(p)) return p;
  }
  return null;
}

function writeStamp(dbPath, data) {
  const stampPath = path.join(path.dirname(dbPath), '.integrity-recovery.json');
  fs.writeFileSync(stampPath, JSON.stringify(data, null, 2) + '\n');
  return stampPath;
}

async function runBootIntegrityCheck(dbPath, opts = {}) {
  const { recentBackupMaxAgeMs = 24 * 3600 * 1000, backupKeep = 5, now = Date.now() } = opts;

  if (!fs.existsSync(dbPath)) {
    return { status: 'ok-missing' };
  }

  if (quickCheck(dbPath)) {
    const age = newestBackupAge(dbPath, now);
    if (age >= recentBackupMaxAgeMs) {
      try { backupDb(dbPath, { keep: backupKeep }); } catch (err) {
        console.error(`[osi-db-integrity] opportunistic backup failed (non-fatal): ${err.message}`);
      }
    }
    return { status: 'ok' };
  }

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const quarantinedTo = quarantine(dbPath, stamp);

  const goodBackup = findPassingBackup(dbPath);
  if (goodBackup) {
    fs.copyFileSync(goodBackup, dbPath);
    const stampPath = writeStamp(dbPath, {
      event: 'recovered',
      restoredFrom: goodBackup,
      quarantinedTo,
      timestamp: new Date(now).toISOString(),
    });
    return { status: 'recovered', restoredFrom: goodBackup, quarantinedTo, stampPath };
  }

  const stampPath = writeStamp(dbPath, {
    event: 'unrecoverable',
    quarantinedTo,
    timestamp: new Date(now).toISOString(),
  });
  return { status: 'unrecoverable', quarantinedTo, stampPath };
}

if (require.main === module) {
  const dbPath = process.argv[2] || '/data/db/farming.db';
  runBootIntegrityCheck(dbPath).then(result => {
    console.error(`[osi-db-integrity] ${result.status}${result.restoredFrom ? ` (restored from ${result.restoredFrom})` : ''}${result.quarantinedTo ? ` (quarantined to ${result.quarantinedTo})` : ''}`);
    process.exit(result.status === 'unrecoverable' ? 1 : 0);
  }).catch(err => {
    console.error(`[osi-db-integrity] FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runBootIntegrityCheck };
