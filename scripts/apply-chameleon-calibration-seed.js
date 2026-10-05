#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { REPO_ROOT: repoRoot, SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');

const seedPath = path.join(repoRoot, 'database/seeds/chameleon-calibrations.sql');
// Every bundled seed image. They must stay byte-identical, so the snapshot is
// applied to a copy of each image first; the copies replace the images only
// after all of them succeeded, and any failure leaves every image unchanged.
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

const staged = [];
function discardStaged() {
  for (const { tmpPath } of staged) fs.rmSync(tmpPath, { force: true });
}

try {
  for (const rel of dbPaths) {
    const dbPath = path.join(repoRoot, rel);
    const tmpPath = `${dbPath}.calibration-tmp`;
    staged.push({ rel, dbPath, tmpPath });
    fs.copyFileSync(dbPath, tmpPath);
    // -bail stops at the first failing statement; the transaction keeps a
    // partly applied seed out of the copy.
    execFileSync('sqlite3', ['-bail', tmpPath], {
      input: `BEGIN;\n${seed}\nCOMMIT;\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    const rows = Number(sqlite(tmpPath, 'SELECT COUNT(*) FROM chameleon_calibrations;'));
    console.log(`${rel}: ${rows} chameleon calibration row(s)`);
  }
} catch (error) {
  discardStaged();
  fail(`calibration seed not applied, all images left unchanged: ${error.message}`);
}

for (const { dbPath, tmpPath } of staged) fs.renameSync(tmpPath, dbPath);

if (insertCount === 0) {
  console.log('No bundled Chameleon calibration rows found; image will rely on runtime OSI Server calibration sync.');
} else {
  console.log(`Applied ${insertCount} bundled Chameleon calibration row(s).`);
}
