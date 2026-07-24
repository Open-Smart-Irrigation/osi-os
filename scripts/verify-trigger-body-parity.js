#!/usr/bin/env node
'use strict';
// verify-trigger-body-parity - issue 16 regression guard.
//
// The seed (database/seed-blank.sql) and the sync-init-fn boot node are two
// sources of truth for the same triggers. verify-runtime-schema-parity.js
// compares trigger NAME SETS only, so trigger BODIES drifted silently for
// seven weeks (the devices outbox trigger gained chameleon depth fields in
// the boot rewrite on 2026-05-26 while the seed copy never did — found during
// the 2026-07-13 fresh-Pi verification, ledger issue 16).
//
// This verifier builds an in-memory DB from the seed, snapshots trigger
// bodies, executes the boot node's interpolated DDL (reusing
// verify-boot-ddl-interpolation.js's extraction), snapshots again, and
// compares canonicalized bodies for every trigger the boot statements manage.
//
// Canonicalization rules (each exists for a named reason — never add one to
// silence an unexplained diff):
//   1. Gateway-EUI literals -> '<GATEWAY_EUI>': the seed hardcodes a fallback
//      EUI where the boot node interpolates the device's own; this is the one
//      intended difference between the two copies.
//   2. IF NOT EXISTS removed: the boot node DROPs before CREATE, the seed may
//      guard with IF NOT EXISTS; same resulting object.
//   3. Whitespace collapsed, spacing inside parens/commas normalized: the
//      seed is pretty-printed, the boot DDL is single-line.
//   4. Spacing around bare `=` normalized: the seed and the boot rewrite are
//      inconsistent with each other about padding equality comparisons
//      (some emit `col=val`, others `col = val`, in both the seed's
//      hand-written SQL and the boot node's JS template literals) -- found
//      in the 2026-07-13 repo-tree discovery run (issue 16 Task 2) across
//      trg_dp_dendro_daily_outbox_ai/au, trg_sync_devices_outbox_au,
//      trg_sync_schedules_outbox_au, trg_sync_zones_outbox_au. Confirmed
//      safe: neither source uses `<=`, `>=`, `!=`, `==`, or embeds a literal
//      `=` inside a quoted string in these trigger bodies (checked by
//      grep across both sources before adding this rule).
//
// Usage:
//   node scripts/verify-trigger-body-parity.js            # both profiles
//   node scripts/verify-trigger-body-parity.js --flows <path> [--seed <path>]

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { extractTriggerStatements, TEST_GATEWAY_SQL } = require('./verify-boot-ddl-interpolation.js');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(repoRoot, p));
const DEFAULT_SEED = path.join(repoRoot, 'database/seed-blank.sql');
const MIGRATION_OWNED_TRIGGER_NAMES = new Set([
  'trg_sync_zone_irrigation_calibration_defaults_ai',
  'trg_sync_zone_irrigation_calibration_outbox_au',
]);

// Rule 1: the interpolated test EUI and the seed's hardcoded fallback EUI.
const GATEWAY_EUI_LITERALS = [TEST_GATEWAY_SQL, "'0016C001F11715E2'"];

function canonicalizeTriggerSql(sql) {
  let s = String(sql || '');
  for (const lit of GATEWAY_EUI_LITERALS) s = s.split(lit).join("'<GATEWAY_EUI>'"); // rule 1
  s = s.replace(/\bIF\s+NOT\s+EXISTS\b/gi, ' ');                                    // rule 2
  s = s.replace(/\s+/g, ' ');                                                       // rule 3
  s = s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ', ');
  s = s.replace(/\s*(?<![<>=!])=(?!=)\s*/g, ' = ');                                  // rule 4
  return s.trim();
}

function firstDiffWindow(s, other) {
  let i = 0;
  while (i < s.length && i < other.length && s[i] === other[i]) i += 1;
  return s.slice(Math.max(0, i - 40), i + 80);
}

function snapshotTriggers(db) {
  return new Map(
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all().map((r) => [r.name, r.sql])
  );
}

function verifyFlows(flowsPath, seedPath) {
  const stmts = extractTriggerStatements(flowsPath);
  const bootManaged = new Set();
  for (const stmt of stmts) {
    const m = String(stmt).match(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i);
    if (m) bootManaged.add(m[1]);
  }

  const db = new DatabaseSync(':memory:');
  const failures = [];
  try {
    db.exec(fs.readFileSync(seedPath, 'utf8'));
    const seedTriggers = snapshotTriggers(db);
    for (const name of MIGRATION_OWNED_TRIGGER_NAMES) {
      if (!seedTriggers.has(name)) {
        failures.push(`${name}: migration-owned trigger absent from seed-blank.sql`);
      }
      if (bootManaged.has(name)) {
        failures.push(`${name}: migration-owned trigger duplicated in frozen boot DDL`);
      }
    }
    for (const sql of stmts) {
      try { db.exec(sql); } catch (_) { /* execution failures are verify-boot-ddl-interpolation's job */ }
    }
    const bootTriggers = snapshotTriggers(db);

    for (const name of [...bootManaged].sort()) {
      const bootSql = bootTriggers.get(name);
      if (!bootSql) { failures.push(`${name}: named in boot DDL but absent after execution`); continue; }
      const seedSql = seedTriggers.get(name);
      if (seedSql === undefined) { failures.push(`${name}: created by boot DDL but absent from seed-blank.sql`); continue; }
      const a = canonicalizeTriggerSql(seedSql);
      const b = canonicalizeTriggerSql(bootSql);
      if (a !== b) {
        failures.push(
          `${name}: body drift between seed and boot rewrite\n` +
          `      seed: ...${firstDiffWindow(a, b)}...\n` +
          `      boot: ...${firstDiffWindow(b, a)}...`
        );
      }
    }
  } finally {
    db.close();
  }
  return failures;
}

function parseArgs(argv) {
  const o = { flows: null, seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--flows') (o.flows = o.flows || []).push(argv[++i]);
    else if (a === '--seed') o.seed = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.flows) o.flows = DEFAULT_FLOWS;
  return o;
}

function run() {
  const o = parseArgs(process.argv.slice(2));
  let failed = false;
  for (const flowsPath of o.flows) {
    const rel = path.isAbsolute(flowsPath) ? flowsPath : path.relative(repoRoot, path.resolve(flowsPath));
    const failures = verifyFlows(path.resolve(flowsPath), path.resolve(o.seed));
    if (failures.length) {
      failed = true;
      console.error(`FAIL ${rel}:`);
      for (const f of failures) console.error(`  - ${f}`);
    } else {
      console.log(`OK ${rel} (all boot-managed trigger bodies match seed-blank.sql after canonicalization)`);
    }
  }
  if (failed) {
    console.error('verify-trigger-body-parity: FAIL');
    process.exit(1);
  }
  console.log('verify-trigger-body-parity: OK');
}

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error('verify-trigger-body-parity: FAIL - ' + e.message);
    process.exit(1);
  }
}

module.exports = { canonicalizeTriggerSql, verifyFlows };
