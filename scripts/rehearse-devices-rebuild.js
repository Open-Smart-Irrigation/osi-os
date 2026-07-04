#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const REQUIRED = ['KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN'];

function sh(db, sql) { execFileSync('sqlite3', ['-bail', db], { input: sql, encoding: 'utf8' }); }
function funcText() { return JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === 'sync-init-fn').func; }

function readDevices(dbPath) {
  const db = new DatabaseSync(dbPath);
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get() || {}).sql || '';
  const count = Number(db.prepare('SELECT COUNT(*) c FROM devices').get().c);
  db.close();
  return { ddl, count };
}

// Facade-compatible shim over node:sqlite (REAL engine). Mirrors the osi-db-helper API the
// sync-init-fn func uses: run/get/all/exec (promise OR node-style callback) + transaction + close.
function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
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

function seed(db, mode) {
  sh(db, fs.readFileSync(SEED, 'utf8'));
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const row = (eui, type) => `INSERT INTO devices (deveui,name,type_id,created_at,updated_at) VALUES ('${eui}','n','${type}',${now},${now});`;
  if (mode === 'healthy') sh(db, row('AAAA000000000001', 'AQUASCOPE_LORAIN') + row('AAAA000000000002', 'KIWI_SENSOR'));
  else if (mode === 'would-drop') {
    reseedDevicesCheck(db, REQUIRED.filter((t) => t !== 'AQUASCOPE_LORAIN').concat(['BOGUS_TYPE']));
    sh(db, row('AAAA000000000003', 'KIWI_SENSOR') + row('AAAA000000000004', 'BOGUS_TYPE'));
  } else if (mode === 'legit-upgrade') {
    reseedDevicesCheck(db, REQUIRED.filter((t) => t !== 'AQUASCOPE_LORAIN'));
    sh(db, row('AAAA000000000005', 'KIWI_SENSOR') + row('AAAA000000000006', 'STREGA_VALVE'));
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
  const result = {
    case: mode, before: before.count, after: after.count,
    skipped: before.ddl === after.ddl,
    rowsPreserved: after.count === before.count,
    hasLorain: /'AQUASCOPE_LORAIN'/.test(after.ddl),
    // Specifically the rebuild-abort message, not just any node.error (e.g. the outer catch).
    errorSurfaced: errors.some((m) => /rebuild ABORTED/.test(m)),
  };
  if (mode === 'healthy' || mode === 'existing') result.ok = result.skipped && result.rowsPreserved;
  else if (mode === 'would-drop') result.ok = result.rowsPreserved && result.errorSurfaced; // no silent drop, surfaced as ABORTED
  else if (mode === 'legit-upgrade') result.ok = result.rowsPreserved && result.hasLorain;
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
main().catch((e) => { console.log(JSON.stringify({ case: process.argv[2], ok: false, error: e.message })); process.exit(1); });
