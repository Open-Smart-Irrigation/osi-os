#!/usr/bin/env node
'use strict';
// verify-sqlite-cli-limits - replay the schema under the GATEWAY's sqlite3 limits.
//
// Why this exists (2026-08-14 live-deploy failure):
//   Migration 0046 extended trg_dp_device_data_outbox_ai's payload json_object to
//   150 arguments. Every local and CI verifier passed. The deploy to a live Pi
//   then died with:
//       Parse error near line 166: too many arguments on function json_object
//   SQLITE_MAX_FUNCTION_ARG defaults to 127 in the SQLite amalgamation, which is
//   what the OpenWrt sqlite3-cli package ships. Developer/CI sqlite3 builds (and
//   node:sqlite, used by several other verifiers) raise it to 1000, so the
//   over-limit statement parsed fine everywhere we looked.
//
//   The limit is a per-connection runtime limit (sqlite3_limit), not only a
//   compile-time ceiling: the CLI's `.limit function_arg N` can lower it. That
//   makes the device constraint reproducible on any build, which is exactly what
//   this gate does - it replays the ordered migrations, the seed, and the
//   sync-init-fn boot DDL through `sqlite3 -bail` with the limit pinned to the
//   device value, and fails on any parse error.
//
// Usage:
//   node scripts/verify-sqlite-cli-limits.js
//   node scripts/verify-sqlite-cli-limits.js --limit 1000   # diagnostic override

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');
const { extractTriggerStatements } = require('./verify-boot-ddl-interpolation.js');

// SQLITE_MAX_FUNCTION_ARG default in the amalgamation == what OpenWrt sqlite3-cli
// ships on the gateway. Raising this constant requires proving the fleet's sqlite3
// was rebuilt with a higher ceiling, not just the CI runner's.
const DEVICE_FUNCTION_ARG_LIMIT = 127;

const repoRoot = path.resolve(__dirname, '..');
const SEED = path.join(repoRoot, 'database/seed-blank.sql');
const MIGRATIONS_DIR = path.join(repoRoot, 'database/migrations/ordered');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
// Same 7-path surface verify-db-schema-consistency.js covers.
const BUNDLED_DBS = [
  'conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
];

function scratchDb(tag) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `clilimits-${tag}-`)), 'x.db');
}

function describe(err) {
  const stderr = err && err.stderr ? String(err.stderr).trim() : '';
  return (stderr || (err && err.message) || String(err)).split('\n').slice(0, 4).join('\n      ');
}

async function main() {
  const argv = process.argv.slice(2);
  let limit = DEVICE_FUNCTION_ARG_LIMIT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') limit = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(limit) || limit < 8) throw new Error(`bad --limit: ${limit}`);

  const opts = { functionArgLimit: limit };
  const failures = [];

  // 1. Ordered migrations, replayed in order through the ledgered runner.
  try {
    await bootstrapFresh(cliRunner(scratchDb('replay'), opts), {
      migrationsDir: MIGRATIONS_DIR,
      appVersion: 'cli-limits',
    });
    console.log(`OK  ordered migrations replay under function_arg=${limit}`);
  } catch (e) {
    failures.push(`ordered migrations replay:\n      ${describe(e)}`);
  }

  // 2. seed-blank.sql applied fresh.
  const seedDb = scratchDb('seed');
  const seedRunner = cliRunner(seedDb, opts);
  let seedOk = false;
  try {
    await seedRunner.exec(fs.readFileSync(SEED, 'utf8'));
    seedOk = true;
    console.log(`OK  database/seed-blank.sql under function_arg=${limit}`);
  } catch (e) {
    failures.push(`database/seed-blank.sql:\n      ${describe(e)}`);
  }

  // 3. sync-init-fn boot DDL. It runs on every boot on every live gateway, and its
  //    trigger DDL is a hand-maintained copy of the seed's, so it can drift over the
  //    limit on its own.
  //
  //    This section is DIFFERENTIAL, not absolute: the boot node's ~93 idempotent
  //    ADD COLUMN statements are *expected* to fail against a seeded DB ("duplicate
  //    column name") and the boot node swallows them by design. So we replay the same
  //    statement sequence twice - once at the device limit, once at a deliberately
  //    high limit - and only flag statements that fail at the device limit and pass
  //    at the high one. That difference can only be a limit violation.
  const HIGH_LIMIT = 1000;
  for (const rel of FLOWS) {
    if (!seedOk) { failures.push(`${rel}: skipped (seed did not apply)`); continue; }
    const stmts = extractTriggerStatements(path.join(repoRoot, rel));
    const runs = [];
    for (const lim of [limit, HIGH_LIMIT]) {
      const runner = cliRunner(scratchDb('boot'), { functionArgLimit: lim });
      await runner.exec(fs.readFileSync(SEED, 'utf8'));
      const errs = [];
      for (const stmt of stmts) {
        const sql = String(stmt).trim().replace(/;+$/, '');
        try { await runner.exec(`${sql};`); errs.push(null); } catch (e) { errs.push(describe(e)); }
      }
      runs.push(errs);
    }
    const [atDevice, atHigh] = runs;
    let bad = 0;
    for (let i = 0; i < stmts.length; i += 1) {
      if (atDevice[i] && !atHigh[i]) {
        bad += 1;
        const name = (String(stmts[i]).match(/CREATE\s+(?:TRIGGER|TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i) || [])[1]
          || String(stmts[i]).slice(0, 60);
        failures.push(`${rel} boot DDL ${name}: rejected at function_arg=${limit}, accepted at ${HIGH_LIMIT}:\n      ${atDevice[i]}`);
      }
    }
    if (!bad) console.log(`OK  ${rel} sync-init-fn boot DDL (${stmts.length} statements) under function_arg=${limit}`);
  }

  // 4. The 7 bundled farming.db copies. An over-limit trigger baked into a shipped DB
  //    is worse than an over-limit migration: SQLite parses sqlite_master on open, so
  //    the whole database is unreadable ("malformed database schema ... too many
  //    arguments") on a fresh gateway, not just the one statement. Verified: the
  //    pre-fix bundled DBs failed exactly this way.
  for (const rel of BUNDLED_DBS) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) { failures.push(`${rel}: bundled DB missing`); continue; }
    try {
      await cliRunner(abs, opts).all('SELECT count(*) AS c FROM sqlite_master');
      console.log(`OK  ${rel} opens under function_arg=${limit}`);
    } catch (e) {
      failures.push(`${rel} (bundled DB unreadable on a gateway):\n      ${describe(e)}`);
    }
  }

  if (failures.length) {
    console.error(`\nverify-sqlite-cli-limits: FAIL (function_arg=${limit}, gateway limit is ${DEVICE_FUNCTION_ARG_LIMIT})`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\n  Fix: split the over-limit call, e.g.');
    console.error('       json_object(<a>, <b>)  ->  json_insert(json_object(<a>), \'$.k\', v, ...)');
    console.error('  json_insert preserves NULL members; json_patch DELETES them (RFC 7386) and is NOT payload-identical.');
    process.exit(1);
  }
  console.log('verify-sqlite-cli-limits: OK');
}

main().catch((e) => { console.error('verify-sqlite-cli-limits: FAIL - ' + (e && e.message)); process.exit(2); });

module.exports = { DEVICE_FUNCTION_ARG_LIMIT };
