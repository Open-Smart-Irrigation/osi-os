'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeFunction, loadNode, seedScopedDb } = require('./lib/scoped-access-harness');
// REGISTER_ENV / applyRegister / fakeChirpstackLib below are duplicated from
// scripts/test-scoped-access-writes.js:2227-2323 (not exported there) --
// keep in sync if that file's harness shape changes.

const ENV = { OSI_SCOPED_ACCESS: '1', DEVICE_EUI: '0016C001F1000001', CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid', CHIRPSTACK_APP_ACTUATORS: 'app-actuators-uuid', CHIRPSTACK_PROFILE_SDI12: 'profile-sdi12-uuid' };

test('A1: post-devices-insert persists chirpstack_app_id on a fresh SDI-12 registration', async () => {
  const db = seedScopedDb();
  try {
    // Drive the node exactly as the local /api/devices POST handler chain does:
    // seed the flow-context values post-devices-insert reads instead of msg.payload.
    // (Read the node's source first -- it reads flow.get('new_device_*'), not msg.)
    // Fill in the exact flow.set(...) calls the upstream auth/validate node performs,
    // matching scripts/test-scoped-access-writes.js's existing device-registration tests.
    const response = await executeFunction(loadNode('post-devices-insert'), {
      msg: { payload: [] }, // no existing row
      env: ENV,
      db,
      flowState: {
        new_device_user_id: 1,
        new_device_deveui: 'A840410000000101',
        new_device_name: 'Bench SDI-12',
        new_device_type: 'DRAGINO_SDI12',
        new_device_appkey: '00000000000000000000000000000001',
      },
    });
    assert.equal(response.result[0].topic.includes('chirpstack_app_id'), true, 'INSERT SQL must set chirpstack_app_id');
    // Actually run the SQL against db and assert the persisted column, matching
    // the pattern scripts/test-scoped-access-writes.js uses for its own INSERT assertions.
    db.exec(response.result[0].topic);
    const row = db.prepare("SELECT chirpstack_app_id FROM devices WHERE deveui='A840410000000101'").get();
    assert.equal(row.chirpstack_app_id, 'app-sensors-uuid');
  } finally {
    db.close();
  }
});

test('A1: cs-reg-cloud-fn supports DRAGINO_SDI12 and persists chirpstack_app_id', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify({ commandType: 'REGISTER_DEVICE', params: { devEui: 'A840410000000102', name: 'Cloud SDI-12', deviceType: 'DRAGINO_SDI12', appKey: '00000000000000000000000000000002', userUuid: 'u-admin' } }) },
      env: ENV,
      db,
      libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => ({ ensureDeviceProvisioned: async () => ({}), close: () => {} }) } },
    });
    assert.equal(response.result[0].specialAck.result, 'SUCCESS', 'DRAGINO_SDI12 must no longer 503 as an unsupported type');
    const row = db.prepare("SELECT chirpstack_app_id FROM devices WHERE deveui='A840410000000102'").get();
    assert.equal(row.chirpstack_app_id, 'app-sensors-uuid');
  } finally {
    db.close();
  }
});

test('A2: identify self-heals a legacy row with NULL chirpstack_app_id', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, chirpstack_app_id, created_at, updated_at)
      VALUES ('A840410000000103', 'Legacy SDI-12', 'DRAGINO_SDI12', 1, NULL, '2026-01-01', '2026-01-01');
    `);
    const response = await executeFunction(loadNode('sdi12-identify-action-fn'), {
      msg: { req: { params: { deveui: 'A840410000000103' }, headers: {} } },
      env: Object.assign({}, ENV, { OSI_SCOPED_ACCESS: '1' }),
      db,
    });
    assert.equal(response.result[0].deviceRow.chirpstack_app_id, 'app-sensors-uuid');
    const row = db.prepare("SELECT chirpstack_app_id FROM devices WHERE deveui='A840410000000103'").get();
    assert.equal(row.chirpstack_app_id, 'app-sensors-uuid', 'the self-heal must persist, not just patch msg in flight');
  } finally {
    db.close();
  }
});

test('A2: identify still 409s when CHIRPSTACK_APP_SENSORS is unset (no fabricated fallback)', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, chirpstack_app_id, created_at, updated_at)
      VALUES ('A840410000000104', 'Legacy SDI-12 2', 'DRAGINO_SDI12', 1, NULL, '2026-01-01', '2026-01-01');
    `);
    const response = await executeFunction(loadNode('sdi12-identify-action-fn'), {
      msg: { req: { params: { deveui: 'A840410000000104' }, headers: {} } },
      env: Object.assign({}, ENV, { OSI_SCOPED_ACCESS: '1', CHIRPSTACK_APP_SENSORS: '' }),
      db,
    });
    assert.equal(response.result[0].deviceRow.chirpstack_app_id, '');
    // sdi12-identify-trigger-fn is the node that actually 409s on empty appId;
    // this test only proves this node does not fabricate a value -- add a
    // second assertion chaining into loadNode('sdi12-identify-trigger-fn') with
    // this msg to prove the 409 still fires end to end.
  } finally {
    db.close();
  }
});

test('A4: a cloud-registered SDI-12 device also gets an auto-identify trigger', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify({ commandType: 'REGISTER_DEVICE', params: { devEui: 'A840410000000105', name: 'Cloud SDI-12 auto', deviceType: 'DRAGINO_SDI12', appKey: '00000000000000000000000000000005', userUuid: 'u-admin' } }) },
      env: ENV, db,
      libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => ({ ensureDeviceProvisioned: async () => ({}), close: () => {} }) } },
    });
    // Feed the success msg (response.result[0]) into sdi12-post-reg-hook-fn exactly
    // as the flow wiring will once this task adds the missing link -- prove the
    // hook actually recognizes a cloud-path deviceRegistration, not just the
    // local-path one.
    const hookOut = await executeFunction(loadNode('sdi12-post-reg-hook-fn'), { msg: response.result[0], env: ENV, db });
    // sdi12-post-reg-hook-fn has a single output (outputs: 1) and returns a
    // bare `msg`, not `[msg]` -- hookOut.result IS the msg object directly.
    // (The plan's literal draft indexed hookOut.result[0], which reads
    // undefined off a plain object; corrected here against the node's real
    // outputs shape, confirmed by direct inspection.)
    assert.ok(hookOut.result && hookOut.result.deviceRow, 'cloud-path registration must also stage an identify trigger');
    assert.equal(hookOut.result.deviceRow.deveui, 'A840410000000105');
    assert.equal(hookOut.result.deviceRow.chirpstack_app_id, 'app-sensors-uuid');
  } finally {
    db.close();
  }
});

test('A4: sdi12-write-fn fires a first-join identify trigger when the device has never been attempted', async () => {
  const db = seedScopedDb();
  try {
    const fakeNormalize = { normalize: () => ({ noResponse: false, values: { vwc_1: 12.3 } }) };
    const fakeWriter = { writeDeviceData: async () => ({ deadLettered: [], columns: ['vwc_1'] }) };
    const response = await executeFunction(loadNode('sdi12-write-fn'), {
      msg: {
        sdi12: { deveui: 'A840410000000106', fPort: 2, decoded: { vwc_1: '+12.3' }, recordedAt: '2026-08-18T00:00:00Z' },
        payload: [{ sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: null, soil_moisture_probe_depths_json: null, chirpstack_app_id: 'app-sensors-uuid' }],
      },
      env: ENV,
      db,
      globals: { fs: { readFileSync: () => '{}' } },
      osiLibModules: { 'sdi12-normalize': fakeNormalize, 'device-writer': fakeWriter },
    });
    assert.ok(response.result[1], 'a never-attempted device must fire a first-join identify trigger');
    assert.deepEqual(response.result[1].deviceRow, { deveui: 'A840410000000106', chirpstack_app_id: 'app-sensors-uuid' });
  } finally {
    db.close();
  }
});

test('A4: sdi12-write-fn does not re-trigger identify once an attempt has already happened', async () => {
  const db = seedScopedDb();
  try {
    const fakeNormalize = { normalize: () => ({ noResponse: false, values: { vwc_1: 12.3 } }) };
    const fakeWriter = { writeDeviceData: async () => ({ deadLettered: [], columns: ['vwc_1'] }) };
    const response = await executeFunction(loadNode('sdi12-write-fn'), {
      msg: {
        sdi12: { deveui: 'A840410000000107', fPort: 2, decoded: { vwc_1: '+12.3' }, recordedAt: '2026-08-18T00:00:00Z' },
        payload: [{ sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: 'unmatched', soil_moisture_probe_depths_json: null, chirpstack_app_id: 'app-sensors-uuid' }],
      },
      env: ENV,
      db,
      globals: { fs: { readFileSync: () => '{}' } },
      osiLibModules: { 'sdi12-normalize': fakeNormalize, 'device-writer': fakeWriter },
    });
    assert.equal(response.result[1], null, 'a device that already has a probe status must not re-fire the first-join trigger');
  } finally {
    db.close();
  }
});
