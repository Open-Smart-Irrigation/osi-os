#!/usr/bin/env node
'use strict';
// verify-seed-db-ledger.js - the bundled seed must ship already stamped at
// the migration head.
//
// deploy.sh's seed_db_if_missing() copies a bundled farming.db onto a
// brand-new gateway, and run_schema_migration() runs immediately afterwards
// against that freshly seeded file. Which branch it takes is decided purely
// by the seed's own schema_migrations ledger:
//
//   * ledger rows > 0  -> the ordinary catch-up path. With a head-stamped
//     seed there is nothing pending, so applyPending is a no-op and
//     verify-head-cli confirms the gateway is at head in seconds.
//   * ledger rows == 0 -> the Stage 0 pre-ledger path (repair-sync-outbox-v2
//     + baseline-existing-db). baseline-existing-db has to rebuild the whole
//     1..head reference chain to find the version the live schema matches;
//     that measured >10 minutes on a 16-core workstation and is not a viable
//     deploy step on a Pi.
//
// A seed that drifts behind the migration head puts every fresh install back
// on that second path, so this gate fails when any bundled image's ledger is
// not exactly the current ordered-migration set.
//
// It is stricter than a head-version comparison: lib/osi-migrate's verifyHead
// compares every applied row's version AND checksum against the migration
// files on disk, then compares the stored schema_object_fingerprints against
// the fingerprints recomputed from the live schema. So this also catches a
// seed whose schema was edited without a migration, or whose ledger was
// stamped against different migration bytes.
//
// Usage: node scripts/verify-seed-db-ledger.js
// Regenerate a failing seed with: node scripts/build-seed-db.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { verifyHead } = require('../lib/osi-migrate');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { SEED_DB_PATHS, MIGRATIONS_DIR, REPO_ROOT } = require('./seed-db-paths');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const migrations = loadMigrations(MIGRATIONS_DIR);
  if (migrations.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);
  const head = migrations[migrations.length - 1].version;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-seed-ledger-'));
  const failures = [];
  const digests = new Map();

  for (const seedPath of SEED_DB_PATHS) {
    const rel = path.relative(REPO_ROOT, seedPath);
    if (!fs.existsSync(seedPath)) {
      failures.push(`${rel}: bundled seed image is missing`);
      continue;
    }
    digests.set(rel, sha256(seedPath));

    // verifyHead has two grace paths that RE-STAMP fingerprints in place
    // (the osi-os#153 normalizer-scheme upgrade and the osi-os#212
    // boot-owned trigger-body drift). Running it against a copy keeps this
    // gate read-only over the committed images, and comparing the copy's
    // digest afterwards turns "verifyHead had to repair it" into a failure
    // instead of a silent pass: a freshly built seed must already be clean.
    const probe = path.join(scratch, `${rel.replace(/[\\/]/g, '_')}`);
    fs.copyFileSync(seedPath, probe);
    const runner = cliRunner(probe);

    const ledgerTable = await runner.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schema_migrations','schema_object_fingerprints') ORDER BY name");
    const present = new Set(ledgerTable.map((r) => r.name));
    if (!present.has('schema_migrations') || !present.has('schema_object_fingerprints')) {
      const missing = ['schema_migrations', 'schema_object_fingerprints'].filter((t) => !present.has(t));
      failures.push(`${rel}: bundled seed has no ${missing.join(' and no ')} - a fresh install would fall into the slow Stage 0 baseline path; rebuild with 'node scripts/build-seed-db.js'`);
      continue;
    }

    const applied = await runner.all(
      "SELECT MAX(version) AS head, COUNT(*) AS n FROM schema_migrations WHERE status='applied'");
    const seedHead = applied[0] ? Number(applied[0].head) : 0;
    const seedCount = applied[0] ? Number(applied[0].n) : 0;
    if (seedHead !== head || seedCount !== migrations.length) {
      failures.push(`${rel}: ledger is ${seedCount} row(s) at head ${seedHead}, expected ${migrations.length} at head ${head} - rebuild with 'node scripts/build-seed-db.js'`);
      continue;
    }

    const fps = await runner.all('SELECT COUNT(*) AS n FROM schema_object_fingerprints');
    if (!fps[0] || Number(fps[0].n) === 0) {
      failures.push(`${rel}: schema_object_fingerprints is empty - rebuild with 'node scripts/build-seed-db.js'`);
      continue;
    }

    const result = await verifyHead(runner, { migrationsDir: MIGRATIONS_DIR });
    if (!result.ok) {
      failures.push(`${rel}: verifyHead reported ${result.reason}`);
      continue;
    }
    if (sha256(probe) !== digests.get(rel)) {
      failures.push(`${rel}: verifyHead had to re-stamp fingerprints, so the committed image is not clean at head - rebuild with 'node scripts/build-seed-db.js'`);
      continue;
    }

    console.log(`OK ${rel} (ledger ${seedCount}/${head}, ${(await runner.all('SELECT COUNT(*) AS n FROM schema_object_fingerprints'))[0].n} fingerprints)`);
  }

  // All seven images are copies of one build; profile parity only compares
  // two of them, so pin the rest here rather than let a partial regeneration
  // ship two different schemas under the same version.
  const distinct = new Set(digests.values());
  if (distinct.size > 1) {
    const grouped = [...digests.entries()].map(([rel, d]) => `  ${d.slice(0, 12)}  ${rel}`).join('\n');
    failures.push(`bundled seed images are not byte-identical:\n${grouped}`);
  }

  if (failures.length) {
    console.error('verify-seed-db-ledger: FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`verify-seed-db-ledger: OK (${SEED_DB_PATHS.length} images stamped at migration head ${head})`);
}

main().catch((err) => {
  console.error(`verify-seed-db-ledger: FAILED: ${err.message}`);
  process.exit(2);
});
