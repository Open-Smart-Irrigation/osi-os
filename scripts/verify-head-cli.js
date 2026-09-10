#!/usr/bin/env node
'use strict';
// Thin CLI wrapper over lib/osi-migrate's verifyHead (previously test-only).
// Prints the JSON result and exits 0 when ok:true, 1 when ok:false, 2 on
// usage/fatal error. Read-only: never mutates the database.
const fs = require('node:fs');
const path = require('node:path');
const { verifyHead } = require('../lib/osi-migrate');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function parseArgs(argv) {
  const opts = { dbPath: null, migrationsDir: DEFAULT_MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--migrations-dir') opts.migrationsDir = path.resolve(argv[++i] || '');
    else if (!opts.dbPath) opts.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function runVerifyHead({ dbPath, migrationsDir = DEFAULT_MIGRATIONS_DIR }) {
  if (!dbPath) {
    throw new Error('usage: verify-head-cli.js <path-to-farming.db> [--migrations-dir <dir>]');
  }
  if (!fs.existsSync(dbPath)) {
    // Mirrors restamp-fingerprints.js / baseline-existing-db.js: never let the
    // sqlite3 CLI silently CREATE an empty DB at a typoed path and "verify" that.
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  return verifyHead(cliRunner(dbPath), { migrationsDir });
}

if (require.main === module) {
  (async () => {
    try {
      const opts = parseArgs(process.argv.slice(2));
      const result = await runVerifyHead(opts);
      console.log(JSON.stringify(result));
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error(`[verify-head] FAILED: ${err.message}`);
      process.exit(2);
    }
  })();
}

module.exports = { runVerifyHead, parseArgs, DEFAULT_MIGRATIONS_DIR };
