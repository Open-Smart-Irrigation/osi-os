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
].map((value) => path.join(REPO, value));
const SOURCE_ID = 'scoped-access-command-apply-fn';
const TARGET_ID = 'zone-command-apply-fn';
const LEGACY_ID = '934bf2bc19a8ce22';
const ACK_ID = '9d5e3035c3d069c4';
const SOURCE_BEFORE_SHA256 =
  '7ca0e9aac009c860a8bd6a55fe9b80cbeea50d762e95658099b01497513ad5c6';

const FUNCTION_SOURCE = `return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('Zone command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('Zone command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  const zoneTypes = new Set([
    'UPSERT_ZONE',
    'DELETE_ZONE',
    'UPSERT_ZONE_CONFIG',
    'UPSERT_ZONE_LOCATION'
  ]);
  if (!zoneTypes.has(commandType)) return [msg, null];
  const dbLoad = osiLib.require('osi-db-helper');
  const zoneLoad = osiLib.require('zone-commands');
  const scopeLoad = osiLib.require('scope');
  if (!dbLoad.ok || !zoneLoad.ok || !scopeLoad.ok) {
    const detail = [dbLoad, zoneLoad, scopeLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Zone command helpers unavailable: ' + detail, msg);
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
    if (result.ack && result.ack.result === 'APPLIED' &&
        typeof scopeLoad.value.invalidateScope === 'function') {
      scopeLoad.value.invalidateScope();
    }
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Zone command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Zone command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

function hashNode(node) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(node))
    .digest('hex');
}

function serialized(flow, trailingNewline) {
  return JSON.stringify(flow, null, 2) + (trailingNewline ? '\n' : '');
}

function expectedNode(source) {
  return {
    id: TARGET_ID,
    type: 'function',
    z: source.z,
    name: 'Apply Zone Command',
    func: FUNCTION_SOURCE,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [
      {
        var: 'osiLib',
        module: 'osi-lib',
      },
    ],
    x: 1960,
    y: 1100,
    wires: [
      [LEGACY_ID],
      [ACK_ID],
    ],
  };
}

function transform(raw, relativePath) {
  const trailingNewline = raw.endsWith('\n');
  const flow = JSON.parse(raw);
  assert.equal(
    serialized(flow, trailingNewline),
    raw,
    `${relativePath}: parse/stringify round-trip changed bytes`
  );
  const source = flow.find((node) => node.id === SOURCE_ID);
  assert.ok(source, `${relativePath}: source node is missing`);
  const desired = expectedNode(source);
  const existing = flow.find((node) => node.id === TARGET_ID);
  if (existing) {
    assert.deepEqual(
      existing,
      desired,
      `${relativePath}: existing zone command node drifted`
    );
    assert.deepEqual(
      source.wires,
      [[TARGET_ID], [ACK_ID]],
      `${relativePath}: existing source wiring drifted`
    );
    return raw;
  }
  assert.equal(
    hashNode(source),
    SOURCE_BEFORE_SHA256,
    `${relativePath}: source node no longer matches reviewed pre-edit hash`
  );
  assert.deepEqual(
    source.wires,
    [[LEGACY_ID], [ACK_ID]],
    `${relativePath}: source wiring no longer matches reviewed shape`
  );
  source.wires = [[TARGET_ID], [ACK_ID]];
  flow.splice(flow.indexOf(source) + 1, 0, desired);
  const next = serialized(flow, trailingNewline);
  assert.equal(
    transform(next, relativePath),
    next,
    `${relativePath}: transformer is not idempotent`
  );
  return next;
}

const before = FLOW_PATHS.map((flowPath) => fs.readFileSync(flowPath, 'utf8'));
assert.equal(before[0], before[1], 'maintained flow profiles differ before edit');
const after = FLOW_PATHS.map((flowPath, index) => transform(
  before[index],
  path.relative(REPO, flowPath)
));
assert.equal(after[0], after[1], 'maintained flow profiles differ after edit');
for (let index = 0; index < FLOW_PATHS.length; index += 1) {
  if (after[index] !== before[index]) {
    fs.writeFileSync(FLOW_PATHS[index], after[index]);
  }
}
console.log('migrate-flows-zone-command-applier: OK');
