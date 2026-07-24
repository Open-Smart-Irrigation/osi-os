'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const commands = require('./index');
const repo = path.resolve(__dirname, '../../../../../../..');
const seed = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-weather-command-'));
const GATEWAY = '0016C001F11715E2';
const DEVICE = '0123456789ABCDEF';
const USER = '11111111-1111-4111-8111-111111111111';
const ZONE_A = '22222222-2222-4222-8222-222222222222';
const ZONE_B = '33333333-3333-4333-8333-333333333333';
let counter = 0;
const opened = [];

test.after(() => {
  for (const db of opened) db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

class Db {
  constructor(type = 'SENSECAP_S2120') {
    this.native = new DatabaseSync(path.join(root, `db-${++counter}.db`));
    this.native.exec(seed);
    this.failSql = null;
    opened.push(this);
    const now = '2026-07-24T00:00:00.000Z';
    this.native.prepare(`
      INSERT INTO users (
        username,password_hash,created_at,updated_at,user_uuid
      ) VALUES ('grower','hash',?,?,?)
    `).run(now, now, USER);
    for (const [name, uuid] of [['B', ZONE_B], ['A', ZONE_A]]) {
      this.native.prepare(`
        INSERT INTO irrigation_zones (
          name,user_id,zone_uuid,gateway_device_eui,sync_version,
          created_at,updated_at
        ) VALUES (?,(SELECT id FROM users WHERE user_uuid=?),?,?,1,?,?)
      `).run(name, USER, uuid, GATEWAY, now, now);
    }
    this.native.prepare(`
      INSERT INTO devices (
        deveui,name,type_id,user_id,gateway_device_eui,sync_version,
        created_at,updated_at
      ) VALUES (
        ?,'Weather',?,(SELECT id FROM users WHERE user_uuid=?),?,1,?,?
      )
    `).run(DEVICE, type, USER, GATEWAY, now, now);
    this.native.prepare(`
      INSERT INTO sync_link_state (
        peer_node,linked,server_url,cloud_user_id,gateway_device_eui,updated_at
      ) VALUES ('cloud',1,'https://example.invalid',17,?,?)
      ON CONFLICT(peer_node) DO UPDATE SET
        linked=excluded.linked,
        gateway_device_eui=excluded.gateway_device_eui,
        updated_at=excluded.updated_at
    `).run(GATEWAY, now);
    this.native.prepare(`
      INSERT INTO weather_station_zone_state(deveui,sync_version)
      VALUES (?,0)
    `).run(DEVICE);
    this.native.exec('DELETE FROM sync_outbox');
  }
  get(sql, params) {
    return Promise.resolve(this.native.prepare(sql).get(...(params || [])));
  }
  all(sql, params) {
    return Promise.resolve(this.native.prepare(sql).all(...(params || [])));
  }
  run(sql, params) {
    if (this.failSql && String(sql).includes(this.failSql)) {
      return Promise.reject(new Error('injected write failure'));
    }
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
  close() {
    this.native.close();
  }
}

function envelope(base = 1, zones = [ZONE_A, ZONE_B]) {
  const target = base + 1;
  return {
    commandId: 77 + base,
    commandType: 'REPLACE_WEATHER_STATION_ZONES',
    payload: {
      command_id: '44444444-4444-4444-8444-444444444444',
      command_type: 'REPLACE_WEATHER_STATION_ZONES',
      effect_key: `weather_station_zones:${DEVICE}:${base}`,
      device_eui: DEVICE,
      gateway_device_eui: GATEWAY,
      base_sync_version: base,
      target_sync_version: target,
      weather_station_zones: {
        contract_version: 1,
        device_eui: DEVICE,
        gateway_device_eui: GATEWAY,
        zone_uuids: zones,
        sync_version: target,
        last_applied_at: null,
      },
    },
  };
}

const runtime = {
  command_type_recognized: true,
  gateway_device_eui: GATEWAY,
};

test('replaces a complete sorted set, emits one event, and replays its ACK', async () => {
  const db = new Db();
  const command = envelope();
  const first = await commands.applyWeatherStationZonesCommand(
    db, command, runtime
  );
  assert.equal(first.handled, true);
  assert.equal(first.ack.result, 'APPLIED');
  assert.equal(first.ack.appliedSyncVersion, 2);
  assert.deepEqual(
    db.native.prepare(`
      SELECT iz.zone_uuid
        FROM weather_station_zones wsz
        JOIN irrigation_zones iz ON iz.id=wsz.zone_id
       WHERE wsz.deveui=?
       ORDER BY iz.zone_uuid
    `).all(DEVICE).map((row) => row.zone_uuid),
    [ZONE_A, ZONE_B]
  );
  const events = db.native.prepare(`
    SELECT payload_json FROM sync_outbox
     WHERE aggregate_type='WEATHER_STATION_ZONES'
  `).all();
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].payload_json).zone_uuids, [
    ZONE_A, ZONE_B,
  ]);
  assert.equal(
    db.native.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n,
    1
  );
  const replay = await commands.applyWeatherStationZonesCommand(
    db, command, runtime
  );
  assert.deepEqual(replay.ack, first.ack);
  assert.equal(
    db.native.prepare(`
      SELECT COUNT(*) AS n FROM sync_outbox
       WHERE aggregate_type='WEATHER_STATION_ZONES'
    `).get().n,
    1
  );
});

test('conflicts on stale version and rejects type, zone, or unsorted input', async () => {
  const stale = new Db();
  assert.equal(
    (await commands.applyWeatherStationZonesCommand(
      stale, envelope(0), runtime
    )).ack.result,
    'CONFLICT'
  );
  const wrongType = new Db('DRAGINO_LSN50');
  assert.equal(
    (await commands.applyWeatherStationZonesCommand(
      wrongType, envelope(), runtime
    )).ack.result,
    'REJECTED_PERMANENT'
  );
  const missingZone = new Db();
  assert.equal(
    (await commands.applyWeatherStationZonesCommand(
      missingZone,
      envelope(1, ['99999999-9999-4999-8999-999999999999']),
      runtime
    )).ack.result,
    'REJECTED_PERMANENT'
  );
  assert.equal(
    missingZone.native.prepare(
      'SELECT COUNT(*) AS n FROM weather_station_zones'
    ).get().n,
    0
  );
  await assert.rejects(
    commands.applyWeatherStationZonesCommand(
      new Db(), envelope(1, [ZONE_B, ZONE_A]), runtime
    ),
    /sorted/
  );
});

test('local replacement advances the same independent aggregate version', async () => {
  const db = new Db();
  const result = await commands.replaceLocalWeatherStationZones(
    db,
    { device_eui: DEVICE, zone_uuids: [ZONE_B] },
    runtime
  );
  assert.equal(result.sync_version, 2);
  assert.deepEqual(result.zone_uuids, [ZONE_B]);
  assert.equal(
    db.native.prepare(`
      SELECT sync_version FROM weather_station_zone_state WHERE deveui=?
    `).get(DEVICE).sync_version,
    2
  );
});

test('rolls back assignments, event, state version, and ledger when ACK persistence fails', async () => {
  const db = new Db();
  db.failSql = 'INSERT INTO command_ack_outbox';
  await assert.rejects(
    commands.applyWeatherStationZonesCommand(db, envelope(), runtime),
    /injected write failure/
  );
  assert.equal(
    db.native.prepare('SELECT COUNT(*) AS n FROM weather_station_zones').get().n,
    0
  );
  assert.equal(
    db.native.prepare(`
      SELECT sync_version FROM weather_station_zone_state WHERE deveui=?
    `).get(DEVICE).sync_version,
    1
  );
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
  assert.equal(
    db.native.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n,
    0
  );
});
