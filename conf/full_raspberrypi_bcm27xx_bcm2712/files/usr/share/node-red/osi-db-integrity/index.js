#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { OLD_MARKERS, assertRepairHealth, retiredPayloadIdentity } = require('./recovery-hold');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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
  publishAtomic(backupPath, file => {
    execFileSync('sqlite3', [dbPath, `.backup ${sqliteDotQuote(file)}`], SQLITE_EXEC_OPTIONS);
    const check = checkStandalone(file, 'integrity_check');
    if (check !== 'ok') throw new Error(`backup integrity_check failed: ${check}`);
  }, { exclusive: true });
  try {
    pruneBackups(dbPath, keep);
  } catch (err) {
    console.error(`[backup] pruneBackups failed (non-fatal): ${err.message || err}`);
  }
  return backupPath;
}

// A normal, existing-file-only open lets SQLite replay a hot DELETE journal
// before verifying the live database. A busy, inaccessible or unavailable
// database is a failed check with no evidence that justifies restoration.
function liveQuickCheck(dbPath) {
  let result;
  try {
    const liveUri = pathToFileURL(dbPath);
    liveUri.searchParams.set('mode', 'rw');
    result = execFileSync('sqlite3', ['-batch', '-bail', '-cmd', '.timeout 5000',
      liveUri.href, 'PRAGMA quick_check;'], SQLITE_EXEC_OPTIONS).trim();
  } catch (error) {
    if (typeof error.status === 'number' && !error.signal && !error.code) {
      const codes = Array.from(String(error.stderr).matchAll(/^.+ \((\d+)\)\s*$/gm), match => Number(match[1]) & 255);
      if (codes.length && codes.every(code => code === 11 || code === 26)) return false;
    }
    throw new Error('live database check could not complete; restoration refused: ' +
      (String(error.stderr || '').trim() || error.message));
  }
  if (!result) throw new Error('live database returned no quick_check result; restoration refused');
  return result === 'ok' && fs.statSync(dbPath).size >= 100;
}

// A standalone backup has no committed sidecars. An immutable read prevents
// SQLite from creating empty WAL files that would make a retry skip it.
function checkStandalone(file, pragma) {
  const uri = pathToFileURL(file);
  uri.searchParams.set('immutable', '1');
  return execFileSync('sqlite3', ['-batch', '-bail', '-readonly', uri.href,
    `PRAGMA ${pragma};`], SQLITE_EXEC_OPTIONS).trim();
}

function backupQuickCheck(dbPath) {
  try {
    if (!fs.lstatSync(dbPath).isFile() || fs.statSync(dbPath).size < 100) return false;
    if (['-wal', '-shm', '-journal'].some(suffix => fs.lstatSync(dbPath + suffix, { throwIfNoEntry: false }))) return false;
    return checkStandalone(dbPath, 'quick_check') === 'ok';
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
    if (backupQuickCheck(p)) return p;
  }
  return null;
}

// The boot check always derives a new file from a complete source. Keep
// partial copies private so neither startup nor the next check can use one.
function publishAtomic(target, write, { exclusive = false } = {}) {
  const dir = path.dirname(target);
  const staging = fs.mkdtempSync(path.join(dir, '.integrity-stage-'));
  const file = path.join(staging, 'candidate');
  try {
    write(file);
    const fd = fs.openSync(file, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (exclusive) {
      fs.linkSync(file, target);
    } else {
      fs.renameSync(file, target);
    }
    const directory = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function writeStamp(dbPath, data) {
  const stampPath = path.join(path.dirname(dbPath), '.integrity-recovery.json');
  publishAtomic(stampPath, file => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'));
  return stampPath;
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function recordHold(marker) {
  // Existence alone holds the boot, even if a media error prevents the
  // diagnostic text or the marker's fsync from making it to storage.
  const fd = fs.openSync(marker, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, 'Database recovery is in progress or held. Inspect the preserved database and backups before clearing this record.\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(marker));
}

function clearHold(marker, owned) {
  const current = fs.lstatSync(marker);
  if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('database recovery hold changed; preserve it');
  fs.unlinkSync(marker);
  try {
    syncDirectory(path.dirname(marker));
  } catch (error) {
    recordHold(marker);
    throw error;
  }
}

async function runBootIntegrityCheck(dbPath, opts = {}) {
  const { recentBackupMaxAgeMs = 24 * 3600 * 1000, backupKeep = 5, now = Date.now() } = opts;
  const marker = dbPath + '.osi-recovery';

  for (const suffix of ['.osi-recovery', ...OLD_MARKERS]) {
    if (fs.lstatSync(dbPath + suffix, { throwIfNoEntry: false })) return { status: 'held', marker: dbPath + suffix };
  }
  if (!fs.lstatSync(dbPath, { throwIfNoEntry: false })) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.lstatSync(dbPath + suffix, { throwIfNoEntry: false })) return { status: 'held', marker: dbPath + suffix };
    }
  }
  const live = fs.lstatSync(dbPath, { throwIfNoEntry: false });
  if (!live) return { status: 'ok-missing' };
  if (!live.isFile()) throw new Error('live database is not a regular file; restoration refused');

  if (liveQuickCheck(dbPath)) {
    const age = newestBackupAge(dbPath, now);
    if (age >= recentBackupMaxAgeMs) {
      try { backupDb(dbPath, { keep: backupKeep }); } catch (err) {
        console.error(`[osi-db-integrity] opportunistic backup failed (non-fatal): ${err.message}`);
      }
    }
    return { status: 'ok' };
  }

  recordHold(marker);
  const ownedHold = fs.lstatSync(marker);
  // A concurrent recovery can finish between our first check and acquiring
  // the hold. Recheck before replacing anything under the exclusive marker.
  let liveRecovered;
  try {
    liveRecovered = liveQuickCheck(dbPath);
  } catch (error) {
    clearHold(marker, ownedHold);
    throw error;
  }
  if (liveRecovered) {
    clearHold(marker, ownedHold);
    return { status: 'ok' };
  }
  const goodBackup = findPassingBackup(dbPath);
  if (!goodBackup) {
    const stampPath = writeStamp(dbPath, { event: 'unrecoverable', timestamp: new Date(now).toISOString() });
    return { status: 'unrecoverable', marker, stampPath };
  }

  const dir = path.dirname(dbPath);
  const staging = fs.mkdtempSync(path.join(dir, '.integrity-restore-'));
  const candidate = path.join(staging, 'candidate');
  try {
    fs.copyFileSync(goodBackup, candidate, fs.constants.COPYFILE_EXCL);
    const check = checkStandalone(candidate, 'integrity_check');
    if (!fs.statSync(candidate).size || check !== 'ok') throw new Error('staged restore failed integrity_check');
    const fd = fs.openSync(candidate, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    for (const suffix of OLD_MARKERS) {
      if (fs.lstatSync(dbPath + suffix, { throwIfNoEntry: false })) return { status: 'held', marker: dbPath + suffix };
    }
    const currentHold = fs.lstatSync(marker, { throwIfNoEntry: false });
    if (!currentHold?.isFile() || currentHold.dev !== ownedHold.dev || currentHold.ino !== ownedHold.ino) return { status: 'held', marker };
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const quarantinedTo = quarantine(dbPath, stamp);
    syncDirectory(dir);
    fs.linkSync(candidate, dbPath);
    syncDirectory(dir);
    const stampPath = writeStamp(dbPath, {
      event: 'recovered',
      restoredFrom: goodBackup,
      quarantinedTo,
      timestamp: new Date(now).toISOString(),
    });
    clearHold(marker, ownedHold);
    return { status: 'recovered', restoredFrom: goodBackup, quarantinedTo, stampPath };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function checkRepairHealth(dbPath, flowsPath) {
  assertRepairHealth(dbPath, flowsPath);
  const check = execFileSync('sqlite3', ['-init', '/dev/null', '-batch', '-bail', '-readonly', '-cmd', '.timeout 30000', dbPath, 'PRAGMA integrity_check; PRAGMA foreign_key_check;'], SQLITE_EXEC_OPTIONS).trim();
  if (check !== 'ok') throw new Error('repaired database health check failed: ' + check);
}

function recordRepairHealth(dbPath, flowsPath) {
  checkRepairHealth(dbPath, flowsPath);
  const proof = { kind: 'legacy-device-retirement-health', ...retiredPayloadIdentity(flowsPath) };
  publishAtomic(path.join(dbPath + '.osi-recovery', 'retirement-health.json'), file => fs.writeFileSync(file, JSON.stringify(proof) + '\n', { mode: 0o600 }));
}

if (require.main === module && process.argv[2] === '--record-repair-health') {
  try { recordRepairHealth(process.argv[3], process.argv[4]); }
  catch (error) { console.error('HELD: ' + error.message); process.exitCode = 1; }
} else if (require.main === module && process.argv[2] === '--repair-health-check') {
  try { checkRepairHealth(process.argv[3], process.argv[4]); }
  catch (error) { console.error('HELD: ' + error.message); process.exitCode = 1; }
} else if (require.main === module) {
  const dbPath = process.argv[2] || '/data/db/farming.db';
  runBootIntegrityCheck(dbPath).then(result => {
    console.error(`[osi-db-integrity] ${result.status}${result.restoredFrom ? ` (restored from ${result.restoredFrom})` : ''}${result.quarantinedTo ? ` (quarantined to ${result.quarantinedTo})` : ''}`);
    if (result.marker) console.error('[osi-db-integrity] HELD: resolve ' + result.marker + ' before starting Node-RED');
    process.exit(result.marker ? 1 : 0);
  }).catch(err => {
    console.error(`[osi-db-integrity] FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runBootIntegrityCheck, checkRepairHealth, recordRepairHealth };
