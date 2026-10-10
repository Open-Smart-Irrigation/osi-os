'use strict';
// Zone-day rain quality on the sync paths (docs/contracts/rainfall/zone-day-projection.md):
// the ZONE_ENVIRONMENT_APPENDED event payload (insert and update triggers,
// migration 0073) carries rain_coverage, rain_selected_deveui,
// rain_policy_version, rain_quality_reasons (a JSON array) and
// rain_received_mm; a legacy row (no rain_policy_version) carries the keys
// with null values.
// Run: node --test scripts/test-zone-env-rain-quality-sync.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { seedTestDb } = require('./lib/flow-node-harness');

const GATEWAY = '0016C001F1000001';
const GAUGE = 'A840410000000001';
const QUALITY_KEYS = ['rain_coverage', 'rain_selected_deveui', 'rain_policy_version', 'rain_quality_reasons', 'rain_received_mm'];

function linkedDb() {
  const db = seedTestDb();
  db.prepare('INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES (?, ?, ?, ?)')
    .run('cloud', 1, GATEWAY, '2026-10-01T00:00:00.000Z');
  return db;
}

function zoneEvents(db, key = 'z-1|2026-10-08') {
  return db.prepare("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE_ENVIRONMENT' AND aggregate_key = ? ORDER BY rowid")
    .all(key).map((row) => ({ op: row.op, syncVersion: row.sync_version, payload: JSON.parse(row.payload_json) }));
}

function insertProjected(db, overrides = {}) {
  const row = {
    zone_id: 1, date: '2026-10-08', rainfall_mm: null, flow_liters: 0, rain_source: 'aquascope_lorain',
    computed_at: '2026-10-08T12:00:00.000Z', sync_version: 1, rain_coverage: 'partial', rain_selected_deveui: GAUGE,
    rain_policy_version: 1, rain_quality_reasons: '["frame_gap"]', rain_received_mm: 2.5, ...overrides,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO zone_daily_environment (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((key) => row[key]));
}

test('insert: the event payload carries the five quality fields, reasons as a JSON array', () => {
  const db = linkedDb();
  insertProjected(db);
  const events = zoneEvents(db);
  assert.equal(events.length, 1);
  const { payload } = events[0];
  assert.equal(events[0].op, 'ZONE_ENVIRONMENT_APPENDED');
  assert.equal(payload.contract_version, 1);
  assert.equal(payload.rain_coverage, 'partial');
  assert.equal(payload.rain_selected_deveui, GAUGE);
  assert.equal(payload.rain_policy_version, 1);
  assert.deepEqual(payload.rain_quality_reasons, ['frame_gap'], 'an array, never a string holding one');
  assert.equal(payload.rain_received_mm, 2.5);
  assert.equal(payload.rainfall_mm, null, 'a present null: the day is not certified');
  assert.ok(Object.prototype.hasOwnProperty.call(payload, 'rainfall_mm'));
  assert.equal(payload.sync_version, 1);
  assert.equal(payload.zone_uuid, 'z-1');
});

test('insert: an empty reason list is an empty array', () => {
  const db = linkedDb();
  insertProjected(db, { rainfall_mm: 4.5, rain_coverage: 'complete', rain_quality_reasons: '[]', rain_received_mm: 4.5 });
  const { payload } = zoneEvents(db)[0];
  assert.deepEqual(payload.rain_quality_reasons, []);
  assert.equal(payload.rainfall_mm, 4.5);
  assert.equal(payload.rain_coverage, 'complete');
});

test('update with a bumped sync_version: one new event with the new values', () => {
  const db = linkedDb();
  insertProjected(db);
  db.prepare(`UPDATE zone_daily_environment SET rainfall_mm = 4.5, rain_coverage = 'complete', rain_quality_reasons = '[]',
    rain_received_mm = 4.5, computed_at = '2026-10-09T00:10:00.000Z', sync_version = sync_version + 1 WHERE zone_id = 1 AND date = '2026-10-08'`).run();
  const events = zoneEvents(db);
  assert.equal(events.length, 2);
  const [first, second] = events;
  assert.ok(second.syncVersion > first.syncVersion);
  assert.equal(second.payload.sync_version, 2);
  assert.equal(second.payload.rainfall_mm, 4.5);
  assert.equal(second.payload.rain_coverage, 'complete');
  assert.deepEqual(second.payload.rain_quality_reasons, []);
  assert.equal(second.payload.rain_received_mm, 4.5);
  assert.equal(second.payload.rain_selected_deveui, GAUGE);
  assert.equal(second.payload.rain_policy_version, 1);
});

test('update without a version bump: no event', () => {
  const db = linkedDb();
  insertProjected(db);
  db.prepare("UPDATE zone_daily_environment SET rain_quality_reasons = '[\"frame_gap\",\"ongoing\"]' WHERE zone_id = 1 AND date = '2026-10-08'").run();
  assert.equal(zoneEvents(db).length, 1);
});

test('a legacy row (five NULLs) carries the five keys with null values', () => {
  const db = linkedDb();
  db.prepare("INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, sync_version) VALUES (1, '2026-10-08', 3.2, 0, 'aquascope_lorain', '2026-10-08T12:00:00.000Z', 1)").run();
  const { payload } = zoneEvents(db)[0];
  for (const key of QUALITY_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `${key} present`);
    assert.equal(payload[key], null, `${key} null`);
  }
  assert.equal(payload.rainfall_mm, 3.2, 'the legacy amount travels as before');
});

test('a row without a rain policy version is never sent with quality fields set', () => {
  const db = linkedDb();
  insertProjected(db, { rain_policy_version: null });
  db.prepare("UPDATE zone_daily_environment SET sync_version = 2 WHERE zone_id = 1 AND date = '2026-10-08'").run();
  const events = zoneEvents(db);
  assert.equal(events.length, 2);
  for (const { payload } of events) {
    for (const key of QUALITY_KEYS) assert.equal(payload[key], null, `${key} null on a row without a policy version`);
  }
});

test('stored reasons that are not a JSON array never fail the write and travel as null', () => {
  const db = linkedDb();
  insertProjected(db, { rain_quality_reasons: 'frame_gap' });
  insertProjected(db, { date: '2026-10-09', rain_quality_reasons: '{"a":1}' });
  assert.equal(zoneEvents(db)[0].payload.rain_quality_reasons, null);
  assert.equal(zoneEvents(db, 'z-1|2026-10-09')[0].payload.rain_quality_reasons, null);
  assert.equal(zoneEvents(db)[0].payload.rain_coverage, 'partial', 'the rest of the row still travels');
});

test('an unlinked gateway emits nothing', () => {
  const db = seedTestDb();
  insertProjected(db);
  assert.equal(zoneEvents(db).length, 0);
});

test('migration 0073 creates the trigger bodies of sync-trigger-source.json byte for byte (the boot node recreates the same)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'database/migrations/ordered/0073__zone_env_rain_quality_sync.sql'), 'utf8');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'scripts/sync-trigger-source.json'), 'utf8'));
  const db = linkedDb();
  db.exec(migration);
  for (const name of ['trg_dp_zone_env_outbox_ai', 'trg_dp_zone_env_outbox_au']) {
    const entry = source.triggers.find((t) => t.name === name);
    assert.ok(migration.includes(`DROP TRIGGER IF EXISTS ${name};\n${entry.sql}\n`), `${name}: migration CREATE equals the canonical entry`);
    const stored = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name).sql;
    assert.equal(`${stored};`, entry.sql, `${name}: sqlite_master holds the canonical body`);
  }
  insertProjected(db);
  assert.deepEqual(zoneEvents(db)[0].payload.rain_quality_reasons, ['frame_gap']);
});
