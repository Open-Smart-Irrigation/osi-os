'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function facade(raw) {
  return {
    get: (sql, params) => Promise.resolve(raw.prepare(sql).get(...(params || []))),
    all: (sql, params) => Promise.resolve(raw.prepare(sql).all(...(params || []))),
    run: (sql, params) => { const r = raw.prepare(sql).run(...(params || [])); return Promise.resolve({ changes: Number(r.changes) }); },
    async transaction(executor) {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await executor(facade(raw)); raw.exec('COMMIT'); return out; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw e; }
    },
    close: (cb) => { try { raw.close(); } catch (_) { /* closed */ } if (cb) cb(); },
  };
}

// (F142) tempDb() used to mkdtemp a directory per call and never remove it. These suites
// call it around 155 times, so one full run left that many copies of the bundled
// farming.db (~1.6 MB each) behind in the system temp dir. On this project's workstation
// 3 561 had accumulated, about 5.7 GB, which filled a 12 GB tmpfs and made unrelated
// suites fail with ENOSPC. Cleanup is not opt-in: every directory is tracked here and
// removed on process exit, so a test that forgets (or throws before) cannot leak. The
// returned cleanup() lets a test reclaim its own earlier than that.
const tempDirs = new Set();
let exitHookInstalled = false;

function removeTempDir(dir) {
  tempDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best effort: on the exit path there is nothing left to report to.
  }
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' admits synchronous work only, which is exactly what rmSync is.
  process.on('exit', () => {
    for (const dir of [...tempDirs]) removeTempDir(dir);
  });
}

/** Directories tempDb() is still holding, i.e. what the exit hook would remove. */
function trackedTempDirs() {
  return [...tempDirs];
}

async function tempDb() {
  const src = path.resolve(__dirname, '../../db/farming.db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  tempDirs.add(dir);
  installExitHook();
  const dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(src, dbPath);
  const raw = new DatabaseSync(dbPath);
  const db = facade(raw);
  await db.run("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))");
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000001','Valve A','STREGA_VALVE',1,datetime('now'),datetime('now'))");
  const cleanup = () => {
    try { raw.close(); } catch (_) { /* already closed by the test */ }
    removeTempDir(dir);
  };
  return { db, path: dbPath, raw, dir, cleanup };
}

// Seeds a linked sync_link_state('cloud') row -- the predicate every JS/trigger sync emitter in
// this module gates on. tempDb()'s device/user fixtures deliberately leave this table empty (no
// server_url/server_sync_token on the seeded user), so unlinked is the default and tests that
// need the linked path opt in explicitly with this helper.
async function linkCloud(db, opts) {
  const o = opts || {};
  await db.run(
    "INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at) " +
    "VALUES ('cloud', 1, ?, ?, ?, datetime('now'))",
    [o.serverUrl || 'https://sync.test.invalid', o.cloudUserId || 'cloud-user-1', o.gatewayDeviceEui || '0016C001F11715E2']
  );
}

module.exports = { tempDb, facade, linkCloud, trackedTempDirs };
