'use strict';
const { loadMigrations } = require('./migrations-loader');
const { ensureLedger, getApplied, recordSuccess, recordFailure } = require('./ledger');
const { backupDb } = require('./backup');
const { cliRunner } = require('./runner-iface');
const { computeFingerprints } = require('./fingerprints');

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
  await syncFingerprints(runner);
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

// One connection: FK toggle stays OUTSIDE the transaction (PRAGMA foreign_keys is a no-op inside one).
function composeDestructiveScript(sql) {
  return `PRAGMA foreign_keys=OFF;\nBEGIN IMMEDIATE;\n${sql}\nCOMMIT;\nPRAGMA foreign_keys=ON;`;
}

async function applyDestructive(runner, m, writersStopped) {
  if (!writersStopped) {
    throw new Error(`migration ${m.name} is destructive; refuse to run unless writers are stopped (deploy/pre-start)`);
  }
  const backupPath = await backupDb(runner.dbPath);
  await runner.exec(composeDestructiveScript(m.sql));
  return backupPath;
}

async function bootstrapFresh(runner, opts) {
  return applyPending(runner, { ...opts, writersStopped: true });
}

async function syncFingerprints(runner) {
  const { sqlQuote } = require('./ledger');
  const fps = await computeFingerprints(runner);
  await runner.exec('DELETE FROM schema_object_fingerprints;');
  for (const f of fps) {
    await runner.exec(
      `INSERT INTO schema_object_fingerprints (object_type, object_name, fingerprint)
       VALUES (${sqlQuote(f.object_type)}, ${sqlQuote(f.object_name)}, ${sqlQuote(f.fingerprint)});`);
  }
}

async function verifyHead(runner, { migrationsDir }) {
  const { loadMigrations } = require('./migrations-loader');
  const applied = (await getApplied(runner)).filter((m) => m.status === 'applied').map((m) => m.version);
  const expected = loadMigrations(migrationsDir).map((m) => m.version);
  const head = (xs) => (xs.length ? Math.max(...xs) : 0);
  if (head(applied) !== head(expected)) {
    return { ok: false, reason: `ledger head ${head(applied)} != expected ${head(expected)}` };
  }
  const stored = await runner.all('SELECT object_type, object_name, fingerprint FROM schema_object_fingerprints ORDER BY object_type, object_name');
  const live = (await computeFingerprints(runner)).sort((a, b) =>
    (a.object_type + a.object_name).localeCompare(b.object_type + b.object_name));
  if (JSON.stringify(stored) !== JSON.stringify(live)) {
    return { ok: false, reason: 'fingerprint drift detected (repair_required)' };
  }
  return { ok: true };
}

module.exports = { applyPending, applyDestructive, postflight, bootstrapFresh, verifyHead, syncFingerprints, composeDestructiveScript };
