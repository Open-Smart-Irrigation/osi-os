#!/usr/bin/env node
'use strict';
// Behavioral (execution-based) pin for the STREGA Gen2 device-profile reconciliation
// feature, across the three flows.json nodes it touches: valve-ack-fn, strega-process-fn,
// and the cloud telemetry builder (8809bb5239dfb3d4, "Build Telemetry").
//
// Why execution, not a static regex: `test-flows-wiring.js`'s string-matching assertions
// for this feature can be defeated by a behavior-preserving-looking refactor that actually
// inverts the logic (e.g. hoisting the stored-generation check into a named `isGen2` const
// and then testing `!isGen2` -- the pinned literal `settings.strega_generation === 'GEN2'`
// survives verbatim while the branch it gates is inverted). Extracting each node's real
// `func` and running it under a stub Node-RED environment pins what the node actually does,
// not what substrings its source happens to contain.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FLOWS_PATH = path.resolve(
  __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
const byId = Object.fromEntries(flows.filter((n) => n.id).map((n) => [n.id, n]));

function makeEnv(vars) {
  const v = vars || {};
  return { get: (key) => (key in v ? v[key] : null) };
}

function noopNode(record) {
  const calls = record || { warns: [], logs: [], errors: [] };
  return {
    warn: (m) => calls.warns.push(m),
    log: (m) => calls.logs.push(m),
    error: (m) => calls.errors.push(m),
    status: () => {},
    calls,
  };
}

const GEN1_UUID = '11111111-1111-4111-8111-111111111111';
const GEN2_UUID = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// valve-ack-fn
// ---------------------------------------------------------------------------

function buildValveAckHarness(options) {
  const opts = options || {};
  const settings = opts.settings; // { strega_generation } or null
  const hasPendingObservation = opts.hasPendingObservation === true;
  const hasPendingObservationThrows = !!opts.hasPendingObservationThrows;
  const setDeviceProfileReturns = 'setDeviceProfileReturns' in opts ? opts.setDeviceProfileReturns : true;
  const setDeviceProfileThrows = !!opts.setDeviceProfileThrows;

  const calls = {
    factory: 0,
    setDeviceProfile: [],
    flushDeviceQueue: [],
    handleUplinkCalled: false,
  };

  class FakeDb {
    close(cb) { cb && cb(); }
  }

  const VC = {
    decodeGen1Fallback: () => ({}),
    handleUplink: async () => { calls.handleUplinkCalled = true; return { acked: 1, generationPromoted: false }; },
    store: {
      getSettings: async () => settings,
      hasPendingObservation: async () => {
        if (hasPendingObservationThrows) throw new Error('injected hasPendingObservation failure');
        return hasPendingObservation;
      },
    },
  };

  const osiLib = {
    require: (name) => {
      if (name === 'osi-db-helper') return { ok: true, value: { Database: FakeDb } };
      if (name === 'osi-valve-control') return { ok: true, value: VC };
      throw new Error('unexpected osiLib.require: ' + name);
    },
  };

  const chirpstack = {
    createProvisioningClientFromEnv: () => {
      calls.factory += 1;
      return {
        setDeviceProfile: async (devEui, profileId) => {
          calls.setDeviceProfile.push([devEui, profileId]);
          if (setDeviceProfileThrows) throw new Error('injected setDeviceProfile failure');
          return setDeviceProfileReturns;
        },
        flushDeviceQueue: async (devEui) => {
          calls.flushDeviceQueue.push(devEui);
        },
      };
    },
  };

  return { osiLib, chirpstack, calls, VC };
}

async function runValveAck(harness, payload, envVars) {
  const node = noopNode();
  const execute = new Function('osiLib', 'chirpstack', 'env', 'node', 'msg', 'global', byId['valve-ack-fn'].func);
  const msg = { payload };
  const globalStub = { get: () => undefined };
  await execute(harness.osiLib, harness.chirpstack, makeEnv(envVars), node, msg, globalStub);
  return node.calls;
}

function stregaUplink({ profileId, profileName, devEui }) {
  return {
    deviceInfo: { devEui: devEui || 'AABBCCDDEEFF0011', deviceProfileId: profileId, deviceProfileName: profileName },
    object: { Ack_Port: 25 }, // any recognised ACK key so hasDecodedAck is true
    fPort: 25,
    time: '2026-01-01T00:00:00.000Z',
  };
}

test('valve-ack-fn: GEN2 stored + mismatched profileId calls setDeviceProfile(devEui, gen2Profile)', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false });
  const payload = stregaUplink({ profileId: GEN1_UUID, profileName: 'OSI STREGA Valve' });
  const calls = await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.deepEqual(harness.calls.setDeviceProfile, [['AABBCCDDEEFF0011', GEN2_UUID]]);
  assert.equal(harness.calls.factory, 1);
  assert.equal(harness.calls.flushDeviceQueue.length, 1, 'no pending observation -> flush fires');
  assert.equal(calls.errors.length, 0);
});

test('valve-ack-fn (MAJOR-4): GEN2 stored + already-matching profileId makes zero factory calls', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false });
  const payload = stregaUplink({ profileId: GEN2_UUID, profileName: 'OSI STREGA Valve Gen2' });
  await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.equal(harness.calls.factory, 0, 'profileId already equals gen2Profile: no gRPC client, no swap, no flush');
  assert.equal(harness.calls.setDeviceProfile.length, 0);
  assert.equal(harness.calls.flushDeviceQueue.length, 0);
});

test('valve-ack-fn: GEN1 stored never calls setDeviceProfile (this is the reconcile-from-state pin)', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN1' }, hasPendingObservation: false });
  const payload = stregaUplink({ profileId: GEN1_UUID, profileName: 'OSI STREGA Valve' });
  await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.equal(harness.calls.factory, 0);
  assert.equal(harness.calls.setDeviceProfile.length, 0);
  assert.equal(harness.calls.flushDeviceQueue.length, 0);
});

test('valve-ack-fn (MAJOR-1): a pending observation skips the flush even though the swap still happens', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: true });
  const payload = stregaUplink({ profileId: GEN1_UUID, profileName: 'OSI STREGA Valve' });
  await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.equal(harness.calls.setDeviceProfile.length, 1, 'the profile swap still happens');
  assert.equal(harness.calls.flushDeviceQueue.length, 0, 'but the queue flush is skipped: a pending open must survive');
});

test('valve-ack-fn: setDeviceProfile throwing never surfaces node.error and never calls flush', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false, setDeviceProfileThrows: true });
  const payload = stregaUplink({ profileId: GEN1_UUID, profileName: 'OSI STREGA Valve' });
  const calls = await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.equal(calls.errors.length, 0, 'a failed swap warns and continues; it must never reach node.error');
  assert.ok(calls.warns.some((w) => /reconciliation failed/.test(w)));
  assert.equal(harness.calls.flushDeviceQueue.length, 0);
});

test('valve-ack-fn (NEW-MINOR-B / whitelist): a Gen2 profile UUID is accepted even when the name does not contain STREGA', async () => {
  // The hazard MAJOR-2 named: CS_PROFILE_STREGA_GEN2_NAME is operator-overridable. This uplink
  // proves acceptance comes from the CHIRPSTACK_PROFILE_STREGA_GEN2 whitelist entry, not the
  // 'STREGA' substring fallback -- the profile name here deliberately does not contain it.
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: true });
  const payload = stregaUplink({ profileId: GEN2_UUID, profileName: 'Acme Actuator v2' });
  const calls = await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  // The proof of acceptance is that VC.handleUplink actually ran -- if the top-of-function
  // STREGA gate had rejected this uplink (whitelist entry missing), the whole reconciliation
  // block, including handleUplink, is never reached and this would silently stay false.
  assert.equal(harness.calls.handleUplinkCalled, true, 'the uplink must pass the top-level STREGA gate');
  assert.equal(calls.errors.length, 0);
  // profileId (GEN2_UUID) matches gen2Profile, so MAJOR-4's fast path also applies here: zero gRPC.
  assert.equal(harness.calls.factory, 0);
});

test('valve-ack-fn: an unrelated profile (not STREGA at all) is rejected by the top-level gate', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false });
  const payload = stregaUplink({ profileId: 'aaaaaaaa-0000-4000-8000-000000000000', profileName: 'Unrelated Sensor' });
  await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.equal(harness.calls.handleUplinkCalled, false, 'gate must reject before any reconciliation logic runs');
  assert.equal(harness.calls.factory, 0, 'gate must reject before any reconciliation logic runs');
});

// ---------------------------------------------------------------------------
// strega-process-fn
// ---------------------------------------------------------------------------

function buildOsiDbStub(rows) {
  class FakeDb {
    all(sql, cb) { cb(null, rows); }
    close(cb) { cb && cb(); }
  }
  return { Database: FakeDb };
}

async function runStregaProcess(payload, envVars) {
  const node = noopNode();
  const osiDb = buildOsiDbStub([{ type_id: 'STREGA_VALVE' }]);
  const execute = new Function('osiDb', 'env', 'node', 'msg', 'global', byId['strega-process-fn'].func);
  const msg = { payload };
  const globalStub = { get: () => undefined };
  const result = await execute(osiDb, makeEnv(envVars), node, msg, globalStub);
  return { result, node };
}

test('strega-process-fn (NEW-MINOR-B / whitelist): Gen2 profile UUID accepted with a non-STREGA name', async () => {
  const payload = { deviceInfo: { devEui: 'AABBCCDDEEFF0022', deviceProfileId: GEN2_UUID, deviceProfileName: 'Acme Actuator v2' }, object: { Actuator: 1, Battery: 91 } };
  const { result, node } = await runStregaProcess(payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.ok(result, 'must not early-return null: the Gen2 profile must pass the STREGA gate');
  assert.equal(result.formattedData.currentState, 'OPEN');
  assert.equal(node.calls.errors.length, 0);
});

test('strega-process-fn (Actuator alias): Valve=0 (falsy CLOSED) wins over Actuator=1 -- proves the check is !== undefined/null, never ||', async () => {
  const payload = { deviceInfo: { devEui: 'AABBCCDDEEFF0022', deviceProfileId: GEN2_UUID, deviceProfileName: 'Acme Actuator v2' }, object: { Valve: 0, Actuator: 1, Battery: 91 } };
  const { result } = await runStregaProcess(payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.ok(result, 'must not early-return null: the Gen2 profile must pass the STREGA gate');
  assert.equal(result.formattedData.currentState, 'CLOSED');
});

test('strega-process-fn (Actuator alias): Valve absent, Actuator=1 -> OPEN', async () => {
  const payload = { deviceInfo: { devEui: 'AABBCCDDEEFF0022', deviceProfileId: GEN2_UUID, deviceProfileName: 'Acme Actuator v2' }, object: { Actuator: 1 } };
  const { result } = await runStregaProcess(payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.ok(result, 'must not early-return null: the Gen2 profile must pass the STREGA gate');
  assert.equal(result.formattedData.currentState, 'OPEN');
});

test('strega-process-fn: Gen1 profile UUID unaffected by the Gen2 whitelist addition', async () => {
  const payload = { deviceInfo: { devEui: 'AABBCCDDEEFF0022', deviceProfileId: GEN1_UUID, deviceProfileName: 'OSI STREGA Valve' }, object: { Valve: 1 } };
  const { result } = await runStregaProcess(payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.equal(result.formattedData.currentState, 'OPEN');
});

// ---------------------------------------------------------------------------
// Build Telemetry (8809bb5239dfb3d4) -- the cloud MQTT telemetry mirror
// ---------------------------------------------------------------------------

async function runBuildTelemetry(payload, envVars) {
  const node = noopNode();
  const osiDb = { Database: class { constructor() { throw new Error('STREGA path must never open the DB'); } } };
  const dendro = {
    decodeRawAdcPayload: () => null,
    lsn50ModeLabel: () => null,
    buildDendroDerivedMetrics: () => ({}),
    computeDendroDeltaMm: () => ({}),
    computeDendroStemChangeUm: () => ({}),
  };
  const flow = { get: () => undefined, set: () => {} };
  const execute = new Function('msg', 'env', 'flow', 'node', 'osiDb', 'dendro', byId['8809bb5239dfb3d4'].func);
  const msg = { payload };
  const result = await execute(msg, makeEnv(envVars), flow, node, osiDb, dendro);
  return { result, node };
}

test('Build Telemetry (NEW-MAJOR-A): Gen2 profile UUID with a non-STREGA name still mirrors a STREGA_VALVE payload', async () => {
  const payload = { deviceInfo: { devEui: 'AABBCCDDEEFF0033', deviceProfileId: GEN2_UUID, deviceProfileName: 'Acme Actuator v2' }, object: { Actuator: 1, Battery: 87 }, time: '2026-01-01T00:00:00Z' };
  const { result } = await runBuildTelemetry(payload, {
    DEVICE_EUI: 'GW1',
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.ok(result, 'must produce a payload, not fall through to the generic sensor branch');
  const body = JSON.parse(result.payload);
  assert.equal(body.deviceType, 'STREGA_VALVE');
  assert.equal(body.state, 'OPEN');
  assert.equal(body.current_state, 'OPEN');
});

test('Build Telemetry (NEW-MAJOR-B): Valve=0 (falsy CLOSED) wins over Actuator=1 -- explicit undefined/null check, never ||', async () => {
  const payload = { deviceInfo: { devEui: 'AABBCCDDEEFF0033', deviceProfileId: GEN2_UUID, deviceProfileName: 'Acme Actuator v2' }, object: { Valve: 0, Actuator: 1, Battery: 87 }, time: '2026-01-01T00:00:00Z' };
  const { result } = await runBuildTelemetry(payload, {
    DEVICE_EUI: 'GW1',
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  assert.ok(result, 'must produce a payload, not fall through to the generic sensor branch');
  const body = JSON.parse(result.payload);
  assert.equal(body.state, 'CLOSED');
});

test('Build Telemetry: Gen1 profile UUID unaffected by the Gen2 whitelist addition', async () => {
  const payload = { deviceInfo: { devEui: 'AABBCCDDEEFF0033', deviceProfileId: GEN1_UUID, deviceProfileName: 'OSI STREGA Valve' }, object: { Valve: 1 }, time: '2026-01-01T00:00:00Z' };
  const { result } = await runBuildTelemetry(payload, {
    DEVICE_EUI: 'GW1',
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  });
  const body = JSON.parse(result.payload);
  assert.equal(body.deviceType, 'STREGA_VALVE');
  assert.equal(body.state, 'OPEN');
});
