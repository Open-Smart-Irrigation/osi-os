'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const grpc = require('@grpc/grpc-js');
const devicePb = require('@chirpstack/chirpstack-api/api/device_pb');

const helper = require('./index.js');
const {
  ChirpStackClient,
  grpcInvoke,
  DEFAULT_RPC_TIMEOUT_MS,
  deviceSnapshot,
  deviceMatches,
} = helper;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEVEUI = 'A8404101FD5ECF41';
const APPLICATION_ID = 'app-new';
const PROFILE_ID = 'profile-new';

// Distinct sentinel key values. Each is a legal 32-char uppercase hex
// string so it can also stand in as a supplied AppKey where needed, but
// the values are otherwise arbitrary and only used to prove key material
// never crosses the helper boundary.
const NWK_KEY = 'A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1';
const OLD_NWK_KEY = 'B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2';
const PRESERVED_APP_KEY = 'C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3';
const PRESERVED_GEN_APP_KEY = 'D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4';
const TAMPERED_APP_KEY = 'E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5';
const SECRET_SENTINEL = 'SECRET-SENTINEL-3f9c2b7a';

function baseInput(overrides = {}) {
  return Object.assign({
    devEui: DEVEUI,
    name: 'Dendro 3',
    applicationId: APPLICATION_ID,
    deviceProfileId: PROFILE_ID,
    appKey: NWK_KEY,
    description: '',
  }, overrides);
}

// Plain object with protobuf-compatible getters/setters, per Task 1 Step 1.
function fakeDevice(input = {}) {
  const state = {
    devEui: input.devEui || DEVEUI,
    name: input.name || 'Dendro 3',
    applicationId: input.applicationId || 'app-old',
    deviceProfileId: input.deviceProfileId || 'profile-old',
    description: input.description || '',
    joinEui: input.joinEui || '',
    isDisabled: input.isDisabled === true,
  };
  return {
    state,
    getDevEui: () => state.devEui,
    getName: () => state.name,
    setName: (value) => { state.name = value; },
    getApplicationId: () => state.applicationId,
    setApplicationId: (value) => { state.applicationId = value; },
    getDeviceProfileId: () => state.deviceProfileId,
    setDeviceProfileId: (value) => { state.deviceProfileId = value; },
    getDescription: () => state.description,
    setDescription: (value) => { state.description = value; },
    getJoinEui: () => state.joinEui,
    setJoinEui: (value) => { state.joinEui = value; },
    getIsDisabled: () => state.isDisabled,
    setIsDisabled: (value) => { state.isDisabled = Boolean(value); },
  };
}

function fakeKeys(fields = {}) {
  return {
    getNwkKey: () => fields.nwkKey || '',
    getAppKey: () => fields.appKey || '',
    getGenAppKey: () => fields.genAppKey || '',
  };
}

function fakeFailure(step, code) {
  return Object.assign(new Error(`fake_${step}_failure`), { step, code });
}

// Returns an async function that yields `values[i]` on its i-th call,
// clamped to the last entry for any extra calls. An Error-typed entry is
// thrown instead of returned, modeling an RPC failure at that call site.
function sequence(values) {
  let i = 0;
  return async (...args) => {
    const entry = values[Math.min(i, values.length - 1)];
    i += 1;
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry(...args);
    return entry;
  };
}

function alwaysFails(name) {
  return async () => { throw new Error(`unexpected call to ${name} in this scenario`); };
}

// Builds an Object.create(ChirpStackClient.prototype) instance with every
// RPC-facing leaf method replaced by a fake, per Task 1 Step 2. Only
// ensureDeviceProvisioned/_compensateProvisioning run as the real
// prototype implementation, so these tests exercise pure orchestration.
function makeReconcileClient(handlers = {}) {
  const client = Object.create(ChirpStackClient.prototype);
  client.closed = false;
  client.closeErrors = [];
  const calls = [];
  client._calls = calls;
  const leaf = ['getDevice', 'createDevice', 'updateDevice', 'restoreDevice', 'deleteDevice',
    'getKeys', 'createKeys', 'updateKeys', 'deleteKeys', 'restoreKeys'];
  for (const name of leaf) {
    const impl = handlers[name] || alwaysFails(name);
    client[name] = async (...args) => {
      calls.push(name);
      return impl(...args);
    };
  }
  return client;
}

function countCalls(client, name) {
  return client._calls.filter((entry) => entry === name).length;
}

// ---------------------------------------------------------------------------
// [reconcile] existing-device assignment reconciliation and lifecycle
// ---------------------------------------------------------------------------

test('[reconcile] missing device: creates it, rereads exact assignment, creates keys, reports created', async () => {
  const created = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([null, created, created, created]),
    createDevice: async () => {},
    getKeys: sequence([null, fakeKeys({ nwkKey: NWK_KEY })]),
    createKeys: async () => {},
  });

  const result = await client.ensureDeviceProvisioned(baseInput());

  assert.deepEqual(result, {
    devEui: DEVEUI,
    deviceAction: 'created',
    keysAction: 'created',
    keysVerified: true,
    verifiedApplicationId: APPLICATION_ID,
    verifiedDeviceProfileId: PROFILE_ID,
  });
  assert.equal(countCalls(client, 'createDevice'), 1);
  assert.equal(countCalls(client, 'createKeys'), 1);
  assert.equal(countCalls(client, 'updateDevice'), 0);
  assert.equal(countCalls(client, 'updateKeys'), 0);
});

test('[reconcile] exact existing device: no create/update, keys unchanged, reports unchanged', async () => {
  const existing = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([existing, existing, existing, existing]),
    getKeys: sequence([fakeKeys({ nwkKey: NWK_KEY }), fakeKeys({ nwkKey: NWK_KEY })]),
  });

  const result = await client.ensureDeviceProvisioned(baseInput());

  assert.equal(result.deviceAction, 'unchanged');
  assert.equal(result.keysAction, 'unchanged');
  assert.equal(result.keysVerified, true);
  assert.equal(countCalls(client, 'createDevice'), 0);
  assert.equal(countCalls(client, 'updateDevice'), 0);
  assert.equal(countCalls(client, 'createKeys'), 0);
  assert.equal(countCalls(client, 'updateKeys'), 0);
});

test('[reconcile] wrong application: updates once, rereads exact assignment, reports updated', async () => {
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'stale-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const corrected = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([wrong, wrong, corrected, corrected]),
    updateDevice: async () => {},
    getKeys: sequence([fakeKeys({ nwkKey: NWK_KEY }), fakeKeys({ nwkKey: NWK_KEY })]),
  });

  const result = await client.ensureDeviceProvisioned(baseInput());

  assert.equal(result.deviceAction, 'updated');
  assert.equal(countCalls(client, 'updateDevice'), 1);
  assert.equal(countCalls(client, 'createDevice'), 0);
});

test('[reconcile] wrong profile and disabled device: one update repairs both', async () => {
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: 'stale-profile', isDisabled: true });
  const corrected = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([wrong, wrong, corrected, corrected]),
    updateDevice: async () => {},
    getKeys: sequence([fakeKeys({ nwkKey: NWK_KEY }), fakeKeys({ nwkKey: NWK_KEY })]),
  });

  const result = await client.ensureDeviceProvisioned(baseInput());

  assert.equal(result.deviceAction, 'updated');
  assert.equal(countCalls(client, 'updateDevice'), 1);
});

test('[reconcile] name-only mismatch: updates and reports updated', async () => {
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Old Name', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const corrected = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([wrong, wrong, corrected, corrected]),
    updateDevice: async () => {},
    getKeys: sequence([fakeKeys({ nwkKey: NWK_KEY }), fakeKeys({ nwkKey: NWK_KEY })]),
  });

  const result = await client.ensureDeviceProvisioned(baseInput());

  assert.equal(result.deviceAction, 'updated');
  assert.equal(countCalls(client, 'updateDevice'), 1);
});

test('[reconcile] ALREADY_EXISTS create race: rereads, reconciles the assignment, then keys', async () => {
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'racer-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const corrected = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([null, wrong, corrected, corrected]),
    createDevice: async () => { throw fakeFailure('createDevice', 'ALREADY_EXISTS'); },
    updateDevice: async () => {},
    getKeys: sequence([null, fakeKeys({ nwkKey: NWK_KEY })]),
    createKeys: async () => {},
  });

  const result = await client.ensureDeviceProvisioned(baseInput());

  assert.equal(result.deviceAction, 'updated');
  assert.equal(result.keysAction, 'created');
  assert.equal(countCalls(client, 'createDevice'), 1);
  assert.equal(countCalls(client, 'updateDevice'), 1);
  assert.equal(countCalls(client, 'createKeys'), 1);
});

test('[reconcile] update succeeds but reread remains wrong: RECONCILIATION_REQUIRED, no restore attempted', async () => {
  // The helper cannot prove it still owns the device when its own update
  // never reads back as the requested assignment, so it must not overwrite
  // the mismatching state -- it reports RECONCILIATION_REQUIRED instead.
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'stale-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([wrong, wrong, wrong, wrong]),
    updateDevice: async () => {},
    getKeys: alwaysFails('getKeys'),
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'verifyDevice');
      assert.equal(error.code, 'RECONCILIATION_REQUIRED');
      assert.equal(error.resourceKind, 'device');
      assert.deepEqual(Object.keys(error).sort(), ['code', 'resourceKind', 'step']);
      return true;
    }
  );
  assert.equal(countCalls(client, 'restoreDevice'), 0);
  assert.equal(countCalls(client, 'deleteDevice'), 0);
  assert.equal(countCalls(client, 'createKeys'), 0);
  assert.equal(countCalls(client, 'updateKeys'), 0);
  assert.equal(countCalls(client, 'getKeys'), 0, 'a device-only fence must not make an unrelated key RPC');
});

test('[reconcile] key mutation fails after an existing-device update: restores the original device fields', async () => {
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'stale-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const corrected = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  let restoreArgs = null;
  const client = makeReconcileClient({
    getDevice: sequence([wrong, wrong, corrected, corrected]),
    updateDevice: async () => {},
    restoreDevice: async (device, snapshot) => { restoreArgs = snapshot; },
    getKeys: sequence([null]),
    createKeys: async () => { throw fakeFailure('createKeys', 'UNAVAILABLE'); },
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'createKeys');
      assert.equal(error.code, 'UNAVAILABLE');
      return true;
    }
  );
  assert.equal(countCalls(client, 'restoreDevice'), 1);
  assert.equal(restoreArgs.applicationId, 'stale-app');
  assert.equal(countCalls(client, 'deleteDevice'), 0);
  assert.equal(countCalls(client, 'deleteKeys'), 0);
  assert.equal(countCalls(client, 'restoreKeys'), 0);
});

test('[reconcile] key mutation fails after a create: deletes the new device', async () => {
  const created = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  let deletedDevEui = null;
  const client = makeReconcileClient({
    getDevice: sequence([null, created, created]),
    createDevice: async () => {},
    deleteDevice: async (devEui) => { deletedDevEui = devEui; },
    getKeys: sequence([null]),
    createKeys: async () => { throw fakeFailure('createKeys', 'UNAVAILABLE'); },
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'createKeys');
      return true;
    }
  );
  assert.equal(countCalls(client, 'deleteDevice'), 1);
  assert.equal(deletedDevEui, DEVEUI);
  assert.equal(countCalls(client, 'restoreDevice'), 0);
  assert.equal(countCalls(client, 'deleteKeys'), 0);
  assert.equal(countCalls(client, 'restoreKeys'), 0);
});

test('[reconcile] later failure after keys were created on an existing device: deletes only the new key row and restores device fields', async () => {
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'stale-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const corrected = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  let restoreArgs = null;
  let deletedKeysDevEui = null;
  const client = makeReconcileClient({
    getDevice: sequence([wrong, wrong, corrected, fakeFailure('getDevice', 'UNAVAILABLE'), corrected]),
    updateDevice: async () => {},
    restoreDevice: async (device, snapshot) => { restoreArgs = snapshot; },
    // Pre-write: no key row yet. Post-write (fence re-fetch): the row this
    // call's own createKeys just verified, proving the fence holds.
    getKeys: sequence([null, fakeKeys({ nwkKey: NWK_KEY })]),
    createKeys: async () => {},
    deleteKeys: async (devEui) => { deletedKeysDevEui = devEui; },
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'getDevice');
      return true;
    }
  );
  assert.equal(countCalls(client, 'restoreDevice'), 1);
  assert.equal(restoreArgs.applicationId, 'stale-app');
  assert.equal(countCalls(client, 'deleteKeys'), 1);
  assert.equal(deletedKeysDevEui, DEVEUI);
  assert.equal(countCalls(client, 'deleteDevice'), 0);
  assert.equal(countCalls(client, 'restoreKeys'), 0);
});

test('[reconcile] later failure after keys were updated: restores the original keys without exposing them', async () => {
  const matching = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  let restoreArgs = null;
  const client = makeReconcileClient({
    getDevice: sequence([matching, matching, matching, fakeFailure('getDevice', 'UNAVAILABLE')]),
    // Pre-write: the old nwkKey. Post-write (fence re-fetch): the verified
    // new nwkKey with the preserved appKey/genAppKey this call's own
    // updateKeys just wrote, proving the fence holds.
    getKeys: sequence([
      fakeKeys({ nwkKey: OLD_NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY }),
      fakeKeys({ nwkKey: NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY }),
    ]),
    updateKeys: async () => {},
    restoreKeys: async (devEui, snapshot) => { restoreArgs = snapshot; },
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'getDevice');
      assert.ok(!JSON.stringify(error).includes(PRESERVED_APP_KEY));
      assert.ok(!JSON.stringify(error).includes(OLD_NWK_KEY));
      return true;
    }
  );
  assert.equal(countCalls(client, 'restoreKeys'), 1);
  assert.equal(restoreArgs.nwkKey, OLD_NWK_KEY);
  assert.equal(restoreArgs.appKey, PRESERVED_APP_KEY);
  assert.equal(restoreArgs.genAppKey, PRESERVED_GEN_APP_KEY);
  assert.equal(countCalls(client, 'restoreDevice'), 0);
  assert.equal(countCalls(client, 'deleteDevice'), 0);
  assert.equal(countCalls(client, 'deleteKeys'), 0);
});

test('[reconcile] concurrent device reassignment after the verified write: RECONCILIATION_REQUIRED with zero mutations', async () => {
  const matching = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const reassigned = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'someone-elses-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([matching, matching, matching, reassigned]),
    getKeys: sequence([fakeKeys({ nwkKey: NWK_KEY })]),
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'verifyDevice');
      assert.equal(error.code, 'RECONCILIATION_REQUIRED');
      assert.equal(error.resourceKind, 'device');
      assert.deepEqual(Object.keys(error).sort(), ['code', 'resourceKind', 'step']);
      return true;
    }
  );
  assert.equal(countCalls(client, 'updateDevice'), 0);
  assert.equal(countCalls(client, 'restoreDevice'), 0);
  assert.equal(countCalls(client, 'deleteDevice'), 0);
  assert.equal(countCalls(client, 'createKeys'), 0);
  assert.equal(countCalls(client, 'updateKeys'), 0);
  assert.equal(countCalls(client, 'deleteKeys'), 0);
  assert.equal(countCalls(client, 'restoreKeys'), 0);
});

for (const field of ['nwkKey', 'appKey', 'genAppKey']) {
  test(`[reconcile] concurrent change to ${field}: RECONCILIATION_REQUIRED with zero device or key mutations`, async () => {
    const matching = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
    const goodKeys = { nwkKey: NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY };
    const tamperedKeys = Object.assign({}, goodKeys, { [field]: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' });
    const client = makeReconcileClient({
      getDevice: sequence([matching, matching, matching, matching]),
      getKeys: sequence([fakeKeys(goodKeys), fakeKeys(tamperedKeys)]),
    });

    await assert.rejects(
      client.ensureDeviceProvisioned(baseInput()),
      (error) => {
        assert.equal(error.step, 'verifyKeys');
        assert.equal(error.code, 'RECONCILIATION_REQUIRED');
        assert.equal(error.resourceKind, 'keys');
        return true;
      }
    );
    assert.equal(countCalls(client, 'updateDevice'), 0);
    assert.equal(countCalls(client, 'restoreDevice'), 0);
    assert.equal(countCalls(client, 'deleteDevice'), 0);
    assert.equal(countCalls(client, 'createKeys'), 0);
    assert.equal(countCalls(client, 'updateKeys'), 0);
    assert.equal(countCalls(client, 'deleteKeys'), 0);
    assert.equal(countCalls(client, 'restoreKeys'), 0);
  });
}

test('[reconcile] created device with verifyKeys mismatch while the fence holds: deletes the new device once and rejects with the original bounded failure', async () => {
  const created = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  let deletedDevEui = null;
  const client = makeReconcileClient({
    // 1: initial miss, 2: post-create reread, 3: verify, 4: final verify,
    // 5: compensation fence re-fetch (still matches desired -> fence holds)
    getDevice: sequence([null, created, created, created, created]),
    createDevice: async () => {},
    deleteDevice: async (devEui) => { deletedDevEui = devEui; },
    getKeys: sequence([null, fakeKeys({ nwkKey: OLD_NWK_KEY })]),
    createKeys: async () => {},
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'verifyKeys');
      assert.equal(error.code, 'FAILED_PRECONDITION');
      assert.deepEqual(Object.keys(error).sort(), ['code', 'step']);
      return true;
    }
  );
  assert.equal(countCalls(client, 'deleteDevice'), 1, 'a brand-new device that cannot finish provisioning must be deleted, not orphaned');
  assert.equal(deletedDevEui, DEVEUI);
  assert.equal(countCalls(client, 'updateDevice'), 0);
  assert.equal(countCalls(client, 'restoreDevice'), 0);
  assert.equal(countCalls(client, 'updateKeys'), 0);
  assert.equal(countCalls(client, 'deleteKeys'), 0);
  assert.equal(countCalls(client, 'restoreKeys'), 0);
});

test('[reconcile] created device with verifyKeys mismatch after aggregate drift: zero compensating mutations and RECONCILIATION_REQUIRED', async () => {
  const created = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const drifted = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'foreign-writer-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    // Fence re-fetch (5th read) shows a foreign writer took the device.
    getDevice: sequence([null, created, created, created, drifted]),
    createDevice: async () => {},
    getKeys: sequence([null, fakeKeys({ nwkKey: OLD_NWK_KEY })]),
    createKeys: async () => {},
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.step, 'verifyKeys');
      assert.equal(error.code, 'RECONCILIATION_REQUIRED');
      assert.equal(error.resourceKind, 'keys');
      return true;
    }
  );
  assert.equal(countCalls(client, 'deleteDevice'), 0);
  assert.equal(countCalls(client, 'updateDevice'), 0);
  assert.equal(countCalls(client, 'restoreDevice'), 0);
  assert.equal(countCalls(client, 'createKeys'), 1, 'only the forward createKeys already made before the failure');
  assert.equal(countCalls(client, 'updateKeys'), 0);
  assert.equal(countCalls(client, 'deleteKeys'), 0);
  assert.equal(countCalls(client, 'restoreKeys'), 0);
});

test('[reconcile] restore failure: rejects with both the provisioning and rollback failures, never reports provisioned', async () => {
  const wrong = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: 'stale-app', deviceProfileId: PROFILE_ID, isDisabled: false });
  const corrected = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false });
  const client = makeReconcileClient({
    getDevice: sequence([wrong, wrong, corrected, corrected]),
    updateDevice: async () => {},
    restoreDevice: async () => { throw fakeFailure('restoreDevice', 'UNAVAILABLE'); },
    getKeys: sequence([null]),
    createKeys: async () => { throw fakeFailure('createKeys', 'INTERNAL'); },
  });

  let caught = null;
  try {
    caught = await client.ensureDeviceProvisioned(baseInput());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.devEui, undefined, 'a failed call never reports a provisioned devEui');
  assert.equal(caught.step, 'createKeys');
  assert.equal(caught.code, 'INTERNAL');
  assert.deepEqual(caught.rollback, [{ step: 'restoreDevice', code: 'UNAVAILABLE' }]);
});

test('[reconcile] validation failures never touch ChirpStack and stay bounded', async () => {
  const client = makeReconcileClient();
  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput({ devEui: '' })),
    (error) => {
      assert.equal(error.step, 'validate');
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(Object.keys(error).sort(), ['code', 'step']);
      return true;
    }
  );
  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput({ appKey: 'too-short' })),
    (error) => {
      assert.equal(error.step, 'validate');
      return true;
    }
  );
  assert.equal(client._calls.length, 0, 'validation failures make zero RPC-facing calls');
});

test('[reconcile] an omitted JoinEUI does not erase an existing value', async () => {
  const existing = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false, joinEui: 'AABBCCDDEEFF0011' });
  const client = makeReconcileClient({
    getDevice: sequence([existing, existing, existing, existing]),
    getKeys: sequence([fakeKeys({ nwkKey: NWK_KEY }), fakeKeys({ nwkKey: NWK_KEY })]),
  });

  const result = await client.ensureDeviceProvisioned(baseInput());
  assert.equal(result.deviceAction, 'unchanged');
  assert.equal(countCalls(client, 'updateDevice'), 0);
});

test('[reconcile] deviceSnapshot/deviceMatches compare a fakeDevice against a desired snapshot', () => {
  const device = fakeDevice({ devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, isDisabled: false, joinEui: 'aabbccdd' });
  const snapshot = deviceSnapshot(device);
  assert.deepEqual(snapshot, {
    name: 'Dendro 3',
    applicationId: APPLICATION_ID,
    deviceProfileId: PROFILE_ID,
    description: '',
    joinEui: 'AABBCCDD',
    isDisabled: false,
  });
  assert.equal(deviceMatches(device, snapshot), true);
  assert.equal(deviceMatches(device, Object.assign({}, snapshot, { name: 'Other' })), false);
});

// ---------------------------------------------------------------------------
// [rpc] fixed deadline, bounded errors, and idempotent close-all
// ---------------------------------------------------------------------------

test('[rpc] grpcInvoke passes a Date deadline ~DEFAULT_RPC_TIMEOUT_MS ahead and rejects with only step+code', async () => {
  let capturedOptions = null;
  const fakeClient = {
    someMethod(request, metadata, options, callback) {
      capturedOptions = options;
      callback({ code: grpc.status.DEADLINE_EXCEEDED, details: 'deadline exceeded', message: 'deadline exceeded' });
    },
  };
  const before = Date.now();

  await assert.rejects(
    grpcInvoke(fakeClient, 'someMethod', {}, new grpc.Metadata(), 'getDevice'),
    (error) => {
      assert.deepEqual(Object.keys(error).sort(), ['code', 'step']);
      assert.equal(error.step, 'getDevice');
      assert.equal(error.code, 'DEADLINE_EXCEEDED');
      assert.ok(!JSON.stringify(error).includes('deadline exceeded'));
      assert.ok(!String(error.message).includes('deadline exceeded'));
      return true;
    }
  );

  assert.ok(capturedOptions && capturedOptions.deadline instanceof Date, 'a Date deadline option was passed');
  const deltaMs = capturedOptions.deadline.getTime() - before;
  assert.ok(deltaMs > DEFAULT_RPC_TIMEOUT_MS - 1000 && deltaMs <= DEFAULT_RPC_TIMEOUT_MS + 1000, `deadline delta ${deltaMs}ms should be ~${DEFAULT_RPC_TIMEOUT_MS}ms`);
});

test('[rpc] grpcInvoke resolves with the callback response on success', async () => {
  const fakeClient = {
    m(request, metadata, options, callback) { callback(null, { ok: true }); },
  };
  const response = await grpcInvoke(fakeClient, 'm', {}, new grpc.Metadata(), 'getDevice');
  assert.deepEqual(response, { ok: true });
});

test('[rpc] grpcInvoke ignores a caller-supplied extra sixth argument; the deadline is not overridable', async () => {
  let capturedOptions = null;
  const fakeClient = { m(request, metadata, options, callback) { capturedOptions = options; callback(null, {}); } };
  const before = Date.now();
  await grpcInvoke(fakeClient, 'm', {}, new grpc.Metadata(), 'getDevice', 999999);
  const deltaMs = capturedOptions.deadline.getTime() - before;
  assert.ok(deltaMs > DEFAULT_RPC_TIMEOUT_MS - 1000 && deltaMs <= DEFAULT_RPC_TIMEOUT_MS + 1000);
});

test('[rpc] grpcInvoke normalizes an unrecognized step to grpc_call and an unrecognized code to UNKNOWN', async () => {
  const fakeClient = { m(request, metadata, options, callback) { callback({ code: 987654 }); } };
  await assert.rejects(
    grpcInvoke(fakeClient, 'm', {}, new grpc.Metadata(), 'not-a-real-step'),
    (error) => {
      assert.equal(error.step, 'grpc_call');
      assert.equal(error.code, 'UNKNOWN');
      return true;
    }
  );
});

test('[rpc] grpcInvoke never copies a raw error secret sentinel across the boundary', async () => {
  const fakeClient = {
    m(request, metadata, options, callback) {
      callback({ code: grpc.status.INTERNAL, details: SECRET_SENTINEL, message: SECRET_SENTINEL, metadata: { secret: SECRET_SENTINEL }, stack: SECRET_SENTINEL });
    },
  };
  await assert.rejects(
    grpcInvoke(fakeClient, 'm', {}, new grpc.Metadata(), 'getDevice'),
    (error) => {
      assert.ok(!JSON.stringify(error).includes(SECRET_SENTINEL));
      assert.ok(!String(error.message).includes(SECRET_SENTINEL));
      assert.ok(!String(error.stack).includes(SECRET_SENTINEL));
      return true;
    }
  );
});

test('[rpc] close() closes every distinct underlying client exactly once, tolerates throwing clients, and is idempotent', () => {
  const client = Object.create(ChirpStackClient.prototype);
  client.closed = false;
  client.closeErrors = [];
  const closeCounts = {};
  function makeService(name, shouldThrow) {
    return {
      close() {
        closeCounts[name] = (closeCounts[name] || 0) + 1;
        if (shouldThrow) throw new Error(`${SECRET_SENTINEL}-${name}`);
      },
    };
  }
  client.deviceClient = makeService('deviceClient', true);
  client.applicationClient = makeService('applicationClient', false);
  client.tenantClient = makeService('tenantClient', true);
  client.deviceProfileClient = makeService('deviceProfileClient', false);
  client.gatewayClient = makeService('gatewayClient', false);

  const errors1 = client.close();
  assert.deepEqual(closeCounts, {
    deviceClient: 1, applicationClient: 1, tenantClient: 1, deviceProfileClient: 1, gatewayClient: 1,
  });
  assert.deepEqual(errors1, [
    { service: 'deviceClient', code: 'CLOSE_FAILED' },
    { service: 'tenantClient', code: 'CLOSE_FAILED' },
  ]);
  for (const entry of errors1) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'service']);
  }
  assert.ok(!JSON.stringify(errors1).includes(SECRET_SENTINEL));

  const errors2 = client.close();
  assert.deepEqual(closeCounts, {
    deviceClient: 1, applicationClient: 1, tenantClient: 1, deviceProfileClient: 1, gatewayClient: 1,
  }, 'a second close() call must not close anything again');
  assert.deepEqual(errors2, errors1);
});

test('[rpc] close() dedupes a client object shared across two service roles, keeping the first stable role', () => {
  const client = Object.create(ChirpStackClient.prototype);
  client.closed = false;
  client.closeErrors = [];
  let closeCount = 0;
  const shared = { close() { closeCount += 1; } };
  client.deviceClient = shared;
  client.applicationClient = shared;
  client.tenantClient = { close() {} };
  client.deviceProfileClient = { close() {} };
  client.gatewayClient = { close() {} };

  const errors = client.close();
  assert.equal(closeCount, 1);
  assert.deepEqual(errors, []);
});

test('[rpc] close() ignores a client with no close method', () => {
  const client = Object.create(ChirpStackClient.prototype);
  client.closed = false;
  client.closeErrors = [];
  client.deviceClient = {};
  client.applicationClient = {};
  client.tenantClient = {};
  client.deviceProfileClient = {};
  client.gatewayClient = {};
  assert.deepEqual(client.close(), []);
});

// ---------------------------------------------------------------------------
// [rpc-shape] real generated protobuf request/message classes
// ---------------------------------------------------------------------------

function makeRecordingServiceClient(methodImpls) {
  const calls = [];
  const client = { _calls: calls };
  for (const [method, impl] of Object.entries(methodImpls)) {
    client[method] = (request, metadata, options, callback) => {
      calls.push({ method, request, metadata, options });
      impl(request, metadata, options, callback);
    };
  }
  return client;
}

function makeShapeClient(deviceServiceImpls) {
  const client = Object.create(ChirpStackClient.prototype);
  client.closed = false;
  client.closeErrors = [];
  client.metadata = new grpc.Metadata();
  client.metadata.set('authorization', 'Bearer shape-test-key');
  const deviceClient = makeRecordingServiceClient(deviceServiceImpls);
  client.deviceClient = deviceClient;
  client.applicationClient = {};
  client.tenantClient = {};
  client.deviceProfileClient = {};
  client.gatewayClient = {};
  return { client, deviceClient };
}

function assertDeadline(options) {
  assert.ok(options.deadline instanceof Date);
  const deltaMs = options.deadline.getTime() - Date.now();
  assert.ok(deltaMs > DEFAULT_RPC_TIMEOUT_MS - 2000 && deltaMs <= DEFAULT_RPC_TIMEOUT_MS);
}

test('[rpc-shape] updateDevice sends a real UpdateDeviceRequest with only owned fields changed and DevEUI unchanged', async () => {
  const { client, deviceClient } = makeShapeClient({
    update(request, metadata, options, callback) { callback(null, {}); },
  });
  const fetched = new devicePb.Device();
  fetched.setDevEui(DEVEUI);
  fetched.setName('Old Name');
  fetched.setApplicationId('old-app');
  fetched.setDeviceProfileId('old-profile');
  fetched.setDescription('old-desc');
  fetched.setIsDisabled(true);
  fetched.setSkipFcntCheck(true); // unowned field, must survive untouched

  const desired = {
    name: 'New Name', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID,
    description: 'new-desc', joinEui: '', isDisabled: false,
  };
  await client.updateDevice(fetched, desired);

  assert.equal(deviceClient._calls.length, 1);
  const call = deviceClient._calls[0];
  assert.equal(call.method, 'update');
  assert.ok(call.request instanceof devicePb.UpdateDeviceRequest);
  const sentDevice = call.request.getDevice();
  assert.equal(sentDevice.getDevEui(), DEVEUI);
  assert.equal(sentDevice.getName(), 'New Name');
  assert.equal(sentDevice.getApplicationId(), APPLICATION_ID);
  assert.equal(sentDevice.getDeviceProfileId(), PROFILE_ID);
  assert.equal(sentDevice.getDescription(), 'new-desc');
  assert.equal(sentDevice.getIsDisabled(), false);
  assert.equal(sentDevice.getSkipFcntCheck(), true);
  assert.equal(call.metadata.get('authorization')[0], 'Bearer shape-test-key');
  assertDeadline(call.options);
});

test('[rpc-shape] createKeys sends devEui + supplied AppKey as nwkKey and omits appKey/genAppKey for a new row', async () => {
  const { client, deviceClient } = makeShapeClient({
    createKeys(request, metadata, options, callback) { callback(null, {}); },
  });
  await client.createKeys({ devEui: DEVEUI, nwkKey: NWK_KEY });
  const call = deviceClient._calls[0];
  assert.equal(call.method, 'createKeys');
  assert.ok(call.request instanceof devicePb.CreateDeviceKeysRequest);
  const keys = call.request.getDeviceKeys();
  assert.ok(keys instanceof devicePb.DeviceKeys);
  assert.equal(keys.getDevEui(), DEVEUI);
  assert.equal(keys.getNwkKey(), NWK_KEY);
  assert.equal(keys.getAppKey(), '');
  assert.equal(keys.getGenAppKey(), '');
  assertDeadline(call.options);
});

test('[rpc-shape] updateKeys changes only nwkKey and copies previous appKey/genAppKey exactly', async () => {
  const { client, deviceClient } = makeShapeClient({
    updateKeys(request, metadata, options, callback) { callback(null, {}); },
  });
  await client.updateKeys({ devEui: DEVEUI, nwkKey: NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY });
  const call = deviceClient._calls[0];
  assert.equal(call.method, 'updateKeys');
  assert.ok(call.request instanceof devicePb.UpdateDeviceKeysRequest);
  const keys = call.request.getDeviceKeys();
  assert.equal(keys.getDevEui(), DEVEUI);
  assert.equal(keys.getNwkKey(), NWK_KEY);
  assert.equal(keys.getAppKey(), PRESERVED_APP_KEY);
  assert.equal(keys.getGenAppKey(), PRESERVED_GEN_APP_KEY);
});

test('[rpc-shape] restoreDevice encodes the exact prior application/profile/name/description/JoinEUI/disabled snapshot', async () => {
  const { client, deviceClient } = makeShapeClient({
    update(request, metadata, options, callback) { callback(null, {}); },
  });
  const fetched = new devicePb.Device();
  fetched.setDevEui(DEVEUI);
  fetched.setName('Current Name');
  fetched.setApplicationId('current-app');
  fetched.setDeviceProfileId('current-profile');
  const snapshot = {
    name: 'Original Name', applicationId: 'orig-app', deviceProfileId: 'orig-profile',
    description: 'orig-desc', joinEui: 'AABBCCDDEEFF0011', isDisabled: true,
  };
  await client.restoreDevice(fetched, snapshot);
  const call = deviceClient._calls[0];
  assert.equal(call.method, 'update');
  const sent = call.request.getDevice();
  assert.equal(sent.getDevEui(), DEVEUI);
  assert.equal(sent.getName(), snapshot.name);
  assert.equal(sent.getApplicationId(), snapshot.applicationId);
  assert.equal(sent.getDeviceProfileId(), snapshot.deviceProfileId);
  assert.equal(sent.getDescription(), snapshot.description);
  assert.equal(sent.getJoinEui(), snapshot.joinEui);
  assert.equal(sent.getIsDisabled(), true);
});

test('[rpc-shape] restoreDevice explicitly clears JoinEUI back to empty when the prior snapshot had none', async () => {
  const { client, deviceClient } = makeShapeClient({
    update(request, metadata, options, callback) { callback(null, {}); },
  });
  const fetched = new devicePb.Device();
  fetched.setDevEui(DEVEUI);
  fetched.setName('Dendro 3');
  fetched.setApplicationId(APPLICATION_ID);
  fetched.setDeviceProfileId(PROFILE_ID);
  fetched.setJoinEui('AABBCCDDEEFF0011'); // set by this call's forward write
  const snapshot = {
    name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID,
    description: '', joinEui: '', isDisabled: false,
  };
  await client.restoreDevice(fetched, snapshot);
  const sent = deviceClient._calls[0].request.getDevice();
  assert.equal(sent.getJoinEui(), '', 'restore must clear a JoinEUI the failed provisioning attempt introduced');
});

test('[rpc-shape] restoreKeys encodes the complete prior key tuple', async () => {
  const { client, deviceClient } = makeShapeClient({
    updateKeys(request, metadata, options, callback) { callback(null, {}); },
  });
  const snapshot = { nwkKey: OLD_NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY };
  await client.restoreKeys(DEVEUI, snapshot);
  const call = deviceClient._calls[0];
  assert.equal(call.method, 'updateKeys');
  const keys = call.request.getDeviceKeys();
  assert.equal(keys.getDevEui(), DEVEUI);
  assert.equal(keys.getNwkKey(), OLD_NWK_KEY);
  assert.equal(keys.getAppKey(), PRESERVED_APP_KEY);
  assert.equal(keys.getGenAppKey(), PRESERVED_GEN_APP_KEY);
});

test('[rpc-shape] deleteDevice and deleteKeys send DeleteDeviceRequest/DeleteDeviceKeysRequest carrying only the DevEUI', async () => {
  const { client, deviceClient } = makeShapeClient({
    delete(request, metadata, options, callback) { callback(null, {}); },
    deleteKeys(request, metadata, options, callback) { callback(null, {}); },
  });
  await client.deleteDevice(DEVEUI);
  await client.deleteKeys(DEVEUI);
  assert.equal(deviceClient._calls[0].method, 'delete');
  assert.ok(deviceClient._calls[0].request instanceof devicePb.DeleteDeviceRequest);
  assert.equal(deviceClient._calls[0].request.getDevEui(), DEVEUI);
  assert.equal(deviceClient._calls[1].method, 'deleteKeys');
  assert.ok(deviceClient._calls[1].request instanceof devicePb.DeleteDeviceKeysRequest);
  assert.equal(deviceClient._calls[1].request.getDevEui(), DEVEUI);
});

// Stateful in-memory fake DeviceService for integrated ensureDeviceProvisioned
// runs across the real protobuf boundary.
function makeInMemoryDeviceService(options = {}) {
  let deviceRecord = options.initialDevice ? Object.assign({}, options.initialDevice) : null;
  let keysRecord = options.initialKeys ? Object.assign({}, options.initialKeys) : null;
  let getDeviceCalls = 0;
  let getKeysCalls = 0;
  const calls = [];

  function buildDeviceResponse() {
    const device = new devicePb.Device();
    device.setDevEui(deviceRecord.devEui);
    device.setName(deviceRecord.name);
    device.setApplicationId(deviceRecord.applicationId);
    device.setDeviceProfileId(deviceRecord.deviceProfileId);
    device.setDescription(deviceRecord.description || '');
    device.setIsDisabled(Boolean(deviceRecord.isDisabled));
    if (deviceRecord.joinEui) device.setJoinEui(deviceRecord.joinEui);
    const response = new devicePb.GetDeviceResponse();
    response.setDevice(device);
    return response;
  }
  function buildKeysResponse() {
    const keys = new devicePb.DeviceKeys();
    keys.setDevEui(deviceRecord.devEui);
    keys.setNwkKey(keysRecord.nwkKey || '');
    if (keysRecord.appKey) keys.setAppKey(keysRecord.appKey);
    if (keysRecord.genAppKey) keys.setGenAppKey(keysRecord.genAppKey);
    const response = new devicePb.GetDeviceKeysResponse();
    response.setDeviceKeys(keys);
    return response;
  }
  function deviceFromRequest(request) {
    const d = request.getDevice();
    return {
      devEui: d.getDevEui(), name: d.getName(), applicationId: d.getApplicationId(),
      deviceProfileId: d.getDeviceProfileId(), description: d.getDescription(),
      isDisabled: d.getIsDisabled(), joinEui: d.getJoinEui ? d.getJoinEui() : '',
    };
  }

  return {
    _calls: calls,
    _state: () => ({ device: deviceRecord ? Object.assign({}, deviceRecord) : null, keys: keysRecord ? Object.assign({}, keysRecord) : null }),
    get(request, metadata, opts, callback) {
      calls.push('get');
      getDeviceCalls += 1;
      if (options.beforeGetDeviceResponse) {
        options.beforeGetDeviceResponse(getDeviceCalls, (mutation) => {
          if (deviceRecord) deviceRecord = Object.assign({}, deviceRecord, mutation);
        });
      }
      if (options.forceMissingDeviceOnCall === getDeviceCalls || !deviceRecord) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, buildDeviceResponse());
    },
    create(request, metadata, opts, callback) {
      calls.push('create');
      if (deviceRecord) {
        callback({ code: grpc.status.ALREADY_EXISTS });
        return;
      }
      deviceRecord = deviceFromRequest(request);
      callback(null, {});
    },
    update(request, metadata, opts, callback) {
      calls.push('update');
      deviceRecord = deviceFromRequest(request);
      callback(null, {});
    },
    delete(request, metadata, opts, callback) {
      calls.push('delete');
      deviceRecord = null;
      callback(null, {});
    },
    getKeys(request, metadata, opts, callback) {
      calls.push('getKeys');
      getKeysCalls += 1;
      if (options.beforeGetKeysResponse) {
        options.beforeGetKeysResponse(getKeysCalls, (mutation) => {
          if (keysRecord) keysRecord = Object.assign({}, keysRecord, mutation);
        });
      }
      if (options.forceMissingKeysOnCall === getKeysCalls || !keysRecord) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, buildKeysResponse());
    },
    createKeys(request, metadata, opts, callback) {
      calls.push('createKeys');
      if (options.failCreateKeys) {
        callback({ code: grpc.status.INTERNAL });
        return;
      }
      const k = request.getDeviceKeys();
      if (!options.silentlyIgnoreKeyMutations) {
        keysRecord = { nwkKey: k.getNwkKey(), appKey: k.getAppKey(), genAppKey: k.getGenAppKey() };
      }
      callback(null, {});
    },
    updateKeys(request, metadata, opts, callback) {
      calls.push('updateKeys');
      const k = request.getDeviceKeys();
      if (!options.silentlyIgnoreKeyMutations) {
        keysRecord = { nwkKey: k.getNwkKey(), appKey: k.getAppKey(), genAppKey: k.getGenAppKey() };
      }
      callback(null, {});
    },
    deleteKeys(request, metadata, opts, callback) {
      calls.push('deleteKeys');
      keysRecord = null;
      callback(null, {});
    },
  };
}

function makeInMemoryShapeClient(options) {
  const client = Object.create(ChirpStackClient.prototype);
  client.closed = false;
  client.closeErrors = [];
  client.metadata = new grpc.Metadata();
  client.metadata.set('authorization', 'Bearer shape-test-key');
  const deviceClient = makeInMemoryDeviceService(options);
  client.deviceClient = deviceClient;
  client.applicationClient = {};
  client.tenantClient = {};
  client.deviceProfileClient = {};
  client.gatewayClient = {};
  return { client, deviceClient };
}

test('[rpc-shape] a changed preserved key field between write and reread rejects at verifyKeys with RECONCILIATION_REQUIRED', async () => {
  const { client, deviceClient } = makeInMemoryShapeClient({
    initialDevice: { devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, description: '', isDisabled: false, joinEui: '' },
    initialKeys: { nwkKey: OLD_NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY },
    beforeGetKeysResponse(count, mutate) {
      if (count === 2) mutate({ appKey: TAMPERED_APP_KEY });
    },
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.code, 'RECONCILIATION_REQUIRED');
      assert.equal(error.resourceKind, 'keys');
      assert.ok(!JSON.stringify(error).includes(PRESERVED_APP_KEY));
      assert.ok(!JSON.stringify(error).includes(TAMPERED_APP_KEY));
      return true;
    }
  );
  assert.deepEqual(deviceClient._calls.filter((c) => ['createKeys', 'updateKeys', 'deleteKeys'].includes(c)), ['updateKeys']);
});

test('[rpc-shape] a missing key row on reread (deleted concurrently) rejects at verifyKeys with RECONCILIATION_REQUIRED', async () => {
  const { client, deviceClient } = makeInMemoryShapeClient({
    initialDevice: { devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, description: '', isDisabled: false, joinEui: '' },
    initialKeys: { nwkKey: OLD_NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY },
    forceMissingKeysOnCall: 2,
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.code, 'RECONCILIATION_REQUIRED');
      assert.equal(error.resourceKind, 'keys');
      return true;
    }
  );
  assert.deepEqual(deviceClient._calls.filter((c) => ['createKeys', 'updateKeys', 'deleteKeys'].includes(c)), ['updateKeys']);
});

test('[rpc-shape] a stale key row (write reported success but reread still shows the old nwkKey) rejects at verifyKeys with RECONCILIATION_REQUIRED', async () => {
  const { client, deviceClient } = makeInMemoryShapeClient({
    initialDevice: { devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, description: '', isDisabled: false, joinEui: '' },
    initialKeys: { nwkKey: OLD_NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY },
    silentlyIgnoreKeyMutations: true,
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput()),
    (error) => {
      assert.equal(error.code, 'RECONCILIATION_REQUIRED');
      assert.equal(error.resourceKind, 'keys');
      return true;
    }
  );
  assert.deepEqual(deviceClient._calls.filter((c) => ['createKeys', 'updateKeys', 'deleteKeys'].includes(c)), ['updateKeys']);
});

test('[rpc-shape] a later failure after a forward JoinEUI write restores the empty JoinEUI on read-back', async () => {
  const { client, deviceClient } = makeInMemoryShapeClient({
    initialDevice: { devEui: DEVEUI, name: 'Dendro 3', applicationId: APPLICATION_ID, deviceProfileId: PROFILE_ID, description: '', isDisabled: false, joinEui: '' },
    initialKeys: null,
    failCreateKeys: true,
  });

  await assert.rejects(
    client.ensureDeviceProvisioned(baseInput({ joinEui: 'AABBCCDDEEFF0011' })),
    (error) => {
      assert.equal(error.step, 'createKeys');
      assert.equal(error.code, 'INTERNAL');
      return true;
    }
  );
  const after = deviceClient._state();
  assert.ok(after.device, 'the pre-existing device must not be deleted');
  assert.equal(after.device.joinEui, '', 'restore must clear the JoinEUI this failed attempt introduced');
  assert.equal(after.device.applicationId, APPLICATION_ID);
  assert.equal(after.device.name, 'Dendro 3');
  assert.equal(after.keys, null, 'no key row may survive the failed attempt');
});

test('[rpc-shape] full ensureDeviceProvisioned happy path through the real protobuf boundary never exposes key material', async () => {
  const { client } = makeInMemoryShapeClient({
    initialDevice: { devEui: DEVEUI, name: 'Old Name', applicationId: 'stale-app', deviceProfileId: PROFILE_ID, description: '', isDisabled: false, joinEui: '' },
    initialKeys: { nwkKey: OLD_NWK_KEY, appKey: PRESERVED_APP_KEY, genAppKey: PRESERVED_GEN_APP_KEY },
  });

  const result = await client.ensureDeviceProvisioned(baseInput({ appKey: NWK_KEY }));
  assert.deepEqual(result, {
    devEui: DEVEUI,
    deviceAction: 'updated',
    keysAction: 'updated',
    keysVerified: true,
    verifiedApplicationId: APPLICATION_ID,
    verifiedDeviceProfileId: PROFILE_ID,
  });
  assert.ok(!JSON.stringify(result).includes(NWK_KEY));
  assert.ok(!JSON.stringify(result).includes(PRESERVED_APP_KEY));
  assert.ok(!JSON.stringify(result).includes(PRESERVED_GEN_APP_KEY));
});

// ---------------------------------------------------------------------------
// [flow] flow lifecycle red tests (expected red on this base; Task 4 owned)
// ---------------------------------------------------------------------------

const FLOWS_JSON_PATH = path.join(__dirname, '..', '..', 'flows.json');
const RUN_FLOW_RED = process.env.OSI_EXPECT_FLOW_RED === '1';

function loadFlowNode(name) {
  const flows = JSON.parse(fs.readFileSync(FLOWS_JSON_PATH, 'utf8'));
  const node = flows.find((entry) => entry.type === 'function' && entry.name === name);
  if (!node) throw new Error(`flows.json is missing the function node ${name}`);
  return node;
}

function defaultFlowApi(state = new Map()) {
  return {
    get: (key) => state.get(key),
    set: (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value); },
  };
}

function noopStore() {
  return { get() { return undefined; }, set() {} };
}

function runFlowFunctionNode(node, msg, options = {}) {
  const libVars = (node.libs || []).map((lib) => lib.var);
  const params = ['msg', 'node', 'flow', 'env', 'context', 'global', ...libVars];
  const script = new vm.Script(`(async function(${params.join(',')}){\n${node.func}\n})`);
  const fn = script.runInNewContext({
    Buffer, console, require, process, setTimeout, clearTimeout, JSON, Promise,
  });
  const nodeApi = Object.assign({ error() {}, warn() {}, status() {} }, options.node || {});
  const flowApi = options.flow || defaultFlowApi();
  const envValues = options.env || {};
  const envApi = { get: (key) => envValues[key] };
  const libValues = libVars.map((name) => (options.libs || {})[name]);
  return fn(msg, nodeApi, flowApi, envApi, options.context || noopStore(), options.global || noopStore(), ...libValues);
}

function makeFakeOsiDb(opts = {}) {
  return {
    Database: function FakeDatabase() {
      return {
        run(sqlOrParamsA, sqlOrParamsB, maybeCb) {
          const cb = typeof sqlOrParamsB === 'function' ? sqlOrParamsB : maybeCb;
          if (opts.failRun) { cb(new Error('fake_db_run_failure')); return; }
          cb(null);
        },
        all(sql, paramsOrCb, maybeCb) {
          const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
          cb(null, []);
        },
        close(cb) { if (cb) cb(); },
      };
    },
  };
}

function makeFakeProvisioningClient(overrides = {}) {
  const state = { closeCalls: 0 };
  return {
    _state: state,
    ensureDeviceProvisioned: overrides.ensureDeviceProvisioned || (async () => ({
      devEui: DEVEUI, deviceAction: 'created', keysAction: 'created', keysVerified: true,
      verifiedApplicationId: APPLICATION_ID, verifiedDeviceProfileId: PROFILE_ID,
    })),
    deleteDevice: overrides.deleteDevice || (async () => true),
    close() { state.closeCalls += 1; return []; },
  };
}

function makeFakeChirpstackModule(makeClientImpl) {
  return { createProvisioningClientFromEnv: (env) => makeClientImpl(env) };
}

const flowTest = RUN_FLOW_RED ? test : test.skip;

flowTest('[flow] CS Register Device closes the chirpstack client after a successful registration', async () => {
  const client = makeFakeProvisioningClient();
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb();
  const msg = { deviceRegistration: baseInput(), topic: "INSERT OR IGNORE INTO devices (deveui) VALUES ('X')" };
  await runFlowFunctionNode(loadFlowNode('CS Register Device'), msg, {
    libs: { osiDb, chirpstack },
    env: { DEVICE_EUI: 'GATEWAYEUI' },
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a successful registration');
});

flowTest('[flow] CS Register Device closes the chirpstack client after a validation failure', async () => {
  const client = makeFakeProvisioningClient({
    ensureDeviceProvisioned: async () => { throw Object.assign(new Error('bad'), { step: 'validate', code: 'INVALID_ARGUMENT' }); },
  });
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb();
  const msg = { deviceRegistration: baseInput(), topic: "INSERT OR IGNORE INTO devices (deveui) VALUES ('X')" };
  await runFlowFunctionNode(loadFlowNode('CS Register Device'), msg, {
    libs: { osiDb, chirpstack },
    env: { DEVICE_EUI: 'GATEWAYEUI' },
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a validation failure');
});

flowTest('[flow] CS Register Device closes the chirpstack client after a reconciliation failure', async () => {
  const client = makeFakeProvisioningClient({
    ensureDeviceProvisioned: async () => { throw Object.assign(new Error('bad'), { step: 'verifyKeys', code: 'RECONCILIATION_REQUIRED', resourceKind: 'keys' }); },
  });
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb();
  const msg = { deviceRegistration: baseInput(), topic: "INSERT OR IGNORE INTO devices (deveui) VALUES ('X')" };
  await runFlowFunctionNode(loadFlowNode('CS Register Device'), msg, {
    libs: { osiDb, chirpstack },
    env: { DEVICE_EUI: 'GATEWAYEUI' },
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a reconciliation failure');
});

flowTest('[flow] CS Register Device closes the chirpstack client after a local DB failure', async () => {
  const client = makeFakeProvisioningClient();
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb({ failRun: true });
  const msg = { deviceRegistration: baseInput(), topic: "INSERT OR IGNORE INTO devices (deveui) VALUES ('X')" };
  await runFlowFunctionNode(loadFlowNode('CS Register Device'), msg, {
    libs: { osiDb, chirpstack },
    env: { DEVICE_EUI: 'GATEWAYEUI' },
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a local DB failure');
});

flowTest('[flow] CS Register (cloud cmd) closes the chirpstack client after a successful REGISTER_DEVICE', async () => {
  const client = makeFakeProvisioningClient();
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb();
  const envValues = {
    DEVICE_EUI: 'GATEWAYEUI',
    CHIRPSTACK_APP_SENSORS: APPLICATION_ID,
    CHIRPSTACK_PROFILE_KIWI: PROFILE_ID,
  };
  const msg = { payload: { commandType: 'REGISTER_DEVICE', params: { devEui: DEVEUI, name: 'Dendro 3', deviceType: 'KIWI_SENSOR', appKey: NWK_KEY } } };
  await runFlowFunctionNode(loadFlowNode('CS Register (cloud cmd)'), msg, {
    libs: { osiDb, chirpstack },
    env: envValues,
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a successful cloud REGISTER_DEVICE');
});

flowTest('[flow] CS Register (cloud cmd) closes the chirpstack client after a validation failure', async () => {
  const client = makeFakeProvisioningClient({
    ensureDeviceProvisioned: async () => { throw Object.assign(new Error('bad'), { step: 'validate', code: 'INVALID_ARGUMENT' }); },
  });
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb();
  const envValues = {
    DEVICE_EUI: 'GATEWAYEUI',
    CHIRPSTACK_APP_SENSORS: APPLICATION_ID,
    CHIRPSTACK_PROFILE_KIWI: PROFILE_ID,
  };
  const msg = { payload: { commandType: 'REGISTER_DEVICE', params: { devEui: DEVEUI, name: 'Dendro 3', deviceType: 'KIWI_SENSOR', appKey: NWK_KEY } } };
  await runFlowFunctionNode(loadFlowNode('CS Register (cloud cmd)'), msg, {
    libs: { osiDb, chirpstack },
    env: envValues,
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a validation failure');
});

flowTest('[flow] CS Register (cloud cmd) closes the chirpstack client after a reconciliation failure', async () => {
  const client = makeFakeProvisioningClient({
    ensureDeviceProvisioned: async () => { throw Object.assign(new Error('bad'), { step: 'verifyDevice', code: 'RECONCILIATION_REQUIRED', resourceKind: 'device' }); },
  });
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb();
  const envValues = {
    DEVICE_EUI: 'GATEWAYEUI',
    CHIRPSTACK_APP_SENSORS: APPLICATION_ID,
    CHIRPSTACK_PROFILE_KIWI: PROFILE_ID,
  };
  const msg = { payload: { commandType: 'REGISTER_DEVICE', params: { devEui: DEVEUI, name: 'Dendro 3', deviceType: 'KIWI_SENSOR', appKey: NWK_KEY } } };
  await runFlowFunctionNode(loadFlowNode('CS Register (cloud cmd)'), msg, {
    libs: { osiDb, chirpstack },
    env: envValues,
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a reconciliation failure');
});

flowTest('[flow] CS Register (cloud cmd) closes the chirpstack client after a local DB failure', async () => {
  const client = makeFakeProvisioningClient();
  const chirpstack = makeFakeChirpstackModule(() => client);
  const osiDb = makeFakeOsiDb({ failRun: true });
  const envValues = {
    DEVICE_EUI: 'GATEWAYEUI',
    CHIRPSTACK_APP_SENSORS: APPLICATION_ID,
    CHIRPSTACK_PROFILE_KIWI: PROFILE_ID,
  };
  const msg = { payload: { commandType: 'REGISTER_DEVICE', params: { devEui: DEVEUI, name: 'Dendro 3', deviceType: 'KIWI_SENSOR', appKey: NWK_KEY } } };
  await runFlowFunctionNode(loadFlowNode('CS Register (cloud cmd)'), msg, {
    libs: { osiDb, chirpstack },
    env: envValues,
  });
  assert.equal(client._state.closeCalls, 1, 'client.close() must be called after a local DB failure');
});
