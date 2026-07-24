#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const flowPaths = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((entry) => path.join(repo, entry));
const sourceId = 'zone-command-apply-fn';
const targetId = 'irrigation-config-command-apply-fn';
const legacyId = '934bf2bc19a8ce22';
const ackId = '9d5e3035c3d069c4';
const sourcePreimage =
  '61ec8d94351f4c06dbaa2fd3fe76f689b4ba079ca505c73b86b7154c9af9a706';

const functionSource = `return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('Irrigation config command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('Irrigation config command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  const protectedTypes = new Set([
    'UPSERT_SCHEDULE',
    'UPSERT_ZONE_IRRIGATION_CALIBRATION'
  ]);
  const payload = envelope.payload && typeof envelope.payload === 'object'
    ? envelope.payload
    : {};
  const protectedShape = payload.effect_key != null
    || payload.effectKey != null
    || payload.base_sync_version != null
    || payload.baseSyncVersion != null;
  if (!protectedTypes.has(commandType) || !protectedShape) return [msg, null];
  const dbLoad = osiLib.require('osi-db-helper');
  const helper = osiLib.require('irrigation-config-commands');
  if (!dbLoad.ok || !helper.ok) {
    const detail = [dbLoad, helper]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Irrigation config command helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new dbLoad.value.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await helper.value.applyIrrigationConfigCommand(db, envelope, {
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
    node.error('Irrigation config command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Irrigation config command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

function hashNode(node) {
  return crypto.createHash('sha256').update(JSON.stringify(node)).digest('hex');
}

function serialize(flows, trailingNewline) {
  return JSON.stringify(flows, null, 2) + (trailingNewline ? '\n' : '');
}

function desiredNode(source) {
  return {
    id: targetId,
    type: 'function',
    z: source.z,
    name: 'Apply Irrigation Config Command',
    func: functionSource,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [{ var: 'osiLib', module: 'osi-lib' }],
    x: 2180,
    y: 1100,
    wires: [[legacyId], [ackId]],
  };
}

function transform(raw, label) {
  const trailingNewline = raw.endsWith('\n');
  const flows = JSON.parse(raw);
  assert.equal(
    serialize(flows, trailingNewline),
    raw,
    `${label}: parse/stringify changed bytes`
  );
  const source = flows.find((node) => node.id === sourceId);
  assert.ok(source, `${label}: source node missing`);
  const desired = desiredNode(source);
  const existing = flows.find((node) => node.id === targetId);
  if (existing) {
    assert.deepEqual(existing, desired, `${label}: target node drifted`);
    assert.deepEqual(
      source.wires,
      [[targetId], [ackId]],
      `${label}: source wiring drifted`
    );
    return raw;
  }
  assert.equal(hashNode(source), sourcePreimage, `${label}: source preimage drifted`);
  assert.deepEqual(
    source.wires,
    [[legacyId], [ackId]],
    `${label}: source wiring preimage drifted`
  );
  source.wires = [[targetId], [ackId]];
  flows.splice(flows.indexOf(source) + 1, 0, desired);
  const next = serialize(flows, trailingNewline);
  assert.equal(transform(next, label), next, `${label}: not idempotent`);
  return next;
}

const before = flowPaths.map((file) => fs.readFileSync(file, 'utf8'));
assert.equal(before[0], before[1], 'maintained profiles differ before edit');
const after = flowPaths.map((file, index) =>
  transform(before[index], path.relative(repo, file))
);
assert.equal(after[0], after[1], 'maintained profiles differ after edit');
for (let index = 0; index < flowPaths.length; index += 1) {
  if (after[index] !== before[index]) fs.writeFileSync(flowPaths[index], after[index]);
}
process.stdout.write('migrate-flows-irrigation-config-command-applier: OK\n');
