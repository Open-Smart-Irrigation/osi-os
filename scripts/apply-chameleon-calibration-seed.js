#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { REPO_ROOT: repoRoot, SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');

const seedPath = path.join(repoRoot, 'database/seeds/chameleon-calibrations.sql');
// Every bundled seed image: they must stay byte-identical, so a calibration
// snapshot goes into all of them or none.
const dbPaths = SEED_DB_RELATIVE_PATHS;
const requireRows = process.argv.includes('--require-rows') || process.env.REQUIRE_CHAMELEON_CALIBRATION_ROWS === '1';

function sqlite(dbPath, sql) {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(seedPath)) fail(`missing seed file: ${seedPath}`);
const seed = fs.readFileSync(seedPath, 'utf8');
const insertCount = (seed.match(/INSERT OR IGNORE INTO chameleon_calibrations/g) || []).length;

if (insertCount === 0 && requireRows) {
  fail(
    'database/seeds/chameleon-calibrations.sql contains no calibration rows. ' +
    'Run OSI_ADMIN_TOKEN=<token> node scripts/refresh-chameleon-calibrations.js first.',
  );
}

for (const rel of dbPaths) {
  if (!fs.existsSync(path.join(repoRoot, rel))) fail(`missing database: ${rel}`);
}

for (const rel of dbPaths) {
  const dbPath = path.join(repoRoot, rel);
  execFileSync('sqlite3', [dbPath], { input: seed, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  const rows = Number(sqlite(dbPath, 'SELECT COUNT(*) FROM chameleon_calibrations;'));
  console.log(`${rel}: ${rows} chameleon calibration row(s)`);
}

if (insertCount === 0) {
  console.log('No bundled Chameleon calibration rows found; image will rely on runtime OSI Server calibration sync.');
} else {
  console.log(`Applied ${insertCount} bundled Chameleon calibration row(s).`);
}
