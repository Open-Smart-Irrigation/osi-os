#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const ORDERED_MIGRATIONS = path.join(
  REPO,
  'database/migrations/ordered'
);
const PRE_MIGRATION_FILES = fs.readdirSync(ORDERED_MIGRATIONS)
  .filter((name) => /^\d{4}__.*\.sql$/.test(name))
  .filter((name) => Number(name.slice(0, 4)) <= 35)
  .sort();
const ADDITIVE_MIGRATION = path.join(
  REPO,
  'database/migrations/ordered/0036__zone_irrigation_calibration_sync.sql'
);
const DATA_MIGRATION = path.join(
  REPO,
  'database/migrations/ordered/0037__zone_irrigation_calibration_backfill.sql'
);
const GATEWAY_EUI = '0016C001F11715E2';
const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ZONE_UUID = '22222222-2222-4222-8222-222222222222';
const MEASURED_AT = '2026-07-24T10:00:00.000Z';

function seededDatabase() {
  const db = new DatabaseSync(':memory:');
  for (const migrationName of PRE_MIGRATION_FILES) {
    db.exec(fs.readFileSync(
      path.join(ORDERED_MIGRATIONS, migrationName),
      'utf8'
    ));
  }
  db.prepare(`
    INSERT INTO users (
      username,
      password_hash,
      created_at,
      user_uuid,
      cloud_user_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    'grower',
    'not-a-real-hash',
    '2026-07-24T00:00:00.000Z',
    USER_UUID,
    17
  );
  db.prepare(`
    INSERT INTO sync_link_state (
      peer_node,
      linked,
      server_url,
      cloud_user_id,
      gateway_device_eui,
      updated_at
    ) VALUES ('cloud', 1, ?, ?, ?, ?)
    ON CONFLICT(peer_node) DO UPDATE SET
      linked = excluded.linked,
      server_url = excluded.server_url,
      cloud_user_id = excluded.cloud_user_id,
      gateway_device_eui = excluded.gateway_device_eui,
      updated_at = excluded.updated_at
  `).run(
    'https://example.invalid',
    '17',
    GATEWAY_EUI,
    '2026-07-24T00:00:00.000Z'
  );
  db.prepare(`
    INSERT INTO irrigation_zones (
      name,
      user_id,
      zone_uuid,
      gateway_device_eui,
      sync_version,
      created_at,
      updated_at
    ) VALUES (
      'North',
      (SELECT id FROM users WHERE user_uuid = ?),
      ?,
      ?,
      1,
      ?,
      ?
    )
  `).run(
    USER_UUID,
    ZONE_UUID,
    GATEWAY_EUI,
    '2026-07-24T00:01:00.000Z',
    '2026-07-24T00:01:00.000Z'
  );
  db.exec('DELETE FROM sync_outbox');
  return db;
}

function applyMigration(db, migrationPath) {
  db.exec(fs.readFileSync(migrationPath, 'utf8'));
}

function calibrationEvents(db) {
  return db.prepare(`
    SELECT aggregate_type, aggregate_key, op, payload_json, sync_version,
           gateway_device_eui
      FROM sync_outbox
     WHERE aggregate_type = 'IRRIGATION_CALIBRATION'
     ORDER BY occurred_at, event_uuid
  `).all();
}

test('backfill assigns version one and emits the initial calibration mirror', () => {
  const db = seededDatabase();
  try {
    db.prepare(`
      INSERT INTO zone_irrigation_calibration (
        zone_id,
        valve_device_eui,
        measured_flow_rate_lpm,
        measurement_method,
        measured_at,
        created_at,
        updated_at
      ) VALUES (
        (SELECT id FROM irrigation_zones WHERE zone_uuid = ?),
        NULL,
        12.5,
        'Timed bucket test',
        ?,
        ?,
        ?
      )
    `).run(ZONE_UUID, MEASURED_AT, MEASURED_AT, MEASURED_AT);

    applyMigration(db, ADDITIVE_MIGRATION);
    applyMigration(db, DATA_MIGRATION);

    const row = db.prepare(`
      SELECT sync_version
        FROM zone_irrigation_calibration
       WHERE zone_id = (
         SELECT id FROM irrigation_zones WHERE zone_uuid = ?
       )
    `).get(ZONE_UUID);
    assert.equal(row.sync_version, 1);

    const events = calibrationEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].aggregate_key, ZONE_UUID);
    assert.equal(events[0].op, 'ZONE_IRRIGATION_CALIBRATION_UPSERTED');
    assert.equal(events[0].sync_version, 1);
    assert.equal(events[0].gateway_device_eui, GATEWAY_EUI);
    assert.deepEqual(JSON.parse(events[0].payload_json), {
      contract_version: 1,
      zone_uuid: ZONE_UUID,
      gateway_device_eui: GATEWAY_EUI,
      measured_flow_rate_lpm: 12.5,
      measurement_method: 'Timed bucket test',
      measured_at: MEASURED_AT,
      sync_version: 1,
      deleted_at: null,
      last_applied_at: null,
    });
  } finally {
    db.close();
  }
});

test('local calibration update emits the next version', () => {
  const db = seededDatabase();
  try {
    applyMigration(db, ADDITIVE_MIGRATION);
    applyMigration(db, DATA_MIGRATION);
    db.prepare(`
      INSERT INTO zone_irrigation_calibration (
        zone_id,
        valve_device_eui,
        measured_flow_rate_lpm,
        measurement_method,
        measured_at,
        created_at,
        updated_at
      ) VALUES (
        (SELECT id FROM irrigation_zones WHERE zone_uuid = ?),
        NULL,
        10,
        'Initial test',
        ?,
        ?,
        ?
      )
    `).run(ZONE_UUID, MEASURED_AT, MEASURED_AT, MEASURED_AT);
    db.exec('DELETE FROM sync_outbox');

    db.prepare(`
      UPDATE zone_irrigation_calibration
         SET measured_flow_rate_lpm = 14.25,
             measurement_method = 'Retested',
             measured_at = ?,
             updated_at = ?,
             sync_version = 2
       WHERE zone_id = (
         SELECT id FROM irrigation_zones WHERE zone_uuid = ?
       )
    `).run(
      '2026-07-24T11:00:00.000Z',
      '2026-07-24T11:00:00.000Z',
      ZONE_UUID
    );

    const events = calibrationEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].sync_version, 2);
    assert.deepEqual(
      JSON.parse(events[0].payload_json),
      {
        contract_version: 1,
        zone_uuid: ZONE_UUID,
        gateway_device_eui: GATEWAY_EUI,
        measured_flow_rate_lpm: 14.25,
        measurement_method: 'Retested',
        measured_at: '2026-07-24T11:00:00.000Z',
        sync_version: 2,
        deleted_at: null,
        last_applied_at: null,
      }
    );
  } finally {
    db.close();
  }
});
