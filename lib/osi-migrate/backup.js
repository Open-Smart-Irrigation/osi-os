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
function pruneBackups(dbPath, keep = 5) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-`;
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  for (const f of excess) fs.unlinkSync(path.join(dir, f));
  return excess.length;
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
  pruneBackups(dbPath, keep);
  return backupPath;
}

module.exports = { backupDb, pruneBackups, sqliteDotQuote };
