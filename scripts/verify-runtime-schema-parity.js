#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const SEED = path.join(repo, 'database/seed-blank.sql');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(repo, p));
const MIGRATION_OWNED_TRIGGERS = new Map([
  // 0005__field_work_requests.sql is delivered by seed DBs and deploy.sh's
  // additive migration repair. Do not add it to the frozen sync-init-fn boot DDL.
  ['trg_improvement_requests_outbox_ai', '0005__field_work_requests.sql'],
  // 0024__valve_schedule_sync_triggers.sql — same story: seed DB + deploy-time
  // migration runner delivery, not the frozen sync-init-fn boot DDL.
  ['trg_sync_valve_schedules_outbox_ai', '0024__valve_schedule_sync_triggers.sql'],
  ['trg_sync_valve_schedules_outbox_au', '0024__valve_schedule_sync_triggers.sql'],
  // 0025__valve_settings_sync_triggers.sql (cloud full-parity Task P2-E1) —
  // same story again: seed DB + deploy-time migration runner delivery.
  ['trg_sync_valve_settings_outbox_ai', '0025__valve_settings_sync_triggers.sql'],
  ['trg_sync_valve_settings_outbox_au', '0025__valve_settings_sync_triggers.sql'],
  // 0029__sentek_vwc_vic_channels.sql decorates existing outbox rows with additive
  // Sentek fields. Migration-owned so the frozen sync-init-fn boot DDL does not
  // duplicate the new schema behavior.
  ['trg_sentek_device_outbox_payload_ai', '0029__sentek_vwc_vic_channels.sql'],
  ['trg_sentek_data_outbox_payload_ai', '0029__sentek_vwc_vic_channels.sql'],
  // 0043__journal_v2_media.sql (journal v2 replication, renumbered from AgroLink
  // 0044) guards journal attachment provenance. These are NOT sync_outbox emitters
  // -- they are integrity guards -- but this verifier compares the whole seed trigger
  // set against sync-init-fn, so migration-delivered triggers must be listed here or
  // the boot node would be required to grow them. Seed DB + deploy-time migration
  // runner delivery, not the frozen sync-init-fn boot DDL.
  ['trg_journal_attachment_source_immutable_bu', '0043__journal_v2_media.sql'],
  ['trg_journal_attachment_edge_parent_bi', '0043__journal_v2_media.sql'],
  ['trg_journal_attachment_edge_parent_bu', '0043__journal_v2_media.sql'],
  ['trg_journal_attachment_edge_binding_immutable_bu', '0043__journal_v2_media.sql'],
  // 0044__scoped_access_schema.sql (scoped multi-gateway access, renumbered from
  // AgroLink 0033) is migration-owned and emit-gated.
  ['trg_dp_user_zone_assign_outbox_ai', '0044__scoped_access_schema.sql'],
  ['trg_dp_user_zone_assign_outbox_au', '0044__scoped_access_schema.sql'],
  ['trg_dp_user_plot_assign_outbox_ai', '0044__scoped_access_schema.sql'],
  ['trg_dp_user_plot_assign_outbox_au', '0044__scoped_access_schema.sql'],
  ['trg_dp_users_outbox_uuid_au', '0044__scoped_access_schema.sql'],
  ['trg_dp_users_outbox_ai', '0044__scoped_access_schema.sql'],
  ['trg_dp_users_outbox_role_au', '0044__scoped_access_schema.sql'],
  // 0046__zone_insert_outbox.sql (renumbered from AgroLink 0035) repairs
  // local-create sync through the deploy-time migration runner. The frozen
  // boot DDL must not duplicate it.
  ['trg_sync_zones_outbox_ai', '0046__zone_insert_outbox.sql'],
  // 0047__zone_irrigation_calibration_sync.sql (renumbered from AgroLink
  // 0036) versions and mirrors the calibration aggregate. These triggers
  // stay out of the frozen boot DDL.
  [
    'trg_sync_zone_irrigation_calibration_defaults_ai',
    '0047__zone_irrigation_calibration_sync.sql',
  ],
  [
    'trg_sync_zone_irrigation_calibration_outbox_au',
    '0047__zone_irrigation_calibration_sync.sql',
  ],
  // 0049__weather_station_zone_sync.sql (renumbered from AgroLink 0038)
  // versions and mirrors complete S2120 weather-station assignment sets.
  [
    'trg_sync_weather_station_zone_state_defaults_ai',
    '0049__weather_station_zone_sync.sql',
  ],
  [
    'trg_sync_weather_station_zones_outbox_au',
    '0049__weather_station_zone_sync.sql',
  ],
  // 0051__durable_history_batch.sql (renumbered from AgroLink 0040) writes
  // correction dirty-keys into sync_history_dirty_keys, NOT sync_outbox --
  // these are durable-history-batch coverage triggers, not outbox emitters,
  // but this verifier compares the whole seed trigger set against
  // sync-init-fn, so migration-delivered triggers must be listed here.
  // Seed DB + deploy-time migration runner delivery, not the frozen
  // sync-init-fn boot DDL.
  ['trg_sync_irrigation_events_dirty_ai', '0051__durable_history_batch.sql'],
  ['trg_sync_irrigation_events_dirty_au', '0051__durable_history_batch.sql'],
  ['trg_sync_valve_actuation_dirty_ai', '0051__durable_history_batch.sql'],
  ['trg_sync_valve_actuation_dirty_au', '0051__durable_history_batch.sql'],
]);

function q(db, sql) {
  const out = execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}
function checkTypes(sql) {
  const m = /CHECK\s*\(\s*type_id\s+IN\s*\(([\s\S]*?)\)/i.exec(sql || '');
  return new Set(((m && m[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
}
function triggerNames(text) {
  return new Set([...text.matchAll(/CREATE TRIGGER (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]));
}

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));

// Everything below has real side effects (spawns the sqlite3 CLI against a temp
// DB) and is only appropriate for the CLI entry point — a module consumer
// (runner.js's osi-os#212 boot-trigger grace path) needs only the
// MIGRATION_OWNED_TRIGGERS map above, not a re-run of this whole verifier on
// every require(). Guarded behind run() / require.main below.
function run() {
  // Canonical schema from the seed: the devices CHECK type-set and the full trigger set.
  const canonDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-')), 'canon.db');
  execFileSync('sqlite3', ['-bail', canonDb], { input: fs.readFileSync(SEED, 'utf8'), encoding: 'utf8' });
  const canonDevices = checkTypes((q(canonDb, "SELECT sql FROM sqlite_master WHERE name='devices'")[0] || {}).sql);
  const canonTriggers = new Set(q(canonDb, "SELECT name FROM sqlite_master WHERE type='trigger'").map((r) => r.name));
  const runtimeCanonTriggers = new Set([...canonTriggers].filter((name) => !MIGRATION_OWNED_TRIGGERS.has(name)));

  const problems = [];
  for (const [triggerName, migrationName] of MIGRATION_OWNED_TRIGGERS) {
    if (!canonTriggers.has(triggerName)) {
      problems.push(`migration-owned trigger ${triggerName} is not present in the canonical seed`);
    }
    const migrationPath = path.join(
      repo,
      'database/migrations/ordered',
      migrationName
    );
    if (!fs.existsSync(migrationPath)) {
      problems.push(`migration-owned trigger ${triggerName} has no migration ${migrationName}`);
    } else if (!triggerNames(fs.readFileSync(migrationPath, 'utf8')).has(triggerName)) {
      problems.push(`migration ${migrationName} does not create ${triggerName}`);
    }
  }
  for (const flowPath of FLOWS) {
    const rel = path.relative(repo, flowPath);
    const raw = fs.readFileSync(flowPath, 'utf8');
    const node = JSON.parse(raw).find((n) => n.id === 'sync-init-fn');
    if (!node) throw new Error(`${rel}: sync-init-fn node not found`);

    // (a) devices_new CHECK — the regression site (specific to sync-init-fn's rebuild).
    const dm = /devices_new\s*\(id[\s\S]*?CHECK\s*\(\s*type_id\s+IN\s*\(([\s\S]*?)\)/i.exec(node.func || '');
    const devTypes = new Set(((dm && dm[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
    if (!setEq(devTypes, canonDevices)) {
      problems.push(`${rel}: sync-init-fn devices_new CHECK != canonical seed. missing=[${diff(canonDevices, devTypes)}] extra=[${diff(devTypes, canonDevices)}]`);
    }

    // (b) triggers — created across MULTIPLE flow nodes, so compare the WHOLE flow text.
    const flowTriggers = triggerNames(raw);
    if (!setEq(flowTriggers, runtimeCanonTriggers)) {
      problems.push(`${rel}: runtime flow trigger set != canonical runtime trigger set. missing=[${diff(runtimeCanonTriggers, flowTriggers)}] extra=[${diff(flowTriggers, runtimeCanonTriggers)}]`);
    }
  }

  if (problems.length) {
    console.error('verify-runtime-schema-parity: FAIL');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`verify-runtime-schema-parity: OK (${FLOWS.length} flows: devices CHECK + runtime trigger parity)`);
  process.exit(0);
}

if (require.main === module) {
  run();
}

module.exports = { MIGRATION_OWNED_TRIGGERS, run };
