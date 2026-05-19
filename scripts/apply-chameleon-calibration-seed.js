#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'database/seeds/chameleon-calibrations.sql');
const dbPaths = [
  'database/farming.db',
  'web/react-gui/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
];

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

for (const rel of dbPaths) {
  const dbPath = path.join(repoRoot, rel);
  if (!fs.existsSync(dbPath)) fail(`missing database: ${rel}`);
  execFileSync('sqlite3', [dbPath], { input: seed, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  const rows = Number(sqlite(dbPath, 'SELECT COUNT(*) FROM chameleon_calibrations;'));
  console.log(`${rel}: ${rows} chameleon calibration row(s)`);
}

if (insertCount === 0) {
  fail(
    'database/seeds/chameleon-calibrations.sql contains no calibration rows. ' +
    'Run OSI_ADMIN_TOKEN=<token> node scripts/refresh-chameleon-calibrations.js first.',
  );
}

console.log(`Applied ${insertCount} bundled Chameleon calibration row(s).`);
