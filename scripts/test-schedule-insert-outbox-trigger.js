#!/usr/bin/env node
// Guard for migration 0084__schedule_insert_outbox_trigger.sql (E5, 0.9
// must-fix, backported into 0.8.4). irrigation_schedules had an outbox
// trigger for UPDATE only, so a schedule newly created on the gateway was
// reported to the cloud at the next 6-hourly bootstrap at the earliest and a
// cloud "disable all schedules" could miss it for up to 6 hours. Builds a DB
// by replaying the ordered migrations (the same mechanism
// verify-seed-replay.js uses) and asserts the trg_sync_schedules_outbox_ai
// trigger emits exactly one SCHEDULE_UPSERTED sync_outbox row per insert,
// that updates and deletes keep their existing shape, and that the
// defaults-trigger interplay never double-emits at one version.
//
// OSI_SCHEDULE_TRIGGER_MIGRATIONS_DIR overrides the corpus (used by the
// pre-fix red control that replays the origin/main corpus without 0084).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = process.env.OSI_SCHEDULE_TRIGGER_MIGRATIONS_DIR
  || path.join(REPO, 'database/migrations/ordered');
const GATEWAY_EUI = 'AABBCCDDEEFF0003';
const ZONE1_UUID = '11111111-1111-4111-8111-111111111111';
const ZONE2_UUID = '22222222-2222-4222-8222-222222222222';
const ZONE3_UUID = '33333333-3333-4333-8333-333333333333';
const ZONE4_UUID = '44444444-4444-4444-8444-444444444444';

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

// The production insert shape of osi-daily-scheduler/schedule-save.js
// (gateway GUI) and osi-irrigation-policy/lifecycle.js (cloud commands):
// irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes,
// enabled, response_mode, sync_version, deleted_at, created_at, updated_at.
function scheduleInsertSql(zoneId, overrides) {
  const r = Object.assign({
    trigger_metric: 'SWT_WM1',
    threshold_kpa: 40,
    duration_minutes: 30,
    enabled: 1,
    response_mode: 'proportional',
    sync_version: 1,
    now: '2026-11-23T00:00:00.000Z',
  }, overrides || {});
  const val = (v) => (v === null ? 'NULL' : (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`));
  return `INSERT INTO irrigation_schedules(irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version, deleted_at, created_at, updated_at) VALUES (${zoneId}, ${val(r.trigger_metric)}, ${r.threshold_kpa}, ${r.duration_minutes}, ${r.enabled}, ${val(r.response_mode)}, ${val(r.sync_version)}, NULL, '${r.now}', '${r.now}');`;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-insert-sync-'));
  const dbPath = path.join(dir, 'r.db');
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });

  await runner.exec(`
    INSERT INTO users(id, username, password_hash, created_at, user_uuid)
      VALUES(1, 'local', 'x', '2026-11-23T00:00:00.000Z', 'user-1');
    INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, created_at, updated_at, sync_version)
      VALUES(1, 'Zone 1', 1, '${ZONE1_UUID}', '${GATEWAY_EUI}', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z', 3),
            (2, 'Zone 2', 1, '${ZONE2_UUID}', '${GATEWAY_EUI}', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z', 7),
            (3, 'Zone 3', 1, '${ZONE3_UUID}', '${GATEWAY_EUI}', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z', 1),
            (4, 'Zone 4', 1, '${ZONE4_UUID}', '${GATEWAY_EUI}', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z', 1);
  `);

  // --- Case 1: UNLINKED gateway emits nothing ------------------------------
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_link_state WHERE peer_node='cloud';")) === 0,
    'fresh DB has no sync_link_state row (unlinked)');
  await runner.exec(scheduleInsertSql(1));
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='SCHEDULE';")) === 0,
    'unlinked gateway: INSERT on irrigation_schedules emits 0 outbox rows');
  await runner.exec('DELETE FROM irrigation_schedules;');

  // --- Link the gateway ----------------------------------------------------
  await runner.exec(`
    INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at)
    VALUES('cloud', 1, '${GATEWAY_EUI}', '2026-11-23T00:00:00.000Z')
    ON CONFLICT(peer_node) DO UPDATE SET linked=1, gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at;
  `);
  await runner.exec('DELETE FROM sync_outbox;');

  // --- Case 2: the E5 defect — a newly created schedule (gateway GUI shape,
  // osi-daily-scheduler/schedule-save.js inserts sync_version 1 and a
  // validated response_mode) must reach the outbox at once -----------------
  await runner.exec(scheduleInsertSql(1));
  const rows2 = await runner.all("SELECT event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, gateway_device_eui FROM sync_outbox WHERE aggregate_type='SCHEDULE';");
  ok(rows2.length === 1, 'linked gateway: INSERT on irrigation_schedules emits exactly 1 outbox row');
  if (rows2.length === 1) {
    const row = rows2[0];
    ok(row.aggregate_type === 'SCHEDULE', 'row aggregate_type = SCHEDULE');
    ok(row.aggregate_key === ZONE1_UUID, 'row aggregate_key = zone_uuid');
    ok(row.op === 'SCHEDULE_UPSERTED', "row op = 'SCHEDULE_UPSERTED'");
    ok(Number(row.sync_version) === 1, 'row sync_version = inserted sync_version (1)');
    ok(row.gateway_device_eui === GATEWAY_EUI, 'row gateway_device_eui resolves from the zone');
    ok(typeof row.event_uuid === 'string' && row.event_uuid.length > 0 && row.event_uuid.length <= 36,
      `event_uuid is <=36 chars (got ${row.event_uuid && row.event_uuid.length})`);
    const payload = JSON.parse(row.payload_json);
    ok(payload.contract_version === 1, 'payload carries top-level contract_version: 1');
    ok(payload.zone_uuid === ZONE1_UUID, 'payload.zone_uuid matches');
    ok(payload.trigger_metric === 'SWT_WM1', 'payload.trigger_metric matches');
    ok(payload.threshold_kpa === 40, 'payload.threshold_kpa matches');
    ok(payload.enabled === 1, 'payload.enabled matches');
    ok(payload.duration_minutes === 30, 'payload.duration_minutes matches');
    ok(payload.response_mode === 'proportional', 'payload.response_mode matches');
    ok(payload.sync_version === 1, 'payload.sync_version matches');
    ok(payload.deleted_at === null, 'payload.deleted_at is null for a fresh schedule');
  }

  // --- Case 3: cloud-command shape (lifecycle.js:358 inserts the command's
  // version and response_mode) emits the same single confirmation echo the
  // update trigger already emits for cloud-command updates ---------------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(scheduleInsertSql(2, { sync_version: 5, response_mode: 'fixed', threshold_kpa: 55 }));
  const rows3 = await runner.all("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type='SCHEDULE' AND aggregate_key='" + ZONE2_UUID + "';");
  ok(rows3.length === 1, 'cloud-command-shaped INSERT emits exactly 1 outbox row (no double echo)');
  if (rows3.length === 1) {
    const payload = JSON.parse(rows3[0].payload_json);
    ok(Number(rows3[0].sync_version) === 5, 'cloud-command echo carries the command version (5)');
    ok(payload.response_mode === 'fixed' && payload.threshold_kpa === 55,
      'cloud-command echo carries exactly the commanded values');
  }

  // --- Case 4: UPDATE behaviour unchanged (still the _au trigger) ----------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec("UPDATE irrigation_schedules SET enabled=0, sync_version=COALESCE(sync_version,0)+1, updated_at='2026-11-23T00:01:00.000Z' WHERE irrigation_zone_id=1;");
  const rows4 = await runner.all("SELECT op, sync_version FROM sync_outbox WHERE aggregate_type='SCHEDULE';");
  ok(rows4.length === 1, 'UPDATE enabled emits exactly 1 row (update path unchanged)');
  if (rows4.length === 1) {
    ok(rows4[0].op === 'SCHEDULE_UPSERTED' && Number(rows4[0].sync_version) === 2,
      'update event is SCHEDULE_UPSERTED at the bumped version');
  }

  // --- Case 5: soft delete unchanged ---------------------------------------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec("UPDATE irrigation_schedules SET deleted_at='2026-11-23T00:02:00.000Z', sync_version=COALESCE(sync_version,0)+1, updated_at='2026-11-23T00:02:00.000Z' WHERE irrigation_zone_id=1;");
  const rows5 = await runner.all("SELECT op, payload_json FROM sync_outbox WHERE aggregate_type='SCHEDULE';");
  ok(rows5.length === 1, 'soft delete emits exactly 1 row (delete path unchanged)');
  if (rows5.length === 1) {
    const payload = JSON.parse(rows5[0].payload_json);
    ok(payload.deleted_at === '2026-11-23T00:02:00.000Z', 'soft-delete payload.deleted_at carries the timestamp');
    ok(rows5[0].op === 'SCHEDULE_UPSERTED', 'soft delete stays an upsert (no distinct DELETE op)');
  }

  // --- Case 6: defaults-trigger interplay — an insert still needing
  // normalization (sync_version 0) is reported once, by the defaults
  // UPDATE through _au, never twice ---------------------------------------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(scheduleInsertSql(3, { sync_version: 0 }));
  const rows6 = await runner.all("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type='SCHEDULE' AND aggregate_key='" + ZONE3_UUID + "';");
  ok(rows6.length === 1, 'version-0 INSERT emits exactly 1 row in total (defaults normalize -> _au, no double emit)');
  if (rows6.length === 1) {
    const payload = JSON.parse(rows6[0].payload_json);
    ok(Number(rows6[0].sync_version) === 1 && payload.sync_version === 1,
      'the single event reports the normalized row (version 1)');
  }

  // --- Case 7: NULL response_mode at version > 0 — same partition ----------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(scheduleInsertSql(4, { sync_version: 4, response_mode: null }));
  const rows7 = await runner.all("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type='SCHEDULE' AND aggregate_key='" + ZONE4_UUID + "';");
  ok(rows7.length === 1, 'NULL response_mode INSERT emits exactly 1 row in total (defaults fill -> _au, no double emit)');
  if (rows7.length === 1) {
    const payload = JSON.parse(rows7[0].payload_json);
    ok(payload.response_mode === 'proportional',
      'the single event reports the normalized row (response_mode proportional)');
  }

  await runner.close();
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`test-schedule-insert-outbox-trigger: FAIL (${failures} assertion(s) failed)`);
    process.exit(1);
  }
  console.log('test-schedule-insert-outbox-trigger: OK');
}

main().catch((e) => { console.error(e); process.exit(2); });
