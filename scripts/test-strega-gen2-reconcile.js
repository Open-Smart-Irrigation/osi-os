#!/usr/bin/env node
'use strict';
// Behavioral (execution-based) pin for the STREGA Gen2 device-profile reconciliation
// feature, across all seven flows.json nodes this wave touches: the three ACK/telemetry
// nodes (valve-ack-fn, strega-process-fn, 8809bb5239dfb3d4 "Build Telemetry") plus the four
// registration-path nodes (check-existing-device, post-devices-insert, cs-register-device-fn,
// cs-reg-cloud-fn).
//
// Why execution, not a static regex: `test-flows-wiring.js`'s string-matching assertions
// for this feature can be defeated by a behavior-preserving-looking refactor that actually
// inverts the logic (e.g. hoisting the stored-generation check into a named `isGen2` const
// and then testing `!isGen2` -- the pinned literal `settings.strega_generation === 'GEN2'`
// survives verbatim while the branch it gates is inverted). Extracting each node's real
// `func` and running it under a stub Node-RED environment pins what the node actually does,
// not what substrings its source happens to contain.
//
// The registration-path tests below (FIX-4) go one step further than the ACK/telemetry
// tests: check-existing-device's real SQL text is captured and then actually EXECUTED
// against a real seed-blank-derived SQLite database (via node:sqlite), and
// cs-register-device-fn/cs-reg-cloud-fn's promotion-only upserts run for real against that
// same database. A mutant that drops the LEFT JOIN, drops the stored-generation consult, or
// swaps the guarded upsert for a plain one changes what actually lands in the database, not
// just what substring the node's source contains.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FLOWS_PATH = path.resolve(
  __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
const byId = Object.fromEntries(flows.filter((n) => n.id).map((n) => [n.id, n]));

// Reuses osi-valve-control's own tempDb() helper (a real sqlite database copied from the
// bundled seed DB, via node:sqlite) instead of re-deriving DB-setup logic here.
const { tempDb } = require(path.resolve(
  __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers.js'
));

// osi-db-helper's real Database class exposes a callback-style API (run/all/close), not the
// promise-style facade tempDb()'s own `db` handle uses -- the registration-path flows.json
// nodes call `new osiDb.Database(...)` and use that callback shape directly. This wraps the
// SAME underlying node:sqlite connection tempDb() already opened, so writes made through it
// are immediately visible to assertions made through tempDb()'s promise-style `db` handle.
function makeCallbackDb(raw) {
  return {
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = undefined; }
      try {
        const stmt = raw.prepare(sql);
        if (params === undefined) stmt.run(); else stmt.run(...params);
        if (cb) cb(null);
      } catch (e) { if (cb) cb(e); }
    },
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = undefined; }
      try {
        const stmt = raw.prepare(sql);
        const rows = params === undefined ? stmt.all() : stmt.all(...params);
        if (cb) cb(null, rows);
      } catch (e) { if (cb) cb(e); }
    },
    // Deliberately a no-op: the node under test calls close() when it's done, but the test
    // wants to keep querying the same connection afterward to assert what actually landed.
    close(cb) { if (cb) cb(); },
  };
}

function makeOsiDbStub(raw) {
  return { Database: function Database() { return makeCallbackDb(raw); } };
}

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
  // MAJOR-3 fix: what push.compileAndQueue would hand back after a real compile. Defaults to
  // one downlink message so the common "swap happened, plan re-pushed" case is exercised
  // without every test having to spell it out.
  const compileAndQueueMessages = 'compileAndQueueMessages' in opts
    ? opts.compileAndQueueMessages
    : [{ topic: 'application/APP1/device/AABBCCDDEEFF0011/command/down', payload: { fPort: 25 } }];
  const compileAndQueueThrows = !!opts.compileAndQueueThrows;

  const calls = {
    factory: 0,
    setDeviceProfile: [],
    flushDeviceQueue: [],
    handleUplinkCalled: false,
    compileAndQueue: [],
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
      getGatewaySetting: async () => 'Europe/Zurich',
    },
    push: {
      // Mirrors push.js's real queuePushes gating (MAJOR-1 invariant preserved): the
      // device-side flush is skipped while an open is pending observation, but the compiled
      // plan is still returned either way -- exactly the shape compileAndQueue's real
      // implementation returns, proven separately by push.test.js.
      compileAndQueue: async (args) => {
        calls.compileAndQueue.push(args);
        if (compileAndQueueThrows) throw new Error('injected compileAndQueue failure');
        const pending = await VC.store.hasPendingObservation(args.db, args.deviceEui);
        let flushed = false;
        if (!pending && typeof args.flushQueue === 'function') {
          await args.flushQueue(args.deviceEui);
          flushed = true;
        }
        return { rows: [], messages: compileAndQueueMessages, flushed };
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
  const output = await execute(harness.osiLib, harness.chirpstack, makeEnv(envVars), node, msg, globalStub);
  // Merge node.warn/log/error calls with the node function's own return value (what
  // Node-RED would send on the node's outputs) so callers can assert on either without
  // the harness having two different return shapes.
  return Object.assign({}, node.calls, { output });
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
    CHIRPSTACK_APP_ACTUATORS: 'APP1',
  });
  assert.deepEqual(harness.calls.setDeviceProfile, [['AABBCCDDEEFF0011', GEN2_UUID]]);
  assert.equal(harness.calls.factory, 1);
  assert.equal(harness.calls.flushDeviceQueue.length, 1, 'no pending observation -> flush fires');
  assert.equal(calls.errors.length, 0);
  // MAJOR-3: a successful re-point must force a fresh compileAndQueue, not just flush and
  // walk away. Pin the real call shape (force: true, the swapped device's own eui), not a
  // bare "was it called" boolean -- a mutant that force-pushes the WRONG valve, or with
  // force left false (silently a no-op against unchanged hashes), must also fail this.
  assert.equal(harness.calls.compileAndQueue.length, 1, 'a successful swap must force a fresh plan push');
  assert.equal(harness.calls.compileAndQueue[0].deviceEui, 'AABBCCDDEEFF0011');
  assert.equal(harness.calls.compileAndQueue[0].force, true, 'the push must be forced: buildPlanPushes skips unchanged hashes otherwise');
  assert.equal(harness.calls.compileAndQueue[0].appId, 'APP1');
  assert.equal(typeof harness.calls.compileAndQueue[0].flushQueue, 'function');
  // And the compiled plan must actually reach the node's output (the ChirpStack mqtt-out
  // wire), not just get computed and discarded.
  assert.deepEqual(calls.output, [null, [{ topic: 'application/APP1/device/AABBCCDDEEFF0011/command/down', payload: { fPort: 25 } }]]);
});

test('valve-ack-fn (MAJOR-4): GEN2 stored + already-matching profileId makes zero factory calls', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false });
  const payload = stregaUplink({ profileId: GEN2_UUID, profileName: 'OSI STREGA Valve Gen2' });
  const calls = await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
    CHIRPSTACK_APP_ACTUATORS: 'APP1',
  });
  assert.equal(harness.calls.factory, 0, 'profileId already equals gen2Profile: no gRPC client, no swap, no flush');
  assert.equal(harness.calls.setDeviceProfile.length, 0);
  assert.equal(harness.calls.flushDeviceQueue.length, 0);
  // MAJOR-3 guard against a spurious push: nothing was re-pointed (fast path, zero gRPC),
  // so nothing must be force-pushed either.
  assert.equal(harness.calls.compileAndQueue.length, 0, 'no swap occurred: forcing a push here would be spurious');
  assert.equal(calls.output, null);
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
  assert.equal(harness.calls.compileAndQueue.length, 0, 'GEN1 never swaps, so it must never force-push either');
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
  // The force-push still runs (compileAndQueue itself is what decides whether to flush, via
  // the same hasPendingObservation gate) -- it must not be skipped just because the queue
  // flush was; a farmer's in-flight OPEN_FOR_DURATION only protects the ChirpStack queue's
  // existing frames, not the DB-side plan bookkeeping.
  assert.equal(harness.calls.compileAndQueue.length, 1, 'the plan is still (re)compiled even when the device-side flush is skipped');
  assert.equal(harness.calls.compileAndQueue[0].force, true);
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
  assert.equal(harness.calls.compileAndQueue.length, 0, 'setDeviceProfile threw before swapped was ever true: no push must be forced');
});

test('valve-ack-fn (MAJOR-3): compileAndQueue throwing is warned and swallowed, never a crash', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false, compileAndQueueThrows: true });
  const payload = stregaUplink({ profileId: GEN1_UUID, profileName: 'OSI STREGA Valve' });
  const calls = await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
    CHIRPSTACK_APP_ACTUATORS: 'APP1',
  });
  assert.equal(calls.errors.length, 0, 'a failed force-push warns and continues; it must never reach node.error');
  assert.ok(calls.warns.some((w) => /reconciliation failed/.test(w)));
  assert.equal(calls.output, null, 'nothing is sent on either output when the push failed');
});

test('valve-ack-fn (MAJOR-3): a missing CHIRPSTACK_APP_ACTUATORS warns and withholds the malformed-topic downlink', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false });
  const payload = stregaUplink({ profileId: GEN1_UUID, profileName: 'OSI STREGA Valve' });
  const calls = await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
    // CHIRPSTACK_APP_ACTUATORS deliberately absent.
  });
  assert.equal(harness.calls.compileAndQueue.length, 1, 'the plan is still compiled and queued in the DB');
  assert.ok(calls.warns.some((w) => /CHIRPSTACK_APP_ACTUATORS missing/.test(w)));
  assert.equal(calls.output, null, 'no malformed-topic downlink (application//device/... ) is ever sent');
});

test('valve-ack-fn (MAJOR-3): zero compiled pushes (e.g. no schedule) sends nothing on either output', async () => {
  const harness = buildValveAckHarness({ settings: { strega_generation: 'GEN2' }, hasPendingObservation: false, compileAndQueueMessages: [] });
  const payload = stregaUplink({ profileId: GEN1_UUID, profileName: 'OSI STREGA Valve' });
  const calls = await runValveAck(harness, payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
    CHIRPSTACK_APP_ACTUATORS: 'APP1',
  });
  assert.equal(harness.calls.compileAndQueue.length, 1);
  assert.equal(calls.output, null);
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

async function runStregaProcess(payload, envVars, fsStub) {
  const node = noopNode();
  const osiDb = buildOsiDbStub([{ type_id: 'STREGA_VALVE' }]);
  const execute = new Function('osiDb', 'env', 'node', 'msg', 'global', byId['strega-process-fn'].func);
  const msg = { payload };
  const globalStub = { get: (key) => (key === 'fs' && fsStub ? fsStub : undefined) };
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

test('strega-process-fn (MAJOR-5): a Gen2 profile with an empty decoded object refuses the Gen1 fallback decoder', async () => {
  // The hazard: ChirpStack hands over p.object = {} (codec not applied yet / bypassed) for a
  // valve already on the Gen2 profile. The old fallback decoded these bytes with the Gen1
  // codec unconditionally and wrote the (wrong) result to device_data. Proof of the fix is
  // that the Gen1 codec file is never even read for this profile -- not just that the final
  // formattedData happens to look empty, which a decode-then-discard "fix" could also produce.
  const fsCalls = [];
  const fsStub = { readFileSync: (p) => { fsCalls.push(p); return ''; } };
  const payload = {
    deviceInfo: { devEui: 'AABBCCDDEEFF0044', deviceProfileId: GEN2_UUID, deviceProfileName: 'OSI STREGA Valve Gen2' },
    object: {}, data: 'AAAAAAAAAAA=', fPort: 25,
  };
  const { result, node } = await runStregaProcess(payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  }, fsStub);
  assert.equal(result, null, 'a Gen2 valve with no decoded object must write nothing rather than a Gen1-mis-decoded value');
  assert.equal(fsCalls.length, 0, 'the Gen1 codec file must never be read at all for a Gen2 profile');
  assert.ok(node.calls.warns.some((w) => /refusing the Gen1 fallback decoder/.test(w)));
  assert.equal(node.calls.errors.length, 0);
});

test('strega-process-fn: a Gen1 profile with an empty decoded object still attempts the Gen1 fallback decoder', async () => {
  const fsCalls = [];
  const fsStub = { readFileSync: (p) => { fsCalls.push(p); return ''; } };
  const payload = {
    deviceInfo: { devEui: 'AABBCCDDEEFF0055', deviceProfileId: GEN1_UUID, deviceProfileName: 'OSI STREGA Valve' },
    object: {}, data: 'AAAAAAAAAAA=', fPort: 14,
  };
  const { result } = await runStregaProcess(payload, {
    CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
    CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  }, fsStub);
  assert.equal(fsCalls.length, 1, 'the Gen1 fallback path must still be attempted for a Gen1 profile');
  assert.equal(fsCalls[0], '/srv/node-red/codecs/strega_gen1_decoder.js');
  assert.equal(result, null, 'an empty codec source still yields no decoded object (this is not accidentally producing a value)');
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

// ---------------------------------------------------------------------------
// FIX-4 (review MAJOR-1, 5th recurrence): registration path, pinned by real execution
// against a real SQLite database instead of test-flows-wiring.js's regex-only pins.
// ---------------------------------------------------------------------------

const REG_ENV = {
  CHIRPSTACK_APP_ACTUATORS: 'APP1',
  CHIRPSTACK_PROFILE_STREGA: GEN1_UUID,
  CHIRPSTACK_PROFILE_STREGA_GEN2: GEN2_UUID,
  DEVICE_EUI: 'GW1',
};
const APPKEY = '00112233445566778899AABBCCDDEEFF';

function makeFlowStub(initial) {
  const store = Object.assign({}, initial || {});
  return { get: (k) => (k in store ? store[k] : undefined), set: (k, v) => { store[k] = v; } };
}

function runCheckExistingDevice(userId, deveui) {
  const msg = { payload: [{ id: userId }] };
  const flow = makeFlowStub({ new_device_deveui: deveui });
  const execute = new Function('msg', 'flow', byId['check-existing-device'].func);
  const out = execute(msg, flow);
  return { out, flow, sql: msg.topic };
}

function runPostDevicesInsert({ flow, payloadRows, envVars }) {
  const msg = { payload: payloadRows };
  const node = noopNode();
  const execute = new Function('msg', 'flow', 'env', 'node', byId['post-devices-insert'].func);
  const out = execute(msg, flow, makeEnv(envVars), node);
  return { out, msg, node };
}

// Chains check-existing-device's real SQL through a real database and into
// post-devices-insert, exactly as the two nodes are wired in production (check-existing-device
// -> a sqlite node -> post-devices-insert). This is what makes a `LEFT JOIN` dropped from
// check-existing-device's SQL text observable here: the rows a mutant's SQL actually returns
// from a real database, not what the SQL string happens to contain.
async function runRegistrationSelectAndInsert({ db, userId, deveui, requestedGeneration }) {
  const { flow, sql } = runCheckExistingDevice(userId, deveui);
  if (requestedGeneration) flow.set('new_device_strega_generation', requestedGeneration);
  flow.set('new_device_name', 'Test Valve');
  flow.set('new_device_type', 'STREGA_VALVE');
  flow.set('new_device_appkey', APPKEY);
  const rows = await db.all(sql);
  const { out, msg, node } = runPostDevicesInsert({ flow, payloadRows: rows, envVars: REG_ENV });
  return { out, msg, node, flow, rows };
}

test('registration path (execution): stored GEN2, generation omitted on re-registration -> stays GEN2', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1002001';
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'Gen2 Valve', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN2', datetime('now'))", [eui]);
  const { msg } = await runRegistrationSelectAndInsert({ db, userId: 1, deveui: eui, requestedGeneration: '' });
  assert.equal(msg.deviceRegistration.stregaGeneration, 'GEN2');
  assert.equal(msg.deviceRegistration.deviceProfileId, GEN2_UUID, 'a stored-GEN2 valve must resolve the Gen2 ChirpStack profile even when the request omits generation');
  raw.close();
});

test('registration path (execution): stored GEN1, generation omitted -> stays GEN1', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1002002';
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'Gen1 Valve', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN1', datetime('now'))", [eui]);
  const { msg } = await runRegistrationSelectAndInsert({ db, userId: 1, deveui: eui, requestedGeneration: '' });
  assert.equal(msg.deviceRegistration.stregaGeneration, 'GEN1');
  assert.equal(msg.deviceRegistration.deviceProfileId, GEN1_UUID);
  raw.close();
});

test('registration path (execution): existing device with NO valve_settings row is still found (proves LEFT JOIN, not INNER JOIN)', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1002003';
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'No Settings Row', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  // Deliberately no valve_settings row: an INNER JOIN would make this device invisible to
  // the SELECT entirely, and post-devices-insert would then wrongly try to CREATE it again
  // instead of recognising the existing row (this is exactly what MAJOR-2's fix round changed
  // an implicit non-join SELECT into a LEFT JOIN to prevent).
  const { msg, flow } = await runRegistrationSelectAndInsert({ db, userId: 1, deveui: eui, requestedGeneration: '' });
  assert.equal(flow.get('device_action'), 'updated', 'the device must be recognised as existing (an INNER JOIN would silently drop it and re-"create" it)');
  assert.equal(msg.deviceRegistration.stregaGeneration, 'GEN1');
  assert.equal(msg.deviceRegistration.deviceProfileId, GEN1_UUID);
  raw.close();
});

test('registration path (execution): stored GEN2, requested GEN1 -> stored generation wins (promotion-only, never demotes)', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1002005';
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'Sticky Gen2', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN2', datetime('now'))", [eui]);
  const { msg } = await runRegistrationSelectAndInsert({ db, userId: 1, deveui: eui, requestedGeneration: 'GEN1' });
  assert.equal(msg.deviceRegistration.stregaGeneration, 'GEN2', 'a stored GEN2 must survive an explicit GEN1 request on re-registration');
  assert.equal(msg.deviceRegistration.deviceProfileId, GEN2_UUID);
  raw.close();
});

test('registration path (execution): stored GEN1, requested GEN2 -> explicit promotion is honored', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1002004';
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'Promote Me', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN1', datetime('now'))", [eui]);
  const { msg } = await runRegistrationSelectAndInsert({ db, userId: 1, deveui: eui, requestedGeneration: 'GEN2' });
  assert.equal(msg.deviceRegistration.stregaGeneration, 'GEN2');
  assert.equal(msg.deviceRegistration.deviceProfileId, GEN2_UUID);
  raw.close();
});

test('registration path (execution): a brand-new device (no devices row at all) resolves generation from the request alone', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1002099';
  const gen2 = await runRegistrationSelectAndInsert({ db, userId: 1, deveui: eui, requestedGeneration: 'GEN2' });
  assert.equal(gen2.flow.get('device_action'), 'created');
  assert.equal(gen2.msg.deviceRegistration.stregaGeneration, 'GEN2');
  assert.equal(gen2.msg.deviceRegistration.deviceProfileId, GEN2_UUID);

  const eui2 = '0016C001F1002098';
  const absent = await runRegistrationSelectAndInsert({ db, userId: 1, deveui: eui2, requestedGeneration: '' });
  assert.equal(absent.flow.get('device_action'), 'created');
  assert.equal(absent.msg.deviceRegistration.stregaGeneration, 'GEN1');
  assert.equal(absent.msg.deviceRegistration.deviceProfileId, GEN1_UUID);
  raw.close();
});

// --- cs-register-device-fn: promotion-only valve_settings upsert, executed for real ---

async function runCsRegisterDeviceFn({ raw, registration, topicSql, envVars }) {
  const node = noopNode();
  const flow = makeFlowStub({});
  const calls = { ensureDeviceProvisioned: [] };
  const chirpstack = {
    createProvisioningClientFromEnv: () => ({
      ensureDeviceProvisioned: async (reg) => { calls.ensureDeviceProvisioned.push(reg); return { deviceCreated: false }; },
      deleteDevice: async () => {},
    }),
  };
  const osiDb = makeOsiDbStub(raw);
  const msg = { deviceRegistration: registration, topic: topicSql };
  const execute = new Function('osiDb', 'chirpstack', 'env', 'node', 'msg', 'flow', byId['cs-register-device-fn'].func);
  const out = await execute(osiDb, chirpstack, makeEnv(envVars), node, msg, flow);
  return { out, calls, node };
}

test('cs-register-device-fn (execution): a GEN1-resolved re-registration never demotes a stored GEN2 valve_settings row', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1003001';
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'V', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN2', datetime('now'))", [eui]);
  // A GEN1-resolved registration reaching this node (e.g. an upstream defect, or simply
  // exercising this node's own defense-in-depth in isolation) must never be allowed to
  // overwrite a stored GEN2 row -- this is the exact v1 defect (review MAJOR-1's "upsert"
  // mutant) restated as an assertion against a real database write.
  const registration = { devEui: eui, deviceType: 'STREGA_VALVE', stregaGeneration: 'GEN1' };
  const topicSql = `UPDATE devices SET updated_at = datetime('now') WHERE deveui = '${eui}'`;
  const { node } = await runCsRegisterDeviceFn({ raw, registration, topicSql, envVars: REG_ENV });
  assert.equal(node.calls.errors.length, 0);
  const row = await db.get('SELECT strega_generation FROM valve_settings WHERE device_eui = ?', [eui]);
  assert.equal(row.strega_generation, 'GEN2', 'a GEN1-resolved registration must never demote a stored GEN2 valve');
  raw.close();
});

test('cs-register-device-fn (execution): a GEN2-resolved registration promotes a stored GEN1 valve_settings row', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1003002';
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'V', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN1', datetime('now'))", [eui]);
  const registration = { devEui: eui, deviceType: 'STREGA_VALVE', stregaGeneration: 'GEN2' };
  const topicSql = `UPDATE devices SET updated_at = datetime('now') WHERE deveui = '${eui}'`;
  const { node } = await runCsRegisterDeviceFn({ raw, registration, topicSql, envVars: REG_ENV });
  assert.equal(node.calls.errors.length, 0);
  const row = await db.get('SELECT strega_generation FROM valve_settings WHERE device_eui = ?', [eui]);
  assert.equal(row.strega_generation, 'GEN2', 'an explicit GEN2 promotion must actually land in the database');
  raw.close();
});

// --- cs-reg-cloud-fn: independent registration path (no generation field in the cloud
// command payload at all), promotion-only valve_settings upsert executed for real ---

async function runCsRegCloudFn({ raw, payload, envVars, osiDb }) {
  const node = noopNode();
  const calls = { ensureDeviceProvisioned: [] };
  const chirpstack = {
    createProvisioningClientFromEnv: () => ({
      ensureDeviceProvisioned: async (reg) => { calls.ensureDeviceProvisioned.push(reg); return { deviceCreated: false }; },
      deleteDevice: async () => {},
    }),
  };
  const db = osiDb || makeOsiDbStub(raw);
  const msg = { payload };
  const execute = new Function('osiDb', 'chirpstack', 'env', 'node', 'msg', byId['cs-reg-cloud-fn'].func);
  const out = await execute(db, chirpstack, makeEnv(envVars), node, msg);
  return { out, calls, node };
}

// Wraps the same real sqlite connection makeOsiDbStub() uses, but makes `all()` throw for any
// SQL matching `sqlPattern` instead of executing it -- used to reproduce a transient
// valve_settings lookup failure (review §5 residual gap) without disturbing any other query
// the node makes on the same connection (its `run()` calls for the devices INSERT and the
// valve_settings upsert still hit the real database, so what actually lands there is what's
// asserted, not a stub's say-so).
function makeThrowingOsiDbStub(raw, sqlPattern) {
  const real = makeCallbackDb(raw);
  return {
    Database: function Database() {
      return {
        run: real.run,
        all: (sql, params, cb) => {
          if (typeof params === 'function') { cb = params; params = undefined; }
          if (sqlPattern.test(sql)) { cb(new Error('injected valve_settings lookup failure')); return; }
          real.all(sql, params, cb);
        },
        close: real.close,
      };
    },
  };
}

test('cs-reg-cloud-fn (execution): REGISTER_DEVICE for a stored-GEN2 valve provisions onto the Gen2 ChirpStack profile', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1004001';
  // This cloud command payload carries no generation field at all (confirmed against the
  // sync contract): the stored valve_settings row is the ONLY signal this path has. A mutant
  // that defeats the SELECT (review MAJOR-1's "cloudsel" mutant) makes this resolve GEN1 and
  // actively re-point a real Gen2 valve's ChirpStack device back onto the Gen1 profile.
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'Cloud Gen2 Valve', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN2', datetime('now'))", [eui]);
  const payload = {
    commandType: 'REGISTER_DEVICE',
    params: { devEui: eui, deviceType: 'STREGA_VALVE', appKey: APPKEY, name: 'Cloud Valve', cloudUserId: 1 },
  };
  const { calls, node } = await runCsRegCloudFn({ raw, payload, envVars: REG_ENV });
  assert.equal(node.calls.errors.length, 0);
  assert.equal(calls.ensureDeviceProvisioned.length, 1);
  assert.equal(calls.ensureDeviceProvisioned[0].deviceProfileId, GEN2_UUID, 'a stored-GEN2 valve must be provisioned onto the Gen2 ChirpStack profile, not silently defaulted to Gen1');
  const row = await db.get('SELECT strega_generation FROM valve_settings WHERE device_eui = ?', [eui]);
  assert.equal(row.strega_generation, 'GEN2');
  raw.close();
});

test('cs-reg-cloud-fn (execution): REGISTER_DEVICE for a never-seen valve provisions onto the Gen1 profile (control case)', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1004002';
  // No valve_settings row at all: an empty storedRows result here is legitimate (a brand-new
  // device), not the defect -- this control case proves the mechanism can resolve GEN1, not
  // only ever GEN2.
  const payload = {
    commandType: 'REGISTER_DEVICE',
    params: { devEui: eui, deviceType: 'STREGA_VALVE', appKey: APPKEY, name: 'Cloud Valve 2', cloudUserId: 1 },
  };
  const { calls } = await runCsRegCloudFn({ raw, payload, envVars: REG_ENV });
  assert.equal(calls.ensureDeviceProvisioned[0].deviceProfileId, GEN1_UUID);
  // M3: the ChirpStack profile assertion above only pins what this node tells ChirpStack --
  // it says nothing about what actually lands in valve_settings. The cloud registration
  // payload carries no generation field at all, so this path's upsert is a plausible target
  // for a "the ternary is redundant" simplification that stores a constant 'GEN2' regardless
  // of input (review's mutant B2: the promotion-only WHERE guard stays byte-identical, only
  // the bound value changes, so nothing else here catches it). Pin the stored row directly.
  const row = await db.get('SELECT strega_generation FROM valve_settings WHERE device_eui = ?', [eui]);
  assert.equal(row.strega_generation, 'GEN1', 'a never-seen valve registered through the cloud path must be stored as GEN1, not GEN2');
  raw.close();
});

test('cs-reg-cloud-fn (execution, review §5 residual): a throwing valve_settings lookup must not demote a stored GEN2 row', async () => {
  const { db, raw } = await tempDb();
  const eui = '0016C001F1004003';
  // A real Gen2 valve already exists. The stored-generation lookup is wrapped in its own
  // try/catch that warns and falls back to the 'GEN1' default (a plausible transient failure
  // on a busy/read-only overlay) -- the guard on the valve_settings upsert
  // (`WHERE ... AND excluded.strega_generation = 'GEN2'`) is what stops that fallback from
  // being written back to the database. This is a regex-only-pinned mutant surface (review
  // §5's `cloudcomment3`): the guard is unreachable by the existing no-throw tests above,
  // because on the happy path `stregaGeneration` already resolves to 'GEN2', so a plain
  // demoting upsert writes the SAME value the guarded upsert would have written -- no
  // observable difference. Only a lookup failure makes `stregaGeneration` diverge from what's
  // actually stored, which is exactly what distinguishes a guarded write from a demoting one.
  await db.run("INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'))", [eui, 'Cloud Gen2 Valve', 'STREGA_VALVE', 1, 'CLOSED', 'CLOSED']);
  await db.run("INSERT INTO valve_settings (device_eui, strega_generation, updated_at) VALUES (?, 'GEN2', datetime('now'))", [eui]);
  const payload = {
    commandType: 'REGISTER_DEVICE',
    params: { devEui: eui, deviceType: 'STREGA_VALVE', appKey: APPKEY, name: 'Cloud Valve', cloudUserId: 1 },
  };
  const osiDb = makeThrowingOsiDbStub(raw, /FROM valve_settings/);
  const { node } = await runCsRegCloudFn({ raw, payload, envVars: REG_ENV, osiDb });
  assert.equal(node.calls.errors.length, 0);
  assert.ok(node.calls.warns.some((w) => /generation lookup failed/.test(w)), 'the lookup failure must be visibly warned, not swallowed');
  const row = await db.get('SELECT strega_generation FROM valve_settings WHERE device_eui = ?', [eui]);
  assert.equal(row.strega_generation, 'GEN2', 'a lookup failure must never demote a stored GEN2 row to GEN1');
  raw.close();
});
