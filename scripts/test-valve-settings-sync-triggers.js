#!/usr/bin/env node
// Guard for migration 0025__valve_settings_sync_triggers.sql (Bovey cloud
// full-parity Task P2-E1, edge half). Builds a DB by replaying every ordered
// migration (the same mechanism verify-seed-replay.js uses) and asserts the
// trg_sync_valve_settings_outbox_ai/_au pair emits VALVE_SETTINGS_UPSERTED
// sync_outbox rows correctly -- including the conditional sync_version bump
// (only synced columns trigger it, not clock-sync bookkeeping columns).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const DEVICE_EUI = 'A84041CAFECAFE20';
const GATEWAY_EUI = '0016C001F11715E2';

let failures = 0;
function ok(cond, label) {
  if (cond) { console.log(`OK  ${label}`); }
  else { console.error(`FAIL ${label}`); failures += 1; }
}

async function scalar(runner, sql) {
  const rows = await runner.all(sql);
  const row = rows[0] || {};
  const key = Object.keys(row)[0];
  return key === undefined ? null : row[key];
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-settings-sync-'));
  const dbPath = path.join(dir, 'r.db');
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });

  // Fixture: one STREGA_VALVE device, unlinked to start with (matches a fresh
  // seed: sync_link_state gets no row until a user with server_url/token exists).
  await runner.exec(`
    INSERT INTO users(id, username, password_hash, created_at, user_uuid)
      VALUES(1, 'local', 'x', '2026-08-25T10:00:00.000Z', 'user-1');
    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui)
      VALUES('${DEVICE_EUI}', 'Valve 1', 'STREGA_VALVE', 1, '2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z', '${GATEWAY_EUI}');
  `);

  // --- Case 1: UNLINKED gateway emits nothing on INSERT --------------------
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_link_state WHERE peer_node='cloud';")) === 0,
    'fresh DB has no sync_link_state row (unlinked)');
  await runner.exec(`INSERT INTO valve_settings(device_eui) VALUES('${DEVICE_EUI}');`);
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='VALVE_SETTINGS';")) === 0,
    'unlinked gateway: INSERT on valve_settings emits 0 outbox rows');
  await runner.exec(`DELETE FROM valve_settings WHERE device_eui='${DEVICE_EUI}';`);

  // --- Link the gateway ------------------------------------------------------
  await runner.exec(`
    INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at)
    VALUES('cloud', 1, '${GATEWAY_EUI}', '2026-08-25T10:00:00.000Z')
    ON CONFLICT(peer_node) DO UPDATE SET linked=1, gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at;
  `);
  await runner.exec('DELETE FROM sync_outbox;');

  // --- Case 2: LINKED gateway emits on INSERT (bare defaults row) -----------
  await runner.exec(`INSERT INTO valve_settings(device_eui) VALUES('${DEVICE_EUI}');`);
  const rows2 = await runner.all("SELECT aggregate_type, aggregate_key, op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type='VALVE_SETTINGS';");
  ok(rows2.length === 1, 'linked gateway: INSERT on valve_settings emits exactly 1 outbox row');
  if (rows2.length === 1) {
    const row = rows2[0];
    ok(row.aggregate_type === 'VALVE_SETTINGS', 'row aggregate_type = VALVE_SETTINGS');
    ok(row.aggregate_key === DEVICE_EUI, 'row aggregate_key = device_eui');
    ok(row.op === 'VALVE_SETTINGS_UPSERTED', "row op = 'VALVE_SETTINGS_UPSERTED'");
    ok(row.sync_version === 0, 'AI fires on the bare-defaults row: sync_version is 0');
    const payload = JSON.parse(row.payload_json);
    ok(payload.contract_version === 1, 'payload carries top-level contract_version: 1');
    ok(payload.device_eui === DEVICE_EUI, 'payload.device_eui matches');
    ok(payload.strega_generation === 'GEN1', 'payload.strega_generation defaults to GEN1');
    ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.updated_at),
      `payload.updated_at is reformatted to CanonicalUtcTimestamp (got ${payload.updated_at})`);
  }
  const eventUuid2 = await scalar(runner, "SELECT event_uuid FROM sync_outbox WHERE aggregate_type='VALVE_SETTINGS';");
  ok(typeof eventUuid2 === 'string' && eventUuid2.length <= 36 && eventUuid2.length > 0,
    `event_uuid is <=36 chars (got ${eventUuid2 && eventUuid2.length})`);

  // --- Case 3: _au does NOT fire for clock-sync bookkeeping-only writes -----
  // (production shape: store.upsertSettings only bumps sync_version when the
  // patch touches a synced column; a bare clock-sync write does not.)
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(`UPDATE valve_settings SET last_clock_sync_queued_at='2026-08-25T11:00:00.000Z', updated_at=datetime('now') WHERE device_eui='${DEVICE_EUI}';`);
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='VALVE_SETTINGS';")) === 0,
    '_au: clock-sync-only UPDATE (sync_version untouched, no synced column changed) emits 0 rows');

  // --- Case 4: _au DOES fire when a synced column changes (production shape:
  // sync_version bumped alongside it, matching store.upsertSettings) ---------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(`UPDATE valve_settings SET scheduler_status='SKIP_TODAY', skip_today_date='2026-08-25', sync_version=COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE device_eui='${DEVICE_EUI}';`);
  const rows4 = await runner.all("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type='VALVE_SETTINGS';");
  ok(rows4.length === 1, '_au: UPDATE scheduler_status (synced column) emits exactly 1 row');
  if (rows4.length === 1) {
    ok(rows4[0].sync_version === 1, 'emitted sync_version reflects the bump (1)');
    const payload = JSON.parse(rows4[0].payload_json);
    ok(payload.scheduler_status === 'SKIP_TODAY', 'payload.scheduler_status matches');
    ok(payload.skip_today_date === '2026-08-25', 'payload.skip_today_date matches');
  }

  // --- Case 5: bare UPDATE with no column actually changing value (same     -
  // value written back) and no sync_version bump emits nothing --------------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(`UPDATE valve_settings SET scheduler_status='SKIP_TODAY', updated_at=datetime('now') WHERE device_eui='${DEVICE_EUI}';`);
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='VALVE_SETTINGS';")) === 0,
    '_au: UPDATE writing back an unchanged synced value (no sync_version bump) emits 0 rows');

  await runner.close();
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`test-valve-settings-sync-triggers: FAIL (${failures} assertion(s) failed)`);
    process.exit(1);
  }
  console.log('test-valve-settings-sync-triggers: OK');
}

main().catch((e) => { console.error(e); process.exit(2); });
