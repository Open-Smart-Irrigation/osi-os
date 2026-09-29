#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { mock } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const commands = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands'
);

const SEED = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'seed-blank.sql'),
  'utf8'
);
const GATEWAY = '10AA10AA10AA10AD';
const OTHER_GATEWAY = '10AA10AA10AA10AE';
const OWNER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ZONE_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function txFacade(raw, failOn) {
  return {
    run(sql, params = []) {
      if (failOn && sql.includes(failOn)) {
        return Promise.reject(new Error('injected write failure'));
      }
      raw.prepare(sql).run(...params);
      return Promise.resolve();
    },
    get(sql, params = []) {
      return Promise.resolve(raw.prepare(sql).get(...params));
    },
    all(sql, params = []) {
      return Promise.resolve(raw.prepare(sql).all(...params));
    },
  };
}

function database(options = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  raw.prepare(`
    INSERT INTO users (
      username,
      password_hash,
      created_at,
      updated_at,
      user_uuid,
      cloud_user_id,
      role,
      sync_version
    ) VALUES (?, ?, ?, ?, ?, ?, 'researcher', 1)
  `).run(
    'grower',
    'not-a-real-hash',
    '2026-07-24T01:00:00.000Z',
    '2026-07-24T01:00:00.000Z',
    OWNER_UUID,
    41
  );
  raw.prepare(`
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
    '41',
    GATEWAY,
    '2026-07-24T01:00:00.000Z'
  );
  const facade = {
    transaction: async (executor) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await executor(txFacade(raw, options.failOn));
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { raw, facade };
}

function runtime() {
  return {
    gateway_device_eui: GATEWAY,
    command_type_recognized: true,
  };
}

function zoneResource(target, overrides = {}) {
  return {
    contract_version: 1,
    zone_uuid: ZONE_UUID,
    name: 'North',
    gateway_device_eui: GATEWAY,
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
    sync_version: target,
    deleted_at: null,
    user: {
      user_uuid: OWNER_UUID,
      cloudUserId: 41,
    },
    ...overrides,
  };
}

function envelope(commandId, type, base, zoneOverrides = {}) {
  const effectPrefix = type === 'DELETE_ZONE' ? 'zone_delete' : 'zone';
  const effectKey = `${effectPrefix}:${ZONE_UUID}:${base}`;
  const zone = type === 'DELETE_ZONE'
    ? {
        contract_version: 1,
        zone_uuid: ZONE_UUID,
        gateway_device_eui: GATEWAY,
        sync_version: base + 1,
        deleted_at: zoneOverrides.deleted_at,
      }
    : zoneResource(base + 1, zoneOverrides);
  return {
    commandId,
    commandType: type,
    effectKey,
    payload: {
      command_id: `11111111-1111-4111-8111-${String(commandId).padStart(12, '0')}`,
      command_type: type,
      effect_key: effectKey,
      zone_uuid: ZONE_UUID,
      gateway_device_eui: GATEWAY,
      base_sync_version: base,
      target_sync_version: base + 1,
      zone,
    },
  };
}

function seedZone(raw, overrides = {}) {
  const zone = zoneResource(1, overrides);
  raw.prepare(`
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
      deleted_at,
      created_at,
      updated_at
    ) VALUES (
      ?,
      (SELECT id FROM users WHERE user_uuid = ?),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    zone.name,
    OWNER_UUID,
    zone.zone_uuid,
    zone.gateway_device_eui,
    zone.timezone,
    zone.latitude,
    zone.longitude,
    zone.phenological_stage,
    zone.calibration_key,
    zone.crop_type,
    zone.variety,
    zone.soil_type,
    zone.irrigation_method,
    zone.area_m2,
    zone.irrigation_efficiency_pct,
    zone.scheduling_mode,
    zone.prediction_card_enabled,
    zone.notes,
    zone.sync_version,
    zone.deleted_at,
    '2026-07-24T01:00:00.000Z',
    '2026-07-24T01:00:00.000Z'
  );
}

test('protected create applies atomically and exactly replays its terminal ACK', async () => {
  commands._resetForTests();
  const db = database();
  try {
    const create = envelope(1, 'UPSERT_ZONE', 0);
    const applied = await commands.applyZoneCommand(
      db.facade,
      create,
      runtime()
    );
    assert.equal(applied.handled, true);
    assert.equal(applied.ack.result, 'APPLIED');
    assert.equal(applied.ack.appliedSyncVersion, 1);
    assert.match(applied.ack.payloadHash, /^[0-9a-f]{64}$/);

    const zone = db.raw.prepare(
      'SELECT * FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.name, 'North');
    assert.equal(zone.soil_type, 'loam');
    assert.equal(zone.sync_version, 1);
    assert.equal(
      db.raw.prepare(
        "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='ZONE' AND op='ZONE_UPSERTED'"
      ).get().n,
      1
    );

    const replay = await commands.applyZoneCommand(
      db.facade,
      create,
      runtime()
    );
    assert.deepEqual(replay.ack, applied.ack);
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).n,
      1
    );
  } finally {
    db.raw.close();
  }
});

// UPSERT_ZONE_CONFIG is deliberately not exercised through this path: that
// command type is owned end-to-end by the pre-existing Terra-originated
// osi-zone-commands `validate`/`applyOnce` path (its own effect-key grammar
// and rehearsal suite in scripts/test-terra-zone-config-command-flow.js) and
// is excluded from TYPES here -- see osi-zone-commands/index.js.
test('full aggregate and location updates require the exact base', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.exec('DELETE FROM sync_outbox');

    const full = await commands.applyZoneCommand(
      db.facade,
      envelope(2, 'UPSERT_ZONE', 1, {
        name: 'North orchard',
        soil_type: 'sandy_loam',
        latitude: 47.4,
      }),
      runtime()
    );
    assert.equal(full.ack.result, 'APPLIED');
    let zone = db.raw.prepare(
      'SELECT * FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.name, 'North orchard');
    assert.equal(zone.soil_type, 'sandy_loam');
    assert.equal(zone.latitude, 47.4);
    assert.equal(zone.sync_version, 2);

    const location = await commands.applyZoneCommand(
      db.facade,
      envelope(3, 'UPSERT_ZONE_LOCATION', 2, {
        latitude: 46.9,
        longitude: 7.4,
        soil_type: 'silt',
      }),
      runtime()
    );
    assert.equal(location.ack.result, 'APPLIED');
    zone = db.raw.prepare(
      'SELECT * FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.latitude, 46.9);
    assert.equal(zone.longitude, 7.4);
    assert.equal(
      zone.soil_type,
      'sandy_loam',
      'location command must not mutate other portable fields'
    );

    const stale = await commands.applyZoneCommand(
      db.facade,
      envelope(4, 'UPSERT_ZONE', 1, { name: 'Stale' }),
      runtime()
    );
    assert.equal(stale.ack.result, 'CONFLICT');
    assert.equal(stale.ack.appliedSyncVersion, 3);
    assert.equal(
      db.raw.prepare(
        'SELECT name FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).name,
      'North orchard'
    );
  } finally {
    db.raw.close();
  }
});

test('same effect with changed intent reaches a terminal conflict', async () => {
  commands._resetForTests();
  const db = database();
  try {
    const first = await commands.applyZoneCommand(
      db.facade,
      envelope(6, 'UPSERT_ZONE', 0),
      runtime()
    );
    assert.equal(first.ack.result, 'APPLIED');

    const changed = await commands.applyZoneCommand(
      db.facade,
      envelope(7, 'UPSERT_ZONE', 0, { name: 'Different' }),
      runtime()
    );
    assert.equal(changed.ack.result, 'CONFLICT');
    assert.equal(
      db.raw.prepare(
        'SELECT name FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).name,
      'North'
    );
  } finally {
    db.raw.close();
  }
});

test('delete detaches devices, tombstones the zone, and reports target version', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    const zoneId = db.raw.prepare(
      'SELECT id FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID).id;
    db.raw.prepare(`
      INSERT INTO devices (
        deveui,
        name,
        type_id,
        user_id,
        irrigation_zone_id,
        gateway_device_eui,
        sync_version,
        created_at,
        updated_at
      ) VALUES (?, 'Sensor', 'KIWI_SENSOR',
        (SELECT id FROM users WHERE user_uuid=?), ?, ?, 1, ?, ?)
    `).run(
      'A84041AAAAAAAAAA',
      OWNER_UUID,
      zoneId,
      GATEWAY,
      '2026-07-24T01:01:00.000Z',
      '2026-07-24T01:01:00.000Z'
    );
    db.raw.exec('DELETE FROM sync_outbox');

    const removed = await commands.applyZoneCommand(
      db.facade,
      envelope(8, 'DELETE_ZONE', 1, {
        deleted_at: '2026-07-24T01:02:00.000Z',
      }),
      runtime()
    );
    assert.equal(removed.ack.result, 'APPLIED');
    assert.equal(removed.ack.appliedSyncVersion, 2);
    assert.equal(
      db.raw.prepare(
        'SELECT irrigation_zone_id FROM devices WHERE deveui=?'
      ).get('A84041AAAAAAAAAA').irrigation_zone_id,
      null
    );
    const zone = db.raw.prepare(
      'SELECT deleted_at,sync_version FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.deleted_at, '2026-07-24T01:02:00.000Z');
    assert.equal(zone.sync_version, 2);
  } finally {
    db.raw.close();
  }
});

test('missing owner, wrong gateway, malformed numeric fields, and shape drift reject permanently', async () => {
  commands._resetForTests();
  const db = database();
  try {
    const missingOwner = envelope(9, 'UPSERT_ZONE', 0);
    missingOwner.payload.zone.user.user_uuid =
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    assert.equal(
      (
        await commands.applyZoneCommand(
          db.facade,
          missingOwner,
          runtime()
        )
      ).ack.result,
      'REJECTED_PERMANENT'
    );

    const wrongGateway = envelope(10, 'UPSERT_ZONE', 0, {
      gateway_device_eui: OTHER_GATEWAY,
    });
    assert.equal(
      (
        await commands.applyZoneCommand(
          db.facade,
          wrongGateway,
          runtime()
        )
      ).ack.result,
      'REJECTED_PERMANENT'
    );

    const badLatitude = envelope(11, 'UPSERT_ZONE', 0, {
      latitude: Number.POSITIVE_INFINITY,
    });
    assert.equal(
      (
        await commands.applyZoneCommand(
          db.facade,
          badLatitude,
          runtime()
        )
      ).ack.result,
      'REJECTED_PERMANENT'
    );

    const malformedProvider = envelope(12, 'UPSERT_ZONE', 0, {
      weather_source: 'Meteo-Blue!',
    });
    assert.equal(
      (
        await commands.applyZoneCommand(
          db.facade,
          malformedProvider,
          runtime()
        )
      ).ack.result,
      'REJECTED_PERMANENT'
    );
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).n,
      0
    );

    // A provider only the cloud implements is stored as sent (zone
    // weather_source is edge-owned after sub-project 4; the capability
    // zone_config_weather_source_v1 tells the cloud this gateway accepts it).
    const cloudOnlyProvider = envelope(13, 'UPSERT_ZONE', 0, {
      weather_source: 'meteoblue',
    });
    assert.equal(
      (
        await commands.applyZoneCommand(
          db.facade,
          cloudOnlyProvider,
          runtime()
        )
      ).ack.result,
      'APPLIED'
    );
    assert.equal(
      db.raw.prepare(
        'SELECT weather_source FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).weather_source,
      'meteoblue'
    );
  } finally {
    db.raw.close();
  }
});

test('a full UPSERT_ZONE without weather_source keeps the stored provider', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare(
      "UPDATE irrigation_zones SET weather_source='meteoswiss' WHERE zone_uuid=?"
    ).run(ZONE_UUID);
    db.raw.exec('DELETE FROM sync_outbox');
    const full = await commands.applyZoneCommand(
      db.facade,
      envelope(14, 'UPSERT_ZONE', 1, { name: 'North orchard' }),
      runtime()
    );
    assert.equal(full.ack.result, 'APPLIED');
    const zone = db.raw.prepare(
      'SELECT name, weather_source FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.name, 'North orchard');
    assert.equal(zone.weather_source, 'meteoswiss');
    const event = JSON.parse(db.raw.prepare(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='ZONE' ORDER BY rowid DESC LIMIT 1"
    ).get().payload_json);
    assert.equal(event.weather_source, 'meteoswiss');
  } finally {
    db.raw.close();
  }
});

test('a full UPSERT_ZONE writes a present weather_source, null keeps it, and UPSERT_ZONE_LOCATION ignores it', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.exec('DELETE FROM sync_outbox');
    const provider = () => db.raw.prepare(
      'SELECT weather_source FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID).weather_source;

    // Present: trimmed, lower-cased and written by updateFullZone.
    const written = await commands.applyZoneCommand(
      db.facade,
      envelope(15, 'UPSERT_ZONE', 1, { weather_source: ' MeteoSwiss ' }),
      runtime()
    );
    assert.equal(written.ack.result, 'APPLIED');
    assert.equal(provider(), 'meteoswiss');
    const event = JSON.parse(db.raw.prepare(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='ZONE' ORDER BY rowid DESC LIMIT 1"
    ).get().payload_json);
    assert.equal(event.weather_source, 'meteoswiss');

    // null means absent: the stored provider stays.
    const cleared = await commands.applyZoneCommand(
      db.facade,
      envelope(16, 'UPSERT_ZONE', 2, { weather_source: null }),
      runtime()
    );
    assert.equal(cleared.ack.result, 'APPLIED');
    assert.equal(provider(), 'meteoswiss');

    // A location command parses the field (a malformed value fails closed) and
    // updateLocation does not write it.
    const location = await commands.applyZoneCommand(
      db.facade,
      envelope(17, 'UPSERT_ZONE_LOCATION', 3, {
        latitude: 46.9,
        longitude: 7.4,
        weather_source: 'local',
      }),
      runtime()
    );
    assert.equal(location.ack.result, 'APPLIED');
    const zone = db.raw.prepare(
      'SELECT latitude, weather_source FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.latitude, 46.9);
    assert.equal(zone.weather_source, 'meteoswiss');
  } finally {
    db.raw.close();
  }
});

test('database failure rolls back the canonical row and terminal ledger', async () => {
  commands._resetForTests();
  const db = database({ failOn: 'INSERT INTO applied_commands' });
  try {
    await assert.rejects(
      commands.applyZoneCommand(
        db.facade,
        envelope(12, 'UPSERT_ZONE', 0),
        runtime()
      ),
      /injected write failure/
    );
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).n,
      0
    );
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?'
      ).get('12').n,
      0
    );
  } finally {
    db.raw.close();
  }
});

test('legacy zone commands fall through while malformed protected commands fail closed', async () => {
  commands._resetForTests();
  const db = database();
  try {
    assert.deepEqual(
      await commands.applyZoneCommand(
        db.facade,
        {
          commandId: 13,
          commandType: 'UPSERT_ZONE',
          payload: {
            zoneUuid: ZONE_UUID,
            gatewayDeviceEui: GATEWAY,
            syncVersion: 1,
          },
        },
        runtime()
      ),
      { handled: false }
    );

    const malformed = envelope(14, 'UPSERT_ZONE', 0);
    malformed.payload.effect_key = `zone:${ZONE_UUID}:8`;
    await assert.rejects(
      commands.applyZoneCommand(db.facade, malformed, runtime()),
      /effect_key/
    );
  } finally {
    db.raw.close();
  }
});

test('the versioned UPSERT_ZONE applier holds zone.name to the shared name rule', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.exec('DELETE FROM sync_outbox');

    const tooLong = await commands.applyZoneCommand(
      db.facade,
      envelope(20, 'UPSERT_ZONE', 1, { name: 'a'.repeat(101) }),
      runtime()
    );
    assert.equal(tooLong.ack.result, 'REJECTED_PERMANENT');
    assert.match(tooLong.ack.reason, /zone\.name/);

    const control = await commands.applyZoneCommand(
      db.facade,
      envelope(21, 'UPSERT_ZONE', 1, { name: 'North\tblock' }),
      runtime()
    );
    assert.equal(control.ack.result, 'REJECTED_PERMANENT');
    assert.match(control.ack.reason, /zone\.name/);

    assert.equal(
      db.raw.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name,
      'North'
    );

    const trimmed = await commands.applyZoneCommand(
      db.facade,
      envelope(22, 'UPSERT_ZONE', 1, { name: '\u00a0Bloc nord\u00a0' }),
      runtime()
    );
    assert.equal(trimmed.ack.result, 'APPLIED');
    assert.equal(
      db.raw.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name,
      'Bloc nord'
    );
  } finally {
    db.raw.close();
  }
});

test('the versioned UPSERT_ZONE applier accepts a 100-code-point name', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.exec('DELETE FROM sync_outbox');
    const seedlings = '\ud83c\udf31'.repeat(100);
    const applied = await commands.applyZoneCommand(
      db.facade,
      envelope(23, 'UPSERT_ZONE', 1, { name: seedlings }),
      runtime()
    );
    assert.equal(applied.ack.result, 'APPLIED');
    assert.equal(
      db.raw.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name,
      seedlings
    );
  } finally {
    db.raw.close();
  }
});

test('an UPSERT_ZONE_LOCATION carrying a legacy 110-character name still applies', async () => {
  commands._resetForTests();
  const db = database();
  try {
    const legacyName = 'a'.repeat(110);
    seedZone(db.raw, { name: legacyName });
    db.raw.exec('DELETE FROM sync_outbox');

    const location = await commands.applyZoneCommand(
      db.facade,
      envelope(24, 'UPSERT_ZONE_LOCATION', 1, {
        name: legacyName,
        latitude: 46.9,
        longitude: 7.4,
      }),
      runtime()
    );
    assert.equal(location.ack.result, 'APPLIED');
    const zone = db.raw.prepare(
      'SELECT name, latitude, longitude FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.name, legacyName);
    assert.equal(zone.latitude, 46.9);
    assert.equal(zone.longitude, 7.4);
  } finally {
    db.raw.close();
  }
});

// Stage start date on the protected zone command (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B5).
test('a full UPSERT_ZONE sets stage_started_on, null clears it, and a command without the key keeps it', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare("UPDATE irrigation_zones SET stage_started_on='2026-04-01' WHERE zone_uuid=?").run(ZONE_UUID);
    const stored = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    const set = await commands.applyZoneCommand(db.facade, envelope(21, 'UPSERT_ZONE', 1, { stage_started_on: '2026-05-01' }), runtime());
    assert.equal(set.ack.result, 'APPLIED');
    assert.equal(stored(), '2026-05-01');
    const event = JSON.parse(db.raw.prepare(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='ZONE' ORDER BY rowid DESC LIMIT 1"
    ).get().payload_json);
    assert.equal(event.stage_started_on, '2026-05-01');
    assert.equal((await commands.applyZoneCommand(db.facade, envelope(22, 'UPSERT_ZONE', 2, { notes: 'kept' }), runtime())).ack.result, 'APPLIED');
    assert.equal(stored(), '2026-05-01', 'the key absent keeps the stored value');
    assert.equal((await commands.applyZoneCommand(db.facade, envelope(23, 'UPSERT_ZONE', 3, { stage_started_on: null }), runtime())).ack.result, 'APPLIED');
    assert.equal(stored(), null);
  } finally {
    db.raw.close();
  }
});

test('a protected create writes stage_started_on; a malformed date or a location command carrying it is refused', async () => {
  commands._resetForTests();
  const db = database();
  try {
    const created = await commands.applyZoneCommand(db.facade, envelope(31, 'UPSERT_ZONE', 0, { stage_started_on: '2026-05-01' }), runtime());
    assert.equal(created.ack.result, 'APPLIED');
    assert.equal(db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on, '2026-05-01');
    let id = 32;
    for (const bad of ['05/01/2026', '2026-02-30', '2026-5-1', 20260501]) {
      const refused = await commands.applyZoneCommand(db.facade, envelope(id, 'UPSERT_ZONE', 1, { stage_started_on: bad }), runtime());
      assert.equal(refused.ack.result, 'REJECTED_PERMANENT', String(bad));
      id += 1;
    }
    const location = await commands.applyZoneCommand(db.facade, envelope(id, 'UPSERT_ZONE_LOCATION', 1, { stage_started_on: '2026-05-01' }), runtime());
    assert.equal(location.ack.result, 'REJECTED_PERMANENT');
    assert.equal(db.raw.prepare('SELECT stage_started_on, sync_version FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).sync_version, 1);
  } finally {
    db.raw.close();
  }
});

// Residual fix item E: an empty string on the protected UPSERT_ZONE means the
// same "no date" as null on the other three write paths, not a permanent
// rejection -- the cloud never sends one, but a permanently rejected zone
// update would cost the user the whole command for a value that means the
// same thing as one it does send.
test('an empty (or blank) stage_started_on on the protected UPSERT_ZONE reads as null, not REJECTED_PERMANENT', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare("UPDATE irrigation_zones SET stage_started_on='2026-04-01' WHERE zone_uuid=?").run(ZONE_UUID);
    const stored = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    const cleared = await commands.applyZoneCommand(db.facade, envelope(41, 'UPSERT_ZONE', 1, { stage_started_on: '' }), runtime());
    assert.equal(cleared.ack.result, 'APPLIED');
    assert.equal(stored(), null, 'an empty string clears the date like null');
    db.raw.prepare("UPDATE irrigation_zones SET stage_started_on='2026-04-01' WHERE zone_uuid=?").run(ZONE_UUID);
    const trimmed = await commands.applyZoneCommand(db.facade, envelope(42, 'UPSERT_ZONE', 2, { stage_started_on: '   ' }), runtime());
    assert.equal(trimmed.ack.result, 'APPLIED');
    assert.equal(stored(), null, 'a whitespace-only string trims to empty and clears the date too');
  } finally {
    db.raw.close();
  }
});

test('a protected create with an empty stage_started_on stores no date', async () => {
  commands._resetForTests();
  const db = database();
  try {
    const created = await commands.applyZoneCommand(db.facade, envelope(43, 'UPSERT_ZONE', 0, { stage_started_on: '' }), runtime());
    assert.equal(created.ack.result, 'APPLIED');
    assert.equal(db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on, null);
  } finally {
    db.raw.close();
  }
});

// --- Final review E-I2: updateFullZone applies the stage-date rule when a --
// --- protected UPSERT_ZONE carries no stage_started_on key -----------------

test('a full UPSERT_ZONE without the key stamps the zone-local next day when the stage changes at a UTC-evening clock', async () => {
  commands._resetForTests();
  mock.timers.enable({ apis: ['Date'] });
  // 2026-09-29T22:30:00Z is already 2026-09-30 in Europe/Zurich (CEST,
  // UTC+2) -- the boundary this test pins.
  mock.timers.setTime(Date.UTC(2026, 8, 29, 22, 30, 0));
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare(
      "UPDATE irrigation_zones SET phenological_stage='development', stage_started_on='2026-04-01' WHERE zone_uuid=?"
    ).run(ZONE_UUID);
    const stored = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    const result = await commands.applyZoneCommand(
      db.facade,
      envelope(51, 'UPSERT_ZONE', 1, { phenological_stage: 'late_season' }),
      runtime()
    );
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(stored(), '2026-09-30', 'a command without stage_started_on that changes the stage stamps the zone-local today');
  } finally {
    db.raw.close();
    mock.timers.reset();
  }
});

test('a full UPSERT_ZONE without the key keeps the stored date when the stage is unchanged', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare(
      "UPDATE irrigation_zones SET phenological_stage='development', stage_started_on='2026-04-01' WHERE zone_uuid=?"
    ).run(ZONE_UUID);
    const stored = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    const result = await commands.applyZoneCommand(
      db.facade,
      envelope(52, 'UPSERT_ZONE', 1, { phenological_stage: 'development', notes: 'irrigation check' }),
      runtime()
    );
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(stored(), '2026-04-01', 'the same stage keeps the stored date');
  } finally {
    db.raw.close();
  }
});

test('a full UPSERT_ZONE without the key clears the date when the stage becomes unset (stage default)', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare(
      "UPDATE irrigation_zones SET phenological_stage='development', stage_started_on='2026-04-01' WHERE zone_uuid=?"
    ).run(ZONE_UUID);
    const stored = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    const result = await commands.applyZoneCommand(
      db.facade,
      envelope(53, 'UPSERT_ZONE', 1, { phenological_stage: null }),
      runtime()
    );
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(stored(), null, 'a change to unset clears the date even though the command carries no stage_started_on key');
  } finally {
    db.raw.close();
  }
});

test('a full UPSERT_ZONE carrying a date still clears it once the stage becomes unset (stage default)', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare(
      "UPDATE irrigation_zones SET phenological_stage='development', stage_started_on='2026-04-01' WHERE zone_uuid=?"
    ).run(ZONE_UUID);
    const stored = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    const result = await commands.applyZoneCommand(
      db.facade,
      envelope(54, 'UPSERT_ZONE', 1, { phenological_stage: null, stage_started_on: '2026-05-01' }),
      runtime()
    );
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(stored(), null, 'the rule overrides a sent date whatever the key says once the stage becomes unset');
  } finally {
    db.raw.close();
  }
});
