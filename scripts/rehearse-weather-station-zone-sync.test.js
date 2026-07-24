#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(REPO, 'database/migrations/ordered');
const PRE_MIGRATIONS = fs.readdirSync(MIGRATIONS)
  .filter((name) => /^\d{4}__.*\.sql$/.test(name))
  .filter((name) => Number(name.slice(0, 4)) <= 37)
  .sort();
const ADDITIVE = path.join(
  MIGRATIONS,
  '0038__weather_station_zone_sync.sql'
);
const BACKFILL = path.join(
  MIGRATIONS,
  '0039__weather_station_zone_backfill.sql'
);
const GATEWAY = '0016C001F11715E2';
const DEVICE = '0123456789ABCDEF';
const USER = '11111111-1111-4111-8111-111111111111';
const ZONE_A = '22222222-2222-4222-8222-222222222222';
const ZONE_B = '33333333-3333-4333-8333-333333333333';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA legacy_alter_table=ON');
  for (const name of PRE_MIGRATIONS) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, name), 'utf8'));
  }
  // The historical 0010 devices rebuild rewrites this child FK when replayed
  // in isolation. Shipped databases already carry the repaired canonical
  // junction shape; reproduce that pre-0038 live baseline here.
  db.exec(`
    DROP TABLE weather_station_zones;
    CREATE TABLE weather_station_zones (
      deveui TEXT NOT NULL,
      zone_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (deveui, zone_id),
      FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE,
      FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_wsz_zone_id ON weather_station_zones(zone_id);
  `);
  const now = '2026-07-24T00:00:00.000Z';
  db.prepare(`
    INSERT INTO users (
      username,password_hash,created_at,updated_at,user_uuid
    ) VALUES ('grower','not-a-real-hash',?,?,?)
  `).run(now, now, USER);
  for (const [name, uuid] of [['Zulu', ZONE_B], ['Alpha', ZONE_A]]) {
    db.prepare(`
      INSERT INTO irrigation_zones (
        name,user_id,zone_uuid,gateway_device_eui,sync_version,
        created_at,updated_at
      ) VALUES (
        ?,(SELECT id FROM users WHERE user_uuid=?),?,?,1,?,?
      )
    `).run(name, USER, uuid, GATEWAY, now, now);
  }
  db.prepare(`
    INSERT INTO devices (
      deveui,name,type_id,user_id,gateway_device_eui,sync_version,
      created_at,updated_at
    ) VALUES (
      ?,'Weather','SENSECAP_S2120',
      (SELECT id FROM users WHERE user_uuid=?),?,1,?,?
    )
  `).run(DEVICE, USER, GATEWAY, now, now);
  db.prepare(`
    INSERT INTO sync_link_state (
      peer_node,linked,server_url,cloud_user_id,gateway_device_eui,updated_at
    ) VALUES ('cloud',1,'https://example.invalid',17,?,?)
    ON CONFLICT(peer_node) DO UPDATE SET
      linked=excluded.linked,
      gateway_device_eui=excluded.gateway_device_eui,
      updated_at=excluded.updated_at
  `).run(GATEWAY, now);
  db.exec('DELETE FROM sync_outbox');
  return db;
}

function apply(db, file) {
  db.exec(fs.readFileSync(file, 'utf8'));
}

function events(db) {
  return db.prepare(`
    SELECT aggregate_type,aggregate_key,op,payload_json,sync_version,
           gateway_device_eui
      FROM sync_outbox
     WHERE aggregate_type='WEATHER_STATION_ZONES'
     ORDER BY rowid
  `).all();
}

test('backfill versions and publishes the complete sorted S2120 assignment set', () => {
  const db = database();
  try {
    db.prepare(`
      INSERT INTO weather_station_zones(deveui,zone_id)
      SELECT ?,id FROM irrigation_zones WHERE zone_uuid=?
    `).run(DEVICE, ZONE_B);
    db.prepare(`
      INSERT INTO weather_station_zones(deveui,zone_id)
      SELECT ?,id FROM irrigation_zones WHERE zone_uuid=?
    `).run(DEVICE, ZONE_A);

    apply(db, ADDITIVE);
    apply(db, BACKFILL);

    assert.equal(
      db.prepare(`
        SELECT sync_version FROM weather_station_zone_state WHERE deveui=?
      `).get(DEVICE).sync_version,
      1
    );
    const emitted = events(db);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].aggregate_key, DEVICE);
    assert.equal(emitted[0].op, 'WEATHER_STATION_ZONES_REPLACED');
    assert.equal(emitted[0].sync_version, 1);
    assert.equal(emitted[0].gateway_device_eui, GATEWAY);
    assert.deepEqual(JSON.parse(emitted[0].payload_json), {
      contract_version: 1,
      device_eui: DEVICE,
      gateway_device_eui: GATEWAY,
      zone_uuids: [ZONE_A, ZONE_B],
      sync_version: 1,
      last_applied_at: null,
    });

    apply(db, BACKFILL);
    assert.equal(events(db).length, 1);
  } finally {
    db.close();
  }
});

test('one state version update publishes only the final replacement set', () => {
  const db = database();
  try {
    apply(db, ADDITIVE);
    apply(db, BACKFILL);
    db.exec('DELETE FROM sync_outbox');

    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM weather_station_zones WHERE deveui=?').run(DEVICE);
    db.prepare(`
      INSERT INTO weather_station_zones(deveui,zone_id)
      SELECT ?,id FROM irrigation_zones WHERE zone_uuid=?
    `).run(DEVICE, ZONE_B);
    db.prepare(`
      UPDATE weather_station_zone_state
         SET sync_version=2,
             updated_at='2026-07-24T01:00:00.000Z'
       WHERE deveui=?
    `).run(DEVICE);
    db.exec('COMMIT');

    const emitted = events(db);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].sync_version, 2);
    assert.deepEqual(
      JSON.parse(emitted[0].payload_json).zone_uuids,
      [ZONE_B]
    );
  } finally {
    db.close();
  }
});
