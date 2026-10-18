#!/usr/bin/env node
'use strict';

// Valve command safety through the shipped flow: a cloud pending command is
// split, gated, deduplicated by the real command ledger and routed to the
// STREGA downlink builder or the valve command bridge, following the wires in
// flows.json (bcm2712; verify-profile-parity proves the mirror identical).
//
// Rules pinned here:
// - a STREGA valve is only opened with an open-for-duration downlink; a
//   VALVE_COMMAND with any other action, or without a bounded duration, gets
//   no downlink and one durable REJECTED_PERMANENT ACK;
// - the duration a VALVE_COMMAND carries in any accepted field is the one sent;
// - every pending command the gate refuses is answered, never dropped;
// - stop commands (CLOSE, CANCEL_VALVE_ACTUATION) still execute when the
//   gateway clock is ahead of their expiry;
// - a cloud `action:` effect key replays instead of acting twice;
// - a cancel stops the actuation it names and leaves other queued downlinks.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode, makeAuthHeader } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const FLOWS = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const NODE_RED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const byId = Object.fromEntries(flows.map((node) => [node.id, node]));
function idOf(name) {
  const matches = flows.filter((node) => node.name === name);
  assert.equal(matches.length, 1, 'one node named ' + name);
  return matches[0].id;
}
const valveControl = require(path.join(NODE_RED, 'osi-valve-control'));

const GATEWAY = '0016C001F1000001';
const VALVE = 'A840410000000001';
const ROUTE = idOf('Route Command');
const STREGA_BUILDER = idOf('Build STREGA downlink + emit log ctx');
const DOWNLINK_OUT = byId[STREGA_BUILDER].wires[0].find((id) => byId[id].type === 'mqtt out');
const ACK_OUT = idOf('Command ACK → Cloud');
const ENV = { DEVICE_EUI: GATEWAY, CHIRPSTACK_APP_ACTUATORS: 'app-actuators' };

// Nodes this harness executes. Every other wire target is recorded as an
// output. The appliers between the ledger and Route Command (journal, Terra,
// zone, weather, installation, entity-name, scoped-access, WATERMARK) pass a
// valve command through unchanged; their own suites cover them, so their
// entry is short-circuited to Route Command here. Likewise the actuator_log
// write after the STREGA builder is short-circuited to Build Status + ACK,
// the node that answers an open once its log context is written.
const STATUS_ACK = idOf('Build Status + ACK');
const LOG_WRITE = idOf('Zone id known?');
const EXECUTED = new Set([
  'sync-pending-split',
  'reject-indefinite-open',
  'command-dedupe-dispatch',
  ROUTE,
  'write-strega-expectation',
  STREGA_BUILDER,
  'command-ack-queue-rest',
  idOf('Valve Cloud Command Bridge'),
  STATUS_ACK,
]);
const PASS_THROUGH_TO_ROUTE = 'journal-command-apply-fn';

function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  db.exec(`
    INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'grower', 'h', '2026-01-01');
    INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at)
      VALUES ('${VALVE}', 'Valve', 'STREGA_VALVE', 1, '2026-01-01', '2026-01-01');
  `);
  return db;
}

async function commandRegistry() {
  const run = await executeFunction(byId['cmd-type-registry'], { msg: {}, env: ENV, db: seedDb() });
  return run.flowState.command_types;
}

function fakeChirpstack(queue) {
  const calls = { flush: 0, enqueued: [] };
  const client = {
    async flushDeviceQueue(eui) {
      calls.flush += 1;
      queue.splice(0, queue.length);
      return { devEui: eui, method: 'DeviceService.FlushQueue' };
    },
    async getDeviceQueue() {
      return queue.map((item) => Object.assign({}, item));
    },
    async enqueueDownlink(item) {
      calls.enqueued.push(item);
      queue.push({ id: 'q-' + calls.enqueued.length, fPort: item.fPort, data: item.data, confirmed: !!item.confirmed, isPending: false, isEncrypted: false });
      return { id: 'q-' + calls.enqueued.length };
    },
  };
  return { calls, lib: { createProvisioningClientFromEnv: () => client } };
}

// Runs one node, then follows its wires. Returns every message that left the
// executed set, keyed by the node it was sent to.
async function drive(db, startId, msg, options = {}) {
  const outputs = [];
  const warnings = [];
  const queue = [{ nodeId: startId, msg }];
  while (queue.length) {
    const { nodeId, msg: current } = queue.shift();
    const targetId = nodeId === PASS_THROUGH_TO_ROUTE ? ROUTE : (nodeId === LOG_WRITE ? STATUS_ACK : nodeId);
    const node = byId[targetId];
    if (!EXECUTED.has(targetId)) {
      outputs.push({ nodeId: targetId, msg: current });
      continue;
    }
    const run = await executeFunction(node, {
      msg: current,
      env: ENV,
      db,
      flowState: options.flowState || {},
      osiLibModules: { 'osi-valve-control': valveControl },
      libOverrides: options.chirpstack ? { chirpstack: options.chirpstack } : {},
    });
    warnings.push(...run.warnings);
    if (run.errors.length) warnings.push(...run.errors.map((e) => 'ERROR ' + e));
    let result = run.result;
    if (result == null) continue;
    if (!Array.isArray(result)) result = [result];
    result.forEach((out, index) => {
      if (out == null) return;
      const messages = Array.isArray(out) ? out : [out];
      for (const target of (node.wires[index] || [])) {
        for (const m of messages) {
          const link = byId[target];
          if (link && link.type === 'link out') {
            for (const linkIn of link.links || []) {
              for (const next of (byId[linkIn].wires[0] || [])) queue.push({ nodeId: next, msg: structuredClone(m) });
            }
          } else {
            queue.push({ nodeId: target, msg: structuredClone(m) });
          }
        }
      }
    });
  }
  return { outputs, warnings };
}

function pendingCommand(commandId, commandType, payload, extra = {}) {
  return Object.assign({
    commandId,
    commandType,
    eventUuid: '1b4e28ba-2fa1-41d2-883f-0016c0000' + String(commandId).padStart(3, '0'),
    aggregateType: 'DEVICE',
    aggregateKey: VALVE,
    payload,
  }, extra);
}

async function deliver(db, commands, options = {}) {
  const flowState = options.flowState || { command_types: await commandRegistry() };
  return drive(db, 'sync-pending-split', { statusCode: 200, payload: commands }, Object.assign({}, options, { flowState }));
}

function stregaDownlinks(outputs) {
  return outputs
    .filter((o) => o.nodeId === DOWNLINK_OUT)
    .map((o) => ({ fPort: o.msg.payload.fPort, bytes: [...Buffer.from(o.msg.payload.data, 'base64')] }));
}

function ackRows(db, commandId) {
  return db.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id = ?')
    .all(String(commandId))
    .map((row) => JSON.parse(row.payload_json));
}

function soon(ms) {
  return new Date(Date.now() + ms).toISOString();
}

test('VALVE_COMMAND with action OPEN gets no downlink and one REJECTED_PERMANENT ACK', async () => {
  const db = seedDb();
  try {
    const { outputs } = await deliver(db, [pendingCommand(501, 'VALVE_COMMAND', {
      deviceEui: VALVE, devEui: VALVE, action: 'OPEN', duration_minutes: 5,
      effect_key: `irrigation:manual:${VALVE}:cloud:1b4e28ba-2fa1-41d2-883f-0016c0000501`, expires_at: soon(300000),
    })]);
    assert.deepEqual(stregaDownlinks(outputs), [], 'a bare open must never reach the valve');
    const acks = ackRows(db, 501);
    assert.equal(acks.length, 1, 'exactly one durable ACK row');
    assert.equal(acks[0].result, 'REJECTED_PERMANENT');
    assert.equal(acks[0].reason, 'valve_action_not_allowed');
    assert.equal(acks[0].eventUuid, '1b4e28ba-2fa1-41d2-883f-0016c0000501');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM valve_actuation_expectations').get().n, 0);
  } finally {
    db.close();
  }
});

test('VALVE_COMMAND with action CLOSE gets no downlink and one REJECTED_PERMANENT ACK', async () => {
  const db = seedDb();
  try {
    const { outputs } = await deliver(db, [pendingCommand(502, 'VALVE_COMMAND', {
      deviceEui: VALVE, action: 'CLOSE', duration_minutes: 5,
    })]);
    assert.deepEqual(stregaDownlinks(outputs), []);
    const acks = ackRows(db, 502);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].result, 'REJECTED_PERMANENT');
    assert.equal(acks[0].reason, 'valve_action_not_allowed');
  } finally {
    db.close();
  }
});

test('VALVE_COMMAND reaching Route Command with a non-timed action is refused there too', async () => {
  const db = seedDb();
  try {
    for (const [commandId, action] of [[511, 'OPEN'], [512, 'CLOSE'], [513, 'CLOSE_FOR_DURATION']]) {
      const { outputs } = await drive(db, ROUTE, {
        payload: { commandId, commandType: 'VALVE_COMMAND', command_type: 'VALVE_COMMAND', deviceEui: VALVE, action, duration_seconds: 300 },
      });
      assert.deepEqual(stregaDownlinks(outputs), [], `${action} must not produce a downlink`);
      assert.equal(ackRows(db, commandId)[0].result, 'REJECTED_PERMANENT', `${action} is answered`);
    }
  } finally {
    db.close();
  }
});

test('VALVE_COMMAND OPEN_FOR_DURATION opens for the duration it carries, in any accepted field', async () => {
  const cases = [
    [521, { duration_seconds: 600 }, 10],
    [522, { durationMinutes: 7 }, 7],
    [523, { duration_minutes: 3 }, 3],
    [524, { duration_seconds: 90 }, 2],
  ];
  for (const [commandId, duration, minutes] of cases) {
    const db = seedDb();
    try {
      const { outputs } = await deliver(db, [pendingCommand(commandId, 'VALVE_COMMAND', Object.assign({
        deviceEui: VALVE, devEui: VALVE, action: 'OPEN_FOR_DURATION', expires_at: soon(300000),
      }, duration))]);
      assert.deepEqual(stregaDownlinks(outputs), [{ fPort: 2, bytes: [0x41, minutes] }], JSON.stringify(duration));
      assert.deepEqual(ackRows(db, commandId).map((a) => a.result), ['APPLIED'], 'an accepted open is answered APPLIED, not refused');
      const expectation = db.prepare('SELECT COUNT(*) AS n FROM valve_actuation_expectations').get();
      assert.equal(expectation.n, 1, 'the open is tracked as an actuation');
    } finally {
      db.close();
    }
  }
});

test('VALVE_COMMAND OPEN_FOR_DURATION outside 1..255 minutes is refused, not clamped', async () => {
  const db = seedDb();
  try {
    const { outputs } = await deliver(db, [pendingCommand(531, 'VALVE_COMMAND', {
      deviceEui: VALVE, action: 'OPEN_FOR_DURATION', duration_minutes: 300,
    })]);
    assert.deepEqual(stregaDownlinks(outputs), []);
    const acks = ackRows(db, 531);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].result, 'REJECTED_PERMANENT');
    assert.equal(acks[0].reason, 'duration_out_of_range');
  } finally {
    db.close();
  }
});

test('the gate answers every pending command it refuses', async () => {
  const db = seedDb();
  try {
    await deliver(db, [
      pendingCommand(541, 'OPEN', { deviceEui: VALVE, duration_minutes: 5 }),
      pendingCommand(542, 'OPEN_FOR_DURATION', { device_eui: VALVE }),
      pendingCommand(543, 'MOVE_THE_MOON', { device_eui: VALVE }),
    ]);
    const reasons = [541, 542, 543].map((id) => {
      const acks = ackRows(db, id);
      assert.equal(acks.length, 1, `command ${id} gets one ACK`);
      assert.equal(acks[0].result, 'REJECTED_PERMANENT', `command ${id} is rejected for good`);
      return acks[0].reason;
    });
    assert.deepEqual(reasons, ['indefinite_open_not_allowed', 'missing_or_invalid_duration', 'unknown_command_type']);
    const stored = db.prepare("SELECT command_id, result FROM applied_commands ORDER BY command_id").all();
    assert.deepEqual(stored.map((r) => [r.command_id, r.result]), [
      ['541', 'REJECTED_PERMANENT'], ['542', 'REJECTED_PERMANENT'], ['543', 'REJECTED_PERMANENT'],
    ], 'the refusal is in the terminal ledger, so a redelivery replays it');
  } finally {
    db.close();
  }
});

test('an unknown type is not rejected for good while the authoritative registry is not loaded yet', async () => {
  const db = seedDb();
  try {
    await deliver(db, [pendingCommand(551, 'MOVE_THE_MOON', { device_eui: VALVE })], { flowState: {} });
    assert.equal(ackRows(db, 551).length, 0);
  } finally {
    db.close();
  }
});

test('UC512_OPEN_FOR_DURATION has no dispatcher on this gateway and is answered, not dropped', async () => {
  const db = seedDb();
  try {
    const { outputs } = await deliver(db, [pendingCommand(561, 'UC512_OPEN_FOR_DURATION', {
      device_eui: VALVE, duration_seconds: 600,
    })]);
    assert.deepEqual(stregaDownlinks(outputs), []);
    const acks = ackRows(db, 561);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].result, 'REJECTED_PERMANENT');
  } finally {
    db.close();
  }
});

test('stop commands execute with the gateway clock ten minutes ahead of their expiry', async () => {
  const db = seedDb();
  try {
    const elapsed = new Date(Date.now() - 600000).toISOString();
    const close = await deliver(db, [pendingCommand(571, 'CLOSE', {
      device_eui: VALVE, expires_at: elapsed,
      effect_key: `irrigation:manual:${VALVE}:cloud:1b4e28ba-2fa1-41d2-883f-0016c0000571`,
    })]);
    assert.deepEqual(stregaDownlinks(close.outputs), [{ fPort: 1, bytes: [0x30] }], 'the sanctioned stop still closes');

    db.prepare(
      "INSERT INTO valve_actuation_expectations (expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) " +
      "VALUES ('901', ?, '901', '2026-10-01T10:00:00.000Z', 600, '2026-10-01T10:12:00.000Z', 'unknown', 'PENDING_OBSERVATION', '2026-10-01T10:00:00.000Z')"
    ).run(VALVE);
    const queue = [{ id: 'q-a', fPort: 2, data: Buffer.from([0x41, 10]).toString('base64'), confirmed: false, isPending: false, isEncrypted: false }];
    const fake = fakeChirpstack(queue);
    await deliver(db, [pendingCommand(572, 'CANCEL_VALVE_ACTUATION', {
      device_eui: VALVE, expires_at: elapsed, reason: 'operator_cancel',
      effect_key: `irrigation:manual:${VALVE}:cloud:1b4e28ba-2fa1-41d2-883f-0016c0000572`,
    })], { chirpstack: fake.lib });
    assert.equal(db.prepare("SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id='901'").get().reconciliation_state, 'CANCELLED');
    assert.equal(queue.length, 0, 'the queued open is gone');
  } finally {
    db.close();
  }
});

test('the STREGA builder never turns a bare OPEN into a downlink', async () => {
  const db = seedDb();
  try {
    const { outputs } = await drive(db, STREGA_BUILDER, {
      payload: { type: 'actuator_command', device: { devEui: VALVE }, data: { action: 'OPEN', commandId: 581, commandType: 'VALVE_COMMAND' } },
    });
    assert.deepEqual(stregaDownlinks(outputs), []);
    assert.equal(ackRows(db, 581)[0].result, 'REJECTED_PERMANENT');
  } finally {
    db.close();
  }
});

test('a second delivery of one STREGA physical action under a new command id replays its action: effect key', async () => {
  const db = seedDb();
  try {
    const key = `action:${VALVE}:flushing:1b4e28ba-2fa1-41d2-883f-0016c0000591`;
    const payload = { deviceEui: VALVE, returnPosition: 'CLOSE', percentage: 50, effect_key: key, expires_at: soon(300000) };
    const first = await deliver(db, [pendingCommand(591, 'SET_STREGA_FLUSHING', payload)]);
    assert.deepEqual(stregaDownlinks(first.outputs), [{ fPort: 28, bytes: [0x30, 50] }]);
    assert.equal(db.prepare('SELECT effect_key FROM applied_commands WHERE command_id = ?').get('591').effect_key, key,
      'the terminal ledger remembers the effect it applied');

    const second = await deliver(db, [pendingCommand(592, 'SET_STREGA_FLUSHING', payload)]);
    assert.deepEqual(stregaDownlinks(second.outputs), [], 'the same effect is not applied twice');
    const replay = second.outputs.find((o) => o.nodeId === ACK_OUT);
    assert.ok(replay, 'the replay is answered');
    const ack = JSON.parse(replay.msg.payload);
    assert.equal(ack.commandId, 592);
    assert.equal(ack.duplicate, true);
    assert.equal(ack.result, 'APPLIED');

    const otherValve = await deliver(db, [pendingCommand(593, 'SET_STREGA_FLUSHING', Object.assign({}, payload, { deviceEui: 'A840410000000002' }))]);
    assert.equal(otherValve.outputs.some((o) => o.nodeId === ACK_OUT && JSON.parse(o.msg.payload).duplicate === true), false,
      'a key naming another valve is not a replay of this one');
  } finally {
    db.close();
  }
});

// Fix round (F1, owner decision): a cloud SET_STREGA_TIMED_ACTION opens for the duration it
// carries (duration_seconds, then durationMinutes, then duration_minutes, then amount x
// unit), sent as OPEN_FOR_DURATION for 1..255 minutes. A timed close is refused.
function timedAction(commandId, extra) {
  return pendingCommand(commandId, 'SET_STREGA_TIMED_ACTION', Object.assign({
    deviceEui: VALVE, action: 'OPEN', payloadHex: '4105', fPort: 2, expires_at: soon(300000),
    effect_key: `action:${VALVE}:timed_action:1b4e28ba-2fa1-41d2-883f-0016c0000${commandId}`,
  }, extra));
}

test('a cloud timed action opens for its duration, by field precedence, as OPEN_FOR_DURATION', async () => {
  const cases = [
    [601, { unit: 'MINUTES', amount: 10 }, 10],
    [602, { unit: 'SECONDS', amount: 90 }, 2],
    [603, { unit: 'HOURS', amount: 4 }, 240],
    [604, { duration_seconds: 600, durationMinutes: 7, duration_minutes: 3, unit: 'MINUTES', amount: 5 }, 10],
    [605, { durationMinutes: 7, duration_minutes: 3, unit: 'MINUTES', amount: 5 }, 7],
    [606, { duration_minutes: 3, unit: 'MINUTES', amount: 5 }, 3],
  ];
  for (const [commandId, fields, minutes] of cases) {
    const db = seedDb();
    try {
      const { outputs } = await deliver(db, [timedAction(commandId, fields)]);
      assert.deepEqual(stregaDownlinks(outputs), [{ fPort: 2, bytes: [0x41, minutes] }], JSON.stringify(fields));
      const expectation = db.prepare('SELECT expectation_id, commanded_duration_seconds FROM valve_actuation_expectations').get();
      assert.equal(expectation.expectation_id, String(commandId), 'the open is tracked as an actuation');
      const stored = db.prepare('SELECT result, effect_key FROM applied_commands WHERE command_id = ?').get(String(commandId));
      assert.equal(stored.result, 'APPLIED');
      assert.equal(stored.effect_key, `action:${VALVE}:timed_action:1b4e28ba-2fa1-41d2-883f-0016c0000${commandId}`,
        'the terminal ACK carries the action: key, so a redelivery replays');
    } finally {
      db.close();
    }
  }
});

test('a cloud timed action without a usable duration, over 255 minutes, or closing is refused', async () => {
  const cases = [
    [611, { unit: 'HOURS', amount: 5 }, 'duration_out_of_range'],
    [612, { duration_seconds: 15360 }, 'duration_out_of_range'],
    [613, { action: 'CLOSE', unit: 'MINUTES', amount: 10 }, 'valve_action_not_allowed'],
    [614, {}, 'missing_or_invalid_duration'],
    [615, { unit: 'MINUTES', amount: 0 }, 'missing_or_invalid_duration'],
    [616, { unit: 'DAYS', amount: 2 }, 'missing_or_invalid_duration'],
    [617, { unit: 'MINUTES', amount: 256 }, 'missing_or_invalid_duration'],
  ];
  for (const [commandId, fields, reason] of cases) {
    const db = seedDb();
    try {
      const { outputs } = await deliver(db, [timedAction(commandId, fields)]);
      assert.deepEqual(stregaDownlinks(outputs), [], JSON.stringify(fields));
      const acks = ackRows(db, commandId);
      assert.equal(acks.length, 1, JSON.stringify(fields));
      assert.equal(acks[0].result, 'REJECTED_PERMANENT');
      assert.equal(acks[0].reason, reason, JSON.stringify(fields));
    } finally {
      db.close();
    }
  }
});

test('a second delivery of one cloud timed action under a new command id replays instead of opening again', async () => {
  const db = seedDb();
  try {
    const key = `action:${VALVE}:timed_action:1b4e28ba-2fa1-41d2-883f-0016c0000621`;
    const first = await deliver(db, [timedAction(621, { unit: 'MINUTES', amount: 10, effect_key: key })]);
    assert.deepEqual(stregaDownlinks(first.outputs), [{ fPort: 2, bytes: [0x41, 10] }]);
    const second = await deliver(db, [timedAction(622, { unit: 'MINUTES', amount: 10, effect_key: key })]);
    assert.deepEqual(stregaDownlinks(second.outputs), [], 'the same issuance does not open twice');
    const replay = second.outputs.find((o) => o.nodeId === ACK_OUT && JSON.parse(o.msg.payload).commandId === 622);
    assert.ok(replay);
    assert.equal(JSON.parse(replay.msg.payload).duplicate, true);
  } finally {
    db.close();
  }
});

test('a cancel for actuation A leaves actuation B pending, never queues B\'s open again, and names it in the ACK', async () => {
  const db = seedDb();
  try {
    const insert = db.prepare(
      "INSERT INTO valve_actuation_expectations (expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) " +
      "VALUES (?, ?, ?, ?, 600, ?, 'unknown', 'PENDING_OBSERVATION', ?)"
    );
    insert.run('701', VALVE, '701', '2026-10-01T10:00:00.000Z', '2026-10-01T10:12:00.000Z', '2026-10-01T10:00:00.000Z');
    insert.run('702', VALVE, '702', '2026-10-01T10:01:00.000Z', '2026-10-01T10:13:00.000Z', '2026-10-01T10:01:00.000Z');
    const open = Buffer.from([0x41, 10]).toString('base64');
    const plan = Buffer.from([0x01, 0x02, 0x03]).toString('base64');
    const queue = [
      { id: 'q-a', fPort: 2, data: open, confirmed: false, isPending: false, isEncrypted: false },
      { id: 'q-plan', fPort: 10, data: plan, confirmed: false, isPending: false, isEncrypted: false },
      { id: 'q-b', fPort: 2, data: open, confirmed: false, isPending: false, isEncrypted: false },
    ];
    const fake = fakeChirpstack(queue);
    await deliver(db, [pendingCommand(703, 'CANCEL_VALVE_ACTUATION', {
      device_eui: VALVE, expectation_id: '701', reason: 'operator_cancel', expires_at: soon(300000),
    })], { chirpstack: fake.lib });

    const states = Object.fromEntries(db.prepare('SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations').all()
      .map((r) => [r.expectation_id, r.reconciliation_state]));
    assert.deepEqual(states, { 701: 'CANCELLED', 702: 'PENDING_OBSERVATION' });
    assert.deepEqual(queue.map((item) => [item.fPort, item.data]), [[10, plan]],
      'the plan push is queued again; B\'s open, which may already have been sent, is never queued again');
    const ack = ackRows(db, 703)[0];
    assert.equal(ack.result, 'APPLIED');
    assert.equal(ack.reason, 'dropped_opens=1 expectation_ids=702', 'the cloud ACK names the actuation whose open was taken out');
  } finally {
    db.close();
  }
});

test('a cancel that names no actuation is refused while two are active', async () => {
  const db = seedDb();
  try {
    const insert = db.prepare(
      "INSERT INTO valve_actuation_expectations (expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) " +
      "VALUES (?, ?, ?, ?, 600, ?, 'unknown', 'PENDING_OBSERVATION', ?)"
    );
    insert.run('711', VALVE, '711', '2026-10-01T10:00:00.000Z', '2026-10-01T10:12:00.000Z', '2026-10-01T10:00:00.000Z');
    insert.run('712', VALVE, '712', '2026-10-01T10:01:00.000Z', '2026-10-01T10:13:00.000Z', '2026-10-01T10:01:00.000Z');
    const queue = [{ id: 'q-a', fPort: 2, data: Buffer.from([0x41, 10]).toString('base64'), confirmed: false, isPending: false, isEncrypted: false }];
    const fake = fakeChirpstack(queue);
    await deliver(db, [pendingCommand(713, 'CANCEL_VALVE_ACTUATION', { device_eui: VALVE, reason: 'operator_cancel' })], { chirpstack: fake.lib });
    const acks = ackRows(db, 713);
    assert.equal(acks[0].result, 'REJECTED_PERMANENT');
    assert.match(String(acks[0].reason), /ambiguous_actuation/);
    assert.equal(fake.calls.flush, 0, 'nothing is flushed');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE reconciliation_state = 'CANCELLED'").get().n, 0);
  } finally {
    db.close();
  }
});

test('a cloud open is tracked under its command id as text, the id a cancel names', async () => {
  const db = seedDb();
  try {
    await deliver(db, [pendingCommand(721, 'OPEN_FOR_DURATION', {
      device_eui: VALVE, duration_seconds: 600, expires_at: soon(300000),
    })]);
    const row = db.prepare('SELECT expectation_id FROM valve_actuation_expectations').get();
    assert.equal(row && row.expectation_id, '721');
  } finally {
    db.close();
  }
});

test('the local cancel route reports the other open it took out of the queue', async () => {
  const db = seedDb();
  try {
    const insert = db.prepare(
      "INSERT INTO valve_actuation_expectations (expectation_id, device_eui, command_id, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) " +
      "VALUES (?, ?, ?, ?, 600, ?, 'unknown', 'PENDING_OBSERVATION', ?)"
    );
    insert.run('731', VALVE, '731', '2026-10-01T10:00:00.000Z', '2026-10-01T10:12:00.000Z', '2026-10-01T10:00:00.000Z');
    insert.run('732', VALVE, '732', '2026-10-01T10:01:00.000Z', '2026-10-01T10:13:00.000Z', '2026-10-01T10:01:00.000Z');
    const open = Buffer.from([0x41, 10]).toString('base64');
    const queue = [
      { id: 'q-a', fPort: 2, data: open, confirmed: false, isPending: false, isEncrypted: false },
      { id: 'q-b', fPort: 2, data: open, confirmed: false, isPending: false, isEncrypted: false },
    ];
    const fake = fakeChirpstack(queue);
    const run = await executeFunction(byId[idOf('Cancel STREGA Actuation')], {
      msg: {
        req: { headers: { authorization: makeAuthHeader({ userId: 1, username: 'grower', secret: 'valve-test-secret' }) }, params: { deveui: VALVE } },
        payload: { expectation_id: '731', reason: 'operator_cancel' },
      },
      env: Object.assign({ AUTH_TOKEN_SECRET: 'valve-test-secret' }, ENV),
      db,
      osiLibModules: { 'osi-valve-control': valveControl },
      libOverrides: { chirpstack: fake.lib },
    });
    assert.equal(run.result.statusCode, 200, JSON.stringify(run.result.payload));
    assert.deepEqual(run.result.payload.dropped_opens, { count: 1, expectationIds: ['732'] });
    assert.equal(queue.length, 0, 'neither open is queued again');
    const states = Object.fromEntries(db.prepare('SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations').all()
      .map((r) => [r.expectation_id, r.reconciliation_state]));
    assert.deepEqual(states, { 731: 'CANCELLED', 732: 'PENDING_OBSERVATION' }, 'the dropped actuation is reported, not cancelled');
  } finally {
    db.close();
  }
});

// A partial opening ([0x31, pct]) or a flushing sent on fPort 2 would be read by the valve as
// an open; the cloud fPort is not trusted for these two types.
async function assertPortPinned(commandId, type, fields, downlink) {
  const db = seedDb();
  try {
    const { outputs } = await deliver(db, [pendingCommand(commandId, type, Object.assign({ deviceEui: VALVE, expires_at: soon(300000) }, fields))]);
    assert.deepEqual(stregaDownlinks(outputs), [downlink], type);
  } finally {
    db.close();
  }
}

test('a cloud partial opening naming fPort 2 still goes out on fPort 27', async () => {
  await assertPortPinned(741, 'SET_STREGA_PARTIAL_OPENING', { action: 'OPEN', percentage: 50, fPort: 2 }, { fPort: 27, bytes: [0x31, 50] });
});

test('a cloud flushing naming fPort 2 still goes out on fPort 28', async () => {
  await assertPortPinned(742, 'SET_STREGA_FLUSHING', { returnPosition: 'OPEN', percentage: 40, fPort: 2 }, { fPort: 28, bytes: [0x31, 40] });
});
