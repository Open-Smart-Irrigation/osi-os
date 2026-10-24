#!/usr/bin/env node
'use strict';

// Task 7b1 migration rehearsal.  This is deliberately separate from the
// historical 0076 test: it proves the new 0077 table and trigger owner on a
// fresh ledger, a real 0076 -> 0077 upgrade, a pre-existing compatible table,
// and a customer-numbered copy of the same migration.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending, bootstrapFresh, verifyHead } = require('../lib/osi-migrate');
const { syncFingerprints } = require('../lib/osi-migrate/runner');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'database/migrations/ordered');

function tempDir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `conditional-sync-${label}-`)); }

function copyCorpus(dir, maxVersion, renames = {}) {
  for (const name of fs.readdirSync(MIGRATIONS)) {
    const match = /^(\d{4})__.*\.sql$/.exec(name);
    if (!match || Number(match[1]) > maxVersion) continue;
    fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, renames[name] || name));
  }
}

function writeManifest(dir) {
  const checksums = {};
  for (const name of fs.readdirSync(dir).filter((value) => value.endsWith('.sql')).sort()) {
    checksums[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  }
  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), `${JSON.stringify(checksums, null, 2)}\n`);
}

async function bootAt(maxVersion, label, renames = {}) {
  const dir = tempDir(label);
  const corpus = path.join(dir, 'migrations');
  fs.mkdirSync(corpus);
  copyCorpus(corpus, maxVersion, renames);
  writeManifest(corpus);
  const dbPath = path.join(dir, 'farming.db');
  const runner = cliRunner(dbPath);
  await bootstrapFresh(runner, { migrationsDir: corpus, appVersion: `task7b1-${label}` });
  return { dir, corpus, dbPath, runner };
}

// Reuse one real 0076 baseline for the three upgrade variants.  The migration
// runner is process-backed, so closing it before cloning gives every case an
// independent SQLite file without replaying 1..76 three more times.
async function cloneAt76(baseline, label) {
  const dir = tempDir(label);
  const corpus = path.join(dir, 'migrations');
  fs.mkdirSync(corpus);
  copyCorpus(corpus, 76);
  const dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(baseline.dbPath, dbPath);
  return { dir, corpus, dbPath, runner: cliRunner(dbPath) };
}

async function assert0077Objects(runner) {
  assert.equal((await runner.all("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='conditional_irrigation_sync_projections'"))[0].n, 1);
  assert.equal((await runner.all('PRAGMA foreign_key_list(conditional_irrigation_sync_projections)')).length, 0);
  const triggers = await runner.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('trg_sync_irrigation_policies_outbox_ai','trg_sync_irrigation_policies_outbox_au','trg_sync_valve_schedules_outbox_ai','trg_sync_valve_schedules_outbox_au') ORDER BY name");
  assert.equal(triggers.length, 4);
  for (const trigger of triggers) assert.match(trigger.sql, /json_type\(s\.peer_capabilities_json\) = 'array'/);
  const scheduleInsert = triggers.find((trigger) => trigger.name === 'trg_sync_valve_schedules_outbox_ai');
  assert.match(scheduleInsert.sql, /condition_policy_uuid/);
  assert.match(scheduleInsert.sql, /effective_from/);
}

async function freshHead() {
  const setup = await bootAt(77, 'fresh');
  const head = await verifyHead(setup.runner, { migrationsDir: setup.corpus });
  assert.equal(head.ok, true, head.reason);
  assert.equal((await setup.runner.all('SELECT MAX(version) AS version FROM schema_migrations'))[0].version, 77);
  await assert0077Objects(setup.runner);
  assert.equal((await setup.runner.all('PRAGMA foreign_key_check')).length, 0);
}

async function upgradeFrom0076(baseline) {
  const setup = await cloneAt76(baseline, 'upgrade');
  await setup.runner.exec(`
    INSERT INTO users(id,user_uuid,username,password_hash,role,created_at,updated_at)
      VALUES (901,'22345678-1234-4234-8234-123456789abc','sync-schema-user','hash','admin','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z');
    INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at)
      VALUES (901,'Sync schema zone',901,'32345678-1234-4234-8234-123456789abc','UTC','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z');
    INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui)
      VALUES ('0011223344556677','Sync schema valve','STREGA_VALVE',901,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z',901,'8899aabbccddeeff');
    INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version)
      VALUES ('42345678-1234-4234-8234-123456789abc','0011223344556677','WEEKLY',127,'06:00',10,'UTC',1,4);
  `);
  const before = (await setup.runner.all("SELECT schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version FROM valve_schedules WHERE schedule_uuid='42345678-1234-4234-8234-123456789abc'"))[0];
  const c77 = path.join(setup.dir, 'migrations-77');
  fs.mkdirSync(c77);
  copyCorpus(c77, 77);
  writeManifest(c77);
  const result = await applyPending(setup.runner, { migrationsDir: c77, appVersion: 'task7b1-upgrade' });
  assert.deepEqual(result.applied, [77]);
  assert.deepEqual((await setup.runner.all("SELECT schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version FROM valve_schedules WHERE schedule_uuid='42345678-1234-4234-8234-123456789abc'"))[0], before);
  await assert0077Objects(setup.runner);
  assert.equal((await setup.runner.all('PRAGMA foreign_key_check')).length, 0);
}

async function compatibleProjectionTable(baseline) {
  const setup = await cloneAt76(baseline, 'compatible');
  await setup.runner.exec(`
    CREATE TABLE conditional_irrigation_sync_projections (
      projection_kind TEXT NOT NULL CHECK (projection_kind IN ('POLICY_RUNTIME','VALVE_RUNTIME','DECISION')),
      projection_key TEXT NOT NULL,
      projection_revision INTEGER NOT NULL CHECK (projection_revision >= 1),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (projection_kind, projection_key)
    );
  `);
  // This fixture deliberately introduces the compatible table before 0077.
  // Stamp that sanctioned pre-migration shape so applyPending exercises the
  // real compatibility path instead of treating the fixture setup as drift.
  await syncFingerprints(setup.runner);
  const c77 = path.join(setup.dir, 'migrations-77');
  fs.mkdirSync(c77);
  copyCorpus(c77, 77);
  writeManifest(c77);
  const result = await applyPending(setup.runner, { migrationsDir: c77, appVersion: 'task7b1-compatible-table' });
  assert.deepEqual(result.applied, [77]);
  await assert0077Objects(setup.runner);
}

async function customerNumbered(baseline) {
  const setup = await cloneAt76(baseline, 'customer');
  fs.copyFileSync(path.join(MIGRATIONS, '0077__conditional_irrigation_sync.sql'), path.join(setup.corpus, '0994__conditional_irrigation_sync.sql'));
  writeManifest(setup.corpus);
  const result = await applyPending(setup.runner, { migrationsDir: setup.corpus, appVersion: 'task7b1-customer-numbered' });
  assert.deepEqual(result.applied, [994]);
  await assert0077Objects(setup.runner);
  assert.equal((await setup.runner.all("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=994 AND status='applied'"))[0].n, 1);
}

(async () => {
  await freshHead();
  const baseline = await bootAt(76, 'baseline');
  await baseline.runner.close();
  await upgradeFrom0076(baseline);
  await compatibleProjectionTable(baseline);
  await customerNumbered(baseline);
  console.log('test-conditional-irrigation-sync-schema: OK (fresh 0077, 0076 upgrade, compatible table, customer numbering)');
})().catch((error) => {
  console.error(`test-conditional-irrigation-sync-schema: FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
