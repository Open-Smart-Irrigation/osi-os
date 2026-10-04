'use strict';

// E3: exercise the shipped protected-command dispatch chain end to end.  The
// probe runs the real Node-RED function bodies (dedupe, protected applier,
// durable ACK queue) against one SQLite database and checks that replay never
// rewrites terminal evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const FLOW = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const flows = JSON.parse(fs.readFileSync(FLOW, 'utf8'));
const byName = Object.fromEntries(flows.filter((node) => node.name).map((node) => [node.name, node]));
const dedupe = byName['Deduplicate Pending Command'];
const helper = byName['Apply WATERMARK Protected Command'];
const ackQueue = byName['Queue REST Command ACK'];
assert.ok(dedupe && helper && ackQueue, 'protected dispatch nodes exist');
assert.match(helper.func, /applyLegacySoilDepthsCommand/);

const watermark = require(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js'));
const ledger = require(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js'));
const raw = new DatabaseSync(':memory:');
raw.exec(SEED);

const gateway = '0016C001F1000002';
const device = 'A84041A171000002';
const owner = '22222222-2222-4222-8222-222222222222';
const now = '2026-09-30T09:00:00.000Z';
const calibration = {
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
};
raw.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) VALUES(?,?,?,?,?,?,?)')
  .run(1, 'owner', 'hash', now, now, owner, 'admin');
raw.prepare('INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES(?,?,?,?)')
  .run('cloud', 1, gateway, now);
raw.prepare('INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)')
  .run(device, 'Watermark', 'DRAGINO_LSN50', 1, null, gateway, now, now);
raw.prepare('INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)')
  .run('A84041A171000001', 'Legacy depths', 'KIWI_SENSOR', 1, null, '0016C001F1000001', now, now);

function scope() {
  return {
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    run: async (sql, params = []) => { raw.prepare(sql).run(...params); },
    exec: async (sql) => raw.exec(sql),
  };
}

class Database {
  async transaction(fn) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(scope());
      raw.exec('COMMIT');
      return result;
    } catch (error) {
      try { raw.exec('ROLLBACK'); } catch (_) { /* test database cleanup */ }
      throw error;
    }
  }

  close(callback) { callback(); }
}

const osiLib = {
  require(name) {
    if (name === 'osi-db-helper') return { ok: true, value: { Database } };
    if (name === 'watermark-helper') return { ok: true, value: watermark };
    if (name === 'osi-command-ledger') return { ok: true, value: ledger };
    return { ok: false, error: 'unexpected helper ' + name };
  },
};
let activeGateway = gateway;
const env = { get: (key) => ({ DEVICE_EUI: activeGateway, OSI_SCOPED_ACCESS: '1' }[key] || '') };
const nodeErrors = [];
const node = {
  error: (...args) => { nodeErrors.push(args); },
  warn: () => {},
  status: () => {},
};
const flow = {};
const runDedupe = new Function('msg', 'node', 'env', 'flow', 'osiLib', dedupe.func);
const runHelper = new Function('msg', 'node', 'env', 'flow', 'osiLib', helper.func);
const runAckQueue = new Function('msg', 'node', 'env', 'flow', 'osiLib', ackQueue.func);

function envelope(commandId, changes = {}) {
  const payload = Object.assign({
    command_type: 'SET_WATERMARK_CALIBRATION',
    command_id: '11111111-1111-4111-8111-' + String(commandId).padStart(12, '0'),
    effect_key: `watermark_calibration:set:${gateway}:${device}:0`,
    device_eui: device,
    gateway_device_eui: gateway,
    actor_user_uuid: owner,
    base_sync_version: 0,
    operation: 'set',
    values: Object.assign({}, calibration),
  }, changes);
  return { commandId, commandType: 'SET_WATERMARK_CALIBRATION', effectKey: payload.effect_key, payload };
}

async function dispatch(command) {
  nodeErrors.length = 0;
  const msg = {
    payload: { _pendingCommandEnvelope: command },
    _commandTypeRecognized: true,
  };
  const deduped = await runDedupe(msg, node, env, flow, osiLib);
  assert.deepEqual(deduped, [null, null, msg], 'protected command must reach semantic helper');
  const applied = await runHelper(deduped[2], node, env, flow, osiLib);
  assert.equal(applied[0], null);
  assert.ok(applied[1], 'protected helper must return an ACK message');
  const queued = await runAckQueue(applied[1], node, env, flow, osiLib);
  return { applied, queued, queueErrors: nodeErrors.slice() };
}

async function dispatchLegacy(command) {
  nodeErrors.length = 0;
  const msg = { payload: { _pendingCommandEnvelope: command }, _commandTypeRecognized: true };
  const deduped = await runDedupe(msg, node, env, flow, osiLib);
  assert.deepEqual(deduped, [null, null, msg], 'legacy command must reach compatibility helper');
  const applied = await runHelper(deduped[2], node, env, flow, osiLib);
  assert.equal(applied[0], null);
  assert.ok(applied[1], 'legacy helper must return an ACK message');
  return applied[1];
}

function evidence(commandId) {
  const ledgerRow = raw.prepare('SELECT result_detail FROM applied_commands WHERE command_id=?').get(String(commandId));
  const ackRow = raw.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').get(String(commandId));
  assert.ok(ledgerRow && ackRow, 'terminal ledger and durable ACK exist');
  const ledgerCount = raw.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get(String(commandId)).n;
  const ackCount = raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get(String(commandId)).n;
  return { resultDetail: ledgerRow.result_detail, payloadJson: ackRow.payload_json, ledgerCount, ackCount };
}

function assertAckQueueFailsClosed(result, label) {
  assert.equal(result.queued, null, label + ' ACK queue must fail closed without a trusted protected binding');
  assert.equal(result.queueErrors.length, 1, label + ' ACK queue must report its failure');
  assert.match(String(result.queueErrors[0][0]), /^Failed to queue durable command ACK: trusted gateway binding is required$/);
}

(async () => {
  const first = await dispatch(envelope(9201));
  assertAckQueueFailsClosed(first, 'first delivery');
  const firstAckJson = first.applied[1].payload;
  assert.equal(JSON.parse(firstAckJson).result, 'APPLIED');
  const beforeReplay = evidence(9201);
  assert.equal(beforeReplay.resultDetail, firstAckJson, 'first ACK must match stored terminal result detail');
  assert.deepEqual({ ledgerCount: beforeReplay.ledgerCount, ackCount: beforeReplay.ackCount }, { ledgerCount: 1, ackCount: 1 });

  const exact = await dispatch(envelope(9201));
  assertAckQueueFailsClosed(exact, 'exact replay');
  assert.equal(exact.applied[1].payload, beforeReplay.resultDetail, 'exact replay must return the complete stored ACK byte-for-byte');
  assert.deepEqual(JSON.parse(exact.applied[1].payload), JSON.parse(beforeReplay.resultDetail));
  assert.deepEqual(evidence(9201), beforeReplay, 'exact replay must preserve terminal evidence bytes');

  const changed = await dispatch(envelope(9201, {
    actor_user_uuid: '44444444-4444-4444-8444-444444444444',
  }));
  assertAckQueueFailsClosed(changed, 'changed binding');
  assert.equal(changed.applied[1] && JSON.parse(changed.applied[1].payload).result, 'CONFLICT');
  assert.deepEqual(evidence(9201), beforeReplay, 'same-ID changed binding must preserve terminal evidence bytes');
  assert.deepEqual({ ledgerCount: evidence(9201).ledgerCount, ackCount: evidence(9201).ackCount }, { ledgerCount: 1, ackCount: 1 });

  activeGateway = '0016C001F1000001';
  const legacyPayload = {
    deviceEui: 'A84041A171000001',
    gatewayDeviceEui: activeGateway,
    soilMoistureProbeDepthsJson: {},
    soilMoistureProbeDepthsConfigured: false,
    syncVersion: 0,
  };
  const legacy = await dispatchLegacy({
    commandId: 9301,
    commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
    payload: legacyPayload,
  });
  assert.equal(JSON.parse(legacy.payload).commandId, 9301);
  assert.equal(JSON.parse(legacy.payload).appliedSyncVersion, null);
  const legacyRow = raw.prepare('SELECT soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured, sync_version FROM devices WHERE deveui=?').get('A84041A171000001');
  assert.equal(legacyRow.soil_moisture_probe_depths_json, '{}');
  assert.equal(legacyRow.soil_moisture_probe_depths_configured, 0);
  assert.equal(legacyRow.sync_version, 1);
  const configuredLegacy = await dispatchLegacy({
    commandId: 9302,
    commandType: 'UPSERT_DEVICE_SOIL_DEPTHS',
    appliedSyncVersion: 7,
    payload: { ...legacyPayload, soilMoistureProbeDepthsJson: { swt_1: 20, swt_2: 40, swt_3: -1, swt_4: 1001 }, soilMoistureProbeDepthsConfigured: true, syncVersion: 1 },
  });
  assert.equal(JSON.parse(configuredLegacy.payload).appliedSyncVersion, 7);
  const configuredRow = raw.prepare('SELECT soil_moisture_probe_depths_json, soil_moisture_probe_depths_configured, sync_version FROM devices WHERE deveui=?').get('A84041A171000001');
  assert.equal(configuredRow.soil_moisture_probe_depths_json, '{"swt_1":20,"swt_2":40}');
  assert.equal(configuredRow.soil_moisture_probe_depths_configured, 1);
  assert.equal(configuredRow.sync_version, 7);
  const replayAfterLocalEdit = await dispatchLegacy({ commandId: 9301, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS', payload: legacyPayload });
  assert.equal(replayAfterLocalEdit.payload, legacy.payload, 'legacy replay keeps original ACK after a later local edit');
  const legacyEvidence = raw.prepare('SELECT binding_hash, intent_hash, actor_user_uuid, base_sync_version, operation FROM applied_commands WHERE command_id=?').get('9301');
  assert.equal(legacyEvidence.binding_hash, null);
  assert.equal(legacyEvidence.intent_hash, null);
  assert.equal(legacyEvidence.actor_user_uuid, null);
  assert.equal(legacyEvidence.base_sync_version, null);
  assert.equal(legacyEvidence.operation, null);
  const replay = await dispatchLegacy({ commandId: 9301, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS', payload: legacyPayload });
  assert.equal(replay.payload, legacy.payload, 'legacy exact replay returns original ACK');
  const changedLegacy = await dispatchLegacy({ commandId: 9301, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS', payload: { ...legacyPayload, soilMoistureProbeDepthsConfigured: true } });
  assert.equal(JSON.parse(changedLegacy.payload).result, 'CONFLICT', 'legacy same-ID changed binding conflicts');
  const foreignPayload = { ...legacyPayload, deviceEui: device };
  const foreign = await dispatchLegacy({ commandId: 9303, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS', payload: foreignPayload });
  assert.equal(JSON.parse(foreign.payload).result, 'CONFLICT');
  assert.equal(raw.prepare('SELECT result FROM applied_commands WHERE command_id=?').get('9303').result, 'CONFLICT');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get('9303').n, 1);
  const foreignReplay = await dispatchLegacy({ commandId: 9303, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS', payload: foreignPayload });
  assert.equal(foreignReplay.payload, foreign.payload, 'legacy conflict replay returns durable ACK');
  const override = await dispatchLegacy({ commandId: 9304, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS', appliedSyncVersion: 1, payload: legacyPayload });
  assert.equal(JSON.parse(override.payload).appliedSyncVersion, 1);
  const overrideChanged = await dispatchLegacy({ commandId: 9304, commandType: 'UPSERT_DEVICE_SOIL_DEPTHS', payload: legacyPayload });
  assert.equal(JSON.parse(overrideChanged.payload).result, 'CONFLICT', 'ACK-version binding changes conflict even when DB version is unchanged');
  console.log('PROTECTED_COMMAND_REPLAY_CHAIN_OK');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => raw.close());
