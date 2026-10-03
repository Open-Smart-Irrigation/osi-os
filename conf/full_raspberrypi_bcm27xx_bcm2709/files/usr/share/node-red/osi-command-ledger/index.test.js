'use strict';
// Smoke tests for osi-command-ledger — the generic pending-command
// dedupe/ACK pipeline extracted out of osi-journal (2026-07-14). These cover
// the shared pipeline itself (exact-ID replay, non-journal effect-key
// grammar, ACK classification/queueing) plus the two injectable hooks
// (opts.extraEffectBindingValidator / opts.extraSubmittedIntentHash) that let
// osi-journal keep its identity/effect-key binding rules out of this module.
// Full behavioral coverage of the journal-specific path (via the osiJournal
// wrapper) lives in scripts/test-journal-command-path.js.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ledger = require('./index');
const protectedBinding = require('../osi-watermark-binding/canonicalization');

const repoRoot = path.resolve(__dirname, '../../../../../../..');
const seedSql = fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-command-ledger-test-'));
const GATEWAY_EUI = '0016C001F11715E2';
const ZONE_UUID = '22222222-2222-4222-8222-222222222222';

function canonicalHash(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce((out, key) => {
        if (key !== 'command_id') out[key] = canonical(item[key]);
        return out;
      }, {});
    }
    return item;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

let dbCounter = 0;
const openDatabases = [];

test.after(() => {
  for (const db of openDatabases) db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

class TestDb {
  constructor() {
    dbCounter += 1;
    this.native = new DatabaseSync(path.join(tempRoot, 'db-' + dbCounter + '.db'));
    this.native.exec(seedSql);
    openDatabases.push(this);
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

  async transaction(executor) {
    this.native.exec('BEGIN IMMEDIATE');
    try {
      const result = await executor(this);
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

function insertAppliedCommand(db, row) {
  const columns = [
    'command_id', 'device_eui', 'command_type', 'effect_key', 'applied_at', 'result',
    'result_detail', 'originator', 'binding_hash', 'intent_hash', 'resource_type',
    'resource_id', 'gateway_device_eui', 'actor_user_uuid', 'base_sync_version', 'operation',
  ];
  const values = [
    row.commandId, row.deviceEui, row.commandType, row.effectKey, row.appliedAt,
    row.result, JSON.stringify(row.resultDetail), row.originator || 'edge',
    row.bindingHash || null, row.intentHash || null, row.resourceType || null,
    row.resourceId || null, row.gatewayDeviceEui || null, row.actorUserUuid || null,
    row.baseSyncVersion == null ? null : row.baseSyncVersion, row.operation || null,
  ];
  db.native.prepare(`INSERT INTO applied_commands (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
}

const WATERMARK_DEVICE_EUI = 'A84041A171000002';
const WATERMARK_EFFECT_KEY = `watermark_calibration:set:${GATEWAY_EUI}:${WATERMARK_DEVICE_EUI}:4`;
const WATERMARK_ACTOR = '12345678-1234-4234-8234-123456789abc';

function watermarkBinding(overrides = {}) {
  const context = Object.assign({
    resource_type: 'WATERMARK_CALIBRATION',
    resource_id: WATERMARK_DEVICE_EUI,
    gateway_device_eui: GATEWAY_EUI,
    actor_user_uuid: WATERMARK_ACTOR,
    base_sync_version: 4,
    operation: 'set',
    normalized_intent: { worst_residual_pct: 1 },
  }, overrides);
  const binding = {
    command_type: context.command_type || 'SET_WATERMARK_CALIBRATION',
    resource: context.resource || context.resource_type,
    device_eui: context.resource_id,
    gateway_device_eui: context.gateway_device_eui,
    actor_user_uuid: context.actor_user_uuid,
    base_sync_version: context.base_sync_version,
    operation: context.operation,
    normalized_intent: context.normalized_intent,
  };
  context.intent_hash = protectedBinding.sha256(context.normalized_intent);
  context.binding_hash = protectedBinding.sha256(binding);
  return context;
}

function watermarkEnvelope(commandId, overrides = {}) {
  const context = watermarkBinding(overrides);
  return {
    commandId,
    commandType: 'SET_WATERMARK_CALIBRATION',
    payload: {
      command_type: 'SET_WATERMARK_CALIBRATION',
      effect_key: WATERMARK_EFFECT_KEY,
      device_eui: WATERMARK_DEVICE_EUI,
      gateway_device_eui: GATEWAY_EUI,
      actor_user_uuid: WATERMARK_ACTOR,
      base_sync_version: 4,
      operation: 'set',
      values: { worst_residual_pct: 1 },
    },
    protected_context: context,
  };
}

function watermarkRuntime(context = watermarkBinding()) {
  return {
    command_type_recognized: true,
    gateway_device_eui: GATEWAY_EUI,
    protected_context: context,
  };
}

function protectedDedupe(db, envelope, runtime) {
  return ledger.withProtectedCommandTransaction(
    db,
    envelope,
    runtime,
    async () => ({ handled: false })
  );
}

test('classifyAckResult maps known result/status vocabularies', () => {
  assert.equal(ledger.classifyAckResult('SUCCESS'), 'APPLIED');
  assert.equal(ledger.classifyAckResult('APPLIED'), 'APPLIED');
  assert.equal(ledger.classifyAckResult('RETRYABLE_ERROR'), 'FAILED_RETRYABLE');
  assert.equal(ledger.classifyAckResult('EXPIRED'), 'EXPIRED');
  assert.equal(ledger.classifyAckResult('REJECTED_PERMANENT'), 'REJECTED_PERMANENT');
  assert.equal(ledger.classifyAckResult('FAILED', 'missing valve devEui'), 'REJECTED_PERMANENT');
  assert.equal(ledger.classifyAckResult('FAILED', 'timeout talking to gateway'), 'FAILED_RETRYABLE');
  assert.equal(ledger.classifyAckResult('SOMETHING_UNKNOWN'), 'FAILED_RETRYABLE');
});

test('validEffectBinding recognizes the built-in non-journal grammar', async () => {
  const scheduledFor = '2026-07-14T06:00:00.000Z';
  const schedulerEnvelope = {
    commandType: 'IRRIGATION_START',
    payload: { effect_key: 'irrigation:scheduler:12:3:' + scheduledFor, zone_id: 12 },
  };
  assert.equal(
    await ledger.validEffectBinding(schedulerEnvelope, { command_type_recognized: true }),
    true
  );
  assert.equal(
    await ledger.validEffectBinding(schedulerEnvelope, { command_type_recognized: false }),
    false,
    'unrecognized command types must fail closed'
  );

  const manualEnvelope = {
    commandType: 'IRRIGATION_START',
    payload: {
      effect_key: 'irrigation:manual:' + GATEWAY_EUI + ':cloud:11111111-1111-4111-8111-111111111111',
      device_eui: GATEWAY_EUI,
    },
  };
  assert.equal(
    await ledger.validEffectBinding(manualEnvelope, { command_type_recognized: true }),
    true
  );

  const configEnvelope = {
    commandType: 'CONFIG_UPDATE',
    payload: { effect_key: 'config:' + GATEWAY_EUI + ':irrigation_interval:1', device_eui: GATEWAY_EUI },
  };
  assert.equal(
    await ledger.validEffectBinding(configEnvelope, { command_type_recognized: true }),
    true
  );
  assert.equal(
    await ledger.validEffectBinding(
      Object.assign({}, configEnvelope, {
        payload: Object.assign({}, configEnvelope.payload, { device_eui: 'FFFFFFFFFFFFFFFF' }),
      }),
      { command_type_recognized: true }
    ),
    false,
    'device EUI in the effect key must match the payload'
  );
});

test('validEffectBinding binds protected zone commands to UUID and base version', async () => {
  const zone = {
    zone_uuid: ZONE_UUID,
    gateway_device_eui: GATEWAY_EUI,
    sync_version: 5,
  };
  const envelope = {
    commandType: 'UPSERT_ZONE',
    payload: {
      effect_key: `zone:${ZONE_UUID}:4`,
      zone_uuid: ZONE_UUID,
      gateway_device_eui: GATEWAY_EUI,
      base_sync_version: 4,
      target_sync_version: 5,
      zone,
    },
  };
  assert.equal(
    await ledger.validEffectBinding(
      envelope,
      {
        command_type_recognized: true,
        gateway_device_eui: GATEWAY_EUI,
      }
    ),
    true
  );
  assert.equal(
    await ledger.validEffectBinding(
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          effect_key: `zone:${ZONE_UUID}:3`,
        },
      },
      {
        command_type_recognized: true,
        gateway_device_eui: GATEWAY_EUI,
      }
    ),
    false
  );
  assert.equal(
    await ledger.validEffectBinding(
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          gateway_device_eui: 'FFFFFFFFFFFFFFFF',
        },
      },
      {
        command_type_recognized: true,
        gateway_device_eui: GATEWAY_EUI,
      }
    ),
    false,
    'zone effect replay must remain bound to the runtime gateway'
  );

  const deletion = {
    commandType: 'DELETE_ZONE',
    payload: {
      effect_key: `zone_delete:${ZONE_UUID}:5`,
      zone_uuid: ZONE_UUID,
      gateway_device_eui: GATEWAY_EUI,
      base_sync_version: 5,
      target_sync_version: 6,
      zone: {
        zone_uuid: ZONE_UUID,
        gateway_device_eui: GATEWAY_EUI,
        sync_version: 6,
      },
    },
  };
  assert.equal(
    await ledger.validEffectBinding(
      deletion,
      {
        command_type_recognized: true,
        gateway_device_eui: GATEWAY_EUI,
      }
    ),
    true
  );
});

test('validEffectBinding defers journal-shaped types to the injected validator only', async () => {
  const envelope = { commandType: 'UPSERT_JOURNAL_ENTRY', payload: {} };

  assert.equal(
    await ledger.validEffectBinding(envelope, { command_type_recognized: true }),
    false,
    'a journal-shaped type without an injected validator must fail closed'
  );

  let received = null;
  const validator = async (db, receivedEnvelope, opts, type) => {
    received = { db, receivedEnvelope, opts, type };
    return true;
  };
  const stubDb = { marker: 'stub-tx' };
  assert.equal(
    await ledger.validEffectBinding(envelope, {
      gateway_device_eui: GATEWAY_EUI,
      db: stubDb,
      extraEffectBindingValidator: validator,
    }),
    true
  );
  assert.equal(received.db, stubDb);
  assert.equal(received.receivedEnvelope, envelope);
  assert.equal(received.type, 'UPSERT_JOURNAL_ENTRY');
  assert.equal(received.opts.gateway_device_eui, GATEWAY_EUI);
});

test('deduplicatePendingCommand replays an exact command-ID match without re-validating', async () => {
  const db = new TestDb();
  const storedFacts = { commandId: 701, status: 'ACKED', result: 'APPLIED', duplicate: false };
  insertAppliedCommand(db, {
    commandId: '701', deviceEui: GATEWAY_EUI, commandType: 'CONFIG_UPDATE',
    effectKey: 'config:' + GATEWAY_EUI + ':irrigation_interval:1',
    appliedAt: '2026-07-14T05:00:00.000Z', result: 'APPLIED', resultDetail: storedFacts,
  });

  const replay = await ledger.deduplicatePendingCommand(
    db,
    { commandId: 701, commandType: 'CONFIG_UPDATE', payload: { malformed: true } },
    { gateway_device_eui: GATEWAY_EUI }
  );

  assert.equal(replay.handled, true);
  assert.deepEqual(replay.ack, storedFacts);
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['701'])).n,
    1
  );
});

test('deduplicatePendingCommand finds a non-journal duplicate by effect key + command type', async () => {
  const db = new TestDb();
  insertAppliedCommand(db, {
    commandId: '702', deviceEui: GATEWAY_EUI, commandType: 'CONFIG_UPDATE',
    effectKey: 'config:' + GATEWAY_EUI + ':irrigation_interval:1',
    appliedAt: '2026-07-14T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { reason: null, currentSyncVersion: 1 },
  });

  const replay = await ledger.deduplicatePendingCommand(
    db,
    {
      commandId: 703,
      commandType: 'CONFIG_UPDATE',
      payload: { effect_key: 'config:' + GATEWAY_EUI + ':irrigation_interval:1', device_eui: GATEWAY_EUI },
    },
    { gateway_device_eui: GATEWAY_EUI, command_type_recognized: true }
  );

  assert.equal(replay.handled, true);
  assert.equal(replay.ack.commandId, 703);
  assert.equal(replay.ack.result, 'APPLIED');
  assert.equal(replay.ack.duplicate, true);
});

test('protected configuration replay checks exact command ID before effect key', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  insertAppliedCommand(db, {
    commandId: '801', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 801, status: 'ACKED', result: 'APPLIED', duplicate: false },
    ...Object.fromEntries(Object.entries(context).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value,
    ])),
  });
  const replay = await protectedDedupe(
    db, watermarkEnvelope(801), watermarkRuntime(context)
  );
  assert.equal(replay.handled, true);
  assert.equal(replay.ack.commandId, 801);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox')).n, 1);
});

test('generic dedupe rejects protected commands before any ledger or outbox mutation', async () => {
  const db = new TestDb();
  await assert.rejects(
    ledger.deduplicatePendingCommand(db, watermarkEnvelope(806), watermarkRuntime()),
    (error) => error && error.code === 'protected_command_route_required'
  );
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox')).n, 0);
});

test('protected configuration derives trusted hashes from the signed command payload when absent', async () => {
  const db = new TestDb();
  const envelope = watermarkEnvelope(807);
  delete envelope.protected_context;
  const result = await protectedDedupe(db, envelope, {
    command_type_recognized: true,
    gateway_device_eui: GATEWAY_EUI,
  });
  assert.equal(result.handled, false);
});

test('protected configuration verifies canonical hashes from normalized intent and trusted runtime context', async () => {
  const db = new TestDb();
  const intent = { worst_residual_pct: 1 };
  const binding = {
    command_type: 'SET_WATERMARK_CALIBRATION',
    resource: 'WATERMARK_CALIBRATION',
    device_eui: WATERMARK_DEVICE_EUI,
    gateway_device_eui: GATEWAY_EUI,
    actor_user_uuid: '12345678-1234-1234-1234-123456789abc',
    base_sync_version: 4,
    operation: 'set',
    normalized_intent: intent,
  };
  const runtime = {
    command_type_recognized: true,
    gateway_device_eui: GATEWAY_EUI,
    protected_context: { ...binding },
  };
  const envelope = watermarkEnvelope(808);
  envelope.payload.actor_user_uuid = binding.actor_user_uuid;
  envelope.payload.normalized_intent = intent;
  envelope.payload.binding_hash = 'f'.repeat(64);
  envelope.payload.intent_hash = 'e'.repeat(64);
  delete envelope.protected_context;
  const result = await protectedDedupe(db, envelope, runtime);
  assert.equal(result.handled, false);
});

test('protected configuration rejects a runtime gateway mismatch and accepts a non-v4 UUID', async () => {
  const db = new TestDb();
  const envelope = watermarkEnvelope(809);
  envelope.payload.actor_user_uuid = '12345678-1234-1234-1234-123456789abc';
  const runtime = watermarkRuntime({
    ...watermarkBinding(),
    actor_user_uuid: envelope.payload.actor_user_uuid,
    gateway_device_eui: '0016C001F1000004',
  });
  await assert.rejects(
    protectedDedupe(db, envelope, runtime),
    (error) => error && error.code === 'protected_command_conflict'
  );
});

test('protected command ID replay rejects a protected row delivered as another command type', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  insertAppliedCommand(db, {
    commandId: '810', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 810, status: 'ACKED', result: 'APPLIED', duplicate: false },
    bindingHash: context.binding_hash, intentHash: context.intent_hash,
    resourceType: context.resource_type, resourceId: context.resource_id,
    gatewayDeviceEui: context.gateway_device_eui, actorUserUuid: context.actor_user_uuid,
    baseSyncVersion: context.base_sync_version, operation: context.operation,
  });
  await assert.rejects(
    ledger.deduplicatePendingCommand(db, {
      commandId: 810, commandType: 'REBOOT', payload: { effect_key: WATERMARK_EFFECT_KEY },
    }, watermarkRuntime(context)),
    (error) => error && error.code === 'protected_command_conflict'
  );
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox')).n, 0);
});

test('protected command ID replay rejects a non-protected stored row', async () => {
  const db = new TestDb();
  insertAppliedCommand(db, {
    commandId: '811', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'REBOOT', effectKey: 'reboot:001',
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 811, status: 'ACKED', result: 'APPLIED', duplicate: false },
  });
  await assert.rejects(
    protectedDedupe(db, watermarkEnvelope(811), watermarkRuntime(watermarkBinding())),
    (error) => error && error.code === 'protected_command_conflict'
  );
});

test('protected terminal ACK rejects a non-protected stored row', async () => {
  const db = new TestDb();
  insertAppliedCommand(db, {
    commandId: '812', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'REBOOT', effectKey: 'reboot:002',
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 812, status: 'ACKED', result: 'APPLIED', duplicate: false },
  });
  const context = watermarkBinding();
  await assert.rejects(
    ledger.queueCommandAck(db, {
      commandId: 812, commandType: 'SET_WATERMARK_CALIBRATION', result: 'APPLIED',
      effectKey: WATERMARK_EFFECT_KEY, deviceEui: WATERMARK_DEVICE_EUI,
      gatewayDeviceEui: GATEWAY_EUI, actorUserUuid: context.actor_user_uuid,
      baseSyncVersion: context.base_sync_version, operation: context.operation,
      payload: watermarkEnvelope(812).payload,
    }, watermarkRuntime(context)),
    (error) => error && error.code === 'protected_command_conflict'
  );
});

test('protected exact replay derives intent from payload values, not normalized claims', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  insertAppliedCommand(db, {
    commandId: '813', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 813, status: 'ACKED', result: 'APPLIED', duplicate: false },
    bindingHash: context.binding_hash, intentHash: context.intent_hash,
    resourceType: context.resource_type, resourceId: context.resource_id,
    gatewayDeviceEui: context.gateway_device_eui, actorUserUuid: context.actor_user_uuid,
    baseSyncVersion: context.base_sync_version, operation: context.operation,
  });
  const envelope = watermarkEnvelope(813);
  envelope.payload.values.worst_residual_pct = 2;
  await assert.rejects(
    protectedDedupe(db, envelope, watermarkRuntime(context)),
    (error) => error && error.code === 'protected_command_conflict'
  );
});

test('protected effect replay rejects payload intent changes hidden by claims', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  insertAppliedCommand(db, {
    commandId: '814', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 814, status: 'ACKED', result: 'APPLIED', duplicate: false },
    bindingHash: context.binding_hash, intentHash: context.intent_hash,
    resourceType: context.resource_type, resourceId: context.resource_id,
    gatewayDeviceEui: context.gateway_device_eui, actorUserUuid: context.actor_user_uuid,
    baseSyncVersion: context.base_sync_version, operation: context.operation,
  });
  const envelope = watermarkEnvelope(815);
  envelope.payload.values.worst_residual_pct = 2;
  await assert.rejects(
    protectedDedupe(db, envelope, watermarkRuntime(context)),
    (error) => error && error.code === 'protected_command_conflict'
  );
});

test('protected terminal ACK validates delivered values against stored intent', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  insertAppliedCommand(db, {
    commandId: '816', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 816, status: 'ACKED', result: 'APPLIED', duplicate: false },
    bindingHash: context.binding_hash, intentHash: context.intent_hash,
    resourceType: context.resource_type, resourceId: context.resource_id,
    gatewayDeviceEui: context.gateway_device_eui, actorUserUuid: context.actor_user_uuid,
    baseSyncVersion: context.base_sync_version, operation: context.operation,
  });
  const payload = watermarkEnvelope(816).payload;
  payload.values.worst_residual_pct = 2;
  await assert.rejects(
    ledger.queueCommandAck(db, {
      commandId: 816, commandType: 'SET_WATERMARK_CALIBRATION', result: 'APPLIED',
      effectKey: WATERMARK_EFFECT_KEY, deviceEui: WATERMARK_DEVICE_EUI,
      gatewayDeviceEui: GATEWAY_EUI, actorUserUuid: context.actor_user_uuid,
      baseSyncVersion: context.base_sync_version, operation: context.operation,
      payload,
    }, watermarkRuntime(context)),
    (error) => error && error.code === 'protected_command_conflict'
  );
});

test('effect-key replay persists the new command ID as a trusted terminal row', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  insertAppliedCommand(db, {
    commandId: '811', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 811, status: 'ACKED', result: 'APPLIED', duplicate: false },
    bindingHash: context.binding_hash, intentHash: context.intent_hash,
    resourceType: context.resource_type, resourceId: context.resource_id,
    gatewayDeviceEui: context.gateway_device_eui, actorUserUuid: context.actor_user_uuid,
    baseSyncVersion: context.base_sync_version, operation: context.operation,
  });
  const replay = await protectedDedupe(db, watermarkEnvelope(812), watermarkRuntime(context));
  assert.equal(replay.handled, true);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['812'])).n, 1);
  const exact = await protectedDedupe(db, watermarkEnvelope(812), watermarkRuntime(context));
  assert.equal(exact.handled, true);
});

test('protected transaction primitive rolls back mutation, ledger, and ACK together', async () => {
  const db = new TestDb();
  await assert.rejects(
    ledger.withProtectedCommandTransaction(db, watermarkEnvelope(813), watermarkRuntime(), async ({ tx, terminalAck }) => {
      await tx.run('INSERT INTO devices(deveui,name,type_id,created_at,updated_at) VALUES (?,?,?,?,?)', [
        'A84041A171000099', 'rollback', 'DRAGINO_LSN50', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
      ]);
      await terminalAck({ commandId: 813, commandType: 'SET_WATERMARK_CALIBRATION', result: 'APPLIED', effectKey: WATERMARK_EFFECT_KEY, deviceEui: WATERMARK_DEVICE_EUI });
      throw new Error('mutation failed');
    }),
    /mutation failed/
  );
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM devices WHERE deveui=?', ['A84041A171000099'])).n, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['813'])).n, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['813'])).n, 0);
});

test('protected configuration accepts a changed command ID only for the same binding and intent', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  insertAppliedCommand(db, {
    commandId: '802', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: { commandId: 802, status: 'ACKED', result: 'APPLIED', duplicate: false },
    bindingHash: context.binding_hash, intentHash: context.intent_hash,
    resourceType: context.resource_type, resourceId: context.resource_id,
    gatewayDeviceEui: context.gateway_device_eui, actorUserUuid: context.actor_user_uuid,
    baseSyncVersion: context.base_sync_version, operation: context.operation,
  });
  const replay = await protectedDedupe(
    db, watermarkEnvelope(803), watermarkRuntime(context)
  );
  assert.equal(replay.handled, true);
  assert.equal(replay.ack.commandId, 803);
});

test('protected configuration rejects every changed binding or intent without mutation', async (t) => {
  for (const [name, change] of [
    ['actor', { actor_user_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    ['gateway', { gateway_device_eui: '0016C001F1000004' }],
    ['device', { resource_id: 'A84041A171000003' }],
    ['base', { base_sync_version: 5 }],
    ['operation', { operation: 'delete' }],
    ['intent', { normalized_intent: { worst_residual_pct: 2 } }],
  ]) {
    await t.test(name, async () => {
      const db = new TestDb();
      const stored = watermarkBinding();
      insertAppliedCommand(db, {
        commandId: '804', deviceEui: WATERMARK_DEVICE_EUI,
        commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
        appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
        resultDetail: { commandId: 804, status: 'ACKED', result: 'APPLIED', duplicate: false },
        bindingHash: stored.binding_hash, intentHash: stored.intent_hash,
        resourceType: stored.resource_type, resourceId: stored.resource_id,
        gatewayDeviceEui: stored.gateway_device_eui, actorUserUuid: stored.actor_user_uuid,
        baseSyncVersion: stored.base_sync_version, operation: stored.operation,
      });
      const changed = Object.assign({}, stored, change);
      await assert.rejects(
        protectedDedupe(db, watermarkEnvelope(805, changed), watermarkRuntime(changed)),
        (error) => error && error.code === 'protected_command_conflict'
      );
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox')).n, 0);
    });
  }
});

test('recordProtectedDecision preserves terminal evidence for a changed binding', async () => {
  const db = new TestDb();
  const stored = watermarkBinding();
  const originalDetail = {
    commandId: 804, commandType: 'SET_WATERMARK_CALIBRATION',
    status: 'ACKED', result: 'APPLIED', duplicate: false,
  };
  insertAppliedCommand(db, {
    commandId: '804', deviceEui: WATERMARK_DEVICE_EUI,
    commandType: 'SET_WATERMARK_CALIBRATION', effectKey: WATERMARK_EFFECT_KEY,
    appliedAt: '2026-10-01T05:00:00.000Z', result: 'APPLIED',
    resultDetail: originalDetail,
    bindingHash: stored.binding_hash, intentHash: stored.intent_hash,
    resourceType: stored.resource_type, resourceId: stored.resource_id,
    gatewayDeviceEui: stored.gateway_device_eui, actorUserUuid: stored.actor_user_uuid,
    baseSyncVersion: stored.base_sync_version, operation: stored.operation,
  });
  const originalAck = JSON.stringify({ commandId: 804, result: 'APPLIED', status: 'ACKED' });
  db.native.prepare('INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES(?,?,?)')
    .run('804', originalAck, '2026-10-01T05:00:00.000Z');

  const decision = await ledger.recordProtectedDecision(db, watermarkEnvelope(804), 'CONFLICT', 'binding_conflict');
  assert.equal(decision.ack.result, 'CONFLICT');
  assert.equal((await db.get('SELECT result FROM applied_commands WHERE command_id=?', ['804'])).result, 'APPLIED');
  assert.equal((await db.get('SELECT result_detail FROM applied_commands WHERE command_id=?', ['804'])).result_detail, JSON.stringify(originalDetail));
  assert.equal((await db.get('SELECT payload_json FROM command_ack_outbox WHERE command_id=?', ['804'])).payload_json, originalAck);
});

test('queueCommandAck persists trusted WATERMARK terminal binding fields', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  const queued = await ledger.queueCommandAck(db, {
    commandId: 806,
    commandType: 'SET_WATERMARK_CALIBRATION',
    result: 'APPLIED',
    effectKey: WATERMARK_EFFECT_KEY,
    deviceEui: WATERMARK_DEVICE_EUI,
    gatewayDeviceEui: GATEWAY_EUI,
    actorUserUuid: WATERMARK_ACTOR,
    baseSyncVersion: 4,
    operation: 'set',
    payload: {
      effect_key: WATERMARK_EFFECT_KEY,
      device_eui: WATERMARK_DEVICE_EUI,
      gateway_device_eui: GATEWAY_EUI,
      actor_user_uuid: WATERMARK_ACTOR,
      base_sync_version: 4,
      operation: 'set',
      values: context.normalized_intent,
    },
    protected_context: context,
  }, { protected_context: context, gateway_device_eui: GATEWAY_EUI });
  assert.equal(queued.result, 'APPLIED');
  const row = await db.get('SELECT binding_hash,intent_hash,resource_type,resource_id,gateway_device_eui,actor_user_uuid,base_sync_version,operation FROM applied_commands WHERE command_id=?', ['806']);
  assert.deepEqual({ ...row }, {
    binding_hash: context.binding_hash,
    intent_hash: context.intent_hash,
    resource_type: context.resource_type,
    resource_id: context.resource_id,
    gateway_device_eui: context.gateway_device_eui,
    actor_user_uuid: context.actor_user_uuid,
    base_sync_version: context.base_sync_version,
    operation: context.operation,
  });
});

test('contextless retryable ACK cannot replace a protected terminal ACK', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  const original = await ledger.queueCommandAck(db, {
    commandId: 816,
    commandType: 'SET_WATERMARK_CALIBRATION',
    result: 'APPLIED',
    effectKey: WATERMARK_EFFECT_KEY,
    deviceEui: WATERMARK_DEVICE_EUI,
    gatewayDeviceEui: GATEWAY_EUI,
    actorUserUuid: WATERMARK_ACTOR,
    baseSyncVersion: 4,
    operation: 'set',
    payload: {
      effect_key: WATERMARK_EFFECT_KEY,
      device_eui: WATERMARK_DEVICE_EUI,
      gateway_device_eui: GATEWAY_EUI,
      actor_user_uuid: WATERMARK_ACTOR,
      base_sync_version: 4,
      operation: 'set',
      values: context.normalized_intent,
    },
    protected_context: context,
  }, { protected_context: context, gateway_device_eui: GATEWAY_EUI });
  const before = await db.get('SELECT result,result_detail FROM applied_commands WHERE command_id=?', ['816']);
  const outboxBefore = await db.get('SELECT payload_json FROM command_ack_outbox WHERE command_id=?', ['816']);
  await assert.rejects(
    ledger.queueCommandAck(db, {
      commandId: 816,
      commandType: 'SET_WATERMARK_CALIBRATION',
      result: 'FAILED_RETRYABLE',
    }),
    (error) => error && error.code === 'protected_command_conflict'
  );
  const trustedRetry = await ledger.queueCommandAck(db, {
    commandId: 816,
    commandType: 'SET_WATERMARK_CALIBRATION',
    result: 'FAILED_RETRYABLE',
    effectKey: WATERMARK_EFFECT_KEY,
    deviceEui: WATERMARK_DEVICE_EUI,
    gatewayDeviceEui: GATEWAY_EUI,
    actorUserUuid: WATERMARK_ACTOR,
    baseSyncVersion: 4,
    operation: 'set',
    payload: {
      effect_key: WATERMARK_EFFECT_KEY,
      device_eui: WATERMARK_DEVICE_EUI,
      gateway_device_eui: GATEWAY_EUI,
      actor_user_uuid: WATERMARK_ACTOR,
      base_sync_version: 4,
      operation: 'set',
      values: context.normalized_intent,
    },
    protected_context: context,
  }, { protected_context: context, gateway_device_eui: GATEWAY_EUI });
  assert.deepEqual(trustedRetry, original);
  assert.deepEqual(JSON.parse((await db.get('SELECT payload_json FROM command_ack_outbox WHERE command_id=?', ['816'])).payload_json), original);
  await assert.rejects(
    ledger.queueCommandAck(db, {
      commandId: 816,
      commandType: 'CONFIG_UPDATE',
      result: 'FAILED_RETRYABLE',
    }),
    (error) => error && error.code === 'protected_command_conflict'
  );
  assert.deepEqual(await db.get('SELECT result,result_detail FROM applied_commands WHERE command_id=?', ['816']), before);
  assert.deepEqual(await db.get('SELECT payload_json FROM command_ack_outbox WHERE command_id=?', ['816']), outboxBefore);
});

test('zone effect replay requires the same submitted payload hash', async () => {
  const db = new TestDb();
  const payload = {
    command_id: '11111111-1111-4111-8111-111111111111',
    command_type: 'UPSERT_ZONE',
    effect_key: `zone:${ZONE_UUID}:0`,
    zone_uuid: ZONE_UUID,
    gateway_device_eui: GATEWAY_EUI,
    base_sync_version: 0,
    target_sync_version: 1,
    zone: {
      zone_uuid: ZONE_UUID,
      gateway_device_eui: GATEWAY_EUI,
      sync_version: 1,
      name: 'North',
    },
  };
  insertAppliedCommand(db, {
    commandId: '709',
    deviceEui: GATEWAY_EUI,
    commandType: 'UPSERT_ZONE',
    effectKey: `zone:${ZONE_UUID}:0`,
    appliedAt: '2026-07-24T01:00:00.000Z',
    result: 'APPLIED',
    resultDetail: {
      commandId: 709,
      commandType: 'UPSERT_ZONE',
      result: 'APPLIED',
      status: 'ACKED',
      duplicate: false,
      payloadHash: canonicalHash(payload),
    },
  });

  const duplicate = await ledger.deduplicatePendingCommand(
    db,
    {
      commandId: 710,
      commandType: 'UPSERT_ZONE',
      payload,
    },
    {
      gateway_device_eui: GATEWAY_EUI,
      command_type_recognized: true,
    }
  );
  assert.equal(duplicate.handled, true);
  assert.equal(duplicate.ack.commandId, 710);
  assert.equal(duplicate.ack.duplicate, true);

  const sameIntentNewLogicalId =
    await ledger.deduplicatePendingCommand(
      db,
      {
        commandId: 711,
        commandType: 'UPSERT_ZONE',
        payload: {
          ...payload,
          command_id: '22222222-2222-4222-8222-222222222222',
        },
      },
      {
        gateway_device_eui: GATEWAY_EUI,
        command_type_recognized: true,
      }
    );
  assert.equal(sameIntentNewLogicalId.handled, true);
  assert.equal(sameIntentNewLogicalId.ack.commandId, 711);

  const changed = await ledger.deduplicatePendingCommand(
    db,
    {
      commandId: 712,
      commandType: 'UPSERT_ZONE',
      payload: {
        ...payload,
        command_id: '33333333-3333-4333-8333-333333333333',
        zone: { ...payload.zone, name: 'South' },
      },
    },
    {
      gateway_device_eui: GATEWAY_EUI,
      command_type_recognized: true,
    }
  );
  assert.equal(
    changed.handled,
    false,
    'same effect with different zone intent must reach the applier and conflict'
  );
});

test('deduplicatePendingCommand fails closed when the effect binding is not recognized', async () => {
  const db = new TestDb();
  const replay = await ledger.deduplicatePendingCommand(
    db,
    {
      commandId: 704,
      commandType: 'CONFIG_UPDATE',
      payload: { effect_key: 'config:' + GATEWAY_EUI + ':irrigation_interval:1', device_eui: GATEWAY_EUI },
    },
    { gateway_device_eui: GATEWAY_EUI, command_type_recognized: false }
  );
  assert.equal(replay.handled, false);
});

test('deduplicatePendingCommand fails closed after a permissive validator accepts a null payload', async () => {
  const db = new TestDb();
  const replay = await ledger.deduplicatePendingCommand(
    db,
    { commandId: 708, commandType: 'UPSERT_JOURNAL_ENTRY', payload: null },
    {
      gateway_device_eui: GATEWAY_EUI,
      extraEffectBindingValidator: async () => true,
    }
  );

  assert.deepEqual(replay, { handled: false });
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['708'])).n,
    0
  );
});

test('deduplicatePendingCommand uses the injected journal hooks for identity-based duplicate lookup', async () => {
  const db = new TestDb();
  const entryUuid = '22222222-2222-4222-8222-222222222222';
  insertAppliedCommand(db, {
    commandId: '705', deviceEui: GATEWAY_EUI, commandType: 'UPSERT_JOURNAL_ENTRY',
    effectKey: 'journal_entry:' + entryUuid + ':0',
    appliedAt: '2026-07-14T05:00:00.000Z', result: 'APPLIED',
    resultDetail: {
      commandType: 'UPSERT_JOURNAL_ENTRY',
      submittedIntentHash: 'intent-hash-1',
      ownerUserUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorPrincipalUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      authorLabel: null,
      gatewayDeviceEui: GATEWAY_EUI,
    },
  });

  const envelope = {
    commandId: 706,
    commandType: 'UPSERT_JOURNAL_ENTRY',
    payload: {
      effect_key: 'journal_entry:' + entryUuid + ':0',
      owner_user_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      author_principal_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      author_label: null,
    },
  };

  const replay = await ledger.deduplicatePendingCommand(db, envelope, {
    gateway_device_eui: GATEWAY_EUI,
    extraEffectBindingValidator: async () => true,
    extraSubmittedIntentHash: () => 'intent-hash-1',
  });

  assert.equal(replay.handled, true);
  assert.equal(replay.ack.commandId, 706);
  assert.equal(replay.ack.duplicate, true);

  const withoutIntentHash = await ledger.deduplicatePendingCommand(
    db,
    Object.assign({}, envelope, { commandId: 707 }),
    {
      gateway_device_eui: GATEWAY_EUI,
      extraEffectBindingValidator: async () => true,
      // No extraSubmittedIntentHash supplied: identity-based duplicate lookup
      // must not match anything (falls through to "not handled").
    }
  );
  assert.equal(withoutIntentHash.handled, false);
});

test('queueCommandAck writes the ledger + outbox atomically and fires the lifecycle hook', async () => {
  const db = new TestDb();
  let hookFired = null;
  const queued = await ledger.queueCommandAck(db, {
    commandId: 800,
    commandType: 'CONFIG_UPDATE',
    effectKey: 'config:' + GATEWAY_EUI + ':irrigation_interval:1',
    deviceEui: GATEWAY_EUI,
    result: 'APPLIED',
  }, {
    lifecycle_hooks: { afterCommandLedger: async (ack) => { hookFired = ack; } },
  });

  assert.equal(queued.result, 'APPLIED');
  assert.equal(queued.duplicate, false);
  assert.ok(hookFired, 'afterCommandLedger hook must fire for a terminal ACK');
  assert.equal(
    (await db.get('SELECT result FROM applied_commands WHERE command_id=?', ['800'])).result,
    'APPLIED'
  );
});

test('queueCommandAck treats CONFLICT as terminal only for protected exact-base commands', async () => {
  const db = new TestDb();
  const context = watermarkBinding();
  const protectedAck = await ledger.queueCommandAck(db, {
    commandId: 817,
    commandType: 'SET_WATERMARK_CALIBRATION',
    result: 'CONFLICT',
    effectKey: WATERMARK_EFFECT_KEY,
    deviceEui: WATERMARK_DEVICE_EUI,
    gatewayDeviceEui: GATEWAY_EUI,
    actorUserUuid: WATERMARK_ACTOR,
    baseSyncVersion: context.base_sync_version,
    operation: context.operation,
    payload: watermarkEnvelope(817).payload,
    protected_context: context,
  }, watermarkRuntime(context));
  assert.equal(protectedAck.result, 'CONFLICT');
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['817'])).n,
    1,
    'protected exact-base conflicts remain terminal ledger evidence'
  );

  const legacyAck = await ledger.queueCommandAck(db, {
    commandId: 818,
    commandType: 'CONFIG_UPDATE',
    effectKey: 'config:' + GATEWAY_EUI + ':irrigation_interval:1',
    deviceEui: GATEWAY_EUI,
    result: 'CONFLICT',
    reason: 'stale_base',
  });
  assert.equal(legacyAck.result, 'CONFLICT');
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['818'])).n,
    0,
    'legacy conflicts remain retryable and do not become terminal ledger evidence'
  );
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['818'])).n,
    1,
    'legacy conflicts still queue their ACK for retry'
  );
});

test('queueCommandAck durably stores and exactly replays the first normalized terminal ACK', async () => {
  const db = new TestDb();
  let hookAck = null;
  const rawAck = {
    commandId: 803,
    eventUuid: 'event-803',
    aggregateType: 'ZONE_CONFIG',
    aggregateKey: 'zone-803',
    commandType: 'CONFIG_UPDATE',
    effectKey: 'config:' + GATEWAY_EUI + ':irrigation_interval:1',
    deviceEui: GATEWAY_EUI,
    status: 'ACKED',
    result: 'SUCCESS',
    requestedSyncVersion: 7,
    appliedSyncVersion: 8,
    duplicate: false,
  };
  const queued = await ledger.queueCommandAck(db, rawAck, {
    lifecycle_hooks: { afterCommandLedger: async (ack) => { hookAck = ack; } },
  });

  assert.deepEqual(queued, {
    commandId: 803,
    eventUuid: 'event-803',
    aggregateType: 'ZONE_CONFIG',
    aggregateKey: 'zone-803',
    commandType: 'CONFIG_UPDATE',
    status: 'ACKED',
    result: 'APPLIED',
    appliedAt: queued.appliedAt,
    requestedSyncVersion: 7,
    appliedSyncVersion: 8,
    duplicate: false,
    reason: null,
    detail: null,
  });
  assert.match(queued.appliedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const durable = await db.get(
    'SELECT result_detail FROM applied_commands WHERE command_id=?',
    ['803']
  );
  const outbox = await db.get(
    'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    ['803']
  );
  assert.deepEqual(JSON.parse(durable.result_detail), queued);
  assert.deepEqual(JSON.parse(outbox.payload_json), queued);
  assert.deepEqual(hookAck, queued);

  const replay = await ledger.deduplicatePendingCommand(
    db,
    { commandId: 803, commandType: 'CONFIG_UPDATE', payload: null },
    { gateway_device_eui: GATEWAY_EUI }
  );
  assert.deepEqual(replay, { handled: true, ack: queued });
});

test('queueCommandAck normalizes invalid sync versions before every durable observation', async () => {
  const invalidVersions = [
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    'not-a-version',
  ];
  for (const [index, appliedSyncVersion] of invalidVersions.entries()) {
    const db = new TestDb();
    const commandId = 810 + index;
    let hookAck = null;
    const queued = await ledger.queueCommandAck(db, {
      commandId,
      commandType: 'CONFIG_UPDATE',
      result: 'APPLIED',
      appliedSyncVersion,
    }, {
      lifecycle_hooks: { afterCommandLedger: async (ack) => { hookAck = ack; } },
    });
    const durable = JSON.parse((await db.get(
      'SELECT result_detail FROM applied_commands WHERE command_id=?',
      [String(commandId)]
    )).result_detail);
    const outbox = JSON.parse((await db.get(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      [String(commandId)]
    )).payload_json);
    const replay = await ledger.deduplicatePendingCommand(
      db,
      { commandId, commandType: 'CONFIG_UPDATE', payload: null },
      { gateway_device_eui: GATEWAY_EUI }
    );

    assert.equal(queued.appliedSyncVersion, null);
    assert.deepEqual(durable, queued);
    assert.deepEqual(outbox, queued);
    assert.deepEqual(hookAck, queued);
    assert.deepEqual(replay, { handled: true, ack: queued });
  }
});

test('queueCommandAck never rewrites an existing terminal result and never re-fires the hook', async () => {
  const db = new TestDb();
  await ledger.queueCommandAck(db, {
    commandId: 801, commandType: 'CONFIG_UPDATE', result: 'REJECTED_PERMANENT', error: 'invalid setting',
  });
  let hookFired = false;
  const queued = await ledger.queueCommandAck(db, {
    commandId: 801, commandType: 'CONFIG_UPDATE', result: 'APPLIED',
  }, {
    lifecycle_hooks: { afterCommandLedger: async () => { hookFired = true; } },
  });

  assert.equal(queued.result, 'REJECTED_PERMANENT');
  assert.equal(hookFired, false, 'a contradictory replay must not re-fire the ledger hook');
});

test('queueCommandAck stores EXPIRED as a terminal result and replays it exactly', async () => {
  const db = new TestDb();
  const queued = await ledger.queueCommandAck(db, {
    commandId: 802, commandType: 'CONFIG_UPDATE', result: 'EXPIRED', reason: 'lease_expired',
  });

  assert.equal(queued.result, 'EXPIRED');
  assert.equal(
    (await db.get('SELECT result FROM applied_commands WHERE command_id=?', ['802'])).result,
    'EXPIRED'
  );
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['802'])).n,
    1
  );
  const replay = await ledger.deduplicatePendingCommand(
    db,
    { commandId: 802, commandType: 'CONFIG_UPDATE', payload: null },
    { gateway_device_eui: GATEWAY_EUI }
  );
  assert.deepEqual(replay, { handled: true, ack: queued });
});

// F93: Silvan command_ack_outbox row 1 (commandId a local harness UUID) was
// queued for cloud delivery by queueCommandAck and 400'd forever against the
// cloud's Long-typed CommandAckEntry.commandId, blocking every later ack
// behind it. A LOCAL command (write-strega-expectation's manual-GUI /
// harness path) never carries a cloud-issued numeric commandId -- only a
// UUID minted on the edge -- so queueCommandAck must keep the local ledger
// entry (applied_commands) but never produce a command_ack_outbox row for
// one. A genuine CLOUD command (numeric commandId, e.g. from Route Command's
// pending-command dispatch) must be entirely unaffected.
test('queueCommandAck: a local (non-numeric) commandId writes the ledger but never queues a cloud ack', async () => {
  const db = new TestDb();
  const localCommandId = '43526a1e-a3e9-441c-97ea-8dca6f4b6696';
  let hookFired = null;
  const queued = await ledger.queueCommandAck(db, {
    commandId: localCommandId,
    commandType: 'OPEN_FOR_DURATION',
    deviceEui: GATEWAY_EUI,
    result: 'APPLIED',
  }, {
    lifecycle_hooks: { afterCommandLedger: async (ack) => { hookFired = ack; } },
  });

  assert.equal(queued.commandId, localCommandId, 'the returned ack still reports the local id for edge-side use');
  assert.equal(queued.result, 'APPLIED');
  assert.ok(hookFired, 'the local ledger hook must still fire -- F93 fix 1 keeps the local ledger entry');
  assert.equal(
    (await db.get('SELECT result FROM applied_commands WHERE command_id=?', [localCommandId])).result,
    'APPLIED',
    'a local action keeps its local ledger entry (applied_commands)'
  );
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', [localCommandId])).n,
    0,
    'a local (non-cloud-numeric) commandId must never produce a command_ack_outbox row (F93)'
  );
});

test('queueCommandAck: a cloud (numeric) commandId still queues a cloud ack, unchanged by the F93 fix', async () => {
  const db = new TestDb();
  const queued = await ledger.queueCommandAck(db, {
    commandId: 900,
    commandType: 'OPEN_FOR_DURATION',
    deviceEui: GATEWAY_EUI,
    result: 'APPLIED',
  });

  assert.equal(queued.commandId, 900);
  assert.equal(
    (await db.get('SELECT result FROM applied_commands WHERE command_id=?', ['900'])).result,
    'APPLIED'
  );
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['900'])).n,
    1,
    'a genuine cloud-issued numeric commandId must still be queued for delivery'
  );
});

test('queueCommandAck: replaying an existing local ledger entry still never queues a cloud ack', async () => {
  const db = new TestDb();
  const localCommandId = 'b2c1a0f0-1111-4222-8333-444455556666';
  const first = await ledger.queueCommandAck(db, {
    commandId: localCommandId, commandType: 'OPEN_FOR_DURATION', result: 'APPLIED',
  });
  const replay = await ledger.queueCommandAck(db, {
    commandId: localCommandId, commandType: 'OPEN_FOR_DURATION', result: 'APPLIED',
  });

  assert.deepEqual(replay, first, 'a replay of a local commandId must reproduce the same ack shape');
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', [localCommandId])).n,
    0,
    'a replayed local commandId must still never queue a cloud ack (F93)'
  );
});

test('queueCommandAck: a rejection for a local commandId (write-strega-expectation scope gates) never queues a cloud ack', async () => {
  const db = new TestDb();
  const localCommandId = 'c3d2b1a0-2222-4333-8444-555566667777';
  const queued = await ledger.queueCommandAck(db, {
    commandId: localCommandId,
    commandType: 'OPEN_FOR_DURATION',
    deviceEui: GATEWAY_EUI,
    result: 'REJECTED_PERMANENT',
    reason: 'scope_denied',
  });

  assert.equal(queued.result, 'REJECTED_PERMANENT');
  assert.equal(
    (await db.get('SELECT result FROM applied_commands WHERE command_id=?', [localCommandId])).result,
    'REJECTED_PERMANENT',
    'a local rejection still keeps its local ledger entry'
  );
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', [localCommandId])).n,
    0,
    'a local rejection (e.g. write-strega-expectation scope_denied/scope_actor_required) must never queue a cloud ack'
  );
});

// F117/F120: OPEN_FOR_DURATION's applied_commands.result_detail was briefly capped at 255
// chars here (#278/F96) and reverted (F120): the ack envelope's own structural skeleton
// already serializes to ~284-319 chars with reason/detail both null, so EVERY
// OPEN_FOR_DURATION ack was truncated into invalid JSON -- corrupting replay (F117) and
// failing scripts/test-scoped-access-writes.js outright. The cloud's varchar(255) mirror
// is already protected at the payload boundary (sync-bootstrap-build/sync-outbox-build/
// sync-force-build's capFreeTextFields(), see scripts/test-valve-actuation-text-caps.js)
// and by the cloud's own EdgeStrings.fitFreeText (#136); this writer must keep the full,
// parseable ack JSON regardless of command type or length.
test('queueCommandAck never truncates result_detail, even for an over-255-char OPEN_FOR_DURATION ack (F117/F120)', async () => {
  const db = new TestDb();
  const shortError = 'downlink send failed: timeout';

  const queued = await ledger.queueCommandAck(db, {
    commandId: 900,
    commandType: 'OPEN_FOR_DURATION',
    deviceEui: GATEWAY_EUI,
    result: 'REJECTED_PERMANENT',
    error: shortError,
  });
  const fullSerialized = JSON.stringify(queued);
  assert.ok(
    fullSerialized.length > 255,
    'fixture reproduces F96/F120: the ack skeleton alone exceeds 255 chars, got ' + fullSerialized.length
  );

  assert.equal(queued.reason, shortError);
  assert.equal(queued.detail, shortError);

  const durable = await db.get(
    'SELECT result_detail FROM applied_commands WHERE command_id=?',
    ['900']
  );
  assert.equal(
    durable.result_detail.length,
    fullSerialized.length,
    'applied_commands.result_detail must hold the FULL ack JSON, never truncated (F117/F120)'
  );
  assert.deepEqual(
    JSON.parse(durable.result_detail),
    queued,
    'the persisted result_detail must be valid, complete JSON'
  );

  const outbox = await db.get(
    'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    ['900']
  );
  assert.equal(
    JSON.parse(outbox.payload_json).reason,
    shortError,
    'the outbox/caller-facing ack must keep the full untruncated text'
  );

  // Replay must reproduce the exact same ack shape now that result_detail is always
  // valid JSON -- no fallback-to-DB-columns reconstruction needed for this command type.
  const replay = await ledger.deduplicatePendingCommand(
    db,
    { commandId: 900, commandType: 'OPEN_FOR_DURATION', payload: null },
    { gateway_device_eui: GATEWAY_EUI }
  );
  assert.equal(replay.handled, true);
  assert.deepEqual(replay.ack, queued, 'replay must reproduce the exact untruncated ack (F117/F120)');
});

test('queueCommandAck never truncates result_detail for a non-valve command type', async () => {
  const db = new TestDb();
  const longError = 'x'.repeat(400);

  await ledger.queueCommandAck(db, {
    commandId: 901,
    commandType: 'CONFIG_UPDATE',
    result: 'REJECTED_PERMANENT',
    error: longError,
  });

  const durable = await db.get(
    'SELECT result_detail FROM applied_commands WHERE command_id=?',
    ['901']
  );
  assert.ok(
    durable.result_detail.length > 255,
    'non-valve command types must keep their full result_detail'
  );
  assert.equal(JSON.parse(durable.result_detail).reason, longError);
});
