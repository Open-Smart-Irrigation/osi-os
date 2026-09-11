#!/usr/bin/env node
'use strict';
// Uganda catch-up artifact generator (runbook Phase 2, issue #87, rehearsal 2026-09-11).
//
// Uganda's live DB predates database/migrations/ordered/0001__baseline.sql (the
// "reference(1)" snapshot baseline-existing-db.js compares against). It is
// missing a fixed set of pre-ledger objects that reference(1) already assumes
// exist on every gateway. Those objects predate the migration ledger, so no
// ordered migration will ever (re)create them - the same rationale
// repair-sync-outbox-v2.js documents for sync_outbox's v2 columns.
//
// This generator extracts the DDL for exactly those objects VERBATIM from
// 0001__baseline.sql - never hand-retyped - and wraps each in an idempotent,
// additive guard (CREATE TABLE/INDEX IF NOT EXISTS; DROP TRIGGER IF EXISTS +
// CREATE TRIGGER). It deliberately sources triggers from 0001, NOT from the
// current database/seed-blank.sql: 16 of the 28 target triggers were edited
// by later migrations (0015-0053), so a seed-sourced (head) trigger body
// would itself register as [changed] against reference(1) and defeat the
// clean baseline-stamp this artifact exists to enable. Ordinary applyPending
// (migrate-cli.js) carries every trigger forward from its 0001 body to its
// head body via those same later migrations, exactly as it would for any
// other gateway baselined at N=1. See REHEARSAL-REPORT.md "runbook staleness"
// section for the full comparison (docs/operations/uganda-catchup-runbook.md
// Phase 2 item 3 currently says to source triggers from the seed's "current"
// bodies - that instruction is what this comment, and the artifact, correct).
//
// Usage:
//   node generate-uganda-catchup-20260911.js                  # (re)generate the .sql artifact
//   node generate-uganda-catchup-20260911.js --apply <db>     # apply the checked-in .sql to <db>
//   node generate-uganda-catchup-20260911.js --verify <db>    # assert zero [missing] target objects remain
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { snapshotSchema } = require('../semantic-schema-compare');

const REPO = path.resolve(__dirname, '..', '..');
const SOURCE_MIGRATION = path.join(REPO, 'database/migrations/ordered/0001__baseline.sql');
const ARTIFACT_PATH = path.join(__dirname, 'uganda-catchup-20260911.sql');

// Empirically determined 2026-09-11 from:
//   node scripts/baseline-existing-db.js <uganda-copy> --report
// at its best-scoring candidate, N=1 (66 failing diffs total). Every name
// below is a `missing` table/index/trigger at N=1. See REHEARSAL-REPORT.md
// for the full report and the classification of the 20 diffs NOT addressed
// here ([changed] column/check/foreign_key, [missing] column,
// [extra_unknown] column) - those are real non-additive schema drift
// unrelated to "missing whole objects" and are explicitly OUT OF SCOPE for
// an additive-only catch-up artifact; they remain open findings.
const TABLES = [
  'sync_link_state',
  'sync_history_cursors',
  'sync_history_dirty_keys',
  'sync_history_segments',
  'sync_history_quarantine',
  'history_channel_rollups',
];

// sync_link_state's ON CONFLICT bootstrap row (runbook Phase-2 item 2); the
// only DML this artifact carries, and idempotent by construction (ON
// CONFLICT DO UPDATE, not INSERT OR IGNORE - a re-run updates, not duplicates).
const SYNC_LINK_STATE_BOOTSTRAP = true;

const INDEXES = [
  'idx_sync_outbox_pending', // belt-and-braces: sync_outbox already exists on Uganda; IF NOT EXISTS makes this a no-op.
  'idx_history_rollups_unique_bucket',
  'idx_history_rollups_zone_card_bucket',
  'idx_history_rollups_source_channel',
  'idx_applied_commands_applied_at',
  'idx_device_data_deveui_recorded_at',
  'idx_valve_act_exp_device_eui',
  'idx_valve_act_exp_active',
  'idx_valve_act_exp_effect_key',
  'idx_zone_seasons_zone_range',
  'idx_zone_seasons_zone_active_unique',
  'idx_zone_seasons_zone_default',
  'idx_zone_seasons_uuid',
  // NOT included: idx_irrigation_events_event_uuid. Its column
  // (irrigation_events.event_uuid) is itself missing on Uganda and is a
  // [missing column] diff, not a [missing object] diff - out of scope for
  // this additive-only artifact (CREATE INDEX fails immediately against a
  // nonexistent column, unlike a trigger body, which SQLite does not
  // validate until it runs). Documented open gap; see REHEARSAL-REPORT.md.
];

const TRIGGERS = [
  'trg_dp_chameleon_readings_outbox_ai',
  'trg_dp_dendro_daily_outbox_ai',
  'trg_dp_dendro_daily_outbox_au',
  'trg_dp_dendro_readings_outbox_ai',
  'trg_dp_device_data_outbox_ai',
  'trg_dp_irrigation_events_outbox_ai',
  'trg_dp_irrigation_events_outbox_au_event_uuid',
  'trg_dp_zone_env_outbox_ai',
  'trg_dp_zone_env_outbox_au',
  'trg_dp_zone_recs_outbox_ai',
  'trg_dp_zone_recs_outbox_au',
  'trg_gateway_locations_outbox_ai',
  'trg_gateway_locations_outbox_au',
  'trg_sync_chameleon_readings_dirty_au',
  'trg_sync_dendro_daily_dirty_ai',
  'trg_sync_dendro_daily_dirty_au',
  'trg_sync_dendro_readings_dirty_au',
  'trg_sync_device_data_dirty_au',
  'trg_sync_devices_defaults_ai',
  'trg_sync_devices_outbox_au',
  'trg_sync_irrigation_events_uuid_ai',
  'trg_sync_schedules_outbox_au',
  'trg_sync_zone_env_dirty_ai',
  'trg_sync_zone_env_dirty_au',
  'trg_sync_zone_recs_dirty_ai',
  'trg_sync_zone_recs_dirty_au',
  'trg_sync_zones_defaults_ai',
  'trg_sync_zones_outbox_au',
];

// --- statement extraction --------------------------------------------------
// database/migrations/ordered/0001__baseline.sql is a generated, flush-left
// file: every top-level statement (CREATE/INSERT/DROP/PRAGMA) starts at
// column 0, and nothing inside a statement body (trigger BEGIN..END blocks
// included) does. That makes "next column-0 statement keyword" a much more
// robust statement terminator than paren/quote depth tracking - a trigger
// body's internal `stmt1; stmt2; END;` has semicolons at depth 0 that a
// naive depth-tracker mistakes for the end of the CREATE TRIGGER statement.
const STATEMENT_START_RE = /^(?:CREATE|INSERT|DROP|PRAGMA)\b/;

function statementStarts(text) {
  const lines = text.split('\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    if (STATEMENT_START_RE.test(line)) starts.push(offset);
    offset += line.length + 1;
  }
  starts.push(text.length);
  return starts;
}

// Finds `CREATE <TYPE> [UNIQUE] [IF NOT EXISTS] <name> ...` in `text`, keyed
// by object name; each statement runs to (not including) the next column-0
// statement start.
function extractStatements(text, type) {
  const starts = statementStarts(text);
  const re = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?${type}\\s+(?:IF NOT EXISTS\\s+)?(\\w+)`, 'gim');
  const out = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const end = starts.find((s) => s > m.index);
    out.set(name, text.slice(m.index, end).trimEnd());
  }
  return out;
}

function extractSyncLinkStateBootstrap(text) {
  const start = text.indexOf('INSERT INTO sync_link_state');
  if (start === -1) throw new Error('sync_link_state bootstrap INSERT not found in 0001__baseline.sql');
  const end = text.indexOf(';', start);
  if (end === -1) throw new Error('unterminated sync_link_state bootstrap INSERT');
  return text.slice(start, end + 1);
}

function requireAll(map, names, label) {
  const missing = names.filter((n) => !map.has(n));
  if (missing.length) {
    throw new Error(`${label} not found in ${SOURCE_MIGRATION}: ${missing.join(', ')}`);
  }
}

function generate() {
  const src = fs.readFileSync(SOURCE_MIGRATION, 'utf8');
  const tables = extractStatements(src, 'TABLE');
  const indexes = extractStatements(src, 'INDEX');
  const triggers = extractStatements(src, 'TRIGGER');
  requireAll(tables, TABLES, 'table');
  requireAll(indexes, INDEXES, 'index');
  requireAll(triggers, TRIGGERS, 'trigger');

  const lines = [];
  lines.push('-- Uganda catch-up artifact (runbook Phase 2, issue #87)');
  lines.push('-- GENERATED by scripts/ops/generate-uganda-catchup-20260911.js - do not hand-edit.');
  lines.push(`-- Source: ${path.relative(REPO, SOURCE_MIGRATION)} (reference(1)), verbatim.`);
  lines.push('-- Rehearsed 2026-09-11 on a byte-copy of the Uganda gateway DB (sha256');
  lines.push('-- 0f131395c6dfb02d16ea770c7ab20e4b23615c6ea3311c9e1802b398abee4460).');
  lines.push('-- Additive only: CREATE ... IF NOT EXISTS, DROP TRIGGER IF EXISTS + CREATE TRIGGER,');
  lines.push('-- and one idempotent ON CONFLICT DO UPDATE bootstrap row. Nothing here rewrites an');
  lines.push('-- existing table, drops one, or removes rows. Regenerate with --apply/--verify per');
  lines.push('-- the header of the generator.');
  lines.push('');
  lines.push('PRAGMA foreign_keys = ON;');
  lines.push('');

  lines.push('-- === Tables (pre-ledger, absent on Uganda) ===');
  for (const name of TABLES) {
    const stmt = tables.get(name).replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
    lines.push(stmt);
    lines.push('');
    if (name === 'sync_link_state' && SYNC_LINK_STATE_BOOTSTRAP) {
      lines.push('-- sync_link_state bootstrap row (idempotent: ON CONFLICT DO UPDATE, not INSERT OR IGNORE).');
      lines.push(extractSyncLinkStateBootstrap(src));
      lines.push('');
    }
  }

  lines.push('-- === Indexes (missing on Uganda; underlying tables already exist or were just created above) ===');
  for (const name of INDEXES) {
    const stmt = tables.has(name) ? null : indexes.get(name);
    const guarded = stmt.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_, uniq) => `CREATE ${uniq || ''}INDEX IF NOT EXISTS `);
    lines.push(guarded);
    lines.push('');
  }

  lines.push('-- === Triggers (sourced from 0001__baseline.sql, i.e. reference(1) bodies - see header comment) ===');
  for (const name of TRIGGERS) {
    lines.push(`DROP TRIGGER IF EXISTS ${name};`);
    lines.push(triggers.get(name));
    lines.push('');
  }

  fs.writeFileSync(ARTIFACT_PATH, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  return ARTIFACT_PATH;
}

async function apply(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: database file does not exist: ${dbPath}`);
  if (!fs.existsSync(ARTIFACT_PATH)) throw new Error(`artifact not generated yet: ${ARTIFACT_PATH}`);
  const sql = fs.readFileSync(ARTIFACT_PATH, 'utf8');
  const runner = cliRunner(dbPath);
  await runner.exec(`BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`);
  const integrity = execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim();
  if (integrity !== 'ok') throw new Error(`post-apply integrity_check failed: ${integrity}`);
  console.error(`[uganda-catchup] applied ${path.basename(ARTIFACT_PATH)} to ${dbPath}; integrity_check ok`);
}

// --verify: re-snapshot the live DB and assert every TABLES/INDEXES/TRIGGERS
// name is now present (the "missing" class this artifact targets is gone).
// Does NOT assert a clean baseline match at N=1 - the 20 non-additive
// [changed]/[missing column]/[extra_unknown] diffs documented above are real
// drift this artifact cannot and does not touch; that is baseline-existing-db.js's
// job to report, not this generator's job to paper over.
async function verify(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`refusing: database file does not exist: ${dbPath}`);
  const snap = await snapshotSchema(cliRunner(dbPath));
  const missing = [];
  for (const t of TABLES) if (!snap.tables[t]) missing.push(`table:${t}`);
  for (const i of INDEXES) if (!snap.indexes[i]) missing.push(`index:${i}`);
  for (const tr of TRIGGERS) if (!snap.triggers[tr]) missing.push(`trigger:${tr}`);
  if (missing.length) {
    console.error(`[uganda-catchup] --verify FAILED: still missing: ${missing.join(', ')}`);
    process.exitCode = 1;
    return false;
  }
  console.error(`[uganda-catchup] --verify PASSED: all ${TABLES.length} tables, ${INDEXES.length} indexes, ${TRIGGERS.length} triggers present.`);
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--apply') {
    await apply(argv[1]);
  } else if (argv[0] === '--verify') {
    const ok = await verify(argv[1]);
    process.exit(ok ? 0 : 1);
  } else {
    const p = generate();
    console.error(`[uganda-catchup] generated ${p}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`[uganda-catchup] FAILED: ${e.message}`); process.exit(2); });
}

module.exports = { generate, apply, verify, TABLES, INDEXES, TRIGGERS, ARTIFACT_PATH };
