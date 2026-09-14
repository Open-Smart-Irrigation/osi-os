#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const REQUIRED = ['KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN','MILESIGHT_UC512','DRAGINO_SDI12'];

function sh(db, sql) { execFileSync('sqlite3', ['-bail', db], { input: sql, encoding: 'utf8' }); }
function funcText() { return JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === 'sync-init-fn').func; }

function readDevices(dbPath) {
  const db = new DatabaseSync(dbPath);
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get() || {}).sql || '';
  const count = Number(db.prepare('SELECT COUNT(*) c FROM devices').get().c);
  // The FK-cascade witness: device_data hangs off devices(deveui) ON DELETE CASCADE.
  const telemetry = Number(db.prepare('SELECT COUNT(*) c FROM device_data').get().c);
  db.close();
  return { ddl, count, telemetry };
}

// Facade-compatible shim over node:sqlite (REAL engine). Mirrors the osi-db-helper API the
// sync-init-fn func uses: run/get/all/exec (promise OR node-style callback) + transaction + close.
function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
    // osi-db-helper's run/get/all/exec take (sql, callback) only -- there is no
    // bound-parameter overload on the facade. Without this guard a
    // `run(sql, params)` call would silently resolve here (params ignored,
    // callback never fired) and only fail on the Pi, which is the opposite of
    // what a rehearsal is for.
    if (cb !== undefined && typeof cb !== 'function') {
      throw new TypeError(`osi-db facade ${kind}(sql, cb): second argument must be a callback, got ${typeof cb}`);
    }
    try {
      let r;
      if (kind === 'run' || kind === 'exec') { db.exec(sql); r = undefined; }
      else if (kind === 'get') r = db.prepare(sql).get();
      else r = db.prepare(sql).all();
      if (typeof cb === 'function') { process.nextTick(() => cb(null, r)); return; }
      return Promise.resolve(r);
    } catch (e) {
      if (typeof cb === 'function') { process.nextTick(() => cb(e)); return; }
      return Promise.reject(e);
    }
  };
  const scope = { run: call('run'), all: call('all'), get: call('get'), exec: call('exec') };
  return Object.assign({}, scope, {
    async transaction(executor) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await executor(scope); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
    close(cb) { try { db.close(); } catch (_) {} if (typeof cb === 'function') cb(); },
  });
}

function reseedDevicesCheck(db, types) {
  const ddl = (execFileSync('sqlite3', ['-json', db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'"], { encoding: 'utf8' }).trim());
  const cur = JSON.parse(ddl)[0].sql;
  const list = types.map((t) => `'${t}'`).join(',');
  const nu = cur.replace(/CHECK\s*\(\s*type_id\s+IN\s*\([\s\S]*?\)/i, `CHECK(type_id IN (${list})`);
  sh(db, 'PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;' +
    `ALTER TABLE devices RENAME TO devices_seedtmp; ${nu};` +
    'INSERT INTO devices SELECT * FROM devices_seedtmp; DROP TABLE devices_seedtmp;' +
    'PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
}

// --- devices reshaping for the drift cases ---------------------------------------
// A rehearsal case needs a `devices` table whose COLUMN set differs from the shipped
// one (an older gateway, a newer one, or Uganda's hand-repaired shape). These helpers
// rebuild `devices` from its own live DDL with columns removed, added, or reordered,
// preserving the rows that the remaining columns can hold.
function balancedBody(text, openIdx) {
  let depth = 0, inStr = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) { if (ch === "'") { if (text[i + 1] === "'") i += 1; else inStr = false; } continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  throw new Error('unbalanced parentheses');
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) { cur += ch; if (ch === "'") { if (body[i + 1] === "'") { cur += body[i + 1]; i += 1; } else inStr = false; } continue; }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') { depth += 1; cur += ch; continue; }
    if (ch === ')') { depth -= 1; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const IS_TABLE_CONSTRAINT = (p) => /^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(p);
const COL_NAME = (p) => p.trim().split(/[\s(]/)[0];

function liveDevicesDdl(db) {
  const out = execFileSync('sqlite3', ['-json', db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'"], { encoding: 'utf8' }).trim();
  return JSON.parse(out)[0].sql;
}

// only: exact ordered column-name list to keep (unknown names become TEXT columns)
// drop/add: column names to remove / raw declarations to append
// types: the type_id CHECK list the reshaped table should carry
function reshapeDevices(db, { only = null, drop = [], add = [], types = REQUIRED }) {
  const cur = liveDevicesDdl(db);
  const parts = splitTopLevel(balancedBody(cur, cur.indexOf('('))).map((p) => p.trim().replace(/\s+/g, ' '));
  const byName = new Map(parts.filter((p) => !IS_TABLE_CONSTRAINT(p)).map((p) => [COL_NAME(p), p]));
  const cons = parts.filter(IS_TABLE_CONSTRAINT);
  let cols = (only || [...byName.keys()]).map((n) => byName.get(n) || `${n} TEXT`);
  cols = cols.filter((c) => !drop.includes(COL_NAME(c))).concat(add);
  const list = types.map((t) => `'${t}'`).join(',');
  cols = cols.map((c) => (COL_NAME(c) === 'type_id'
    ? c.replace(/CHECK\s*\(\s*type_id\s+IN\s*\([^)]*\)/i, `CHECK(type_id IN (${list})`) : c));
  const copyable = cols.map(COL_NAME).filter((n) => byName.has(n));
  sh(db, 'PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;'
    + 'ALTER TABLE devices RENAME TO devices_reshapetmp;'
    + `CREATE TABLE devices (${cols.concat(cons).join(', ')});`
    + `INSERT INTO devices (${copyable.join(',')}) SELECT ${copyable.join(',')} FROM devices_reshapetmp;`
    + 'DROP TABLE devices_reshapetmp;'
    + 'PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
}

// A CHECK list that is deliberately short of REQUIRED, so the set-equality guard rebuilds.
const DRIFTED_TYPES = REQUIRED.filter((t) => t !== 'AQUASCOPE_LORAIN' && t !== 'DRAGINO_SDI12');
const SDI12_COLUMNS = ['sdi12_probe_profile', 'sdi12_probe_status', 'sdi12_identity', 'sdi12_value_count', 'sdi12_channel_layout_json'];
const UGANDA_FIXTURE = path.join(__dirname, 'fixtures/uganda-post-repair-devices-columns.json');

// device_data.deveui REFERENCES devices(deveui) ON DELETE CASCADE. That cascade is why the
// rebuild is fenced: if PRAGMA foreign_keys were ever left ON across the rename-swap, the
// DROP/RENAME would take every telemetry row for the device with it. Every case seeds three
// rows per device and the harness reports the surviving count, so a rebuild that silently
// deletes history fails the rehearsal instead of shipping (the Uganda incident class).
const TELEMETRY_PER_DEVICE = 3;

function seed(db, mode) {
  sh(db, fs.readFileSync(SEED, 'utf8'));
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const telemetry = (eui) => Array.from({ length: TELEMETRY_PER_DEVICE }, (_, i) =>
    `INSERT INTO device_data (deveui,recorded_at,swt_wm1) VALUES ('${eui}',${now},${10 + i});`).join('');
  const row = (eui, type) => `INSERT INTO devices (deveui,name,type_id,created_at,updated_at) VALUES ('${eui}','n','${type}',${now},${now});` + telemetry(eui);
  const sdi12Row = (eui) => `INSERT INTO devices (deveui,name,type_id,created_at,updated_at,sdi12_probe_profile,sdi12_probe_status,sdi12_identity,sdi12_value_count,sdi12_channel_layout_json) VALUES ('${eui}','n','KIWI_SENSOR',${now},${now},'SENTINEL_P','manual','SENTINEL_I',5,'{"version":1,"address":"0"}');` + telemetry(eui);
  if (mode === 'healthy') sh(db, row('AAAA000000000001', 'AQUASCOPE_LORAIN') + row('AAAA000000000002', 'KIWI_SENSOR'));
  else if (mode === 'would-drop') {
    reseedDevicesCheck(db, REQUIRED.filter((t) => t !== 'AQUASCOPE_LORAIN').concat(['BOGUS_TYPE']));
    sh(db, row('AAAA000000000003', 'KIWI_SENSOR') + row('AAAA000000000004', 'BOGUS_TYPE'));
  } else if (mode === 'legit-upgrade') {
    reseedDevicesCheck(db, REQUIRED.filter((t) => t !== 'AQUASCOPE_LORAIN'));
    sh(db, row('AAAA000000000005', 'KIWI_SENSOR') + row('AAAA000000000006', 'STREGA_VALVE'));
  } else if (mode === 'extra-type') {
    // All 6 required + an extra drifted type, no offending rows: the set-equality guard must
    // rebuild and CONVERGE the CHECK back to exactly the 6 canonical types (drop the extra).
    reseedDevicesCheck(db, REQUIRED.concat(['BOGUS_TYPE']));
    sh(db, row('AAAA000000000007', 'KIWI_SENSOR') + row('AAAA000000000008', 'STREGA_VALVE'));
  } else if (mode === 'sdi12-sentinels') {
    reseedDevicesCheck(db, REQUIRED.filter((t) => t !== 'DRAGINO_SDI12'));
    sh(db, sdi12Row('AAAA000000000009'));
  } else if (mode === 'missing-source-columns') {
    // A pre-0026 gateway: none of the five sdi12_* columns exist on the source. The old
    // positional copy selected them unconditionally and aborted on every boot (#220).
    sh(db, row('AAAA00000000000A', 'KIWI_SENSOR') + row('AAAA00000000000B', 'STREGA_VALVE'));
    reshapeDevices(db, { drop: SDI12_COLUMNS, types: DRIFTED_TYPES });
  } else if (mode === 'extra-live-column') {
    // An older payload against a newer live schema (#222 ordering): the rebuild must refuse
    // rather than drop a column it does not know about (#219).
    sh(db, row('AAAA00000000000C', 'KIWI_SENSOR') + row('AAAA00000000000D', 'STREGA_VALVE'));
    reshapeDevices(db, { add: ['future_col TEXT'], types: DRIFTED_TYPES });
    sh(db, "UPDATE devices SET future_col = 'KEEPME';");
  } else if (mode === 'null-chameleon') {
    // The seed declares chameleon_enabled nullable; the old boot DDL declared it NOT NULL (#173).
    sh(db, row('AAAA00000000000E', 'KIWI_SENSOR'));
    sh(db, 'UPDATE devices SET chameleon_enabled = NULL;');
    reshapeDevices(db, { types: DRIFTED_TYPES });
  } else if (mode === 'uganda-post-repair-columns') {
    const fixture = JSON.parse(fs.readFileSync(UGANDA_FIXTURE, 'utf8'));
    if (fixture.pending_capture) throw new Error('uganda fixture is a placeholder: ' + fixture.status);
    sh(db, row('AAAA00000000000F', 'KIWI_SENSOR') + row('AAAA000000000010', 'STREGA_VALVE'));
    reshapeDevices(db, { only: fixture.columns, types: DRIFTED_TYPES });
  } else if (mode !== 'existing') throw new Error(`unknown case ${mode}`);
}

async function runFuncAgainst(copyDb, errors) {
  const osiDb = { Database: function () { return makeFacadeShim(copyDb); }, verbose() { return osiDb; } };
  const env = { get: (k) => (k === 'DEVICE_EUI' ? '0016C001F1000001' : '') };
  const node = { error(m) { errors.push(String(m)); }, warn() {}, status() {}, log() {} };
  const fn = new Function('osiDb', 'env', 'node', 'msg', funcText());
  await fn(osiDb, env, node, {});
}

async function main() {
  const [mode, copyDb] = process.argv.slice(2);
  if (mode !== 'existing') seed(copyDb, mode);
  const before = readDevices(copyDb);
  const errors = [];
  await runFuncAgainst(copyDb, errors);
  const after = readDevices(copyDb);
  const verifyDb = new DatabaseSync(copyDb);
  const sentinel = verifyDb.prepare('SELECT sdi12_probe_profile, sdi12_probe_status, sdi12_identity, sdi12_value_count, sdi12_channel_layout_json FROM devices WHERE deveui = ?').get('AAAA000000000009');
  const columns = verifyDb.prepare('PRAGMA table_info(devices)').all().map((row) => row.name);
  const sdi12Columns = new Set(columns);
  const rows = verifyDb.prepare('SELECT * FROM devices ORDER BY id').all();
  verifyDb.close();
  const abortMsg = errors.find((m) => /rebuild ABORTED/.test(m)) || null;
  const result = {
    case: mode, before: before.count, after: after.count,
    columns, rows, rowCount: after.count,
    aborted: Boolean(abortMsg), error: abortMsg,
    // FK-cascade witness: device_data rows must survive both an abort and a real rebuild.
    telemetryBefore: before.telemetry, telemetryAfter: after.telemetry,
    telemetryPreserved: after.telemetry === before.telemetry,
    skipped: before.ddl === after.ddl,
    rowsPreserved: after.count === before.count,
    hasLorain: /'AQUASCOPE_LORAIN'/.test(after.ddl),
    sdi12Preserved: Boolean(sentinel && sentinel.sdi12_probe_profile === 'SENTINEL_P' && sentinel.sdi12_probe_status === 'manual' && sentinel.sdi12_identity === 'SENTINEL_I' && sentinel.sdi12_value_count === 5 && sentinel.sdi12_channel_layout_json === '{"version":1,"address":"0"}'),
    hasSdi12Columns: ['sdi12_probe_profile', 'sdi12_probe_status', 'sdi12_identity', 'sdi12_value_count', 'sdi12_channel_layout_json'].every((column) => sdi12Columns.has(column)),
    // Specifically the rebuild-abort message, not just any node.error (e.g. the outer catch).
    errorSurfaced: errors.some((m) => /rebuild ABORTED/.test(m)),
  };
  if (mode === 'healthy' || mode === 'existing') result.ok = result.skipped && result.rowsPreserved;
  else if (mode === 'would-drop') result.ok = result.rowsPreserved && result.errorSurfaced; // no silent drop, surfaced as ABORTED
  else if (mode === 'legit-upgrade') result.ok = result.rowsPreserved && result.hasLorain;
  else if (mode === 'sdi12-sentinels') result.ok = result.rowsPreserved && result.sdi12Preserved && result.hasSdi12Columns;
  // extra-type: guard must NOT skip (it rebuilt), rows preserved, and the drifted extra type is gone.
  else if (mode === 'extra-type') result.ok = !result.skipped && result.rowsPreserved && !/'BOGUS_TYPE'/.test(after.ddl);
  // #220: a source missing the sdi12_* columns must rebuild and backfill, not abort every boot.
  else if (mode === 'missing-source-columns') result.ok = !result.aborted && result.rowsPreserved && result.hasSdi12Columns;
  // #219: a live column the payload does not know must abort with devices left intact.
  else if (mode === 'extra-live-column') result.ok = result.aborted && result.columns.includes('future_col') && result.rowsPreserved;
  // #173: chameleon_enabled is nullable in the seed; the COALESCE default fills it on rebuild.
  else if (mode === 'null-chameleon') result.ok = !result.aborted && result.rows[0] && result.rows[0].chameleon_enabled === 0;
  else if (mode === 'uganda-post-repair-columns') result.ok = !result.aborted && result.columns.includes('chameleon_enabled') && result.rowsPreserved;
  // Universal: no case, abort or rebuild, may lose a device_data row to the FK cascade.
  result.ok = Boolean(result.ok) && result.telemetryPreserved;
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
// Guarded so lib/osi-migrate/__tests__/helpers/boot-rehearsal.js can reuse
// makeFacadeShim instead of keeping a second copy of it (osi-os#221 review L7).
// The .test.js harness runs this file as a subprocess, where require.main is
// this module, so the CLI behavior is unchanged.
if (require.main === module) {
  main().catch((e) => { console.log(JSON.stringify({ case: process.argv[2], ok: false, error: e.message })); process.exit(1); });
}

module.exports = { makeFacadeShim };
