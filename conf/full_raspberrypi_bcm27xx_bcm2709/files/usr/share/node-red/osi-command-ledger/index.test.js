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
  assert.equal(ledger.classifyAckResult('EXPIRED'), 'FAILED_RETRYABLE');
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

test('queueCommandAck leaves a retryable result out of the terminal ledger', async () => {
  const db = new TestDb();
  const queued = await ledger.queueCommandAck(db, {
    commandId: 802, commandType: 'CONFIG_UPDATE', result: 'EXPIRED', reason: 'lease_expired',
  });

  assert.equal(queued.result, 'FAILED_RETRYABLE');
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['802'])).n,
    0
  );
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['802'])).n,
    1
  );
});
