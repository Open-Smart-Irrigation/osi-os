#!/usr/bin/env node
'use strict';

// SHA-256 of every migration-runner file deploy.sh fetches to the gateway
// (fetch_migration_runner, fetch_reconciliation_assets), checked by
// deploy.sh's check_fetched_runner_checksums before Node-RED is stopped.
//
// A download cut short can still be valid JavaScript: a prefix that ends
// between two statements parses, and loses whatever followed, for example
// module.exports or a script's CLI block (#762). Comparing bytes catches
// what a parse check cannot.
//
//   node scripts/deploy-runner-checksums.js          # check (CI): exit 1 if stale
//   node scripts/deploy-runner-checksums.js --write  # regenerate after a change
//
// The migrations themselves are covered by database/migrations/ordered/
// CHECKSUMS.json; the lineage fixtures by their own CHECKSUMS.json.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = 'scripts/deploy-runner-checksums.json';

// Every JavaScript file of the runner that deploy.sh fetches. The test
// (deploy-runner-checksums.test.js) proves this equals the files deploy.sh's
// two runner fetch functions request.
const FILES = [
  'lib/osi-migrate/add-column-compat.js',
  'lib/osi-migrate/backup.js',
  'lib/osi-migrate/boot-owned-fingerprints.js',
  'lib/osi-migrate/fingerprints.js',
  'lib/osi-migrate/index.js',
  'lib/osi-migrate/ledger.js',
  'lib/osi-migrate/legacy-device-catalog.js',
  'lib/osi-migrate/migration-manifest.js',
  'lib/osi-migrate/migrations-loader.js',
  'lib/osi-migrate/recovery-hold.js',
  'lib/osi-migrate/runner-iface.js',
  'lib/osi-migrate/runner.js',
  'lib/osi-migrate/sql-normalize.js',
  'scripts/baseline-existing-db.js',
  'scripts/migrate-cli.js',
  'scripts/reconcile-ledger-numbering.js',
  'scripts/repair-sync-outbox-v2.js',
  'scripts/restamp-fingerprints.js',
  'scripts/semantic-schema-compare.js',
  'scripts/verify-devices-rebuild-fence.js',
  'scripts/verify-head-cli.js',
  'scripts/verify-runtime-schema-parity.js',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compute(root = REPO) {
  return Object.fromEntries(FILES.map((rel) => [rel, sha256(path.join(root, rel))]));
}

function render(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function main(argv) {
  const expected = render(compute());
  const file = path.join(REPO, MANIFEST);
  if (argv.includes('--write')) {
    fs.writeFileSync(file, expected);
    console.log(`deploy-runner-checksums: wrote ${MANIFEST} (${FILES.length} files)`);
    return 0;
  }
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (actual !== expected) {
    console.error(`deploy-runner-checksums: FAIL: ${MANIFEST} is stale; run: node scripts/deploy-runner-checksums.js --write`);
    return 1;
  }
  console.log(`deploy-runner-checksums: OK (${FILES.length} files)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { FILES, MANIFEST, compute, render };
