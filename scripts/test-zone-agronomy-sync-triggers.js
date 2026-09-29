#!/usr/bin/env node
'use strict';

// Migration 0067: the daily agronomy record's outbox triggers (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B3). They
// are migration-owned (sync-init-fn does not create them), emit only while the
// gateway is linked and only for a zone with a UUID, carry the B3 payload, fire
// on update only when sync_version changes, and see a retraction as an
// ordinary ZONE_AGRONOMY_UPSERTED with null values.
//
// Run: node --test scripts/test-zone-agronomy-sync-triggers.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0067__zone_daily_agronomy_sync.sql'), 'utf8');
const GATEWAY = '00000000000000A1';
const ZONE_UUID = '306fa8ef-20f8-4911-b9c4-f99f60252579';
const PAYLOAD_KEYS = ['contract_version', 'zone_id', 'zone_uuid', 'date', 'et0_mm', 'et0_tier', 'et0_source', 'et0_station_id',
  'location_key', 'kc', 'kc_source', 'kc_stage_day', 'stage_overrun', 'crop_type', 'phenological_stage', 'stage_started_on',
  'etc_mm', 'hours_present', 'expected_hours', 'null_reason', 'computed_at', 'gateway_device_eui', 'sync_version'];
const TRIGGERS = ['trg_dp_zone_agronomy_outbox_ai', 'trg_dp_zone_agronomy_outbox_au'];

function database({ linked = true, zoneUuid = ZONE_UUID, deleted = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', '2026-01-01')");
  db.prepare("INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, latitude, longitude, crop_type, phenological_stage, created_at, updated_at) VALUES (1, 'North', 7, ?, ?, 1, 'Europe/Zurich', 46.8, 6.95, 'maize', 'mid_season', '2026-01-01', '2026-01-01')")
    .run(zoneUuid, GATEWAY);
  if (linked) db.exec(`INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '${GATEWAY}', '2026-01-01')`);
  // A zone's defaults trigger assigns a UUID at insert; clear it afterwards for the guard case.
  if (zoneUuid === null) db.exec('UPDATE irrigation_zones SET zone_uuid = NULL WHERE id = 1');
  if (deleted) db.exec("UPDATE irrigation_zones SET deleted_at = '2026-09-01T00:00:00Z' WHERE id = 1");
  db.exec('DELETE FROM sync_outbox');
  return db;
}
function agronomyEvents(db) {
  return db.prepare("SELECT aggregate_key, op, sync_version, gateway_device_eui, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE_AGRONOMY' ORDER BY rowid").all()
    .map((row) => ({ key: row.aggregate_key, op: row.op, syncVersion: Number(row.sync_version), eui: row.gateway_device_eui, payload: JSON.parse(row.payload_json) }));
}
const ROW = "INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, et0_tier, et0_source, et0_station_id, kc, kc_source, kc_stage_day, stage_overrun, crop_type, phenological_stage, stage_started_on, etc_mm, hours_present, expected_hours, computed_at, sync_version) "
  + "VALUES (1, '2026-09-20', 3.12, 'station_fao56', 'fao56_hourly', 'S2120AAAA00000001', 0.75, 'fao56_curve', 16, 0, 'maize', 'late_season', '2026-09-05', 2.34, 24, 24, '2026-09-21T00:30:02.114Z', 1)";

test('0067 applies to a database at 0066: the column and both triggers, which sync-init-fn does not create', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SEED);
    for (const name of TRIGGERS) db.exec(`DROP TRIGGER ${name}`);
    db.exec('ALTER TABLE zone_daily_agronomy DROP COLUMN sync_version');
    db.exec(MIGRATION);
    assert.ok(db.prepare('PRAGMA table_info(zone_daily_agronomy)').all().some((c) => c.name === 'sync_version' && c.notnull === 1 && c.dflt_value === '0'));
    for (const name of TRIGGERS) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name), name);
    const flows = fs.readFileSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8');
    for (const name of TRIGGERS) assert.ok(!flows.includes(name), `${name} must stay out of the boot node`);
  } finally {
    db.close();
  }
});

test('an insert emits one ZONE_AGRONOMY_UPSERTED with the B3 payload, keyed zone_uuid|date, at the row version', () => {
  const db = database();
  try {
    db.exec(ROW);
    const [event, ...rest] = agronomyEvents(db);
    assert.deepEqual(rest, []);
    assert.deepEqual([event.key, event.op, event.syncVersion, event.eui], [`${ZONE_UUID}|2026-09-20`, 'ZONE_AGRONOMY_UPSERTED', 1, GATEWAY]);
    assert.deepEqual(Object.keys(event.payload), PAYLOAD_KEYS);
    assert.deepEqual(event.payload, {
      contract_version: 1, zone_id: 1, zone_uuid: ZONE_UUID, date: '2026-09-20', et0_mm: 3.12, et0_tier: 'station_fao56', et0_source: 'fao56_hourly',
      et0_station_id: 'S2120AAAA00000001', location_key: null, kc: 0.75, kc_source: 'fao56_curve', kc_stage_day: 16, stage_overrun: 0,
      crop_type: 'maize', phenological_stage: 'late_season', stage_started_on: '2026-09-05', etc_mm: 2.34, hours_present: 24, expected_hours: 24,
      null_reason: null, computed_at: '2026-09-21T00:30:02.114Z', gateway_device_eui: GATEWAY, sync_version: 1,
    });
  } finally {
    db.close();
  }
});

test('an update emits only when sync_version changes, with the same payload shape', () => {
  const db = database();
  try {
    db.exec(ROW);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE zone_daily_agronomy SET computed_at = '2026-09-21T01:30:00.000Z' WHERE zone_id = 1");
    assert.deepEqual(agronomyEvents(db), [], 'no version change, no event');
    db.exec('UPDATE zone_daily_agronomy SET et0_mm = 3.2, sync_version = sync_version + 1 WHERE zone_id = 1');
    const events = agronomyEvents(db);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].syncVersion, events[0].payload.sync_version, events[0].payload.et0_mm], [2, 2, 3.2]);
    assert.deepEqual(Object.keys(events[0].payload), PAYLOAD_KEYS);
  } finally {
    db.close();
  }
});

test('nothing is emitted while the gateway is unlinked, for a zone without a UUID, or for a deleted zone', () => {
  for (const options of [{ linked: false }, { zoneUuid: null }, { deleted: true }]) {
    const db = database(options);
    try {
      db.exec(ROW);
      db.exec('UPDATE zone_daily_agronomy SET sync_version = 2 WHERE zone_id = 1');
      assert.deepEqual(agronomyEvents(db), [], JSON.stringify(options));
    } finally {
      db.close();
    }
  }
});

const daily = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily');

function facade(db) {
  const scope = { all: async (sql, params) => db.prepare(sql).all(...(params || [])), run: async (sql, params) => { db.prepare(sql).run(...(params || [])); } };
  return {
    ...scope,
    transaction: async (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await fn(scope); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

test('the writer: each new day emits version 1; a retraction emits one event with null values and the next version', async () => {
  daily.resetState();
  const db = database();
  try {
    db.exec("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, kc, kc_source, crop_type, phenological_stage, etc_mm, computed_at, sync_version) VALUES (1, '2026-09-27', 3, 1.2, 'fao56_crop', 'maize', 'mid_season', 3.6, '2026-09-28T00:00:00Z', 3)");
    db.exec('DELETE FROM sync_outbox');
    const summary = await daily.runDaily({ db: facade(db), nowIso: '2026-09-26T06:00:00Z', deploymentDefault: 'open_meteo', warn: () => {} });
    assert.equal(summary.retracted, 1);
    const events = agronomyEvents(db);
    const retraction = events.filter((e) => e.payload.date === '2026-09-27');
    assert.equal(retraction.length, 1);
    assert.deepEqual([retraction[0].syncVersion, retraction[0].payload.null_reason, retraction[0].payload.et0_mm, retraction[0].payload.kc, retraction[0].payload.etc_mm], [4, 'retracted', null, null, null]);
    const newDays = events.filter((e) => e.payload.date < '2026-09-26');
    assert.equal(newDays.length, 7, 'the seven latest completed days, each a new row');
    assert.ok(newDays.every((e) => e.syncVersion === 1 && e.payload.null_reason === 'no_source'));
    db.exec('DELETE FROM sync_outbox');
    await daily.runDaily({ db: facade(db), nowIso: '2026-09-26T06:30:00Z', deploymentDefault: 'open_meteo', warn: () => {} });
    assert.deepEqual(agronomyEvents(db), [], 'an unchanged run emits nothing, and the retracted row is not retracted again');
  } finally {
    db.close();
  }
});

const { executeFunction, loadNode } = require('./lib/scoped-access-harness');
async function bootstrapPayload(db) {
  // The bootstrap is built only for a cloud-linked account.
  db.exec("UPDATE users SET auth_mode = 'server', server_url = 'https://cloud.example.test', server_sync_token = 'fixture-token', user_uuid = COALESCE(user_uuid, '55555555-5555-4555-8555-555555555555') WHERE id = 7");
  const run = await executeFunction(loadNode('sync-bootstrap-build'), {
    msg: {},
    env: { DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'fixture', DEVICE_EUI_CONFIDENCE: 'authoritative' },
    db,
    osiLibModules: { installation: require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper') },
    globals: { fs: { existsSync: () => false, readFileSync: () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } } },
  });
  assert.ok(run.result && run.result.payload, 'the bootstrap node must build a payload: ' + run.warnings.join('; '));
  return run.result.payload;
}

test('the bootstrap snapshot carries zoneAgronomy: 30 days per live zone with a UUID, newest days of every zone first, at most 1,000 rows', async () => {
  const db = database();
  try {
    db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid) VALUES (8, 'second', 'x', '2026-01-01', '66666666-6666-4666-8666-666666666666')");
    const insertZone = db.prepare("INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, created_at, updated_at) VALUES (?, ?, 7, ?, ?, 1, 'UTC', '2026-01-01', '2026-01-01')");
    for (let id = 2; id <= 40; id += 1) insertZone.run(id, 'Z' + id, `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, GATEWAY);
    db.exec("UPDATE irrigation_zones SET deleted_at = '2026-09-01T00:00:00Z' WHERE id = 40");
    const insertRow = db.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, computed_at, sync_version) VALUES (?, date('now', ?), 3, '2026-09-01T00:00:00Z', 1)");
    for (let id = 1; id <= 40; id += 1) for (let back = 1; back <= 31; back += 1) insertRow.run(id, `-${back} day`);
    const payload = await bootstrapPayload(db);
    const rows = payload.zoneAgronomy;
    assert.equal(rows.length, 1000, '39 live zones x 29 or 30 days exceed the cap');
    assert.ok(rows.every((r) => r.zone_id !== 40), 'a deleted zone sends nothing');
    const newest = rows[0].date;
    assert.equal(rows.filter((r) => r.date === newest).length, 39, 'the newest day of every live zone comes first');
    assert.ok(rows.every((r) => r.date >= rows[rows.length - 1].date));
    assert.deepEqual(Object.keys(rows[0]), ['zone_id', 'zone_uuid', 'date', 'et0_mm', 'et0_tier', 'et0_source', 'et0_station_id', 'location_key', 'kc', 'kc_source', 'kc_stage_day', 'stage_overrun', 'crop_type', 'phenological_stage', 'stage_started_on', 'etc_mm', 'hours_present', 'expected_hours', 'null_reason', 'computed_at', 'sync_version']);
    const oldest = db.prepare("SELECT date('now', '-30 day') AS d").get().d;
    assert.ok(rows.every((r) => r.date >= oldest), 'nothing older than 30 days');
  } finally {
    db.close();
  }
});
