#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const FLOWS = path.join(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const byId = Object.fromEntries(flows.filter((node) => node.id).map((node) => [node.id, node]));

const UPDATE = '4f4a765f36cee6f3';
const APPLY = '78d3d38be30a8741';
const ROUTER = 'command-postcondition-route';
const POSTCONDITION = 'command-postcondition-build';
const VERIFY = 'command-postcondition-verify-db';
const ACK = 'command-postcondition-ack';
const ACK_QUEUE = 'command-ack-queue-rest';
const LEGACY_ACK = 'e2e139678c3ddded';

function fail(message) {
  throw new Error('verify-command-ack-postconditions: ' + message);
}

function node(id) {
  if (!byId[id]) fail('missing node ' + id);
  return byId[id];
}

function wires(id, expected) {
  const actual = JSON.stringify(node(id).wires || []);
  if (actual !== JSON.stringify(expected)) {
    fail(`${node(id).name || id} wires ${actual}, expected ${JSON.stringify(expected)}`);
  }
}

function runFunction(flowNode, message, dependencies) {
  const flowState = new Map();
  const sandbox = {
    msg: message,
    env: { get(key) { return key === 'DEVICE_EUI' ? 'AABBCCDDEEFF0011' : undefined; } },
    flow: { get(key) { return flowState.get(key); }, set(key, value) { flowState.set(key, value); } },
    global: { get() { return undefined; } },
    node: { warn() {}, error() {}, status() {} },
    osiLib: dependencies && dependencies.osiLib,
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    JSON,
    Math,
    parseInt,
    parseFloat,
    isFinite,
    Infinity,
    NaN
  };
  const output = vm.runInNewContext(`(function () { ${flowNode.func}\n})()`, sandbox, { timeout: 1000 });
  return output === undefined ? message : output;
}

function sqliteLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function bind(statement, parameters) {
  let index = 0;
  return statement.replace(/\?/g, () => sqliteLiteral((parameters || [])[index++]));
}

function ledgerDatabase(dbPath) {
  return {
    async run(statement, parameters) {
      sql(dbPath, bind(statement, parameters));
      return {};
    },
    async get(statement, parameters) {
      return rows(dbPath, bind(statement, parameters))[0];
    },
    async all(statement, parameters) {
      return rows(dbPath, bind(statement, parameters));
    },
    async transaction(work) {
      return work(this);
    },
    close(callback) {
      callback();
    }
  };
}

async function queueVerifiedAck(dbPath, message) {
  const ledger = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger');
  const osiLib = {
    require(name) {
      if (name === 'osi-db-helper') return { ok: true, value: { Database: function Database() { return ledgerDatabase(dbPath); } } };
      if (name === 'osi-command-ledger') return { ok: true, value: ledger };
      return { ok: false, error: 'unexpected helper ' + name };
    }
  };
  return await runFunction(node(ACK_QUEUE), message, { osiLib });
}

function sql(db, statement) {
  return execFileSync('sqlite3', ['-bail', db], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function rows(db, statement) {
  const output = execFileSync('sqlite3', ['-bail', '-json', db, statement], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  return output ? JSON.parse(output) : [];
}

function makeDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-command-postcondition-'));
  const db = path.join(directory, 'farming.db');
  sql(db, `
    CREATE TABLE irrigation_zones (
      id INTEGER PRIMARY KEY, zone_uuid TEXT UNIQUE, sync_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE irrigation_schedules (
      irrigation_zone_id INTEGER PRIMARY KEY, trigger_metric TEXT, threshold_kpa REAL,
      duration_minutes INTEGER, enabled INTEGER, response_mode TEXT, sync_version INTEGER NOT NULL,
      created_at TEXT, updated_at TEXT, last_applied_at TEXT
    );
    CREATE TABLE devices (
      deveui TEXT PRIMARY KEY, irrigation_zone_id INTEGER, gateway_device_eui TEXT,
      updated_at TEXT, sync_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE applied_commands (
      command_id TEXT PRIMARY KEY, effect_key TEXT, device_eui TEXT, command_type TEXT,
      result TEXT, applied_at TEXT, result_detail TEXT, originator TEXT
    );
    CREATE TABLE command_ack_outbox (
      command_id TEXT, payload_json TEXT, created_at TEXT, delivered_at TEXT
    );
  `);
  return { db, directory };
}

function command(type, fields) {
  return Object.assign({
    commandType: type,
    commandId: `${type}-command`,
    eventUuid: `${type}-event`,
    aggregateType: type === 'UPSERT_SCHEDULE' ? 'IRRIGATION_SCHEDULE' : 'DEVICE',
    aggregateKey: type === 'UPSERT_SCHEDULE' ? 'zone-a' : 'AABBCCDDEEFF0011',
    appliedSyncVersion: 4
  }, fields);
}

function applyAndVerify(db, cmd, afterApply) {
  const built = runFunction(node(UPDATE), { payload: cmd });
  try {
    sql(db, built.topic);
  } catch (error) {
    return { ack: null, applyError: error };
  }
  if (afterApply) afterApply();
  const verification = runFunction(node(POSTCONDITION), built);
  try {
    verification.payload = rows(db, verification.topic);
  } catch (error) {
    return { ack: null, verificationError: error };
  }
  return { ack: runFunction(node(ACK), verification) };
}

function expectSuccess(result, expected) {
  assert(result.ack, 'expected acknowledgement after verified apply');
  assert.strictEqual(result.ack.syncAck.result, 'SUCCESS');
  assert.strictEqual(result.ack.syncAck.state, 'APPLIED');
  Object.entries(expected).forEach(([key, value]) => assert.deepStrictEqual(result.ack.syncAck[key], value));
}

function verifyWiring() {
  wires(UPDATE, [[APPLY]]);
  wires(APPLY, [[ROUTER]]);
  wires(ROUTER, [[POSTCONDITION], [LEGACY_ACK]]);
  wires(POSTCONDITION, [[VERIFY]]);
  wires(VERIFY, [[ACK]]);
  wires(ACK, [[ACK_QUEUE]]);
  wires(LEGACY_ACK, [['d83e38164efbb860']]);
  const source = node(ACK).func || '';
  ['postcondition_not_met', 'FAILED_RETRYABLE', 'stale_sync_version', 'sync_version'].forEach((text) => {
    if (!source.includes(text)) fail(`verified ACK does not contain ${text}`);
  });
}

function verifyRoutingMatrix() {
  const verifiedTypes = ['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE'];
  const deferredTypes = [
    'SET_LSN50_MODE', 'SET_LSN50_INTERVAL', 'SET_LSN50_INTERRUPT_MODE', 'SET_LSN50_5V_WARMUP',
    'SET_KIWI_INTERVAL', 'ENABLE_KIWI_TEMP_HUMIDITY', 'SET_STREGA_INTERVAL', 'SET_STREGA_TIMED_ACTION',
    'SET_STREGA_MAGNET_MODE', 'SET_STREGA_PARTIAL_OPENING', 'SET_STREGA_FLUSHING'
  ];
  const directTypes = [
    'UPSERT_ZONE', 'DELETE_ZONE', 'UPSERT_ZONE_CONFIG', 'UPSERT_ZONE_LOCATION', 'UPSERT_DEVICE_FLAGS',
    'UPSERT_DEVICE_SOIL_DEPTHS', 'UNCLAIM_DEVICE', 'SET_STREGA_MODEL'
  ];
  for (const type of verifiedTypes) {
    const output = runFunction(node(ROUTER), { syncAck: { commandType: type } });
    assert(output[0] && !output[1], `${type} must enter postcondition verification only`);
  }
  for (const type of deferredTypes) {
    const output = runFunction(node(ROUTER), { syncAck: { commandType: type } });
    assert.strictEqual(output[0], null, `${type} must defer its physical-effect ACK`);
    assert.strictEqual(output[1], null, `${type} must defer its physical-effect ACK`);
  }
  for (const type of directTypes) {
    const output = runFunction(node(ROUTER), { syncAck: { commandType: type, commandId: type + '-command' } });
    assert(!output[0] && output[1], `${type} must retain the direct ACK path`);
  }
  const legacyMessage = runFunction(node(LEGACY_ACK), { syncAck: { commandType: 'UPSERT_ZONE', commandId: 'zone-command' } });
  assert.strictEqual(legacyMessage.topic, 'devices/AABBCCDDEEFF0011/command_ack');
  assert.strictEqual(JSON.parse(legacyMessage.payload).result, 'SUCCESS');
}

async function runCases() {
  const temporary = makeDb();
  try {
    const schedule = command('UPSERT_SCHEDULE', {
      zoneUuid: 'zone-a', triggerMetric: 'SWT_WM1', thresholdKpa: 17.5,
      durationMinutes: 12, enabled: true, responseMode: 'proportional'
    });
    sql(temporary.db, "INSERT INTO irrigation_zones (id, zone_uuid, sync_version) VALUES (1, 'zone-a', 4);");
    const scheduled = applyAndVerify(temporary.db, schedule);
    expectSuccess(scheduled, { commandId: schedule.commandId });
    const queuedSchedule = await queueVerifiedAck(temporary.db, scheduled.ack);
    assert.strictEqual(queuedSchedule.topic, 'devices/AABBCCDDEEFF0011/command_ack');
    const durableSchedule = JSON.parse(rows(temporary.db, "SELECT payload_json FROM command_ack_outbox WHERE command_id='UPSERT_SCHEDULE-command'" )[0].payload_json);
    const mqttSchedule = JSON.parse(queuedSchedule.payload);
    assert.deepStrictEqual(mqttSchedule, durableSchedule);
    assert.deepStrictEqual({
      commandId: durableSchedule.commandId,
      eventUuid: durableSchedule.eventUuid,
      aggregateType: durableSchedule.aggregateType,
      aggregateKey: durableSchedule.aggregateKey,
      commandType: durableSchedule.commandType,
      requestedSyncVersion: durableSchedule.requestedSyncVersion,
      appliedSyncVersion: durableSchedule.appliedSyncVersion
    }, {
      commandId: schedule.commandId,
      eventUuid: schedule.eventUuid,
      aggregateType: schedule.aggregateType,
      aggregateKey: schedule.aggregateKey,
      commandType: 'UPSERT_SCHEDULE',
      requestedSyncVersion: 4,
      appliedSyncVersion: 4
    });
    expectSuccess(applyAndVerify(temporary.db, schedule), { commandId: schedule.commandId });
    assert.deepStrictEqual(rows(temporary.db, 'SELECT trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version FROM irrigation_schedules'), [{ trigger_metric: 'SWT_WM1', threshold_kpa: 17.5, duration_minutes: 12, enabled: 1, response_mode: 'proportional', sync_version: 4 }]);
    const updateSchedule = command('UPDATE_SCHEDULE', {
      zoneUuid: 'zone-a', triggerMetric: 'SWT_WM2', thresholdKpa: 18.5,
      durationMinutes: 13, enabled: false, responseMode: 'fixed', appliedSyncVersion: 5
    });
    expectSuccess(applyAndVerify(temporary.db, updateSchedule), { commandId: updateSchedule.commandId });

    const missingSchedule = applyAndVerify(temporary.db, command('UPSERT_SCHEDULE', { zoneUuid: 'missing-zone', triggerMetric: 'SWT_WM1', thresholdKpa: 10, durationMinutes: 3, enabled: true }));
    assert.strictEqual(missingSchedule.ack.syncAck.result, 'FAILED_RETRYABLE');
    assert.strictEqual(missingSchedule.ack.syncAck.error, 'postcondition_not_met');

    const assign = command('ASSIGN_DEVICE_TO_ZONE', { zoneUuid: 'zone-a', deviceEui: 'AABBCCDDEEFF0011' });
    sql(temporary.db, "INSERT INTO devices (deveui, sync_version) VALUES ('AABBCCDDEEFF0011', 0);");
    expectSuccess(applyAndVerify(temporary.db, assign), { commandId: assign.commandId });
    expectSuccess(applyAndVerify(temporary.db, assign), { commandId: assign.commandId });
    assert.deepStrictEqual(rows(temporary.db, 'SELECT irrigation_zone_id, sync_version FROM devices'), [{ irrigation_zone_id: 1, sync_version: 4 }]);

    const missingZone = applyAndVerify(temporary.db, command('ASSIGN_DEVICE_TO_ZONE', { zoneUuid: 'missing-zone', deviceEui: 'AABBCCDDEEFF0011' }));
    assert.strictEqual(missingZone.ack.syncAck.result, 'FAILED_RETRYABLE');
    const missingDevice = applyAndVerify(temporary.db, command('ASSIGN_DEVICE_TO_ZONE', { zoneUuid: 'zone-a', deviceEui: 'MISSING' }));
    assert.strictEqual(missingDevice.ack.syncAck.result, 'FAILED_RETRYABLE');

    const remove = command('REMOVE_DEVICE_FROM_ZONE', { deviceEui: 'AABBCCDDEEFF0011' });
    expectSuccess(applyAndVerify(temporary.db, remove), { commandId: remove.commandId });
    expectSuccess(applyAndVerify(temporary.db, remove), { commandId: remove.commandId });
    assert.deepStrictEqual(rows(temporary.db, 'SELECT irrigation_zone_id, sync_version FROM devices'), [{ irrigation_zone_id: null, sync_version: 4 }]);
    const missingRemoval = applyAndVerify(temporary.db, command('REMOVE_DEVICE_FROM_ZONE', { deviceEui: 'MISSING' }));
    assert.strictEqual(missingRemoval.ack.syncAck.result, 'FAILED_RETRYABLE');

    sql(temporary.db, "UPDATE irrigation_schedules SET trigger_metric='NEWER', sync_version=9 WHERE irrigation_zone_id=1; UPDATE devices SET irrigation_zone_id=1, sync_version=9 WHERE deveui='AABBCCDDEEFF0011';");
    const olderSchedule = applyAndVerify(temporary.db, command('UPSERT_SCHEDULE', { zoneUuid: 'zone-a', triggerMetric: 'OLDER', thresholdKpa: 1, durationMinutes: 1, enabled: false, appliedSyncVersion: 3 }));
    const olderAssign = applyAndVerify(temporary.db, command('ASSIGN_DEVICE_TO_ZONE', { zoneUuid: 'zone-a', deviceEui: 'AABBCCDDEEFF0011', appliedSyncVersion: 3 }));
    assert.strictEqual(olderSchedule.ack.syncAck.error, 'stale_sync_version');
    expectSuccess(olderAssign, { commandId: olderAssign.ack.syncAck.commandId });
    assert.deepStrictEqual(rows(temporary.db, 'SELECT trigger_metric, sync_version FROM irrigation_schedules'), [{ trigger_metric: 'NEWER', sync_version: 9 }]);
    assert.deepStrictEqual(rows(temporary.db, 'SELECT irrigation_zone_id, sync_version FROM devices'), [{ irrigation_zone_id: 1, sync_version: 9 }]);

    sql(temporary.db, "INSERT INTO irrigation_zones (id, zone_uuid, sync_version) VALUES (2, 'zone-b', 9); UPDATE devices SET irrigation_zone_id=2 WHERE deveui='AABBCCDDEEFF0011';");
    const conflictingOlderAssign = applyAndVerify(temporary.db, command('ASSIGN_DEVICE_TO_ZONE', { zoneUuid: 'zone-a', deviceEui: 'AABBCCDDEEFF0011', appliedSyncVersion: 3 }));
    assert.strictEqual(conflictingOlderAssign.ack.syncAck.result, 'REJECTED_PERMANENT');
    assert.strictEqual(conflictingOlderAssign.ack.syncAck.error, 'stale_sync_version');

    const verificationError = applyAndVerify(
      temporary.db,
      command('UPSERT_SCHEDULE', { commandId: 'verification-error-command', zoneUuid: 'zone-a', triggerMetric: 'NEWER', thresholdKpa: 2, durationMinutes: 2, enabled: true, appliedSyncVersion: 10 }),
      () => sql(temporary.db, 'ALTER TABLE irrigation_schedules RENAME TO broken_schedules;')
    );
    assert.strictEqual(verificationError.ack, null, 'verification SQL errors must not publish an ACK');
    assert(verificationError.verificationError, 'expected the real SQLite verification error');
    assert.strictEqual(rows(temporary.db, "SELECT COUNT(*) AS count FROM command_ack_outbox WHERE command_id='verification-error-command'")[0].count, 0, 'verification SQL errors must create zero durable ACK rows');

    sql(temporary.db, 'ALTER TABLE devices RENAME TO broken_devices;');
    const applyError = applyAndVerify(temporary.db, Object.assign({}, assign, { deviceEui: 'AABBCCDDEEFF0011', appliedSyncVersion: 10 }));
    assert.strictEqual(applyError.ack, null, 'apply SQL errors must not publish an ACK');
    assert(applyError.applyError, 'expected the real SQLite apply error');
    assert.strictEqual(rows(temporary.db, "SELECT COUNT(*) AS count FROM command_ack_outbox WHERE command_id='ASSIGN_DEVICE_TO_ZONE-command'")[0].count, 0, 'apply SQL errors must create zero durable ACK rows');
  } finally {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }
}

verifyWiring();
verifyRoutingMatrix();
runCases().then(() => {
  console.log('verify-command-ack-postconditions: PASS');
}).catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
