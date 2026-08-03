#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const FLOW_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map(function(relative) { return path.join(REPO, relative); });
const SPLIT_ID = 'sync-pending-split';
const FORCE_ID = 'sync-force-build';
const SOURCE_ID = 'journal-command-apply-fn';
const TARGET_ID = 'terra-zone-config-command-apply-fn';
const LEGACY_ROUTER_ID = '934bf2bc19a8ce22';
const MQTT_ACK_ID = '9d5e3035c3d069c4';
const SPLIT_BEFORE_SHA256 =
  '2b071e0263bb7c5fd078b0984d9538d7b83996bd37a78af22d8c17d72b9842b7';
const SOURCE_BEFORE_SHA256 =
  'ec1c31e4be6a2d4336fdf31b0564915fad30ed337dfdf4e1de2fea5d4ff1802b';
const FORCE_BEFORE_SHA256 =
  'f5ee51c4f5583630dd085384a3160814cf44cdef37a35ddbb0d7b974df1d2ae5';

const OLD_ENVELOPE = `    _pendingCommandEnvelope: {
      commandId: deliveryCommandId,
      commandType: trustedCommandType,
      effectKey: trustedEffectKey,
      payload: rawPayload
    }`;

const NEW_ENVELOPE = `    _pendingCommandEnvelope: {
      commandId: deliveryCommandId,
      eventUuid: cmd.eventUuid,
      commandType: trustedCommandType,
      aggregateType: cmd.aggregateType,
      aggregateKey: cmd.aggregateKey,
      appliedSyncVersion: cmd.appliedSyncVersion,
      effectKey: trustedEffectKey,
      payload: rawPayload
    }`;

const FORCE_OLD_ENVELOPE = `            _pendingCommandEnvelope: {
              commandId: deliveryCommandId,
              commandType: trustedCommandType,
              effectKey: trustedEffectKey,
              payload: rawPayload
            }`;

const FORCE_NEW_ENVELOPE = `            _pendingCommandEnvelope: {
              commandId: deliveryCommandId,
              eventUuid: cmd.eventUuid,
              commandType: trustedCommandType,
              aggregateType: cmd.aggregateType,
              aggregateKey: cmd.aggregateKey,
              appliedSyncVersion: cmd.appliedSyncVersion,
              effectKey: trustedEffectKey,
              payload: rawPayload
            }`;

const FUNCTION_SOURCE = `return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('Terra zone-config command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('Terra zone-config command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  if (commandType !== 'UPSERT_ZONE_CONFIG') return [msg, null];
  const dbLoad = osiLib.require('osi-db-helper');
  const zoneLoad = osiLib.require('zone-commands');
  if (!dbLoad.ok || !zoneLoad.ok) {
    const detail = [dbLoad, zoneLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Terra zone-config command helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new dbLoad.value.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await zoneLoad.value.applyZoneCommand(db, envelope, {
      gateway_device_eui: gatewayEui,
      command_type_recognized: msg._commandTypeRecognized === true
    });
    if (!result.handled) return [msg, null];
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Terra zone-config command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Terra zone-config command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

function serialized(flow) {
  return JSON.stringify(flow, null, 2) + '\n';
}

function hashNode(node) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(node))
    .digest('hex');
}

function assertRoundtrip(raw, relativePath) {
  const rendered = serialized(JSON.parse(raw));
  assert.equal(
    rendered,
    raw,
    relativePath + ': parse/stringify roundtrip changed bytes'
  );
}

function expectedNode(source) {
  return {
    id: TARGET_ID,
    type: 'function',
    z: source.z,
    name: 'Apply Terra Zone Config Command',
    func: FUNCTION_SOURCE,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [{ var: 'osiLib', module: 'osi-lib' }],
    x: 1740,
    y: 1060,
    wires: [[LEGACY_ROUTER_ID], [MQTT_ACK_ID]],
  };
}

function transform(raw, relativePath) {
  assertRoundtrip(raw, relativePath);
  const flow = JSON.parse(raw);
  const split = flow.find(function(node) { return node.id === SPLIT_ID; });
  const force = flow.find(function(node) { return node.id === FORCE_ID; });
  const source = flow.find(function(node) { return node.id === SOURCE_ID; });
  assert.ok(split, relativePath + ': pending-command splitter is missing');
  assert.ok(force, relativePath + ': force-sync builder is missing');
  assert.ok(source, relativePath + ': journal command source is missing');
  const existing = flow.find(function(node) { return node.id === TARGET_ID; });
  const desired = expectedNode(source);

  if (existing) {
    assert.deepEqual(existing, desired, relativePath + ': Terra command node drifted');
    assert.deepEqual(
      source.wires,
      [[TARGET_ID], [MQTT_ACK_ID]],
      relativePath + ': Terra command source wiring drifted'
    );
    assert.ok(
      split.func.includes(NEW_ENVELOPE),
      relativePath + ': trusted pending envelope fields drifted'
    );
    if (force.func.includes(FORCE_NEW_ENVELOPE)) return raw;
    assert.equal(
      hashNode(force),
      FORCE_BEFORE_SHA256,
      relativePath + ': force-sync builder changed since review'
    );
    assert.ok(
      force.func.includes(FORCE_OLD_ENVELOPE),
      relativePath + ': old force-sync envelope shape is missing'
    );
    force.func = force.func.replace(
      FORCE_OLD_ENVELOPE,
      FORCE_NEW_ENVELOPE
    );
    const next = serialized(flow);
    assert.equal(
      transform(next, relativePath),
      next,
      relativePath + ': transformer is not idempotent'
    );
    return next;
  }

  assert.equal(
    hashNode(split),
    SPLIT_BEFORE_SHA256,
    relativePath + ': pending-command splitter changed since review'
  );
  assert.equal(
    hashNode(source),
    SOURCE_BEFORE_SHA256,
    relativePath + ': journal command source changed since review'
  );
  assert.ok(
    split.func.includes(OLD_ENVELOPE),
    relativePath + ': old pending envelope shape is missing'
  );
  assert.deepEqual(
    source.wires,
    [[LEGACY_ROUTER_ID], [MQTT_ACK_ID]],
    relativePath + ': journal command source wiring is unexpected'
  );

  split.func = split.func.replace(OLD_ENVELOPE, NEW_ENVELOPE);
  assert.equal(
    hashNode(force),
    FORCE_BEFORE_SHA256,
    relativePath + ': force-sync builder changed since review'
  );
  assert.ok(
    force.func.includes(FORCE_OLD_ENVELOPE),
    relativePath + ': old force-sync envelope shape is missing'
  );
  force.func = force.func.replace(FORCE_OLD_ENVELOPE, FORCE_NEW_ENVELOPE);
  source.wires = [[TARGET_ID], [MQTT_ACK_ID]];
  flow.splice(flow.indexOf(source) + 1, 0, desired);
  const next = serialized(flow);
  assert.equal(
    transform(next, relativePath),
    next,
    relativePath + ': transformer is not idempotent'
  );
  return next;
}

const before = FLOW_PATHS.map(function(flowPath) {
  return fs.readFileSync(flowPath, 'utf8');
});
assert.equal(before[0], before[1], 'maintained flow profiles differ before edit');
const after = FLOW_PATHS.map(function(flowPath, index) {
  return transform(before[index], path.relative(REPO, flowPath));
});
assert.equal(after[0], after[1], 'maintained flow profiles differ after edit');
for (let index = 0; index < FLOW_PATHS.length; index += 1) {
  if (after[index] !== before[index]) {
    fs.writeFileSync(FLOW_PATHS[index], after[index]);
  }
}
console.log('migrate-flows-terra-selection-edge: OK');
