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
const { DatabaseSync } = require('node:sqlite');
const { facadeDb } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY_EUI = '0016C001F11715E2';
const DEVICE_EUI = 'AABBCCDDEEFF0011';
const ZONE_UUID = '11111111-1111-4111-8111-111111111111';
const REAL_ENTITY_NAME_MODULE = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js'
);

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

async function runNode(nodeId, msg, helperResults, events, envOverrides) {
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
      // envOverrides lets a test reproduce an unset UCI/env value (e.g.
      // DEVICE_EUI: '') without disturbing the defaults every other test in
      // this file relies on.
      if (envOverrides && Object.prototype.hasOwnProperty.call(envOverrides, name)) return envOverrides[name];
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

// Fix round 1 (review gap): pins the one closed path that had no test --
// applyNameCommand itself throwing. Task 3's amendment made this load-bearing:
// osi-entity-name throws with .code = 'invalid_entity_name_command' (writing
// nothing, acknowledging nothing) when commandId is not a positive safe
// integer or when runtime.gateway_device_eui does not canonicalize to 16
// upper-case hex digits, including on replay. The node's outer catch must
// answer that with node.error only -- no node.send, no ChirpStack call -- and
// still close the DB handle.
function rejectingNameHelper() {
  return {
    ok: true,
    value: {
      async applyNameCommand() {
        const error = new Error('runtime gateway EUI is missing or invalid');
        error.code = 'invalid_entity_name_command';
        throw error;
      },
    },
  };
}

// The real osi-entity-name module (not a stub), for the end-to-end variant of
// the fix-round-1 test below.
function realEntityNameHelper() {
  return { ok: true, value: require(REAL_ENTITY_NAME_MODULE) };
}

// Wraps the shared scoped-access harness's facadeDb (the same promise-based
// db.transaction(async (tx) => {...}) facade osi-command-ledger and
// osi-device-commands are tested against) so a real node:sqlite database can
// stand in for osi-db-helper here too, with the same db-open/db-close event
// recording every other test in this file already relies on.
function realDbHelper(dbSync, events) {
  return {
    ok: true,
    value: {
      // A plain `function` (not an object-literal method shorthand): the node
      // calls this with `new`, and a shorthand method is not constructible.
      Database: function Database(filename) {
        events.push(['db-open', filename]);
        const facade = facadeDb(dbSync);
        const originalClose = facade.close.bind(facade);
        facade.close = function patchedClose(callback) {
          events.push(['db-close']);
          return originalClose(callback);
        };
        return facade;
      },
    },
  };
}

// A minimal, self-contained seed: the real schema plus one device row this
// file's own DEVICE_EUI constant names, so the end-to-end test can assert the
// row is untouched without depending on the unrelated fixture set
// scripts/lib/scoped-access-harness.js's seedScopedDb() carries for the HTTP
// route tests.
function seedEntityNameDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  db.prepare(
    'INSERT INTO devices (deveui, name, type_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(DEVICE_EUI, 'Original Name', 'DRAGINO_LSN50', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  return db;
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

// Fix round 1 (review gap): the missing-envelope and unavailable-helper closed
// paths above both have a test; applyNameCommand itself throwing did not.
// This is the path Task 3's amendment made load-bearing -- a bad commandId or
// an unset runtime gateway EUI, including on replay -- and the node's outer
// catch is the only thing standing between that throw and a silently
// double-acknowledged (or silently dropped) command.
test('a rejected applyNameCommand fails the node closed without emitting an acknowledgement', async () => {
  const events = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4112, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper(events),
    'entity-name': rejectingNameHelper(),
  }, events);
  assert.deepEqual(run.result, [null, null]);
  assert.deepEqual(run.sent, [], 'no acknowledgement and no NACK on a fail-closed throw');
  assert.deepEqual(
    run.requested,
    ['osi-db-helper', 'entity-name'],
    'the ChirpStack helper must never be required when applyNameCommand itself throws'
  );
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0].message, /^Entity name command apply failed closed:/);
  assert.equal(events[events.length - 1][0], 'db-close', 'the DB handle must still be closed');
});

// The end-to-end variant: the REAL osi-entity-name module (not a stub) against
// a real SQLite database, with DEVICE_EUI unset -- Task 3's case (b) -- on a
// well-formed UPSERT_DEVICE_NAME envelope naming a device that really exists.
// Proves the guard fires before any row is read or written, not just that a
// stub can be made to throw.
test('DEVICE_EUI unset: the real osi-entity-name module fails closed against a real database, writing nothing', async () => {
  const db = seedEntityNameDb();
  try {
    const events = [];
    const msg = commandMessage('UPSERT_DEVICE_NAME', 4113, DEVICE_EUI);
    const run = await runNode('entity-name-command-apply-fn', msg, {
      'osi-db-helper': realDbHelper(db, events),
      'entity-name': realEntityNameHelper(),
    }, events, { DEVICE_EUI: '' });
    assert.deepEqual(run.result, [null, null]);
    assert.deepEqual(run.sent, [], 'no acknowledgement and no NACK on a fail-closed throw');
    assert.deepEqual(
      run.requested,
      ['osi-db-helper', 'entity-name'],
      'the ChirpStack helper must never be required when applyNameCommand itself throws'
    );
    assert.equal(run.errors.length, 1);
    assert.match(run.errors[0].message, /^Entity name command apply failed closed:/);
    // Pins the specific reason (Task 3's case (b)), not just that some throw
    // was caught -- a bad commandId throws the same .code with a different
    // message, and this test's envelope carries a valid one.
    assert.match(run.errors[0].message, /runtime gateway EUI is missing or invalid/);
    assert.equal(events[events.length - 1][0], 'db-close', 'the DB handle must still be closed');
    assert.equal(db.prepare('SELECT count(*) n FROM applied_commands').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM command_ack_outbox').get().n, 0);
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE_EUI).name, 'Original Name');
  } finally {
    db.close();
  }
});

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
