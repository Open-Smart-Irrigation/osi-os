'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { SQLITE_EXEC_OPTIONS } = require('./runner-iface');

function sqliteDotQuote(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error('sqlite .backup path must not contain a newline');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ISO stamps sort lexically = chronologically. Keep the newest `keep`.
// `exclude` (optional basename or array of basenames) is rescued out of the
// deletion set regardless of `keep` — belt-and-suspenders for callers that
// must guarantee a specific just-created file survives pruning even under a
// pathological (e.g. zero/negative) keep value. It does NOT change the
// candidate pool used to compute "newest `keep`": in the normal case the
// excluded file is the newest anyway and this is a no-op; it only kicks in
// if `exclude` would otherwise have landed in the excess (oldest) set.
function pruneByPrefix(dir, prefix, keep, exclude) {
  const skip = new Set(Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep)).filter((f) => !skip.has(f));
  let removed = 0;
  // Per-file best-effort: one un-removable sibling must not defeat retention for the rest
  // (a single failing unlink would otherwise abort the loop and let backups grow unbounded).
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

// Unchanged-behavior wrapper over the shared core, for the sqlite3 CLI's own
// `.bak-` snapshots (see backupDb below).
function pruneBackups(dbPath, keep = 5) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-`;
  return pruneByPrefix(dir, prefix, keep);
}

// Online backup via the SQLite CLI `.backup` dot-command (consistent even with an active WAL),
// then open + integrity_check the copy. Runtime adapter (node-sqlite3 `.backup()`) follows the
// same contract in a later phase.
async function backupDb(dbPath, { keep = 5 } = {}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing to back up: source DB does not exist: ${dbPath}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  execFileSync('sqlite3', [dbPath, `.backup ${sqliteDotQuote(backupPath)}`], SQLITE_EXEC_OPTIONS);
  const check = execFileSync('sqlite3', [backupPath, 'PRAGMA integrity_check;'], SQLITE_EXEC_OPTIONS).trim();
  if (check !== 'ok') throw new Error(`backup integrity_check failed: ${check}`);
  // pruneBackups is per-file resilient; this outer guard only catches a directory-level
  // failure (e.g. readdirSync). Cleanup must never fail an already-created + integrity-
  // verified backup — that would wrongly mark the migration failed/repair_required in
  // applyPending despite a good backup existing.
  try {
    pruneBackups(dbPath, keep);
  } catch (err) {
    console.error(`[backup] pruneBackups failed (non-fatal): ${err.message || err}`);
  }
  return backupPath;
}

module.exports = { backupDb, pruneBackups, pruneByPrefix, sqliteDotQuote };
