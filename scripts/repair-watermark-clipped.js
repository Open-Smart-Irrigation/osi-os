#!/usr/bin/env node
'use strict';

// Repair historical clipped WATERMARK estimates created before the ingest path
// promoted a finite clipped bound to canonical SWT. This is an operator tool;
// it is deliberately dry-run by default and is never invoked by deploy.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { backupDb } = require('../lib/osi-migrate/backup');
const { parseSqliteJsonOutput } = require('../lib/osi-migrate/runner-iface');

const SQLITE_OPTIONS = { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 };
const INVALID_FLAGS = 0x1b;
const TEMP_FAILED = 0x04;

function all(dbPath, sql, readOnly = true) {
  const args = readOnly ? ['-readonly', '-json', '-cmd', '.timeout 30000', dbPath, sql] : ['-json', '-cmd', '.timeout 30000', dbPath, sql];
  return parseSqliteJsonOutput(execFileSync('sqlite3', args, SQLITE_OPTIONS));
}

function transact(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', dbPath], { ...SQLITE_OPTIONS, input: '.timeout 30000\n.bail on\n' + sql + '\n' });
  return parseSqliteJsonOutput(output);
}

function candidateWhere(n) {
  return `wr.frame_status = 'accepted'
    AND wr.ch${n}_status = 'wet_offset_clipped'
    AND wr.ch${n}_kpa IS NULL AND dd.swt_${n} IS NULL
    AND UPPER(dd.deveui) = UPPER(wr.deveui) AND dd.recorded_at = wr.recorded_at
    AND wr.ch${n}_flags IS NOT NULL AND (wr.ch${n}_flags & ${INVALID_FLAGS}) = 0
    AND wr.soil_temp_source = 2 AND wr.status_byte IS NOT NULL AND (wr.status_byte & ${TEMP_FAILED}) = 0
    AND typeof(wr.soil_temp_c) IN ('integer','real') AND wr.soil_temp_c BETWEEN 0 AND 50
    AND typeof(wr.ch${n}_kpa_upper_bound) IN ('integer','real')
    AND wr.ch${n}_kpa_upper_bound BETWEEN 0 AND 200`;
}

function candidatesSql(n) {
  return `SELECT wr.id AS wr_id, dd.id AS dd_id, ${n} AS channel, wr.ch${n}_kpa_upper_bound AS kpa,
    dd.deveui AS dd_deveui, dd.recorded_at AS dd_recorded_at, wr.conversion_version
    FROM watermark_readings wr JOIN device_data dd ON dd.id = wr.device_data_id
    WHERE ${candidateWhere(n)}`;
}

function unionCandidates() { return [1, 2].map(candidatesSql).join('\nUNION ALL\n'); }

function linkedSql() {
  return "EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node='cloud' AND linked=1 AND trim(COALESCE(gateway_device_eui,'')) <> '')";
}

function pendingSql(source = `(${unionCandidates()})`) {
  return `EXISTS (SELECT 1 FROM sync_outbox so JOIN ${source} c
    ON so.aggregate_key = c.dd_deveui || '|' || c.dd_recorded_at
    WHERE so.aggregate_type='DEVICE_DATA' AND so.op='DEVICE_DATA_APPENDED'
      AND so.delivered_at IS NULL AND so.rejected_at IS NULL)`;
}

function writeSql() {
  return [1, 2].map((n) => `UPDATE watermark_readings SET ch${n}_kpa = (
    SELECT kpa FROM repair_candidates c WHERE c.wr_id = watermark_readings.id AND c.channel = ${n}
  ) WHERE id IN (SELECT wr_id FROM repair_candidates WHERE channel = ${n});
  UPDATE device_data SET swt_${n} = (
    SELECT kpa FROM repair_candidates c WHERE c.dd_id = device_data.id AND c.channel = ${n}
  ) WHERE id IN (SELECT dd_id FROM repair_candidates WHERE channel = ${n});`).join('\n');
}

function transactionalSql() {
  return `BEGIN IMMEDIATE;
CREATE TEMP TABLE repair_guard(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO repair_guard SELECT CASE WHEN ${linkedSql()} THEN 1 ELSE 0 END;
CREATE TEMP TABLE repair_candidates AS ${unionCandidates()};
INSERT INTO repair_guard SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM repair_candidates GROUP BY dd_id, channel HAVING COUNT(*) > 1) THEN 1 ELSE 0 END;
INSERT INTO repair_guard SELECT CASE WHEN NOT (${pendingSql('repair_candidates')}) THEN 1 ELSE 0 END;
INSERT INTO repair_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_sync_device_data_dirty_au' AND sql LIKE '%sync_history_dirty_keys%') THEN 1 ELSE 0 END;
${writeSql()}
SELECT wr_id, dd_id, channel, kpa, conversion_version FROM repair_candidates ORDER BY wr_id, channel;
COMMIT;`;
}

function versionGroups(rows) {
  return rows.reduce((groups, row) => { const v = row.conversion_version || '(missing)'; groups[v] = (groups[v] || 0) + 1; return groups; }, {});
}

function requiredTriggerPresent(dbPath) {
  return all(dbPath, "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_sync_device_data_dirty_au' AND sql LIKE '%sync_history_dirty_keys%'").length === 1;
}

async function run(dbPath, { apply = false, log = console.log, beforeTransaction = null } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error('refusing: database file does not exist: ' + dbPath);
  const exists = all(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('watermark_readings','device_data','sync_link_state','sync_outbox','sync_history_dirty_keys') ORDER BY name");
  if (exists.length !== 5) throw new Error('refusing: database lacks required WATERMARK/sync tables');
  if (!requiredTriggerPresent(dbPath)) throw new Error('refusing: required device_data dirty-key trigger is absent');
  const rows = all(dbPath, unionCandidates() + ' ORDER BY wr_id');
  const linked = all(dbPath, `SELECT ${linkedSql()} AS linked`)[0].linked === 1;
  const pending = all(dbPath, `SELECT ${pendingSql()} AS pending`)[0].pending === 1;
  log(`[repair-watermark-clipped] ${apply ? 'apply' : 'dry run'}: ${dbPath}`);
  log(`  candidates: ${rows.length}; stored conversion versions: ${JSON.stringify(versionGroups(rows))}; repair policy: wm-lsn50-p3-v3`);
  log(`  linked gateway: ${linked ? 'yes' : 'no'}; pending canonical append event: ${pending ? 'yes' : 'no'}`);
  if (!apply) return { applied: false, planned: rows.length, ids: rows.map((r) => r.wr_id), linked, pending };

  // An online SQLite backup is made and integrity-checked before opening the
  // write transaction. Failure leaves the source untouched.
  const backupPath = await backupDb(dbPath);
  if (!linked) throw new Error('refusing: apply requires a linked gateway');
  if (pending) throw new Error('refusing: unsent DEVICE_DATA_APPENDED event exists for a candidate; wait for delivery');
  if (beforeTransaction) await beforeTransaction();
  let lockedRows;
  try {
    lockedRows = transact(dbPath, transactionalSql());
  } catch (error) {
    const message = String(error.stderr || error.message || error);
    if (/CHECK constraint failed/.test(message)) {
      throw new Error('refusing: locked state changed during apply (linked gateway, pending DEVICE_DATA_APPENDED, ambiguous duplicate candidate, or dirty-key trigger)');
    }
    throw error;
  }
  const ids = lockedRows.map((r) => r.wr_id);
  log(`  filled: ${lockedRows.length}; ids: ${ids.join(',') || '(none)'}; stored conversion versions: ${JSON.stringify(versionGroups(lockedRows))}; verified backup: ${backupPath}`);
  return { applied: true, planned: rows.length, filled: lockedRows.length, ids, versions: versionGroups(lockedRows), backupPath };
}

function parseArgs(argv) {
  let dbPath = null; let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (!arg.startsWith('--') && !dbPath) dbPath = arg;
    else throw new Error('unknown argument: ' + arg);
  }
  if (!dbPath) throw new Error('usage: repair-watermark-clipped.js <farming.db> [--apply]');
  return { dbPath, apply };
}

if (require.main === module) {
  Promise.resolve().then(() => { const a = parseArgs(process.argv.slice(2)); return run(a.dbPath, a); })
    .catch((error) => { console.error('[repair-watermark-clipped] FAILED: ' + error.message); process.exit(1); });
}

module.exports = { run, parseArgs, candidateWhere, candidatesSql, versionGroups };
