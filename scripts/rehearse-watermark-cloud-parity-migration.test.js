'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const migrationPath = path.join(root, 'database/migrations/ordered/0068__watermark_cloud_parity.sql');

function dbWithMigration() {
  assert.ok(fs.existsSync(migrationPath), 'Task 7 migration 0068 must exist');
  const db = new DatabaseSync(':memory:');
  const migrationsDir = path.join(root, 'database/migrations/ordered');
  for (const name of fs.readdirSync(migrationsDir).filter((name) => /^\d{4}__.*\.sql$/.test(name) && name < '0068__watermark_cloud_parity.sql').sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
  }
  db.exec(fs.readFileSync(migrationPath, 'utf8'));
  return db;
}

function setup(db) {
  db.prepare("INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES ('cloud',1,?,?)")
    .run('0016C001F11715E2', '2026-10-01T10:00:00.000Z');
  db.prepare("INSERT INTO devices(deveui,name,type_id,created_at,updated_at,gateway_device_eui) VALUES (?,?,?,?,?,?)")
    .run('A84041A171000002', 'Watermark fixture', 'DRAGINO_LSN50', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', '0016C001F11715E2');
}

function insertCalibration(db, deletedAt = null, version = 1) {
  db.prepare(`INSERT INTO watermark_calibrations
    (deveui,pullup_1_ohm,pulldown_1_ohm,series_fwd_1_ohm,series_rev_1_ohm,
     pullup_2_ohm,pulldown_2_ohm,series_fwd_2_ohm,series_rev_2_ohm,
     measured_at,method,worst_residual_pct,notes,sync_version,updated_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'A84041A171000002', 33000, 33000, 10, 10, 33000, 33000, 10, 10,
      '2026-10-01T09:00:00.000Z', 'bench', 0.5, 'fixture', version,
      '2026-10-01T10:00:00.000Z', deletedAt);
}

test('0068 adds bound applied-command fields and calibration-only triggers', () => {
  const db = dbWithMigration();
  const columns = db.prepare('PRAGMA table_info(applied_commands)').all().map((row) => row.name);
  for (const column of ['binding_hash', 'intent_hash', 'resource_type', 'resource_id',
    'gateway_device_eui', 'actor_user_uuid', 'base_sync_version', 'operation']) {
    assert.ok(columns.includes(column), `missing applied_commands.${column}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE '%watermark_readings%'").get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_watermark_calibrations_outbox_ai'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_watermark_calibrations_outbox_au'").get());
  db.close();
});

test('0068 emits one uppercase gateway-bound live calibration event and leaves raw readings local', () => {
  const db = dbWithMigration();
  setup(db);
  insertCalibration(db);
  const event = db.prepare('SELECT * FROM sync_outbox ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(event.op, 'WATERMARK_CALIBRATION_UPSERTED');
  assert.equal(event.aggregate_type, 'WATERMARK_CALIBRATION');
  assert.equal(event.aggregate_key, 'A84041A171000002');
  assert.equal(event.gateway_device_eui, '0016C001F11715E2');
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.device_eui, 'A84041A171000002');
  assert.equal(payload.gateway_device_eui, '0016C001F11715E2');
  assert.equal(payload.deleted_at, null);
  assert.equal(payload.sync_version, 1);
  const before = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  db.prepare('INSERT INTO watermark_readings(deveui,recorded_at,payload_hex,frame_status,conversion_version) VALUES (?,?,?,?,?)')
    .run('A84041A171000002', '2026-10-01T10:00:00.000Z', 'aa', 'accepted', 'profile-3');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, before);
  db.close();
});

test('0068 emits a full tombstone event without deleting the calibration row', () => {
  const db = dbWithMigration();
  setup(db);
  insertCalibration(db);
  db.prepare("UPDATE watermark_calibrations SET deleted_at='2026-10-01T11:00:00.000Z',sync_version=2 WHERE deveui=?")
    .run('A84041A171000002');
  const event = db.prepare('SELECT * FROM sync_outbox ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(event.op, 'WATERMARK_CALIBRATION_DELETED');
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.deleted_at, '2026-10-01T11:00:00.000Z');
  assert.equal(payload.pullup_1_ohm, 33000);
  assert.equal(payload.sync_version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM watermark_calibrations WHERE deveui=?').get('A84041A171000002').n, 1);
  db.close();
});
