'use strict';
const { loadMigrations } = require('./migrations-loader');
const { ensureLedger, getApplied, recordSuccess, recordFailure } = require('./ledger');
const { backupDb } = require('./backup');
const { cliRunner } = require('./runner-iface');

async function applyPending(runner, { migrationsDir, appVersion, writersStopped = false }) {
  await ensureLedger(runner);
  const applied = await getApplied(runner);
  const appliedOk = new Map(applied.filter((m) => m.status === 'applied').map((m) => [m.version, m]));
  const migrations = loadMigrations(migrationsDir);

  for (const m of migrations) {
    const prior = appliedOk.get(m.version);
    if (prior) {
      if (prior.checksum !== m.checksum) {
        throw new Error(`repair_required: checksum mismatch for applied migration ${m.name}`);
      }
      continue; // already applied, unchanged
    }
    let backupPath = '';
    try {
      if (m.risk === 'destructive') {
        backupPath = await applyDestructive(runner, m, writersStopped);
      } else {
        await runner.exec(`BEGIN IMMEDIATE;\n${m.sql}\nCOMMIT;`);
      }
      await postflight(runner, m);
      await recordSuccess(runner, { version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath });
    } catch (err) {
      // Clean connection: the failed migration's transaction has rolled back at process exit.
      await recordFailure(cliRunner(runner.dbPath), {
        version: m.version, name: m.name, checksum: m.checksum, appVersion, error: String(err.message || err),
      });
      throw err;
    }
  }
  const before = new Set(applied.map((m) => m.version));
  return { applied: migrations.filter((m) => !before.has(m.version)).map((m) => m.version) };
}

async function postflight(runner, m) {
  const integ = (await runner.all('PRAGMA integrity_check'))[0];
  const okVal = integ.integrity_check || Object.values(integ)[0];
  if (okVal !== 'ok') throw new Error(`postflight integrity_check failed after ${m.name}: ${okVal}`);
  const fk = await runner.all('PRAGMA foreign_key_check');
  if (fk.length) throw new Error(`postflight foreign_key_check failed after ${m.name}`);
}

// Destructive recipe filled in Task 7.
async function applyDestructive(runner, m, writersStopped) {
  throw new Error('destructive migrations not yet supported (Task 7)');
}

module.exports = { applyPending, applyDestructive, postflight };
