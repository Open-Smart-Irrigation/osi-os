'use strict';
const fs = require('node:fs');

// Conservative read-only gate. Text in literals/comments is refused too: the
// offline tool must prove the object, never guess that a match is harmless.
// SQLite identifiers include $ and non-ASCII characters; neither is a token
// boundary. The char() range keeps the shell and library predicate identical.
const LEGACY_CATALOG_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','trigger','index','view') AND ((' ' || lower(coalesce(sql,'')) || ' ') GLOB ('*[^a-z0-9_$' || char(128) || '-' || char(1114111) || ']devices_old[^a-z0-9_$' || char(128) || '-' || char(1114111) || ']*') OR lower(tbl_name) = 'devices_old') ORDER BY type, name";
const RECOVERY = 'Run scripts/repair-legacy-device-fk.js <db> --report offline; follow .claude/skills/osi-live-ops-runbook/references/repair.md#legacy-device-foreign-key-repair. This check applied no database repair or migration; SQLite may rebuild the WAL index (-shm).';

async function assertNoLegacyDeviceCatalog(runner) {
  if (runner.dbPath && fs.lstatSync(runner.dbPath + '.legacy-device-fk-repair.lock', { throwIfNoEntry: false })) {
    throw new Error('Incomplete offline legacy device FK repair; keep writers stopped and inspect the retained receipt via .claude/skills/osi-live-ops-runbook/references/repair.md#legacy-device-foreign-key-repair. This check applied no database repair or migration.');
  }
  let matches;
  // Persistent adapters must retain their single connection (the reference
  // chain deliberately spawns no sqlite3 processes). CLI inspection must open
  // read-only so a refusal cannot checkpoint a committed WAL on last close.
  try {
    // CLI runners do not open the file until their first query. An absent
    // file with no recovery evidence is fresh. lstat keeps
    // dangling symlinks and filesystem errors on the fail-closed path. Do not
    // treat a persistent runner as fresh: its handle may hold an in-memory
    // database or catalog changes not visible through another open. Orphan
    // sidecars refuse for every file-backed runner, even one with an open handle.
    if (runner.dbPath && runner.dbPath !== ':memory:' && !fs.lstatSync(runner.dbPath, { throwIfNoEntry: false })) {
      for (const suffix of ['-wal', '-shm', '-journal', '.legacy-device-fk-writer-hold']) {
        if (fs.lstatSync(runner.dbPath + suffix, { throwIfNoEntry: false })) {
          throw new Error('Missing database with retained SQLite sidecar ' + suffix + '; preserve recovery evidence, never create a replacement');
        }
      }
      if (runner.readOnlyAll) return;
    }
    matches = await (runner.readOnlyAll ? runner.readOnlyAll(LEGACY_CATALOG_SQL) : runner.all(LEGACY_CATALOG_SQL));
  }
  catch (cause) { throw new Error('Cannot inspect legacy device catalog: ' + cause.message + '. ' + RECOVERY, { cause }); }
  if (matches.length) {
    const error = new Error('Legacy devices_old catalog references: ' + matches.map(r => `${r.type}:${r.name}`).join(', ') + '. ' + RECOVERY);
    error.code = 'ERR_LEGACY_DEVICE_CATALOG';
    throw error;
  }
}

module.exports = { LEGACY_CATALOG_SQL, RECOVERY, assertNoLegacyDeviceCatalog };
