#!/usr/bin/env node
'use strict';

// Migration 0066 and the zone update trigger it carries (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B2): the
// migration applies to a database at 0065, its trigger body is the canonical
// source's (which generate-sync-trigger-source.js renders into sync-init-fn),
// and on every bundled database a start date change alone emits one
// ZONE_CONFIG_UPSERTED carrying stage_started_on, which every zone payload
// carries (null when unset) beside 0065's conditional weather_source.
//
// Run: node --test scripts/test-stage-started-on-migration.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { canonicalizeTriggerSql } = require('./verify-trigger-body-parity');
const { SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0066__stage_started_on.sql'), 'utf8');
const CANONICAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/sync-trigger-source.json'), 'utf8'))
  .triggers.find((t) => t.name === 'trg_sync_zones_outbox_au').sql;
const GATEWAY = '00000000000000B1';
const ZONE_UUID = '306fa8ef-20f8-4911-b9c4-f99f60252579';

function triggerSql(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_sync_zones_outbox_au'").get().sql;
}
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// The seed minus what 0066 adds: the schema of a gateway at 0065.
function databaseAt0065() {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  // SQLite refuses to drop a column a trigger reads: the zone update trigger goes
  // first, and so does any later migration's trigger on the three agronomy columns.
  const readers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND "
    + "(sql LIKE '%stage_started_on%' OR sql LIKE '%kc_stage_day%' OR sql LIKE '%stage_overrun%')").all();
  for (const { name } of readers) db.exec(`DROP TRIGGER ${name}`);
  db.exec('ALTER TABLE irrigation_zones DROP COLUMN stage_started_on');
  for (const column of ['stage_started_on', 'kc_stage_day', 'stage_overrun']) db.exec(`ALTER TABLE zone_daily_agronomy DROP COLUMN ${column}`);
  return db;
}

test('0066 applies to a database at 0065 and creates the canonical trigger body', () => {
  const db = databaseAt0065();
  try {
    assert.ok(!columns(db, 'irrigation_zones').includes('stage_started_on'));
    db.exec(MIGRATION);
    assert.ok(columns(db, 'irrigation_zones').includes('stage_started_on'));
    for (const column of ['stage_started_on', 'kc_stage_day', 'stage_overrun']) assert.ok(columns(db, 'zone_daily_agronomy').includes(column), column);
    assert.equal(triggerSql(db), CANONICAL.replace(/;\s*$/, ''));
    assert.ok(MIGRATION.includes(CANONICAL), 'the migration carries the canonical body byte for byte');
  } finally {
    db.close();
  }
});

test('the seed trigger equals the migration trigger after canonicalization', () => {
  const seedDb = new DatabaseSync(':memory:');
  const migrated = databaseAt0065();
  try {
    seedDb.exec(SEED);
    migrated.exec(MIGRATION);
    assert.equal(canonicalizeTriggerSql(triggerSql(seedDb)), canonicalizeTriggerSql(triggerSql(migrated)));
  } finally {
    seedDb.close();
    migrated.close();
  }
});

function bundledCopy(t, relativePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-ssd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(path.join(ROOT, relativePath), dbPath);
  const db = new DatabaseSync(dbPath);
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', datetime('now'))");
  db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, phenological_stage, created_at, updated_at) '
    + `VALUES (11, 'North', 7, '${ZONE_UUID}', '${GATEWAY}', 1, 'UTC', 'development', datetime('now'), datetime('now'))`);
  return db;
}
function link(db) {
  db.exec(`INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '${GATEWAY}', datetime('now'))`);
}
function zoneEvents(db) {
  return db.prepare("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE' ORDER BY rowid").all()
    .map((row) => ({ op: row.op, syncVersion: Number(row.sync_version), payload: JSON.parse(row.payload_json) }));
}

for (const relativePath of SEED_DB_RELATIVE_PATHS) {
  test(`[${relativePath}] 0066: a start date change alone emits one ZONE_CONFIG_UPSERTED carrying it`, (t) => {
    const db = bundledCopy(t, relativePath);
    link(db);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01', sync_version = 2 WHERE id = 11");
    const events = zoneEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_CONFIG_UPSERTED');
    assert.equal(events[0].payload.stage_started_on, '2026-05-01');
    // 21 fixed pairs and stage_started_on; 0065 leaves weather_source out while the zone
    // stays on 'auto' and the update does not change it.
    assert.equal(Object.keys(events[0].payload).length, 22, 'the zone payload has 22 key-value pairs on auto');
    assert.ok(!('weather_source' in events[0].payload));
    assert.equal(events[0].syncVersion, 2);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET name = 'North block', sync_version = 3 WHERE id = 11");
    const rename = zoneEvents(db);
    assert.deepEqual([rename.length, rename[0].op, rename[0].payload.stage_started_on], [1, 'ZONE_UPSERTED', '2026-05-01']);
    // A zone on a chosen provider: both keys, 23 pairs; a cleared date travels as null.
    db.exec("UPDATE irrigation_zones SET weather_source = 'open_meteo', sync_version = 4 WHERE id = 11");
    db.exec('DELETE FROM sync_outbox');
    db.exec('UPDATE irrigation_zones SET stage_started_on = NULL, sync_version = 5 WHERE id = 11');
    const cleared = zoneEvents(db);
    assert.deepEqual([cleared.length, cleared[0].op, cleared[0].payload.stage_started_on, cleared[0].payload.weather_source], [1, 'ZONE_CONFIG_UPSERTED', null, 'open_meteo']);
    assert.equal(Object.keys(cleared[0].payload).length, 23, 'both keys: 23 key-value pairs');
  });

  test(`[${relativePath}] 0066: an unlinked gateway emits nothing for a date change`, (t) => {
    const db = bundledCopy(t, relativePath);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01', sync_version = 2 WHERE id = 11");
    assert.deepEqual(zoneEvents(db), []);
  });
}
