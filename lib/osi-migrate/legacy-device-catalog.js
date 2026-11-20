'use strict';
const fs = require('node:fs');
const { cliRunner } = require('./runner-iface');

// Conservative read-only gate. Text in literals/comments is refused too: the
// offline tool must prove the object, never guess that a match is harmless.
const LEGACY_CATALOG_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','trigger','index') AND (instr(lower(coalesce(sql,'')), 'devices_old') > 0 OR lower(tbl_name) = 'devices_old') ORDER BY type, name";
const RECOVERY = 'Run scripts/repair-legacy-device-fk.js <db> --report offline; follow .claude/skills/osi-live-ops-runbook/references/repair.md#legacy-device-foreign-key-repair. Nothing was changed.';

async function assertNoLegacyDeviceCatalog(runner) {
  if (runner.dbPath && fs.lstatSync(runner.dbPath + '.legacy-device-fk-repair.lock', { throwIfNoEntry: false })) {
    throw new Error('Incomplete offline legacy device FK repair; inspect its retained receipt. ' + RECOVERY);
  }
  const reader = runner.dbPath && fs.existsSync(runner.dbPath) ? cliRunner(runner.dbPath, { readOnly: true }) : runner;
  let matches;
  try { matches = await reader.all(LEGACY_CATALOG_SQL); }
  catch (cause) { throw new Error('Cannot inspect legacy device catalog: ' + cause.message + '. ' + RECOVERY, { cause }); }
  if (matches.length) {
    const error = new Error('Legacy devices_old catalog references: ' + matches.map(r => `${r.type}:${r.name}`).join(', ') + '. ' + RECOVERY);
    error.code = 'ERR_LEGACY_DEVICE_CATALOG';
    throw error;
  }
}

module.exports = { LEGACY_CATALOG_SQL, RECOVERY, assertNoLegacyDeviceCatalog };
