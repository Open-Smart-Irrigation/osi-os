'use strict';
const { loadMigrations } = require('./migrations-loader');
const { ensureLedger, getApplied, recordFailure, markRepairRequired, successInsertSql } = require('./ledger');
const { backupDb } = require('./backup');
const { cliRunner } = require('./runner-iface');
const { computeFingerprints, PREVIOUS_NORMALIZER_VERSION } = require('./fingerprints');

// osi-os#153 compatibility: schema_object_fingerprints stamped by the
// pre-fix (fingerprints.js NORMALIZER_VERSION 2) runner will look "drifted"
// on the very first post-fix verify/apply purely because the hash scheme
// changed — the scheme tag is baked into every fingerprint hash, so a stored
// v2 hash can never equal a freshly computed v3 hash even when nothing about
// the live schema changed. Detect that specific, provably-safe case: if the
// live schema, re-hashed under the OLD v2 rules, still matches what is
// stored, the ONLY difference is the normalizer version, and it is safe to
// self-heal by re-stamping under the current scheme instead of refusing.
//
// If the old-scheme comparison ALSO fails, this is not a pure scheme bump —
// e.g. a gateway whose boot node had already rewritten a gateway-EUI trigger
// literal with its own DEVICE_EUI before this fix shipped (the actual
// osi-os#153 false-positive that ate every migrate+restart cycle). We cannot
// prove that case safe from the runner alone, so it is left to the existing
// refusal + the sanctioned, deliberate `restamp-fingerprints.js` recovery
// (see docs: osi-schema-change-control skill, "Restamp rules") rather than
// silently blessing it here.
async function isPureNormalizerSchemeUpgrade(runner, storedFps) {
  const liveUnderOldScheme = sortFps(
    await computeFingerprints(runner, { normalizerVersion: PREVIOUS_NORMALIZER_VERSION }));
  return JSON.stringify(storedFps) === JSON.stringify(liveUnderOldScheme);
}

async function applyPending(runner, { migrationsDir, appVersion, writersStopped = false }) {
  await ensureLedger(runner);
  const applied = await getApplied(runner);

  const broken = applied.find((m) => m.status === 'repair_required');
  if (broken) {
    throw new Error(`repair_required: migration ${broken.name} (v${broken.version}) needs manual repair before further migrations run`);
  }

  // Preflight: refuse to apply onto a schema that drifted out-of-band since the last
  // stamp. Applying + re-stamping would silently bless the drift (runner-drift-preflight).
  const storedFps = await readStoredFingerprints(runner);
  if (storedFps.length > 0) {
    const liveFps = sortFps(await computeFingerprints(runner));
    if (JSON.stringify(storedFps) !== JSON.stringify(liveFps)) {
      if (await isPureNormalizerSchemeUpgrade(runner, storedFps)) {
        // Not real drift: only the fingerprint scheme advanced (osi-os#153). Re-stamp and proceed.
        await syncFingerprints(runner);
      } else {
        throw new Error('schema drift detected before applying migrations: live schema does not match the last-stamped fingerprints. Refuse to proceed. If the live schema is known-correct, re-baseline with `node scripts/restamp-fingerprints.js <db>`; otherwise this is an out-of-band change needing manual repair.');
      }
    }
  }

  const appliedOk = new Map(applied.filter((m) => m.status === 'applied').map((m) => [m.version, m]));
  const migrations = loadMigrations(migrationsDir);
  const appliedNow = [];

  for (const m of migrations) {
    const prior = appliedOk.get(m.version);
    if (prior) {
      if (prior.checksum !== m.checksum) {
        await markRepairRequired(runner, {
          version: m.version,
          error: `checksum mismatch for applied migration ${m.name}`,
        });
        throw new Error(`repair_required: checksum mismatch for applied migration ${m.name}`);
      }
      continue; // already applied, unchanged
    }
    let backupPath = '';
    let committed = false;
    try {
      const ledgerInsert = successInsertSql({ version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath: '' });
      if (m.risk === 'destructive') {
        if (!writersStopped) {
          throw new Error(`migration ${m.name} is destructive; refuse to run unless writers are stopped (deploy/pre-start)`);
        }
        backupPath = await backupDb(runner.dbPath);
        const insertWithBackup = successInsertSql({ version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath });
        await runner.exec(composeDestructiveScript(m.sql, insertWithBackup));
      } else if (m.risk === 'data') {
        // Backfill: take a backup, apply in a normal transaction (no FK toggle,
        // no writers-stopped gate). Write data migrations idempotently vs the old format.
        backupPath = await backupDb(runner.dbPath);
        const insertWithBackup = successInsertSql({ version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath });
        await runner.exec(`BEGIN IMMEDIATE;\n${m.sql}\n${insertWithBackup}\nCOMMIT;`);
      } else {
        await runner.exec(`BEGIN IMMEDIATE;\n${m.sql}\n${ledgerInsert}\nCOMMIT;`);
      }
      committed = true; // schema change AND its 'applied' ledger row are now committed together
      await postflight(runner, m);
      appliedNow.push(m.version);
    } catch (err) {
      // Clean connection: the failed migration's transaction has rolled back at process exit.
      const rec = cliRunner(runner.dbPath);
      if (committed) {
        // Schema persisted; postflight failed. Terminal: do not let the next run re-execute DDL.
        await markRepairRequired(rec, { version: m.version, error: String(err.message || err) });
      } else {
        await recordFailure(rec, {
          version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath,
          error: String(err.message || err),
        });
      }
      throw err;
    }
    // Stamp THIS migration's committed schema before attempting the next one, so a
    // later migration's failure leaves fingerprints matching the live schema (the
    // retry's drift preflight then passes). OUTSIDE the try/catch: a stamp failure
    // must not mark a successful migration repair_required — it lands in the same
    // accepted window as "commit then crash before stamp" (recover via restamp-fingerprints.js).
    await syncFingerprints(runner);
  }
  // Self-heal only: applied migrations exist but nothing is stamped and nothing ran
  // now (fresh DB that crashed between first commit and stamp — no baseline to launder).
  // Successful migrations are already stamped per-migration inside the loop above.
  if (appliedNow.length === 0 && storedFps.length === 0) await syncFingerprints(runner);
  return { applied: appliedNow };
}

async function postflight(runner, m) {
  const integ = (await runner.all('PRAGMA integrity_check'))[0];
  const okVal = integ.integrity_check || Object.values(integ)[0];
  if (okVal !== 'ok') throw new Error(`postflight integrity_check failed after ${m.name}: ${okVal}`);
  const fk = await runner.all('PRAGMA foreign_key_check');
  if (fk.length) throw new Error(`postflight foreign_key_check failed after ${m.name}`);
}

// One connection: FK toggle stays OUTSIDE the transaction (PRAGMA foreign_keys is a no-op inside one).
function composeDestructiveScript(sql, ledgerInsert = '') {
  return `PRAGMA foreign_keys=OFF;\nBEGIN IMMEDIATE;\n${sql}\n${ledgerInsert}\nCOMMIT;\nPRAGMA foreign_keys=ON;`;
}

async function bootstrapFresh(runner, opts) {
  await assertFreshDatabase(runner);
  return applyPending(runner, { ...opts, writersStopped: true });
}

async function assertFreshDatabase(runner) {
  const existing = await runner.all(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 1");
  if (existing.length) {
    throw new Error(`bootstrapFresh requires an empty/uninitialized database; found ${existing[0].type} ${existing[0].name}`);
  }
}

async function syncFingerprints(runner) {
  const fps = await computeFingerprints(runner);
  await runner.exec(composeFingerprintRefresh(fps));
}

function composeFingerprintRefresh(fps) {
  const { sqlQuote } = require('./ledger');
  const inserts = fps.map((f) =>
    `INSERT INTO schema_object_fingerprints (object_type, object_name, fingerprint) VALUES (${sqlQuote(f.object_type)}, ${sqlQuote(f.object_name)}, ${sqlQuote(f.fingerprint)});`
  ).join('\n');
  return `BEGIN IMMEDIATE;\nDELETE FROM schema_object_fingerprints;\n${inserts}\nCOMMIT;`;
}

// Deterministic ordering that matches SQLite `ORDER BY object_type, object_name`
// (BINARY collation). Do NOT use localeCompare — it diverges from SQL ordering.
function sortFps(fps) {
  return fps.slice().sort((a, b) =>
    a.object_type < b.object_type ? -1 : a.object_type > b.object_type ? 1 :
    a.object_name < b.object_name ? -1 : a.object_name > b.object_name ? 1 : 0);
}

async function readStoredFingerprints(runner) {
  return runner.all(
    'SELECT object_type, object_name, fingerprint FROM schema_object_fingerprints ORDER BY object_type, object_name');
}

async function verifyHead(runner, { migrationsDir }) {
  const { loadMigrations } = require('./migrations-loader');
  const appliedRows = (await getApplied(runner))
    .filter((m) => m.status === 'applied')
    .sort((a, b) => a.version - b.version);
  const expected = loadMigrations(migrationsDir);
  const key = (rows) => rows.map((m) => `${m.version}:${m.checksum}`).join(',');
  if (key(appliedRows) !== key(expected)) {
    return {
      ok: false,
      reason: `applied migrations do not match expected (applied=[${appliedRows.map((m) => m.version).join(',')}], expected=[${expected.map((m) => m.version).join(',')}])`,
    };
  }
  const stored = await readStoredFingerprints(runner);
  const live = sortFps(await computeFingerprints(runner));
  if (JSON.stringify(stored) !== JSON.stringify(live)) {
    if (await isPureNormalizerSchemeUpgrade(runner, stored)) {
      // Not real drift: only the fingerprint scheme advanced (osi-os#153). Re-stamp and pass.
      await syncFingerprints(runner);
      return { ok: true };
    }
    return {
      ok: false,
      reason: 'fingerprint drift detected (repair_required). If the live schema is known-correct '
        + '(e.g. this gateway\'s boot node rewrote a gateway-EUI trigger literal before the '
        + 'osi-os#153 fingerprint fix shipped), re-baseline with `node scripts/restamp-fingerprints.js <db>`.',
    };
  }
  return { ok: true };
}

module.exports = { applyPending, postflight, bootstrapFresh, verifyHead, syncFingerprints, composeDestructiveScript, composeFingerprintRefresh, assertFreshDatabase, sortFps, readStoredFingerprints };
