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
//   gateway clock is ahead of their expiry.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/scoped-access-harness');

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
// entry is short-circuited to Route Command here.
const EXECUTED = new Set([
  'sync-pending-split',
  'reject-indefinite-open',
  'command-dedupe-dispatch',
  ROUTE,
  'write-strega-expectation',
  STREGA_BUILDER,
  'command-ack-queue-rest',
  idOf('Valve Cloud Command Bridge'),
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
    const targetId = nodeId === PASS_THROUGH_TO_ROUTE ? ROUTE : nodeId;
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
      assert.equal(ackRows(db, commandId).length, 0, 'an accepted open is not refused');
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

test('a cloud timed action that carries no duration field is answered, not dropped', async () => {
  const db = seedDb();
  try {
    const { outputs } = await deliver(db, [pendingCommand(595, 'SET_STREGA_TIMED_ACTION', {
      deviceEui: VALVE, action: 'OPEN', unit: 'MINUTES', amount: 5,
      effect_key: `action:${VALVE}:timed_action:1b4e28ba-2fa1-41d2-883f-0016c0000595`,
    })]);
    assert.deepEqual(stregaDownlinks(outputs), []);
    const acks = ackRows(db, 595);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].result, 'REJECTED_PERMANENT');
    assert.equal(acks[0].reason, 'missing_or_invalid_duration');
  } finally {
    db.close();
  }
});
