#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('../../lib/osi-migrate');
const { emitArtifact, scratchDir } = require('./rig');

function seedMigrationsDir(dir) {
  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, '0002__addcol.sql'), '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n');
  return dir;
}

function integrityOk(dbPath) {
  try { return execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim() === 'ok'; }
  catch (_) { return false; }
}

async function ledgerState(dbPath) {
  try {
    const rows = await cliRunner(dbPath).all('SELECT version, status FROM schema_migrations ORDER BY version');
    return rows.map((r) => `${r.version}:${r.status}`);
  } catch (_) {
    return [];
  }
}

async function recoverAfterKill(dbPath, migrationsDir) {
  const backupOk = integrityOk(dbPath);
  const before = await ledgerState(dbPath);
  let reRunOutcome;
  try {
    await applyPending(cliRunner(dbPath), { migrationsDir, appVersion: 'soak-recover', writersStopped: true });
    reRunOutcome = 'completed';
  } catch (e) {
    if (/repair_required/.test(e.message)) reRunOutcome = 'repair_required';
    else if (/schema drift detected/i.test(e.message)) reRunOutcome = 'drift_halt';
    else reRunOutcome = 'error';
  }
  let restoreVerifyHead = null;
  if (reRunOutcome === 'completed') {
    restoreVerifyHead = (await verifyHead(cliRunner(dbPath), { migrationsDir })).ok;
  }
  return { backupOk, ledgerState: before, reRunOutcome, restoreVerifyHead };
}

function runKillPoint(dbPath, migrationsDir, killDelayMs) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, 'kill9-child.js'), [dbPath, migrationsDir], { silent: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, killDelayMs);
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      const recovery = await recoverAfterKill(dbPath, migrationsDir);
      resolve({ killDelayMs, childSignal: signal || null, childCode: code, ...recovery });
    });
  });
}

async function run({ artifactDir, killDelaysMs = [1, 3, 5, 8, 12, 20, 35, 60, 100] } = {}) {
  const migrationsDir = seedMigrationsDir(scratchDir('kill9-matrix-migr-'));
  const matrix = [];
  for (const delay of killDelaysMs) {
    const db = path.join(scratchDir('kill9-matrix-db-'), 'copy.db');
    fs.writeFileSync(db, '');
    // eslint-disable-next-line no-await-in-loop
    matrix.push(await runKillPoint(db, migrationsDir, delay));
  }
  const OK = ['completed', 'repair_required', 'drift_halt'];
  const outcome = matrix.every((m) => OK.includes(m.reRunOutcome)) ? 'pass' : 'fail';
  const result = {
    inputs: { killDelaysMs },
    invariants: { matrix },
    outcome,
    timingsMs: 0,
    notes: 'Power-loss-mid-migration rehearsal; DB is always a COPY. Gates Option B Stage 2 (4.3). A kill after a DDL commit but before its ledger row surfaces as drift_halt (the runner refuses, does NOT re-run DDL) — a valid outcome. Widen killDelaysMs / re-run until the matrix includes a drift_halt (proof the mid-apply window is exercised). Deterministic recovery subset also in runner-atomicity.test.js.',
  };
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'kill9-migration', result);
  return result;
}

module.exports = { seedMigrationsDir, integrityOk, ledgerState, recoverAfterKill, runKillPoint, run };

if (require.main === module) {
  run({ artifactDir: path.join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[kill9-migration] ERROR: ${e.message}`); process.exit(2); });
}
