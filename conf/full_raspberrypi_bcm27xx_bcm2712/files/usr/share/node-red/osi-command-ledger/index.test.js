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
  db.native.prepare(
    'INSERT INTO applied_commands (' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
    ') VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    row.commandId, row.deviceEui, row.commandType, row.effectKey,
    row.appliedAt, row.result, JSON.stringify(row.resultDetail), row.originator || 'edge'
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

  // F96 interaction: OPEN_FOR_DURATION's applied_commands.result_detail is now capped at
  // 255 chars (see this file's "caps the persisted result_detail" test) -- and a UUID
  // commandId pushes even a null-reason/detail ack skeleton over that budget, so this
  // row's stored result_detail is a truncated, no-longer-valid-JSON string. replayAck's
  // existing JSON.parse-failure fallback (parsedResultDetail) already handles that: it
  // reconstructs commandId/commandType/status/result/duplicate from applied_commands' own
  // DB columns rather than the (now unparseable) JSON, which is why an exact deepEqual
  // with `first` (the untruncated, freshly-built ack) no longer holds -- the REPLAY-
  // CORRECTNESS invariant this test actually guards (right id/type/result/status, never a
  // cloud ack) still does.
  assert.equal(replay.commandId, localCommandId);
  assert.equal(replay.commandType, 'OPEN_FOR_DURATION');
  assert.equal(replay.result, 'APPLIED');
  assert.equal(replay.status, 'ACKED');
  assert.equal(replay.duplicate, true, 'a replay must self-report as a duplicate');
  assert.equal(replay.appliedAt, first.appliedAt, 'the original applied_at must be preserved across the replay');
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

// F96: applied_commands.result_detail is shipped verbatim as
// ValveActuation.command_result_detail by sync-bootstrap-build/sync-force-build's
// `ac.result_detail AS command_result_detail` query, and the cloud's mirror column is
// varchar(255) -- Silvan reproduced a 319-char result_detail for a local
// OPEN_FOR_DURATION command, which 500s the gateway's entire cloud bootstrap. This is
// the writer-side half of the fix (defense in depth alongside the sync-bootstrap-build/
// sync-force-build payload-boundary cap): the OPEN_FOR_DURATION row PERSISTED into
// applied_commands must never exceed 255 chars, even though the ack returned to the
// caller (and the command_ack_outbox row delivered back over the wire) keeps the full
// text. The ack envelope's own structural skeleton (commandId/eventUuid/aggregateType/
// aggregateKey/commandType/status/result/appliedAt/requestedSyncVersion/
// appliedSyncVersion/duplicate) already serializes to ~284 chars with reason/detail both
// null -- over budget with NO free text at all -- so the fixture below uses a SHORT
// error (35 chars) deliberately: the point is that the pre-existing skeleton alone tips
// this over 255, not that the error text itself needs to be long.
test('queueCommandAck caps the persisted result_detail at 255 chars for OPEN_FOR_DURATION (F96)', async () => {
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
    'fixture must reproduce F96: the ack skeleton alone exceeds 255 chars, got ' + fullSerialized.length
  );

  // The ack returned to the caller (and mirrored into command_ack_outbox for delivery
  // back to whoever is polling this command) is NEVER truncated -- only the durable
  // applied_commands row is capped.
  assert.equal(queued.reason, shortError);
  assert.equal(queued.detail, shortError);

  const durable = await db.get(
    'SELECT result_detail FROM applied_commands WHERE command_id=?',
    ['900']
  );
  assert.ok(
    durable.result_detail.length <= 255,
    'applied_commands.result_detail must never exceed the cloud mirror\'s varchar(255) width: got ' +
      durable.result_detail.length
  );
  assert.ok(
    durable.result_detail.includes('…[truncated]'),
    'truncation must be marked, never silent'
  );
  // A truncated result_detail is no longer valid JSON by design -- parsedResultDetail's
  // own JSON.parse fallback (exercised via a real replay below) is what keeps this safe.
  assert.throws(() => JSON.parse(durable.result_detail), 'a capped row is not valid JSON');

  const outbox = await db.get(
    'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    ['900']
  );
  assert.equal(
    JSON.parse(outbox.payload_json).reason,
    shortError,
    'the outbox/caller-facing ack must keep the full untruncated text'
  );

  // Replay must still resolve to correct commandType/status/result -- reconstructed from
  // applied_commands' own DB columns (never from the now-unparseable result_detail JSON).
  const replay = await ledger.deduplicatePendingCommand(
    db,
    { commandId: 900, commandType: 'OPEN_FOR_DURATION', payload: null },
    { gateway_device_eui: GATEWAY_EUI }
  );
  assert.equal(replay.handled, true);
  assert.equal(replay.ack.commandType, 'OPEN_FOR_DURATION');
  assert.equal(replay.ack.result, 'REJECTED_PERMANENT');
  assert.equal(replay.ack.duplicate, true);
});

// The cap is scoped to OPEN_FOR_DURATION (the only command_type a
// valve_actuation_expectations.command_id can ever reference, per this module's F96
// comment) so that journal/zone/scoped-access command families -- whose dedup logic
// parses result_detail's JSON content (journalEffectProvenanceMatches, the zone
// payloadHash lookup) -- are never put at risk of a truncated, unparseable row.
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
    'non-valve command types must keep their full result_detail (no F96 exposure via this path)'
  );
  assert.equal(JSON.parse(durable.result_detail).reason, longError);
});
