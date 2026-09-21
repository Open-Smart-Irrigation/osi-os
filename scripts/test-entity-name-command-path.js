#!/usr/bin/env node
'use strict';

// Command path for UPSERT_DEVICE_NAME / UPSERT_ZONE_NAME: runs the shipped
// function-node sources (command-dedupe-dispatch, the applier chain, and the
// new entity-name-command-apply-fn) with stubbed helpers, and pins the
// registry, the fallback table and the three capability builders.
//
// Run: node --test scripts/test-entity-name-command-path.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY_EUI = '0016C001F11715E2';
const DEVICE_EUI = 'AABBCCDDEEFF0011';
const ZONE_UUID = '11111111-1111-4111-8111-111111111111';

function loadFlows(profile) {
  return JSON.parse(fs.readFileSync(path.join(
    ROOT, 'conf/full_raspberrypi_bcm27xx_' + profile + '/files/usr/share/flows.json'
  ), 'utf8'));
}

const FLOWS = loadFlows('bcm2712');

function commandMessage(commandType, commandId, target) {
  const payload = {
    command_id: '22222222-2222-4222-8222-222222222222',
    command_type: commandType,
    gateway_device_eui: GATEWAY_EUI,
    actor_user_uuid: '33333333-3333-4333-8333-333333333333',
    requested_at: '2026-09-21T08:00:00.000Z',
    values: { name: 'North block' },
  };
  if (commandType === 'UPSERT_DEVICE_NAME') payload.device_eui = target;
  else payload.zone_uuid = target;
  return {
    _commandTypeRecognized: true,
    payload: {
      commandId,
      commandType,
      command_type: commandType,
      _pendingCommandEnvelope: { commandId, commandType, payload },
    },
  };
}

function flowDbHelper(events) {
  return {
    ok: true,
    value: {
      Database: class FakeFlowDatabase {
        constructor(filename) { events.push(['db-open', filename]); }
        get(sql, params) { events.push(['db-get', sql, params]); return Promise.resolve({ name: 'North block' }); }
        close(callback) { events.push(['db-close']); callback(null); }
      },
    },
  };
}

async function runNode(nodeId, msg, helperResults, events) {
  const node = FLOWS.find((candidate) => candidate.id === nodeId);
  assert.ok(node, 'missing shipped function node ' + nodeId);
  const requested = [];
  const errors = [];
  const warnings = [];
  const sent = [];
  const osiLib = {
    require(name) {
      requested.push(name);
      assert.ok(Object.prototype.hasOwnProperty.call(helperResults, name), 'unexpected helper load ' + name);
      return helperResults[name];
    },
  };
  const nodeApi = {
    error(message, errorMsg) { errors.push({ message, errorMsg }); },
    warn(message) { warnings.push(String(message)); },
    // The applier emits its acknowledgement with node.send before it starts the
    // ChirpStack attempt, so the harness records sends as well as returns, and
    // stamps the shared events array so the two can be ordered against each
    // other.
    send(value) { sent.push(value); if (events) events.push(['node-send']); },
    status() {},
  };
  const env = {
    get(name) {
      if (name === 'DEVICE_EUI') return GATEWAY_EUI;
      if (name === 'OSI_SCOPED_ACCESS') return '1';
      if (name === 'CHIRPSTACK_API_URL') return 'http://127.0.0.1:8080';
      if (name === 'CHIRPSTACK_API_KEY') return 'k';
      return '';
    },
  };
  // eslint-disable-next-line no-new-func
  const runner = new Function('msg', 'node', 'env', 'osiLib', node.func);
  const result = await runner(msg, nodeApi, env, osiLib);
  return { result, requested, errors, warnings, sent };
}

function nameHelper(ack, captured) {
  return {
    ok: true,
    value: {
      async applyNameCommand(_db, envelope, runtime) {
        if (captured) { captured.envelope = envelope; captured.runtime = runtime; }
        if (!ack) return { handled: false };
        return { handled: true, ack };
      },
    },
  };
}

function chirpStackHelper(behaviour, calls, events) {
  return {
    ok: true,
    value: {
      createProvisioningClientFromEnv() {
        if (behaviour.unconfigured) throw new Error('CHIRPSTACK_API_URL is required');
        return { marker: 'client' };
      },
      async updateDeviceName(client, devEui, readCurrentName) {
        if (events) events.push(['chirpstack-start']);
        const seen = await readCurrentName();
        calls.push({ devEui, seen });
        if (behaviour.reject) throw new Error('14 UNAVAILABLE: no connection');
        return 'updated';
      },
    },
  };
}

function appliedAck(commandType, target, extra) {
  return Object.assign({
    commandId: 4101,
    commandType,
    effectKey: null,
    gatewayDeviceEui: GATEWAY_EUI,
    status: 'ACKED',
    result: 'APPLIED',
    reason: null,
    duplicate: false,
    appliedSyncVersion: 7,
    appliedAt: '2026-09-21T08:00:01.000Z',
    target,
    requestedAt: '2026-09-21T08:00:00.000Z',
  }, extra || {});
}

test('a name command without an effect_key survives the dedupe node and reaches the applier', async () => {
  const events = [];
  const msg = commandMessage('UPSERT_ZONE_NAME', 4001, ZONE_UUID);
  let ledgerRuntime = null;
  const dedupe = await runNode('command-dedupe-dispatch', msg, {
    'osi-db-helper': flowDbHelper(events),
    'osi-command-ledger': {
      ok: true,
      value: {
        async deduplicatePendingCommand(_db, envelope, runtime) {
          ledgerRuntime = runtime;
          assert.equal(Object.prototype.hasOwnProperty.call(envelope, 'effectKey'), false);
          return { handled: false };
        },
      },
    },
  });
  assert.deepEqual(dedupe.errors, []);
  assert.equal(dedupe.result[0], msg);
  assert.equal(dedupe.result[1], null);
  assert.equal(ledgerRuntime.gateway_device_eui, GATEWAY_EUI);
  assert.equal(ledgerRuntime.command_type_recognized, true);
});

test('every upstream applier passes a name command through untouched', async () => {
  const events = [];
  for (const nodeId of [
    'journal-command-apply-fn',
    'terra-zone-config-command-apply-fn',
    'zone-command-apply-fn',
    'weather-zones-command-apply-fn',
    'installation-revision-command-apply-fn',
  ]) {
    const msg = commandMessage('UPSERT_DEVICE_NAME', 4002, DEVICE_EUI);
    const run = await runNode(nodeId, msg, {});
    assert.deepEqual(run.requested, [], nodeId + ' must not load a helper for a foreign command type');
    assert.deepEqual(run.errors, [], nodeId);
    assert.equal(run.result[0], msg, nodeId + ' must pass the message on output 0');
    assert.equal(run.result[1], null, nodeId);
  }
  assert.deepEqual(events, []);
});

test('the acknowledgement is sent before the ChirpStack attempt starts', async () => {
  const events = [];
  const calls = [];
  const captured = {};
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4101, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper(events),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI), captured),
    chirpstack: chirpStackHelper({}, calls, events),
  }, events);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.result, [null, null], 'the send already carried the acknowledgement');
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0][0], null);
  assert.equal(run.sent[0][1].topic, 'devices/' + GATEWAY_EUI + '/command_ack');
  assert.equal(run.sent[0][1].qos, 1);
  assert.deepEqual(JSON.parse(run.sent[0][1].payload), appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI));
  assert.equal(captured.envelope.commandId, 4101);
  assert.deepEqual(captured.runtime, {
    scopedMode: true,
    gateway_device_eui: GATEWAY_EUI,
    command_type_recognized: true,
  });
  const names = events.map((entry) => entry[0]);
  assert.ok(
    names.indexOf('node-send') < names.indexOf('chirpstack-start'),
    'a slow ChirpStack must never delay the acknowledgement: ' + JSON.stringify(names)
  );
  assert.deepEqual(calls, [{ devEui: DEVICE_EUI, seen: 'North block' }]);
  // The ChirpStack call is still awaited before the handle closes, or
  // readCurrentName would run against a closed database.
  assert.equal(events[events.length - 1][0], 'db-close');
  assert.ok(events.some((e) => e[0] === 'db-get'));
});

test('a slow ChirpStack does not hold the acknowledgement', async () => {
  const events = [];
  const order = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4111, DEVICE_EUI);
  const slowChirpStack = {
    ok: true,
    value: {
      createProvisioningClientFromEnv() { return { marker: 'client' }; },
      async updateDeviceName() {
        events.push(['chirpstack-start']);
        await new Promise((resolve) => setTimeout(resolve, 120));
        order.push('chirpstack-finished');
        return 'updated';
      },
    },
  };
  const started = Date.now();
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper(events),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI)),
    chirpstack: slowChirpStack,
  }, events);
  const names = events.map((entry) => entry[0]);
  assert.ok(names.indexOf('node-send') < names.indexOf('chirpstack-start'), JSON.stringify(names));
  assert.deepEqual(order, ['chirpstack-finished']);
  assert.ok(Date.now() - started >= 100, 'the node still waits for ChirpStack before it closes the handle');
  assert.equal(run.sent.length, 1);
});

test('a ChirpStack gRPC failure warns but leaves the acknowledgement APPLIED', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4102, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI)),
    chirpstack: chirpStackHelper({ reject: true }, calls),
  });
  assert.deepEqual(run.errors, []);
  assert.equal(JSON.parse(run.sent[0][1].payload).result, 'APPLIED');
  assert.ok(run.warnings.some((w) => /ChirpStack update failed/.test(w)), JSON.stringify(run.warnings));
});

test('unconfigured provisioning skips the ChirpStack call without failing the acknowledgement', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4103, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI)),
    chirpstack: chirpStackHelper({ unconfigured: true }, calls),
  });
  assert.deepEqual(run.errors, []);
  assert.equal(JSON.parse(run.sent[0][1].payload).result, 'APPLIED');
  assert.deepEqual(calls, []);
  assert.ok(run.warnings.some((w) => /provisioning not configured/.test(w)), JSON.stringify(run.warnings));
});

test('a zone rename acknowledges without touching ChirpStack', async () => {
  const msg = commandMessage('UPSERT_ZONE_NAME', 4104, ZONE_UUID);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_ZONE_NAME', ZONE_UUID)),
  });
  assert.deepEqual(run.requested, ['osi-db-helper', 'entity-name']);
  assert.equal(JSON.parse(run.sent[0][1].payload).target, ZONE_UUID);
});

test('a rejected device rename acknowledges without a ChirpStack call', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4105, DEVICE_EUI);
  const rejected = appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI, {
    status: 'NACKED', result: 'REJECTED_PERMANENT', reason: 'name_too_long', appliedSyncVersion: null,
  });
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(rejected),
    chirpstack: chirpStackHelper({}, calls),
  });
  assert.equal(JSON.parse(run.sent[0][1].payload).reason, 'name_too_long');
  assert.deepEqual(calls, []);
});

// A payload too malformed to name a target leaves ack.target and
// ack.requestedAt null. The publisher must carry the nulls through to the cloud
// rather than turning them into the strings 'null' or 'undefined'.
test('a rejected acknowledgement with a null target and requestedAt still publishes', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4109, DEVICE_EUI);
  const malformed = appliedAck('UPSERT_DEVICE_NAME', null, {
    status: 'NACKED',
    result: 'REJECTED_PERMANENT',
    reason: 'malformed_command',
    appliedSyncVersion: null,
    requestedAt: null,
  });
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(malformed),
    chirpstack: chirpStackHelper({}, calls),
  });
  assert.deepEqual(run.errors, []);
  const published = JSON.parse(run.sent[0][1].payload);
  assert.equal(published.target, null);
  assert.equal(published.requestedAt, null);
  assert.equal(published.reason, 'malformed_command');
  assert.deepEqual(calls, [], 'a rejected rename never touches ChirpStack');
});

test('an APPLIED acknowledgement with a null target skips the ChirpStack call', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4110, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', null)),
    chirpstack: chirpStackHelper({}, calls),
  });
  assert.deepEqual(run.errors, []);
  assert.equal(JSON.parse(run.sent[0][1].payload).target, null);
  assert.deepEqual(calls, [], 'no DevEUI means nothing to rename in ChirpStack');
});

test('a foreign command type is passed on, with no helper load at all', async () => {
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4106, DEVICE_EUI);
  msg.payload.commandType = 'REBOOT';
  msg.payload._pendingCommandEnvelope.commandType = 'REBOOT';
  const run = await runNode('entity-name-command-apply-fn', msg, {});
  assert.deepEqual(run.requested, []);
  assert.equal(run.result[0], msg);
  assert.equal(run.result[1], null);
  assert.deepEqual(run.sent, []);
});

test('a missing delivery envelope fails closed with no output', async () => {
  const msg = commandMessage('UPSERT_ZONE_NAME', 4107, ZONE_UUID);
  delete msg.payload._pendingCommandEnvelope;
  const run = await runNode('entity-name-command-apply-fn', msg, {});
  assert.deepEqual(run.result, [null, null]);
  assert.deepEqual(run.sent, []);
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0].message, /no protected delivery envelope/);
});

for (const missing of ['osi-db-helper', 'entity-name']) {
  test('an unavailable ' + missing + ' fails the node closed', async () => {
    const msg = commandMessage('UPSERT_ZONE_NAME', 4108, ZONE_UUID);
    const run = await runNode('entity-name-command-apply-fn', msg, {
      'osi-db-helper': missing === 'osi-db-helper' ? { ok: false, error: 'database helper absent' } : flowDbHelper([]),
      'entity-name': missing === 'entity-name' ? { ok: false, error: 'entity name helper absent' } : nameHelper(null),
    });
    assert.deepEqual(run.result, [null, null]);
    assert.deepEqual(run.sent, []);
    assert.equal(run.errors.length, 1);
    assert.match(run.errors[0].message, /Entity name command helpers unavailable/);
  });
}

test('both command types are in the registry and in the fallback table, on both profiles', () => {
  for (const profile of PROFILES) {
    const flows = loadFlows(profile);
    const registry = flows.find((n) => n.id === 'cmd-type-registry');
    const fallback = flows.find((n) => n.id === 'reject-indefinite-open');
    for (const type of ['UPSERT_DEVICE_NAME', 'UPSERT_ZONE_NAME']) {
      const entry = new RegExp(type + ":\\s*\\{\\s*dispatch: 'entity_name_apply',\\s*actuator: false,\\s*requires_duration: false\\s*\\}");
      assert.match(registry.func, entry, profile + ' registry ' + type);
      assert.match(fallback.func, entry, profile + ' fallback ' + type);
    }
  }
});

test('all three capability builders advertise entity_name_commands_v1, on both profiles', () => {
  for (const profile of PROFILES) {
    const flows = loadFlows(profile);
    for (const id of ['sync-bootstrap-build', 'al-link-build-req', 'sync-force-build']) {
      const node = flows.find((n) => n.id === id);
      assert.match(
        node.func,
        /const syncCapabilities = \['linked_auth_sync_v1', 'force_edge_sync_v1', 'installation_recovery_v1', 'installation_locations_v1', 'entity_name_commands_v1'\];/,
        profile + ' ' + id
      );
    }
  }
});

test('the applier is wired between installation revisions and Route Command, on both profiles', () => {
  for (const profile of PROFILES) {
    const flows = loadFlows(profile);
    const upstream = flows.find((n) => n.id === 'installation-revision-command-apply-fn');
    const applier = flows.find((n) => n.id === 'entity-name-command-apply-fn');
    assert.deepEqual(upstream.wires, [['entity-name-command-apply-fn'], ['9d5e3035c3d069c4']], profile);
    assert.deepEqual(applier.wires, [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']], profile);
    assert.deepEqual(applier.libs, [{ var: 'osiLib', module: 'osi-lib' }], profile);
    assert.equal(applier.name, 'Apply Entity Name Command', profile);
  }
});
