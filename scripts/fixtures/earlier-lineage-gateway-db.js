'use strict';
// Builds a synthetic gateway database on an earlier lineage's numbering, for
// scripts/rehearse-ledger-cutover.test.js and for trying the rehearsal CLI by
// hand:
//
//   node scripts/fixtures/earlier-lineage-gateway-db.js <out.db>
//
// The ledger is the non-valve lineage at version 53, built the same way as the
// "lineage at 53" case of scripts/reconcile-ledger-numbering.test.js: main's
// 0001-0021, the vendored lineage files 0022-0049 (found by content), and
// main's 0069/0070/0061/0068 bytes under the foreign numbers 0050-0053, all
// replayed through the real runner. seedSyntheticRows then writes rows into
// every table the pending migrations touch (zones, devices, telemetry,
// WATERMARK tables, journal tables, outbox, history queue, scoped access, link
// state), already normalised the way the boot node leaves them on a gateway.
// Identifiers are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const MAIN_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const LINEAGES_DIR = path.join(REPO, 'scripts/fixtures/lineages');

const GATEWAY_EUI = '0016C001F1000001';
const FOREIGN_TAIL = {
  '0050__journal_v2_plot_group_snapshot.sql': '0069__journal_v2_plot_group_snapshot.sql',
  '0051__journal_catalog_v11.sql': '0070__journal_catalog_v11.sql',
  '0052__watermark_lsn50.sql': '0061__watermark_lsn50.sql',
  '0053__watermark_cloud_parity.sql': '0068__watermark_cloud_parity.sql',
};

function lineageReaching49() {
  const lineage = fs.readdirSync(LINEAGES_DIR).find((dir) =>
    fs.existsSync(path.join(LINEAGES_DIR, dir, '0049__sdi12_recipe_deployments.sql')));
  if (!lineage) throw new Error('no vendored lineage carries foreign 0049');
  return path.join(LINEAGES_DIR, lineage);
}

function buildMigrationsDir(dir) {
  const { loadMigrations } = require('../../lib/osi-migrate/migrations-loader');
  fs.mkdirSync(dir, { recursive: true });
  for (const m of loadMigrations(MAIN_MIGRATIONS_DIR)) {
    if (m.version <= 21) fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(dir, m.name));
  }
  const lineageDir = lineageReaching49();
  for (const name of fs.readdirSync(lineageDir).filter((f) => f.endsWith('.sql'))) {
    if (Number(name.slice(0, 4)) <= 49) fs.copyFileSync(path.join(lineageDir, name), path.join(dir, name));
  }
  for (const [foreignName, mainName] of Object.entries(FOREIGN_TAIL)) {
    fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, mainName), path.join(dir, foreignName));
  }
  return dir;
}

async function buildLedgerOnly(dbPath, scratchDir) {
  const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
  const { bootstrapFresh } = require('../../lib/osi-migrate');
  const dir = buildMigrationsDir(path.join(scratchDir, 'earlier-lineage-migrations'));
  const res = await bootstrapFresh(cliRunner(dbPath), { migrationsDir: dir, appVersion: 'earlier-lineage-fixture' });
  fs.rmSync(dir, { recursive: true, force: true });
  return res.applied;
}

const T0 = '2026-09-01T00:00:00.000Z';
const iso = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();

// Rows as a gateway on that lineage holds them. Every column the boot node
// backfills when empty is already filled, so a boot pass changes nothing.
function syntheticRowsSql() {
  const s = [];
  const hex64 = (n) => String(n).padStart(64, '0');
  s.push(`INSERT INTO users (id, username, password_hash, created_at, user_uuid, auth_mode, server_offline_verifier_version, role) VALUES
    (1, 'owner', 'x', '${T0}', 'aaaaaaaa000000000000000000000001', 'local', 0, 'admin'),
    (2, 'member', 'x', '${T0}', 'aaaaaaaa000000000000000000000002', 'local', 0, 'researcher');`);
  // Zone 1 carries a legacy stage key (0064 rewrites it), zone 2 an FAO key
  // (untouched), zone 3 a legacy key but deleted (untouched).
  s.push(`INSERT INTO irrigation_zones (id, name, user_id, created_at, updated_at, deleted_at, timezone, zone_uuid, gateway_device_eui, sync_version, scheduling_mode, phenological_stage, calibration_key, prediction_card_enabled, area_m2) VALUES
    (1, 'Zone A', 1, '${T0}', '${T0}', NULL, 'Europe/Zurich', 'bbbbbbbb000000000000000000000001', '${GATEWAY_EUI}', 3, 'local', 'veraison', 'default', 0, 1200.5),
    (2, 'Zone B', 1, '${T0}', '${T0}', NULL, 'Europe/Zurich', 'bbbbbbbb000000000000000000000002', '${GATEWAY_EUI}', 1, 'local', 'mid_season', 'default', 0, 800),
    (3, 'Zone C', 1, '${T0}', '${T0}', '${iso(60)}', 'UTC', 'bbbbbbbb000000000000000000000003', '${GATEWAY_EUI}', 2, 'local', 'harvest', 'default', 0, NULL);`);
  s.push(`INSERT INTO irrigation_schedules (id, irrigation_zone_id, trigger_metric, threshold_kpa, enabled, created_at, updated_at, sync_version, response_mode, duration_minutes) VALUES
    (1, 1, 'SWT_WM1', 60, 1, '${T0}', '${T0}', 1, 'proportional', 30);`);
  const devices = [
    ['A840410000000001', 'Soil node 1', 'KIWI_SENSOR', 1],
    ['A840410000000002', 'Watermark node', 'DRAGINO_LSN50', 1],
    ['A840410000000003', 'Probe node', 'DRAGINO_SDI12', 2],
    ['A840410000000004', 'Valve', 'STREGA_VALVE', 1],
    ['A840410000000005', 'Weather', 'SENSECAP_S2120', null],
  ];
  devices.forEach(([eui, name, type, zone], i) => {
    s.push(`INSERT INTO devices (id, deveui, name, type_id, user_id, created_at, updated_at, irrigation_zone_id, sync_version, gateway_device_eui, soil_moisture_probe_depths_configured, chameleon_enabled) VALUES
      (${i + 1}, '${eui}', '${name}', '${type}', 1, '${T0}', '${T0}', ${zone === null ? 'NULL' : zone}, ${i + 1}, '${GATEWAY_EUI}', 0, ${type === 'KIWI_SENSOR' ? 1 : 0});`);
  });
  s.push(`UPDATE devices SET sdi12_probe_profile='GENERIC_8', sdi12_probe_status='identified', sdi12_identity='013SYNTHETIC', sdi12_value_count=8, sdi12_channel_layout_json='{"version":1,"address":"0"}' WHERE deveui='A840410000000003';`);
  for (let i = 0; i < 40; i += 1) {
    const eui = devices[i % 3][0];
    s.push(`INSERT INTO device_data (deveui, recorded_at, swt_wm1, swt_wm2, bat_v, ext_temperature_c, vwc_1) VALUES ('${eui}', '${iso(10 * i)}', ${(20 + i * 0.25).toFixed(2)}, ${i % 5 === 0 ? 'NULL' : String(30 + i)}, 3.61, ${(12.5 + i / 10).toFixed(1)}, ${i % 3 === 2 ? (0.21 + i / 1000).toFixed(3) : 'NULL'});`);
  }
  for (let i = 0; i < 6; i += 1) {
    s.push(`INSERT INTO chameleon_readings (deveui, recorded_at, temp_c, r1_ohm_raw, r2_ohm_raw, r3_ohm_raw) VALUES ('A840410000000001', '${iso(15 * i)}', ${(14 + i / 4).toFixed(2)}, ${1000 + i}, ${2000 + i}, ${3000 + i});`);
    s.push(`INSERT INTO dendrometer_readings (deveui, recorded_at, position_um) VALUES ('A840410000000001', '${iso(15 * i)}', ${1000 + i * 3});`);
  }
  s.push(`INSERT INTO watermark_calibrations (deveui, pullup_1_ohm, pulldown_1_ohm, series_fwd_1_ohm, series_rev_1_ohm, pullup_2_ohm, pulldown_2_ohm, series_fwd_2_ohm, series_rev_2_ohm, measured_at, method)
    VALUES ('A840410000000002', 47000, 47000, 100, 100, 47000, 47000, 100, 100, '${T0}', 'bench');`);
  for (let i = 0; i < 12; i += 1) {
    s.push(`INSERT INTO watermark_readings (deveui, recorded_at, payload_hex, frame_status, conversion_version) VALUES ('A840410000000002', '${iso(20 * i)}', '0${i.toString(16)}', 'accepted', 'test-1');`);
  }
  // History queue: done and pending keys, none in flight.
  s.push(`INSERT INTO sync_history_dirty_keys (peer_node, table_name, row_key, change_kind, source_row_id, changed_at, status, attempts) VALUES
    ('cloud', 'device_data', 'device_data:1', 'correction', 1, '${iso(5)}', 'done', 1),
    ('cloud', 'device_data', 'device_data:2', 'correction', 2, '${iso(6)}', 'pending', 0),
    ('cloud', 'chameleon_readings', 'chameleon_readings:1', 'correction', 1, '${iso(7)}', 'pending', 2);`);
  s.push(`INSERT INTO sync_history_cursors (peer_node, table_name, state, last_acked_id, retry_count) VALUES ('cloud', 'device_data', 'tail', 40, 0);`);
  s.push(`INSERT INTO user_zone_assignments (assignment_uuid, user_uuid, zone_uuid, gateway_device_eui, created_at) VALUES ('77777777000000000000000000000001', 'aaaaaaaa000000000000000000000002', 'bbbbbbbb000000000000000000000001', '${GATEWAY_EUI}', '${T0}');`);
  // Journal: one plot, one final entry, and the V2 replication queue.
  s.push(`INSERT INTO journal_plots (plot_uuid, plot_code, name, zone_uuid, gateway_device_eui, owner_user_uuid, created_at, updated_at) VALUES ('eeeeeeee000000000000000000000001', 'P1', 'Plot 1', 'bbbbbbbb000000000000000000000001', '${GATEWAY_EUI}', 'aaaaaaaa000000000000000000000001', '${T0}', '${T0}');`);
  s.push(`INSERT INTO journal_entries (entry_uuid, owner_user_uuid, user_id, author_principal_uuid, plot_uuid, zone_uuid, activity_code, template_code, template_version, layout_code, layout_version, catalog_version, occurred_start, occurred_timezone, occurred_utc_offset_minutes, recorded_at, origin, status, gateway_device_eui, created_at, updated_at)
    VALUES ('ffffffff000000000000000000000001', 'aaaaaaaa000000000000000000000001', 1, 'aaaaaaaa000000000000000000000001', 'eeeeeeee000000000000000000000001', 'bbbbbbbb000000000000000000000001', 'irrigation', 'full_record', 10, 'open_field', 10, 10, '2026-09-02T08:00:00Z', 'Europe/Zurich', 120, '${T0}', 'edge-ui', 'final', '${GATEWAY_EUI}', '${T0}', '${T0}');`);
  s.push(`INSERT INTO journal_edge_mutations (mutation_uuid, workspace_uuid, operation, resource_uuid, base_version, payload_json, payload_sha256, status, recorded_at, created_at, updated_at, completed_at) VALUES
    ('99999999000000000000000000000001', '66666666000000000000000000000001', 'ENTRY_CREATE', 'ffffffff000000000000000000000001', 0, '{}', '${hex64(1)}', 'applied', '${T0}', '${T0}', '${T0}', '${iso(1)}'),
    ('99999999000000000000000000000002', '66666666000000000000000000000001', 'PLOT_GROUP_SNAPSHOT', 'eeeeeeee000000000000000000000001', 0, '{}', '${hex64(2)}', 'pending', '${T0}', '${T0}', '${T0}', NULL);`);
  s.push(`INSERT INTO journal_replication_applied (workspace_uuid, sequence, kind, payload_sha256, recorded_at, applied_at) VALUES
    ('66666666000000000000000000000001', 1, 'ENTRY_HEAD', '${hex64(3)}', '${T0}', '${iso(2)}'),
    ('66666666000000000000000000000001', 2, 'PLOT_GROUP_SNAPSHOT', '${hex64(4)}', '${T0}', '${iso(3)}');`);
  // Everything the inserts queued has been delivered (cutover freeze: outbox
  // drained); one older event stays rejected. Then the gateway links.
  s.push(`UPDATE sync_outbox SET delivered_at = '${iso(500)}' WHERE delivered_at IS NULL;`);
  for (let i = 0; i < 8; i += 1) {
    s.push(`INSERT INTO sync_outbox (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, delivered_at, retry_count, gateway_device_eui, rejected_at, rejection_reason)
      VALUES ('dddddddd0000000000000000000000${String(i).padStart(2, '0')}', '${i % 2 ? 'DEVICE' : 'ZONE'}', '${i % 2 ? 'A840410000000001' : 'bbbbbbbb000000000000000000000001'}', '${i % 2 ? 'DEVICE_UPSERTED' : 'ZONE_CONFIG_UPSERTED'}', '{"n":${i}}', ${i + 1}, '${iso(i)}', ${i === 7 ? 'NULL' : `'${iso(i + 1)}'`}, 0, '${GATEWAY_EUI}', ${i === 7 ? `'${iso(i + 2)}'` : 'NULL'}, ${i === 7 ? "'synthetic rejection'" : 'NULL'});`);
  }
  s.push(`INSERT INTO sync_link_state (peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at) VALUES ('cloud', 1, 'https://cloud.example.invalid', 'cccccccc000000000000000000000001', '${GATEWAY_EUI}', '${T0}');`);
  return s.join('\n');
}

// Inserts the rows with the sqlite3 CLI (foreign keys on, as on a gateway).
function seedSyntheticRows(dbPath) {
  execFileSync('sqlite3', ['-bail', dbPath], { input: 'PRAGMA foreign_keys=ON;\nBEGIN;\n' + syntheticRowsSql() + '\nCOMMIT;\n', encoding: 'utf8' });
}

async function buildEarlierLineageGatewayDb(dbPath, { scratchDir = path.dirname(dbPath), withRows = true } = {}) {
  const applied = await buildLedgerOnly(dbPath, scratchDir);
  if (withRows) seedSyntheticRows(dbPath);
  return { applied, gatewayEui: GATEWAY_EUI };
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out || fs.existsSync(out)) {
    process.stderr.write('usage: earlier-lineage-gateway-db.js <new db path>\n');
    process.exit(2);
  }
  buildEarlierLineageGatewayDb(path.resolve(out)).then((r) => {
    process.stdout.write(`built ${out}: ledger ${r.applied.length} rows\n`);
  }).catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
}

module.exports = { buildEarlierLineageGatewayDb, seedSyntheticRows, syntheticRowsSql, GATEWAY_EUI, FOREIGN_TAIL };
