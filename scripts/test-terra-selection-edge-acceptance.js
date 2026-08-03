#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(
  REPO,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands'
);
const SEED = fs.readFileSync(
  path.join(REPO, 'database', 'seed-blank.sql'),
  'utf8'
);

const GATEWAY_EUI = '10AA10AA10AA10AD';
const OWNER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ZONE_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function canonicalHash(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce(function(result, key) {
        result[key] = canonical(item[key]);
        return result;
      }, {});
    }
    return item;
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function loadCommands() {
  assert.ok(
    fs.existsSync(path.join(HELPER_PATH, 'index.js')),
    'protected Terra zone-config helper is not shipped at ' + HELPER_PATH
  );
  return require(HELPER_PATH);
}

function transactionFacade(raw, failOn) {
  return {
    run(sql, params = []) {
      if (failOn && sql.includes(failOn)) {
        return Promise.reject(new Error('injected write failure: ' + failOn));
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
      username, password_hash, created_at, updated_at, user_uuid, cloud_user_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'grower',
    'not-a-real-hash',
    '2026-08-03T10:00:00.000Z',
    '2026-08-03T10:00:00.000Z',
    OWNER_UUID,
    41
  );
  raw.prepare(`
    INSERT INTO sync_link_state (
      peer_node, linked, server_url, cloud_user_id,
      gateway_device_eui, updated_at
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
    GATEWAY_EUI,
    '2026-08-03T10:00:00.000Z'
  );
  raw.prepare(`
    INSERT INTO irrigation_zones (
      name, user_id, zone_uuid, gateway_device_eui, timezone,
      phenological_stage, crop_type, variety, sync_version,
      created_at, updated_at
    ) VALUES (
      'North',
      (SELECT id FROM users WHERE user_uuid=?),
      ?, ?, 'Europe/Zurich', 'flowering', 'pear', 'conference', 42,
      '2026-08-03T10:00:00.000Z', '2026-08-03T10:00:00.000Z'
    )
  `).run(OWNER_UUID, ZONE_UUID, GATEWAY_EUI);
  raw.exec('DELETE FROM sync_outbox');

  const facade = {
    transaction: async (executor) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await executor(
          transactionFacade(raw, options.failOn)
        );
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

function envelope(commandId, baseSyncVersion, targetSyncVersion, overrides = {}) {
  const eventUuid = `11111111-1111-4111-8111-${String(commandId).padStart(12, '0')}`;
  return {
    commandId,
    eventUuid,
    commandType: 'UPSERT_ZONE_CONFIG',
    aggregateType: 'ZONE',
    aggregateKey: ZONE_UUID,
    appliedSyncVersion: targetSyncVersion,
    payload: {
      commandType: 'UPSERT_ZONE_CONFIG',
      zoneUuid: ZONE_UUID,
      gatewayDeviceEui: GATEWAY_EUI,
      ownerUserUuid: OWNER_UUID,
      baseSyncVersion,
      syncVersion: targetSyncVersion,
      cropType: 'maize',
      variety: null,
      phenologicalStage: 'development',
      ...overrides,
    },
  };
}

function runtime() {
  return {
    gateway_device_eui: GATEWAY_EUI,
    command_type_recognized: true,
  };
}

async function apply(commands, db, command) {
  return commands.applyZoneCommand(db.facade, command, runtime());
}

test('applies target 44 with an explicit null cultivar and commits state, mirror event, ledger, and ACK together', async () => {
  const commands = loadCommands();
  if (typeof commands._resetForTests === 'function') commands._resetForTests();
  const db = database();
  try {
    const result = await apply(commands, db, envelope(4401, 42, 44));
    assert.equal(result.handled, true);
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(result.ack.appliedSyncVersion, 44);
    assert.equal(result.ack.eventUuid, '11111111-1111-4111-8111-000000004401');
    assert.equal(result.ack.aggregateType, 'ZONE');
    assert.equal(result.ack.aggregateKey, ZONE_UUID);

    const zone = db.raw.prepare(
      'SELECT crop_type,variety,phenological_stage,sync_version ' +
      'FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.deepEqual({ ...zone }, {
      crop_type: 'maize',
      variety: null,
      phenological_stage: 'development',
      sync_version: 44,
    });

    const mirror = db.raw.prepare(
      "SELECT op,sync_version,payload_json FROM sync_outbox " +
      "WHERE aggregate_type='ZONE' AND aggregate_key=?"
    ).get(ZONE_UUID);
    assert.equal(mirror.op, 'ZONE_CONFIG_UPSERTED');
    assert.equal(mirror.sync_version, 44);
    const mirrorPayload = JSON.parse(mirror.payload_json);
    assert.equal(mirrorPayload.variety, null);
    assert.equal(result.ack.payloadHash, canonicalHash(mirrorPayload));

    const terminal = db.raw.prepare(
      'SELECT result,result_detail FROM applied_commands WHERE command_id=?'
    ).get('4401');
    assert.equal(terminal.result, 'APPLIED');
    assert.equal(JSON.parse(terminal.result_detail).appliedSyncVersion, 44);

    const ackRow = db.raw.prepare(
      'SELECT payload_json,delivered_at FROM command_ack_outbox WHERE command_id=?'
    ).get('4401');
    assert.equal(ackRow.delivered_at, null);
    assert.deepEqual(JSON.parse(ackRow.payload_json), result.ack);
  } finally {
    db.raw.close();
  }
});

test('preserves an originator-provided effect key without inventing one when absent', async (t) => {
  const commands = loadCommands();
  await t.test('provided', async () => {
    if (typeof commands._resetForTests === 'function') commands._resetForTests();
    const db = database();
    try {
      const command = envelope(4408, 42, 44);
      command.effectKey = 'terra-selection:' + ZONE_UUID + ':42:44';
      const result = await apply(commands, db, command);
      assert.equal(result.ack.effectKey, command.effectKey);
      assert.equal(
        db.raw.prepare(
          'SELECT effect_key FROM applied_commands WHERE command_id=?'
        ).get('4408').effect_key,
        command.effectKey
      );
    } finally {
      db.raw.close();
    }
  });
  await t.test('absent', async () => {
    if (typeof commands._resetForTests === 'function') commands._resetForTests();
    const db = database();
    try {
      const result = await apply(commands, db, envelope(4409, 42, 44));
      assert.equal(result.ack.effectKey, null);
      assert.equal(
        db.raw.prepare(
          'SELECT effect_key FROM applied_commands WHERE command_id=?'
        ).get('4409').effect_key,
        null
      );
    } finally {
      db.raw.close();
    }
  });
});

test('replays the exact persisted ACK without a second state change or mirror event', async () => {
  const commands = loadCommands();
  if (typeof commands._resetForTests === 'function') commands._resetForTests();
  const db = database();
  try {
    const command = envelope(4404, 42, 44);
    const applied = await apply(commands, db, command);
    const replayed = await apply(commands, db, command);

    assert.deepEqual(replayed.ack, applied.ack);
    assert.equal(replayed.ack.eventUuid, '11111111-1111-4111-8111-000000004404');
    assert.equal(replayed.ack.aggregateType, 'ZONE');
    assert.equal(replayed.ack.aggregateKey, ZONE_UUID);
    assert.equal(
      db.raw.prepare(
        'SELECT sync_version FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).sync_version,
      44
    );
    assert.equal(
      db.raw.prepare(
        "SELECT COUNT(*) AS n FROM sync_outbox " +
        "WHERE aggregate_type='ZONE' AND aggregate_key=?"
      ).get(ZONE_UUID).n,
      1
    );
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?'
      ).get('4404').n,
      1
    );
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?'
      ).get('4404').n,
      1
    );
  } finally {
    db.raw.close();
  }
});

test('rejects outer and payload target disagreement before any local write', async () => {
  const commands = loadCommands();
  if (typeof commands._resetForTests === 'function') commands._resetForTests();
  const db = database();
  try {
    const command = envelope(4405, 42, 44);
    command.appliedSyncVersion = 45;
    await assert.rejects(
      apply(commands, db, command),
      /outer and payload target versions differ/
    );
    assert.equal(
      db.raw.prepare(
        'SELECT sync_version FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).sync_version,
      42
    );
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 0);
  } finally {
    db.raw.close();
  }
});

test('terminally rejects owner and gateway binding conflicts without changing Terra selection', async (t) => {
  const commands = loadCommands();
  const cases = [
    {
      name: 'owner',
      prepare() {},
      command: envelope(4406, 42, 44, {
        ownerUserUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
      reasonCode: 'owner_mismatch',
    },
    {
      name: 'gateway',
      prepare(db) {
        db.raw.prepare(
          'UPDATE irrigation_zones SET gateway_device_eui=? WHERE zone_uuid=?'
        ).run('20BB20BB20BB20BE', ZONE_UUID);
        db.raw.exec('DELETE FROM sync_outbox');
      },
      command: envelope(4407, 42, 44),
      reasonCode: 'gateway_mismatch',
    },
    {
      name: 'payload gateway',
      prepare() {},
      command: envelope(4410, 42, 44, {
        gatewayDeviceEui: '20BB20BB20BB20BE',
      }),
      reasonCode: 'gateway_mismatch',
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      if (typeof commands._resetForTests === 'function') commands._resetForTests();
      const db = database();
      try {
        entry.prepare(db);
        const result = await apply(commands, db, entry.command);
        assert.equal(result.ack.result, 'NACKED');
        assert.equal(result.ack.reasonCode, entry.reasonCode);
        assert.equal(result.ack.payloadHash, null);
        const zone = db.raw.prepare(
          'SELECT crop_type,variety,phenological_stage,sync_version ' +
          'FROM irrigation_zones WHERE zone_uuid=?'
        ).get(ZONE_UUID);
        assert.deepEqual({ ...zone }, {
          crop_type: 'pear',
          variety: 'conference',
          phenological_stage: 'flowering',
          sync_version: 42,
        });
        assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
        assert.equal(
          db.raw.prepare(
            'SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?'
          ).get(String(entry.command.commandId)).n,
          1
        );
        assert.equal(
          db.raw.prepare(
            'SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?'
          ).get(String(entry.command.commandId)).n,
          1
        );
      } finally {
        db.raw.close();
      }
    });
  }
});

test('rejects a late lower target after target 44 without rewinding state or emitting another mirror event', async () => {
  const commands = loadCommands();
  if (typeof commands._resetForTests === 'function') commands._resetForTests();
  const db = database();
  try {
    await apply(commands, db, envelope(4402, 42, 44));
    const late = await apply(commands, db, envelope(4301, 42, 43));

    assert.equal(late.handled, true);
    assert.equal(late.ack.result, 'NACKED');
    assert.equal(late.ack.reasonCode, 'base_version_conflict');
    assert.equal(late.ack.appliedSyncVersion, 44);
    assert.equal(late.ack.payloadHash, null);
    assert.equal(
      db.raw.prepare(
        'SELECT sync_version FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).sync_version,
      44
    );
    assert.equal(
      db.raw.prepare(
        "SELECT COUNT(*) AS n FROM sync_outbox " +
        "WHERE aggregate_type='ZONE' AND aggregate_key=?"
      ).get(ZONE_UUID).n,
      1
    );
    assert.equal(
      db.raw.prepare(
        'SELECT result FROM applied_commands WHERE command_id=?'
      ).get('4301').result,
      'NACKED'
    );
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?'
      ).get('4301').n,
      1
    );
  } finally {
    db.raw.close();
  }
});

test('rolls back canonical state and trigger outbox when terminal ledger persistence fails', async () => {
  const commands = loadCommands();
  if (typeof commands._resetForTests === 'function') commands._resetForTests();
  const db = database({ failOn: 'INSERT INTO applied_commands' });
  try {
    await assert.rejects(
      apply(commands, db, envelope(4403, 42, 44)),
      /injected write failure: INSERT INTO applied_commands/
    );
    const zone = db.raw.prepare(
      'SELECT crop_type,variety,phenological_stage,sync_version ' +
      'FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.deepEqual({ ...zone }, {
      crop_type: 'pear',
      variety: 'conference',
      phenological_stage: 'flowering',
      sync_version: 42,
    });
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 0);
  } finally {
    db.raw.close();
  }
});
