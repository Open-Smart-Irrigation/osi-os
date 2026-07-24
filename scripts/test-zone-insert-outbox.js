#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(
  path.join(REPO, 'database/seed-blank.sql'),
  'utf8'
);
const GATEWAY_EUI = '0016C001F11715E2';
const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ZONE_UUID = '22222222-2222-4222-8222-222222222222';

function seededDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
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
  return db;
}

test('linked zone insert emits one complete ZONE_UPSERTED event', () => {
  const db = seededDatabase();
  try {
    db.prepare(`
      INSERT INTO irrigation_zones (
        name,
        user_id,
        zone_uuid,
        gateway_device_eui,
        timezone,
        latitude,
        longitude,
        phenological_stage,
        calibration_key,
        crop_type,
        variety,
        soil_type,
        irrigation_method,
        area_m2,
        irrigation_efficiency_pct,
        scheduling_mode,
        prediction_card_enabled,
        notes,
        sync_version,
        created_at,
        updated_at
      ) VALUES (
        ?,
        (SELECT id FROM users WHERE user_uuid = ?),
        ?,
        ?,
        'Europe/Zurich',
        47.3769,
        8.5417,
        'flowering',
        'pear-v1',
        'pear',
        'conference',
        'loam',
        'drip',
        1500,
        87.5,
        'server_preferred',
        1,
        'north block',
        1,
        '2026-07-24T00:01:00.000Z',
        '2026-07-24T00:01:00.000Z'
      )
    `).run('North', USER_UUID, ZONE_UUID, GATEWAY_EUI);

    const rows = db.prepare(`
      SELECT aggregate_type, aggregate_key, op, payload_json, sync_version,
             gateway_device_eui
        FROM sync_outbox
       WHERE aggregate_type = 'ZONE'
       ORDER BY occurred_at, event_uuid
    `).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].aggregate_key, ZONE_UUID);
    assert.equal(rows[0].op, 'ZONE_UPSERTED');
    assert.equal(rows[0].sync_version, 1);
    assert.equal(rows[0].gateway_device_eui, GATEWAY_EUI);

    const payload = JSON.parse(rows[0].payload_json);
    assert.deepEqual(payload, {
      contract_version: 1,
      zone_uuid: ZONE_UUID,
      name: 'North',
      gateway_device_eui: GATEWAY_EUI,
      timezone: 'Europe/Zurich',
      latitude: 47.3769,
      longitude: 8.5417,
      phenological_stage: 'flowering',
      calibration_key: 'pear-v1',
      crop_type: 'pear',
      variety: 'conference',
      soil_type: 'loam',
      irrigation_method: 'drip',
      area_m2: 1500,
      irrigation_efficiency_pct: 87.5,
      scheduling_mode: 'server_preferred',
      prediction_card_enabled: 1,
      notes: 'north block',
      sync_version: 1,
      deleted_at: null,
      user: {
        user_uuid: USER_UUID,
        username: 'grower',
        cloudUserId: 17,
      },
    });
  } finally {
    db.close();
  }
});

test('default-filling insert emits one event after identity fields are populated', () => {
  const db = seededDatabase();
  try {
    db.prepare(`
      INSERT INTO irrigation_zones (
        name,
        user_id,
        created_at,
        updated_at
      ) VALUES (
        ?,
        (SELECT id FROM users WHERE user_uuid = ?),
        ?,
        ?
      )
    `).run(
      'Defaults',
      USER_UUID,
      '2026-07-24T00:02:00.000Z',
      '2026-07-24T00:02:00.000Z'
    );

    const zone = db.prepare(`
      SELECT zone_uuid, gateway_device_eui, sync_version
        FROM irrigation_zones
       WHERE name = 'Defaults'
    `).get();
    assert.match(zone.zone_uuid, /^[0-9a-f]{32}$/);
    assert.equal(zone.gateway_device_eui, GATEWAY_EUI);
    assert.equal(zone.sync_version, 1);

    const events = db.prepare(`
      SELECT aggregate_key, op, payload_json, sync_version
        FROM sync_outbox
       WHERE aggregate_type = 'ZONE'
    `).all();
    assert.equal(events.length, 1);
    assert.equal(events[0].aggregate_key, zone.zone_uuid);
    assert.equal(events[0].op, 'ZONE_UPSERTED');
    assert.equal(events[0].sync_version, 1);
    assert.equal(JSON.parse(events[0].payload_json).zone_uuid, zone.zone_uuid);
  } finally {
    db.close();
  }
});
