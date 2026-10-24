#!/usr/bin/env node
'use strict';

// Migration rehearsal for Task3a. Every case uses the real ordered runner and
// real SQLite files; no ledger or fingerprint rows are hand-written.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending, bootstrapFresh, verifyHead } = require('../lib/osi-migrate');
const { syncFingerprints } = require('../lib/osi-migrate/runner');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'database/migrations/ordered');
let BASELINE_DB = null;

function tempDir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `conditional-${label}-`)); }
function copyCorpus(dir, maxVersion, renames = {}) {
  for (const name of fs.readdirSync(MIGRATIONS)) {
    const match = /^(\d{4})__.*\.sql$/.exec(name);
    if (!match || Number(match[1]) > maxVersion) continue;
    const target = renames[name] || name;
    fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, target));
  }
}
function manifest(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    out[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  }
  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), `${JSON.stringify(out, null, 2)}\n`);
}
async function openAt73(label) {
  const dir = tempDir(label);
  const corpus = path.join(dir, 'migrations'); fs.mkdirSync(corpus);
  copyCorpus(corpus, 73); manifest(corpus);
  const dbPath = path.join(dir, 'farming.db');
  if (!BASELINE_DB) {
    BASELINE_DB = path.join(tempDir('baseline-image'), 'farming.db');
    // Pin the immutable pre-Task3a image. The working tree image is regenerated
    // through the final integrated head later in this task and must not silently change this upgrade
    // fixture into a no-op.
    let baseline;
    try {
      baseline = execFileSync('git', ['show', 'f130073205aa26abaa5d71097b354df39e9fe753:database/farming.db'], { maxBuffer: 8 * 1024 * 1024 });
    } catch (_error) {
      const fallback = cliRunner(BASELINE_DB);
      await bootstrapFresh(fallback, { migrationsDir: corpus, appVersion: 'task3a-rehearsal-fallback' });
      baseline = fs.readFileSync(BASELINE_DB);
    }
    fs.writeFileSync(BASELINE_DB, baseline);
    const baselineRunner = cliRunner(BASELINE_DB);
    assert.equal((await baselineRunner.all('SELECT MAX(version) AS version FROM schema_migrations'))[0].version, 73);
  }
  fs.copyFileSync(BASELINE_DB, dbPath);
  const runner = cliRunner(dbPath);
  return { dir, corpus, dbPath, runner };
}
async function seedLegacy(runner) {
  await runner.exec("PRAGMA foreign_keys=ON; INSERT INTO users(id,user_uuid,username,password_hash,role,created_at,updated_at) VALUES(1,'legacy-user','legacy','hash','admin','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'); INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(1,'Legacy zone',1,'zone-legacy','Europe/Zurich','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'); INSERT INTO devices(id,deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id) VALUES(1,'A840410000000001','Legacy valve','STREGA_VALVE',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1); INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(1,'A840410000000001','2026-10-17T05:55:00Z',55); INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled) VALUES('legacy-schedule','A840410000000001','WEEKLY',127,'06:00',20,'Europe/Zurich',1); INSERT INTO sync_link_state(peer_node,linked,server_url,updated_at) VALUES('cloud',1,'https://example.test','2026-01-01T00:00:00Z'); INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at) VALUES('legacy-event','LEGACY','legacy','LEGACY_UPSERT','{}',1,'2026-01-01T00:00:00Z');");
}
async function migrationUpgrade() {
  const setup = await openAt73('upgrade');
  await seedLegacy(setup.runner);
  const before = {};
  const preservedQueries = {
    devices: 'SELECT id,deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id FROM devices ORDER BY rowid',
    device_data: 'SELECT id,deveui,recorded_at,swt_1 FROM device_data ORDER BY rowid',
    valve_schedules: 'SELECT id,schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,fire_at,duration_minutes,timezone,enabled,once_state,once_fired_at,sync_version,deleted_at,created_at,updated_at FROM valve_schedules ORDER BY rowid',
    sync_outbox: 'SELECT * FROM sync_outbox ORDER BY rowid',
  };
  for (const [table, query] of Object.entries(preservedQueries)) before[table] = await setup.runner.all(query);
  copyCorpus(setup.corpus, 76); manifest(setup.corpus);
  const result = await applyPending(setup.runner, { migrationsDir: setup.corpus, appVersion: 'task3a-rehearsal' });
  assert.deepEqual(result.applied, [74, 75, 76]);
  for (const [table, query] of Object.entries(preservedQueries)) assert.deepEqual(await setup.runner.all(query), before[table], `${table} row content changed`);
  assert.equal((await setup.runner.all('PRAGMA foreign_key_check')).length, 0);
  assert.equal((await setup.runner.all("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=76 AND status='applied'"))[0].n, 1);
  assert.equal((await setup.runner.all("SELECT COUNT(*) AS n FROM schema_object_fingerprints"))[0].n > 0, true);
  const policyTriggers = await setup.runner.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_sync_irrigation_policies%'");
  assert.deepEqual(policyTriggers, [], '0074 must not emit policy sync events');
  const scheduleTrigger = (await setup.runner.all("SELECT sql FROM sqlite_master WHERE name='trg_sync_valve_schedules_outbox_ai'"))[0].sql;
  assert.doesNotMatch(scheduleTrigger, /condition_policy_uuid|effective_from/,
    '0074 must leave the 0024 schedule payload unchanged');
  const beforePolicyEvents = (await setup.runner.all("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY'"))[0].n;
  await setup.runner.exec("UPDATE sync_link_state SET peer_capabilities_json='[\"conditional_irrigation_v1\"]' WHERE peer_node='cloud'; INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone) VALUES('policy-no-event','zone-legacy','{}','Europe/Zurich');");
  const afterPolicyEvents = (await setup.runner.all("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY'"))[0].n;
  assert.equal(afterPolicyEvents, beforePolicyEvents);
  await setup.runner.exec("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,condition_policy_uuid,effective_from) VALUES('schedule-no-fields','A840410000000001','WEEKLY',127,'07:00',10,'Europe/Zurich',1,'policy-no-event','2026-10-17T00:00:00Z');");
  const scheduleEvent = (await setup.runner.all("SELECT payload_json FROM sync_outbox WHERE aggregate_key='schedule-no-fields' ORDER BY rowid DESC LIMIT 1"))[0];
  const schedulePayload = JSON.parse(scheduleEvent.payload_json);
  assert.equal(schedulePayload.condition_policy_uuid, undefined);
  assert.equal(schedulePayload.effective_from, undefined);
  return setup;
}
async function freshInstall() {
  const dir = tempDir('fresh'); const corpus = path.join(dir, 'migrations'); fs.mkdirSync(corpus);
  copyCorpus(corpus, 76); manifest(corpus);
  const runner = cliRunner(path.join(dir, 'farming.db'));
  await bootstrapFresh(runner, { migrationsDir: corpus, appVersion: 'task3a-fresh' });
  const head = await verifyHead(runner, { migrationsDir: corpus });
  assert.equal(head.ok, true); assert.equal((await runner.all('PRAGMA foreign_key_check')).length, 0);
}
async function compatibleColumns() {
  const setup = await openAt73('compatible');
  await setup.runner.exec('ALTER TABLE valve_schedules ADD COLUMN condition_policy_uuid TEXT; ALTER TABLE valve_schedules ADD COLUMN effective_from TEXT; ALTER TABLE valve_settings ADD COLUMN conditional_control_json TEXT; ALTER TABLE valve_schedule_pushes ADD COLUMN transport_json TEXT; ALTER TABLE valve_actuation_expectations ADD COLUMN transport_json TEXT; ALTER TABLE sync_link_state ADD COLUMN peer_capabilities_json TEXT; ALTER TABLE sync_link_state ADD COLUMN peer_capabilities_context_json TEXT; ALTER TABLE sync_link_state ADD COLUMN peer_capabilities_request_id TEXT; ALTER TABLE sync_link_state ADD COLUMN link_attempt_json TEXT;');
  await syncFingerprints(setup.runner);
  copyCorpus(setup.corpus, 75); manifest(setup.corpus);
  const mainResult = await applyPending(setup.runner, { migrationsDir: setup.corpus, appVersion: 'task3a-compatible-main' });
  assert.deepEqual(mainResult.applied, [74, 75]);
  copyCorpus(setup.corpus, 76); manifest(setup.corpus);
  const result = await applyPending(setup.runner, { migrationsDir: setup.corpus, appVersion: 'task3a-compatible-feature' });
  assert.deepEqual(result.applied, [76]);
  assert.equal((await setup.runner.all('PRAGMA foreign_key_check')).length, 0);
}
async function mainHeadToFeature() {
  const setup = await openAt73('main-head-to-feature');
  await seedLegacy(setup.runner);
  copyCorpus(setup.corpus, 75); manifest(setup.corpus);
  const main = await applyPending(setup.runner, { migrationsDir: setup.corpus, appVersion: 'task3a-main-head' });
  assert.deepEqual(main.applied, [74, 75]);
  assert.equal((await setup.runner.all('SELECT MAX(version) AS version FROM schema_migrations'))[0].version, 75);
  copyCorpus(setup.corpus, 76); manifest(setup.corpus);
  const feature = await applyPending(setup.runner, { migrationsDir: setup.corpus, appVersion: 'task3a-main-head-feature' });
  assert.deepEqual(feature.applied, [76]);
}
async function customerNumbered() {
  const setup = await openAt73('customer-numbered');
  const customer = '0994__customer_conditional_irrigation.sql';
  copyCorpus(setup.corpus, 73); fs.copyFileSync(path.join(MIGRATIONS, '0076__conditional_irrigation.sql'), path.join(setup.corpus, customer)); manifest(setup.corpus);
  const result = await applyPending(setup.runner, { migrationsDir: setup.corpus, appVersion: 'task3a-customer' });
  assert.deepEqual(result.applied, [994]);
  assert.equal((await setup.runner.all("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=994 AND status='applied'"))[0].n, 1);
  assert.equal((await setup.runner.all('PRAGMA foreign_key_check')).length, 0);
}

(async () => {
  await migrationUpgrade(); await freshInstall(); await compatibleColumns(); await mainHeadToFeature(); await customerNumbered();
  console.log('test-conditional-irrigation-schema: OK (0073->final, main 0075->0076, compatible columns, fresh head, customer numbering)');
})().catch((error) => { console.error(`test-conditional-irrigation-schema: FAILED: ${error.stack || error.message}`); process.exitCode = 1; });
