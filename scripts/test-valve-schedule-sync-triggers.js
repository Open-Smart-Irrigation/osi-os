#!/usr/bin/env node
// Guard for migration 0024__valve_schedule_sync_triggers.sql (Valve control
// Phase B, edge half). Builds a DB by replaying every ordered migration (the
// same mechanism verify-seed-replay.js uses) and asserts the
// trg_sync_valve_schedules_outbox_ai/_au pair emits VALVE_SCHEDULE_UPSERTED
// sync_outbox rows correctly.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const DEVICE_EUI = 'A84041CAFECAFE10';
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

function scheduleInsertSql(uuid, overrides) {
  const r = Object.assign({
    schedule_uuid: uuid,
    device_eui: DEVICE_EUI,
    kind: 'WEEKLY',
    label: 'Morning',
    weekdays_mask: 3, // Sunday + Monday
    start_time: '06:05',
    fire_at: null,
    duration_minutes: 15,
    timezone: 'Europe/Zurich',
    enabled: 1,
    once_state: null,
  }, overrides || {});
  const val = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  return `INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state) VALUES (${val(r.schedule_uuid)}, ${val(r.device_eui)}, ${val(r.kind)}, ${val(r.label)}, ${r.weekdays_mask === null ? 'NULL' : r.weekdays_mask}, ${val(r.start_time)}, ${val(r.fire_at)}, ${r.duration_minutes}, ${val(r.timezone)}, ${r.enabled}, ${val(r.once_state)});`;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-sched-sync-'));
  const dbPath = path.join(dir, 'r.db');
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });

  // Fixture: one STREGA_VALVE device, unlinked to start with (matches a fresh
  // seed: sync_link_state gets no row until a user with server_url/token exists).
  await runner.exec(`
    INSERT INTO users(id, username, password_hash, created_at, user_uuid)
      VALUES(1, 'local', 'x', '2026-08-23T10:00:00.000Z', 'user-1');
    INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui)
      VALUES('${DEVICE_EUI}', 'Valve 1', 'STREGA_VALVE', 1, '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z', '${GATEWAY_EUI}');
  `);

  // --- Case 1: UNLINKED gateway emits nothing -----------------------------
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_link_state WHERE peer_node='cloud';")) === 0,
    'fresh DB has no sync_link_state row (unlinked)');
  await runner.exec(scheduleInsertSql('11111111-1111-4111-8111-111111111111'));
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE';")) === 0,
    'unlinked gateway: INSERT on valve_schedules emits 0 outbox rows');

  // --- Link the gateway ----------------------------------------------------
  await runner.exec(`
    INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at)
    VALUES('cloud', 1, '${GATEWAY_EUI}', '2026-08-23T10:00:00.000Z')
    ON CONFLICT(peer_node) DO UPDATE SET linked=1, gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at;
  `);
  await runner.exec('DELETE FROM sync_outbox;');

  // --- Case 2: LINKED gateway emits on INSERT ------------------------------
  const uuid2 = '22222222-2222-4222-8222-222222222222';
  await runner.exec(scheduleInsertSql(uuid2));
  const rows2 = await runner.all("SELECT aggregate_type, aggregate_key, op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE';");
  ok(rows2.length === 1, 'linked gateway: INSERT on valve_schedules emits exactly 1 outbox row');
  if (rows2.length === 1) {
    const row = rows2[0];
    ok(row.aggregate_type === 'VALVE_SCHEDULE', 'row aggregate_type = VALVE_SCHEDULE');
    ok(row.aggregate_key === uuid2, 'row aggregate_key = schedule_uuid');
    ok(row.op === 'VALVE_SCHEDULE_UPSERTED', "row op = 'VALVE_SCHEDULE_UPSERTED'");
    const payload = JSON.parse(row.payload_json);
    ok(payload.contract_version === 1, 'payload carries top-level contract_version: 1');
    ok(payload.schedule_uuid === uuid2, 'payload.schedule_uuid matches');
    ok(payload.device_eui === DEVICE_EUI, 'payload.device_eui matches');
  }
  const eventUuid2 = await scalar(runner, "SELECT event_uuid FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE';");
  ok(typeof eventUuid2 === 'string' && eventUuid2.length <= 36 && eventUuid2.length > 0,
    `event_uuid is <=36 chars (got ${eventUuid2 && eventUuid2.length})`);

  // --- Case 3a: bare unsynced-column touch (raw SQL, once_fired_at ALONE, ---
  // --- sync_version NOT bumped) -> the guard must not fire. This asserts   ---
  // --- an invariant production never exercises on its own (see 3b below). ---
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(`UPDATE valve_schedules SET once_fired_at='2026-08-23T11:00:00.000Z' WHERE schedule_uuid='${uuid2}';`);
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE';")) === 0,
    '_au: bare once_fired_at UPDATE (sync_version untouched, raw SQL) emits 0 rows');

  // --- Case 3b: production shape -- store.updateSchedule() ALWAYS bumps    ---
  // --- sync_version on every write, including a ONCE firing. Since         ---
  // --- sync_version IS in the guard, a real firing DOES emit exactly one   ---
  // --- event. A test that only covered 3a would be testing a situation     ---
  // --- that cannot occur in production (see plan Task 2 Step 1 case 3).    ---
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(`UPDATE valve_schedules SET once_fired_at='2026-08-23T11:05:00.000Z', sync_version=COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid='${uuid2}';`);
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE';")) === 1,
    '_au: production-shaped firing (once_fired_at + sync_version bump, matching store.updateSchedule) emits exactly 1 row');

  // --- Case 4: _au DOES fire on a synced column (enabled) ------------------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(`UPDATE valve_schedules SET enabled=0, sync_version=COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid='${uuid2}';`);
  ok((await scalar(runner, "SELECT COUNT(*) n FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE';")) === 1,
    '_au: UPDATE enabled (synced column) emits exactly 1 row');

  // --- Case 5: soft delete emits an upsert carrying deleted_at (D5) --------
  await runner.exec('DELETE FROM sync_outbox;');
  await runner.exec(`UPDATE valve_schedules SET deleted_at='2026-08-23T12:00:00.000Z', sync_version=COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid='${uuid2}';`);
  const delRows = await runner.all("SELECT op, payload_json FROM sync_outbox WHERE aggregate_type='VALVE_SCHEDULE';");
  ok(delRows.length === 1, '_au: soft delete (deleted_at) emits exactly 1 row');
  if (delRows.length === 1) {
    const payload = JSON.parse(delRows[0].payload_json);
    ok(payload.deleted_at === '2026-08-23T12:00:00.000Z', 'soft-delete payload.deleted_at is non-null and carries the timestamp');
    ok(delRows[0].op === 'VALVE_SCHEDULE_UPSERTED', 'no distinct DELETE op -- soft delete stays an upsert (VALVE_SCHEDULE_UPSERTED)');
  }

  await runner.close();
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`test-valve-schedule-sync-triggers: FAIL (${failures} assertion(s) failed)`);
    process.exit(1);
  }
  console.log('test-valve-schedule-sync-triggers: OK');
}

main().catch((e) => { console.error(e); process.exit(2); });
