'use strict';
const fs = require('node:fs');
const { repairHoldRecord } = require('./recovery-hold');

// Conservative read-only gate. Text in literals/comments is refused too: the
// offline tool must prove the object, never guess that a match is harmless.
// SQLite identifiers include $ and non-ASCII characters; neither is a token
// boundary. The char() range keeps the shell and library predicate identical.
const LEGACY_CATALOG_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','trigger','index','view') AND ((' ' || lower(coalesce(sql,'')) || ' ') GLOB ('*[^a-z0-9_$' || char(128) || '-' || char(1114111) || ']devices_old[^a-z0-9_$' || char(128) || '-' || char(1114111) || ']*') OR lower(tbl_name) = 'devices_old') ORDER BY type, name";
const RECOVERY = 'Run scripts/repair-legacy-device-fk.js <db> --report offline; follow .claude/skills/osi-live-ops-runbook/references/repair.md#legacy-device-foreign-key-repair. This check applied no database repair or migration; SQLite may rebuild the WAL index (-shm).';

// Check before opening a create-capable connection. lstat counts dangling
// recovery links as evidence and propagates filesystem errors.
function checkDatabaseRecoveryState(dbPath) {
  if (!dbPath || dbPath === ':memory:') return false;

  for (const suffix of ['.osi-recovery', '.legacy-device-fk-repair.lock', '.legacy-device-fk-writer-hold']) {
    if (fs.lstatSync(dbPath + suffix, { throwIfNoEntry: false })) {
      if (suffix === '.osi-recovery' && fs.lstatSync(dbPath, { throwIfNoEntry: false })) {
        repairHoldRecord(dbPath);
        continue;
      }
      throw new Error('Incomplete offline legacy device FK repair or database recovery (' + suffix + '); keep writers stopped and inspect the retained receipt via .claude/skills/osi-live-ops-runbook/references/repair.md#legacy-device-foreign-key-repair. This check applied no database repair or migration.');
    }
  }

  const main = fs.lstatSync(dbPath, { throwIfNoEntry: false });
  if (main) {
    // A dangling database symlink must never be treated as a fresh path.
    if (main.isSymbolicLink()) fs.statSync(dbPath);
    return false;
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.lstatSync(dbPath + suffix, { throwIfNoEntry: false })) {
      throw new Error('Missing database with retained SQLite sidecar ' + suffix + '; preserve recovery evidence, never create a replacement');
    }
  }
  return true;
}

async function assertNoLegacyDeviceCatalog(runner) {
  let matches;
  // CLI inspection is read-only to avoid checkpointing a committed WAL.
  // Persistent adapters must inspect the catalog on their existing connection.
  try {
    if (checkDatabaseRecoveryState(runner.dbPath) && runner.readOnlyAll) return;
    matches = await (runner.readOnlyAll ? runner.readOnlyAll(LEGACY_CATALOG_SQL) : runner.all(LEGACY_CATALOG_SQL));
  }
  catch (cause) { throw new Error('Cannot inspect legacy device catalog: ' + cause.message + '. ' + RECOVERY, { cause }); }
  if (matches.length) {
    const error = new Error('Legacy devices_old catalog references: ' + matches.map(r => `${r.type}:${r.name}`).join(', ') + '. ' + RECOVERY);
    error.code = 'ERR_LEGACY_DEVICE_CATALOG';
    throw error;
  }
}

module.exports = { LEGACY_CATALOG_SQL, RECOVERY, checkDatabaseRecoveryState, assertNoLegacyDeviceCatalog };
