#!/usr/bin/env node
'use strict';
// build-seed-db.js - regenerate the bundled farming.db seed images.
//
// The bundled seed is what deploy.sh's seed_db_if_missing() copies onto a
// brand-new gateway. It used to be a bare schema image: the full head schema
// with NO schema_migrations ledger and NO schema_object_fingerprints. That
// made every fresh install land on an un-stamped database, so the very next
// step - run_schema_migration() - saw an empty ledger and fell into the
// Stage 0 pre-ledger path (repair-sync-outbox-v2 + baseline-existing-db),
// which rebuilds the whole 1..head reference chain on the gateway itself.
// That is a >10 minute job on a 16-core workstation; on a Pi it is not a
// viable deploy step at all.
//
// The fix is to ship the seed already stamped. This script builds it the one
// sanctioned way - lib/osi-migrate's bootstrapFresh() against an empty file,
// which applies 0001..head and stamps the ledger and fingerprints exactly as
// the runner would on-device - then verifies the result with verifyHead()
// before writing it to every bundled path. Nothing here hand-writes
// schema_migrations or schema_object_fingerprints rows.
//
// Usage:
//   node scripts/build-seed-db.js            # rewrite all bundled copies
//   node scripts/build-seed-db.js --out P    # write a single image to P
//
// Verification of the committed images is a separate gate:
// scripts/verify-seed-db-ledger.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh, verifyHead } = require('../lib/osi-migrate');
const { SEED_DB_PATHS, MIGRATIONS_DIR } = require('./seed-db-paths');

const APP_VERSION = 'bundled-seed';

// Builds one ledger-bearing seed image in an isolated scratch directory and
// returns its path. The scratch directory also collects the runner's own
// pre-migration backups (data/destructive risk classes write .bak-* siblings
// next to the database), which is exactly why the build happens off to the
// side and only the database file itself is copied out.
async function buildSeedImage({ migrationsDir = MIGRATIONS_DIR } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-seed-build-'));
  const dbPath = path.join(scratch, 'farming.db');
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir, appVersion: APP_VERSION });
  const head = await verifyHead(runner, { migrationsDir });
  if (!head.ok) {
    throw new Error(`refusing to emit a seed image that fails verifyHead: ${head.reason}`);
  }
  return { dbPath, scratch };
}

async function main(argv) {
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = path.resolve(argv[++i] || '');
    else throw new Error(`unknown argument: ${argv[i]}`);
  }

  const started = Date.now();
  const { dbPath } = await buildSeedImage();
  const targets = out ? [out] : SEED_DB_PATHS;
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // copyFileSync, not a per-target rebuild: every bundled copy must stay
    // byte-identical (scripts/verify-profile-parity.js compares the bcm2712
    // and bcm2709 payloads byte for byte, and a rebuild would differ in its
    // schema_migrations applied_at timestamps).
    fs.copyFileSync(dbPath, target);
    console.log(`wrote ${path.relative(process.cwd(), target)}`);
  }
  console.log(`build-seed-db: OK (${targets.length} image(s), ${Math.round((Date.now() - started) / 1000)}s)`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`build-seed-db: FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildSeedImage, APP_VERSION };
