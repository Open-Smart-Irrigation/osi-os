#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');

try {
  const migrations = loadMigrations(path.resolve(__dirname, '../database/migrations/ordered'));
  let prev = 0;
  for (const m of migrations) {
    if (m.version !== prev + 1) {
      throw new Error(`non-contiguous version at ${m.name} (expected ${prev + 1}, got ${m.version})`);
    }
    prev = m.version;
  }
  if (migrations.length === 0) throw new Error('no migrations found');
  if (migrations[0].version !== 1) throw new Error('first migration must be version 0001');
  console.log(`verify-migrations: OK (${migrations.length} migrations)`);
  process.exit(0);
} catch (e) {
  console.error(`verify-migrations: FAIL — ${e.message}`);
  process.exit(1);
}
