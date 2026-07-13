#!/usr/bin/env node
'use strict';
// verify-boot-ddl-interpolation - issues #4 + #10 regression guard.
//
// The frozen boot node "Sync Init Schema + Triggers" (sync-init-fn) rewrites
// every trg_dp_* / trg_sync_* / trg_gateway_locations_* trigger on each boot
// by executing JS-assembled DDL strings that interpolate `gatewaySql`.
// Two failure classes shipped silently because the node swallows per-statement
// errors:
//   1. Issue #4: `\" + gatewaySql + \"` (escaped quotes) inside a DDL string
//      ships the literal text ` + gatewaySql + ` into the SQL, where SQLite's
//      double-quoted-string fallback turns it into a bogus string literal.
//   2. Issue #10: upsert-shaped aggregate triggers passing literal 0 as the
//      outbox sync_version, which the cloud watermark terminally rejects on
//      every recompute (equal_version_payload_conflict).
//
// This verifier executes the boot node's rewritten DDL the way the node would:
// it extracts the `triggers` statement array from the node's func, evaluates
// it as JS with `gatewaySql` bound to a test EUI (exactly how the node builds
// it from DEVICE_EUI), runs every statement against a scratch DB built from
// database/seed-blank.sql, and then asserts:
//   (a) every statement executed without error (the node would swallow these);
//   (b) sqlite_master contains no 'gatewaySql' text;
//   (c) no trg_dp_* trigger whose op name ends in _UPSERTED passes literal 0
//       as sync_version;
//   (d) the six versioned-aggregate outbox triggers exist and pass
//       NEW.sync_version (covers ZONE_ENVIRONMENT_APPENDED, same latent
//       defect with an _APPENDED op name).
//
// Usage:
//   node scripts/verify-boot-ddl-interpolation.js            # both profiles
//   node scripts/verify-boot-ddl-interpolation.js --flows <path> [--seed <path>]

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(repoRoot, p));
const DEFAULT_SEED = path.join(repoRoot, 'database/seed-blank.sql');

// The node computes:
//   const gatewaySql = /^[0-9A-F]{16}$/.test(gateway) ? "'" + gateway.replace(/'/g, "''") + "'" : 'NULL';
// Emulate with a valid test EUI.
const TEST_EUI = 'ABCDEF0123456789';
const TEST_GATEWAY_SQL = "'" + TEST_EUI + "'";

// The six outbox triggers over the sync_version-carrying aggregate tables.
const VERSIONED_OUTBOX_TRIGGERS = [
  'trg_dp_dendro_daily_outbox_ai',
  'trg_dp_dendro_daily_outbox_au',
  'trg_dp_zone_recs_outbox_ai',
  'trg_dp_zone_recs_outbox_au',
  'trg_dp_zone_env_outbox_ai',
  'trg_dp_zone_env_outbox_au',
];

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

// Literal 0 in the outbox sync_version slot: it sits between the payload
// json_object(...) close paren and the occurred_at strftime(...).
function passesLiteralZeroVersion(sql) {
  return /\)\s*,\s*0\s*,\s*strftime\s*\(/.test(normalizeSql(sql));
}

function extractTriggerStatements(flowsPath) {
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const node = flows.find((n) => n && n.id === 'sync-init-fn');
  if (!node || typeof node.func !== 'string') {
    throw new Error(`${flowsPath}: sync-init-fn node with func not found`);
  }
  const m = node.func.match(/const\s+triggers\s*=\s*(\[[\s\S]*?\n\]);/);
  if (!m) throw new Error(`${flowsPath}: could not locate the 'const triggers = [...]' array in sync-init-fn`);
  // Evaluate the array source exactly as the node's JS engine would, with
  // gatewaySql bound. String escapes, concatenation, everything is real JS.
  let stmts;
  try {
    stmts = new Function('gatewaySql', `'use strict'; return (${m[1]});`)(TEST_GATEWAY_SQL);
  } catch (e) {
    throw new Error(`${flowsPath}: evaluating the triggers array failed: ${e.message}`);
  }
  if (!Array.isArray(stmts) || stmts.length === 0) {
    throw new Error(`${flowsPath}: triggers array evaluated to a non-array or empty result`);
  }
  return stmts;
}

function verifyFlows(flowsPath, seedPath) {
  const failures = [];
  const stmts = extractTriggerStatements(flowsPath);

  const db = new DatabaseSync(':memory:');
  try {
    db.exec(fs.readFileSync(seedPath, 'utf8'));
    for (const sql of stmts) {
      try {
        db.exec(sql);
      } catch (e) {
        failures.push(`statement failed (the boot node would swallow this): ${e.message} :: ${normalizeSql(sql).slice(0, 160)}`);
      }
    }

    const leaked = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE sql LIKE '%gatewaySql%'")
      .get();
    if (leaked.c !== 0) {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%gatewaySql%'")
        .all();
      failures.push(`sqlite_master contains literal 'gatewaySql' text in: ${rows.map((r) => r.name).join(', ')} (issue #4 escaped-quote interpolation)`);
    }

    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_dp_%'")
      .all();
    for (const t of triggers) {
      const opUpserted = /'[A-Z0-9_]*_UPSERTED'/.test(t.sql || '');
      if (opUpserted && passesLiteralZeroVersion(t.sql)) {
        failures.push(`${t.name}: op *_UPSERTED passes literal 0 as sync_version (issue #10 terminal rejection)`);
      }
    }

    const byName = new Map(triggers.map((t) => [t.name, t]));
    for (const name of VERSIONED_OUTBOX_TRIGGERS) {
      const t = byName.get(name);
      if (!t) {
        failures.push(`${name}: missing after executing the boot node's rewritten DDL`);
        continue;
      }
      if (passesLiteralZeroVersion(t.sql)) {
        failures.push(`${name}: passes literal 0 as sync_version instead of NEW.sync_version`);
      } else if (!/NEW\.sync_version/.test(t.sql)) {
        failures.push(`${name}: does not reference NEW.sync_version`);
      }
    }
  } finally {
    db.close();
  }
  return { failures, statementCount: stmts.length };
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
    const { failures, statementCount } = verifyFlows(path.resolve(flowsPath), path.resolve(o.seed));
    if (failures.length) {
      failed = true;
      console.error(`FAIL ${rel} (${statementCount} boot statements executed):`);
      for (const f of failures) console.error(`  - ${f}`);
    } else {
      console.log(`OK ${rel} (${statementCount} boot statements; no gatewaySql leak; versioned outbox triggers pass NEW.sync_version)`);
    }
  }
  if (failed) {
    console.error('verify-boot-ddl-interpolation: FAIL');
    process.exit(1);
  }
  console.log('verify-boot-ddl-interpolation: OK');
}

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error('verify-boot-ddl-interpolation: FAIL - ' + e.message);
    process.exit(1);
  }
}

module.exports = { verifyFlows, extractTriggerStatements, passesLiteralZeroVersion, VERSIONED_OUTBOX_TRIGGERS, TEST_GATEWAY_SQL };
