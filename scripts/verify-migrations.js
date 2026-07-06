#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');

function parseArgs(argv) {
  const options = {
    migrationsDir: path.resolve(__dirname, '../database/migrations/ordered'),
    manifestPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--migrations-dir') {
      i += 1;
      if (!argv[i]) throw new Error('--migrations-dir requires a path');
      options.migrationsDir = path.resolve(argv[i]);
    } else if (arg === '--checksum-manifest') {
      i += 1;
      if (!argv[i]) throw new Error('--checksum-manifest requires a path');
      options.manifestPath = path.resolve(argv[i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.manifestPath) {
    options.manifestPath = path.join(options.migrationsDir, 'CHECKSUMS.json');
  }

  return options;
}

function readChecksumManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error(`checksum manifest missing: ${manifestPath}`);
    }
    throw new Error(`checksum manifest is invalid JSON: ${e.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('checksum manifest must be an object mapping filename to sha256');
  }

  return parsed;
}

function verifyChecksumManifest(migrations, manifestPath) {
  const manifest = readChecksumManifest(manifestPath);
  const migrationNames = new Set(migrations.map((m) => m.name));

  for (const migration of migrations) {
    if (!Object.prototype.hasOwnProperty.call(manifest, migration.name)) {
      throw new Error(`missing checksum manifest entry for ${migration.name}`);
    }
    const expected = manifest[migration.name];
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`invalid checksum manifest entry for ${migration.name}`);
    }
    if (expected !== migration.checksum) {
      throw new Error(
        `checksum mismatch for ${migration.name} (expected ${expected}, got ${migration.checksum})`
      );
    }
  }

  for (const filename of Object.keys(manifest).sort()) {
    if (!migrationNames.has(filename)) {
      throw new Error(`checksum manifest entry has no migration file: ${filename}`);
    }
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const migrations = loadMigrations(options.migrationsDir);
  let prev = 0;
  for (const m of migrations) {
    if (m.version !== prev + 1) {
      throw new Error(`non-contiguous version at ${m.name} (expected ${prev + 1}, got ${m.version})`);
    }
    prev = m.version;
  }
  if (migrations.length === 0) throw new Error('no migrations found');
  if (migrations[0].version !== 1) throw new Error('first migration must be version 0001');
  verifyChecksumManifest(migrations, options.manifestPath);
  console.log(`verify-migrations: OK (${migrations.length} migrations, checksum manifest OK)`);
  process.exit(0);
} catch (e) {
  console.error(`verify-migrations: FAIL — ${e.message}`);
  process.exit(1);
}
