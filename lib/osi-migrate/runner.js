'use strict';
const path = require('node:path');
const { loadMigrations } = require('./migrations-loader');
const { ensureLedger, getApplied, recordFailure, markRepairRequired, successInsertSql } = require('./ledger');
const { backupDb } = require('./backup');
const { cliRunner } = require('./runner-iface');
const { computeFingerprints, PREVIOUS_NORMALIZER_VERSION } = require('./fingerprints');

// The osi-os#212 default boot-owned-trigger derivation below (reference
// triggers minus verify-runtime-schema-parity.js's MIGRATION_OWNED_TRIGGERS
// map) is only PROVEN correct for this exact, real migration corpus —
// verify-runtime-schema-parity.js CI-gates that "everything the real seed's
// triggers contain minus that map" equals exactly what the real flows.json
// boot node creates. That proof says nothing about an arbitrary OTHER
// migrations directory (a test fixture; conceivably a fork's own migration
// set), where a trigger absent from the map is just as likely to be a real,
// strictly-migration-owned trigger nobody has ever needed to add to that
// list. So the default only activates for this exact directory; any other
// migrationsDir must pass an explicit override to use the tolerant path.
const REAL_MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations/ordered');

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

// osi-os#212: reference-based grace path, layered ONLY after
// isPureNormalizerSchemeUpgrade above has already failed. Covers the shape
// seen live on kaba100 2026-09-11: `deploy.sh` stamps fingerprints right
// after the migration runner commits (Node-RED stopped), but the very next
// Node-RED start rewrites the ~20 triggers the legacy `sync-init-fn` boot
// node still owns (osi-schema-change-control skill, "Boot-DDL freeze") —
// substituting this gateway's real gateway_device_eui for the
// migration-baked fallback literal and reformatting the SQL as a compact
// single-line JS template literal. Both effects are already the intended,
// provably-safe target of fingerprints.js's v3 normalizer
// (canonicalizeGatewayEuiCoalesce + normalizeSqlClause) — but the
// PREVIOUS_NORMALIZER_VERSION (v2) comparison above is whitespace-collapse
// only, so any device that was stamped once and then had Node-RED restart
// before the *next* stamp looks, incorrectly, like more than a pure scheme
// bump.
//
// This builds reference(appliedHead) — a scratch DB with exactly the
// migrations already applied on THIS device (never head; pending migrations
// have not run yet at preflight time) — via
// scripts/baseline-existing-db.js's own incremental reference-chain builder
// (required lazily to dodge the runner.js <-> baseline-existing-db.js <->
// lib/osi-migrate/index.js require cycle), and compares it against the live
// schema with scripts/semantic-schema-compare.js's comparator. Every
// resulting diff must be provably explained by a boot-node-owned trigger's
// BODY differing (never its existence, and never any other object type) to
// be tolerated — the boot-owned name set is sourced from
// scripts/verify-runtime-schema-parity.js's own MIGRATION_OWNED_TRIGGERS map
// (the one place that already enumerates, and CI-gates, which trigger names
// the frozen sync-init-fn boot DDL is allowed to own), not re-derived here.
// Any other diff (a real table/column/index/view change, a missing trigger,
// or a non-boot-owned trigger body change) still refuses exactly as before —
// this must never widen into a general drift bypass. Being boot-owned only
// earns a trigger the RIGHT to have its raw body re-checked under
// fingerprints.js's own v3 normalizer (EUI-literal + formatting blindness);
// it does not tolerate the diff outright. A boot-owned trigger whose body
// differs for any OTHER reason (e.g. a genuinely dropped column reference —
// see fingerprints-boot-rewrite-rehearsal.test.js's "real drift... is still
// caught" case) still refuses.
// { bootOwnedTriggerNames } is test-only injection (see
// runner-boot-trigger-grace.test.js): production callers never pass it, so
// production always derives the set from the real
// verify-runtime-schema-parity.js map below, but a synthetic-migration test
// fixture has no triggers in that real, hardcoded, production-named map and
// needs a way to assert the non-boot-owned refusal path still fires.
async function isBootOwnedTriggerBodyDrift(runner, migrationsDir, appliedHeadVersion, { bootOwnedTriggerNames } = {}) {
  if (!appliedHeadVersion || appliedHeadVersion < 1) return false;
  // See REAL_MIGRATIONS_DIR's comment: the default (no explicit override)
  // derivation is only proven safe for the real, shipped migration corpus.
  if (!bootOwnedTriggerNames && path.resolve(migrationsDir) !== REAL_MIGRATIONS_DIR) return false;

  const os = require('node:os');
  const fs = require('node:fs');
  // Lazy requires: both cross into scripts/, and baseline-existing-db.js itself
  // requires lib/osi-migrate (index.js -> this file) — a top-level require here
  // would deadlock that cycle on a partially-initialized module.
  const { buildReference } = require('../../scripts/baseline-existing-db');
  const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('../../scripts/semantic-schema-compare');

  let refDbPath;
  try {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-migrate-grace-'));
    refDbPath = await buildReference(migrationsDir, appliedHeadVersion, scratchRoot);
  } catch (_e) {
    // Cannot prove the reference-based check safe (e.g. this migrationsDir's
    // checksum manifest doesn't match disk) -> fall through to the existing refusal.
    return false;
  }

  const liveSnap = await snapshotSchema(runner);
  const refSnap = await snapshotSchema(cliRunner(refDbPath));
  const res = compareSchemas(liveSnap, refSnap);

  // Boot-node-owned = every trigger the reference migrations create that is
  // NOT in the explicitly migration-exclusive MIGRATION_OWNED_TRIGGERS map —
  // verify-runtime-schema-parity.js CI-gates that this is exactly the set the
  // frozen sync-init-fn boot DDL (re)creates on every Node-RED start.
  const bootOwnedTriggers = bootOwnedTriggerNames || new Set(
    Object.keys(refSnap.triggers).filter(
      (name) => !require('../../scripts/verify-runtime-schema-parity').MIGRATION_OWNED_TRIGGERS.has(name)
    )
  );

  // Being boot-owned only means the NAME is allowed to differ raw; the BODY
  // must still be proven to differ for no reason beyond the two effects the
  // v3 fingerprint normalizer (fingerprints.js normalizeSqlV3) already treats
  // as safe: gateway-EUI literal substitution and SQL token-spacing/case
  // formatting. Anything else — e.g. a genuinely dropped column reference,
  // the exact regression fingerprints-boot-rewrite-rehearsal.test.js guards —
  // must still refuse. Without this, "the trigger name is boot-owned" alone
  // would tolerate ANY content change to that trigger, which is exactly the
  // general drift bypass this grace path must never become.
  const { sqlQuote } = require('./ledger');
  const rawTriggerSql = async (targetRunner, name) => {
    const rows = await targetRunner.all(
      `SELECT sql FROM sqlite_master WHERE type='trigger' AND name=${sqlQuote(name)}`
    );
    return rows[0] && rows[0].sql;
  };

  const realFailures = [];
  for (const d of res.diffs) {
    if (!FAILING_CLASSES.has(d.class)) continue;
    if (d.kind === 'trigger' && d.class === 'changed' && bootOwnedTriggers.has(d.name)) {
      const { normalizeSqlV3 } = require('./fingerprints');
      const liveSql = await rawTriggerSql(runner, d.name);
      const refSql = await rawTriggerSql(cliRunner(refDbPath), d.name);
      if (normalizeSqlV3(liveSql) === normalizeSqlV3(refSql)) {
        continue; // tolerated: boot-node rewrite differs only by EUI literal / SQL formatting
      }
      // fall through: real content drift in a boot-owned trigger still refuses
    }
    realFailures.push(d);
  }
  return realFailures.length === 0;
}

function maxAppliedVersion(appliedRows) {
  let max = 0;
  for (const m of appliedRows) {
    if (m.status === 'applied' && m.version > max) max = m.version;
  }
  return max;
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
      } else if (await isBootOwnedTriggerBodyDrift(runner, migrationsDir, maxAppliedVersion(applied))) {
        // osi-os#212: live schema equals reference(appliedHead) modulo boot-node-owned
        // trigger BODIES (existence still required) — a provably-safe re-stamp, not a
        // silent bless of unexplained drift. See isBootOwnedTriggerBodyDrift's comment.
        console.error('[migrate] drift preflight: live schema differs from stamped fingerprints only in boot-node-owned trigger bodies (reference-based check, osi-os#212); restamping and proceeding.');
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
    if (await isBootOwnedTriggerBodyDrift(runner, migrationsDir, maxAppliedVersion(appliedRows))) {
      // osi-os#212: reference-based grace path (see isBootOwnedTriggerBodyDrift).
      console.error('[migrate] verifyHead: live schema differs from stamped fingerprints only in boot-node-owned trigger bodies (reference-based check, osi-os#212); restamping and passing.');
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

module.exports = { applyPending, postflight, bootstrapFresh, verifyHead, syncFingerprints, composeDestructiveScript, composeFingerprintRefresh, assertFreshDatabase, sortFps, readStoredFingerprints, isBootOwnedTriggerBodyDrift, maxAppliedVersion };
