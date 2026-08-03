#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode, makeAuthHeader } = require('./lib/scoped-access-harness');

const REPO = path.resolve(__dirname, '..');
const WEATHER_COMMANDS_PATH = path.join(
  REPO,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-commands/weather.js'
);
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

// Promise-style facade over the same node:sqlite handle, matching the interface
// osi-device-commands/weather.js expects (db.get/all/run + db.transaction(fn)).
// Mirrors the fixture already proven against this module in weather.test.js.
class PromiseDbView {
  constructor(native) {
    this.native = native;
  }
  get(sql, params) {
    return Promise.resolve(this.native.prepare(sql).get(...(params || [])));
  }
  all(sql, params) {
    return Promise.resolve(this.native.prepare(sql).all(...(params || [])));
  }
  run(sql, params) {
    return Promise.resolve(this.native.prepare(sql).run(...(params || [])));
  }
  async transaction(fn) {
    this.native.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.native.exec('COMMIT');
      return result;
    } catch (error) {
      this.native.exec('ROLLBACK');
      throw error;
    }
  }
}

test('GUI-path scoped weather zone edit (Scoped Weather Zone Assignments) emits the event and survives a later cloud replace at the stale base version', async () => {
  const db = database();
  try {
    apply(db, ADDITIVE);
    apply(db, BACKFILL);
    // 0039 unconditionally seeds a version-1 state row for every existing S2120 at
    // migration time. Remove it here to reproduce the realistic case this bug actually
    // hits: an S2120 claimed *after* 0039 already ran gets no state row until something
    // writes weather_station_zones for it -- which is exactly the GUI-path edit below.
    db.prepare('DELETE FROM weather_station_zone_state WHERE deveui=?').run(DEVICE);
    db.exec('DELETE FROM sync_outbox');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM weather_station_zone_state WHERE deveui=?').get(DEVICE).n,
      0,
      'no assignment-state row must exist yet for this to be a genuine first GUI edit'
    );

    const zoneARow = db.prepare('SELECT id FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_A);
    const userRow = db.prepare('SELECT id FROM users WHERE user_uuid=?').get(USER);
    const secret = 'weather-zone-router-test-secret';
    const auth = makeAuthHeader({ userId: userRow.id, username: 'grower', secret });
    const node = loadNode('scoped-weather-zone-assign-router');
    const msg = {
      req: {
        headers: { authorization: auth },
        params: { deveui: DEVICE },
      },
      payload: { zone_ids: [zoneARow.id] },
    };

    const { result, errors } = await executeFunction(node, {
      msg,
      env: { OSI_SCOPED_ACCESS: '1', AUTH_TOKEN_SECRET: secret },
      db,
    });

    assert.deepEqual(errors, []);
    const response = result[1];
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.zone_ids, [zoneARow.id]);

    const stateRow = db.prepare(
      'SELECT sync_version FROM weather_station_zone_state WHERE deveui=?'
    ).get(DEVICE);
    assert.equal(stateRow.sync_version, 1, 'the first GUI edit must version the assignment-state row to 1');

    const emitted = events(db);
    assert.equal(emitted.length, 1, 'the GUI-path edit must publish exactly one outbox event, not zero');
    assert.equal(emitted[0].sync_version, 1);
    assert.deepEqual(JSON.parse(emitted[0].payload_json).zone_uuids, [ZONE_A]);

    // A cloud REPLACE_WEATHER_STATION_ZONES arriving at the pre-edit base version (0) must be
    // rejected as a conflict, not silently applied and discard the local GUI edit.
    const weatherCommands = require(WEATHER_COMMANDS_PATH);
    const promiseDb = new PromiseDbView(db);
    const staleCommand = await weatherCommands.applyWeatherStationZonesCommand(
      promiseDb,
      {
        commandId: 9001,
        commandType: 'REPLACE_WEATHER_STATION_ZONES',
        payload: {
          command_id: '55555555-5555-4555-8555-555555555555',
          command_type: 'REPLACE_WEATHER_STATION_ZONES',
          effect_key: `weather_station_zones:${DEVICE}:0`,
          device_eui: DEVICE,
          gateway_device_eui: GATEWAY,
          base_sync_version: 0,
          target_sync_version: 1,
          weather_station_zones: {
            contract_version: 1,
            device_eui: DEVICE,
            gateway_device_eui: GATEWAY,
            zone_uuids: [ZONE_B],
            sync_version: 1,
            last_applied_at: null,
          },
        },
      },
      { command_type_recognized: true, gateway_device_eui: GATEWAY }
    );

    assert.equal(staleCommand.handled, true);
    assert.equal(staleCommand.ack.result, 'CONFLICT');

    const afterConflictRows = db.prepare(
      'SELECT iz.zone_uuid AS zone_uuid FROM weather_station_zones wsz ' +
      'JOIN irrigation_zones iz ON iz.id=wsz.zone_id WHERE wsz.deveui=?'
    ).all(DEVICE);
    assert.deepEqual(
      afterConflictRows.map((row) => row.zone_uuid),
      [ZONE_A],
      'the local GUI edit must survive: the stale cloud replace must not have silently overwritten it'
    );
    const finalState = db.prepare(
      'SELECT sync_version FROM weather_station_zone_state WHERE deveui=?'
    ).get(DEVICE);
    assert.equal(
      finalState.sync_version,
      1,
      'version must still reflect the local edit, not the rejected cloud attempt'
    );
  } finally {
    db.close();
  }
});
