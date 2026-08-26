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
    // Chain into the trigger node: it is the one that 409s on an empty appId.
    // Without this the test is vacuous (the pre-fix node also returned '').
    const trigger = await executeFunction(loadNode('sdi12-identify-trigger-fn'), {
      msg: response.result[0],
      env: Object.assign({}, ENV, { OSI_SCOPED_ACCESS: '1', CHIRPSTACK_APP_SENSORS: '' }),
      db,
    });
    assert.equal(trigger.result[0], null, 'no downlink may be queued without an app id');
    assert.equal(trigger.result[1].statusCode, 409, 'identify must still 409 when no app id can be resolved');
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

test('B1: GET /api/devices projects legacy count, canonical layout, and ten-channel latest data', async () => {
  // The modal tests seed the field directly on the Device fixture, so they
  // cannot see this bug: it lives entirely in the merge step between the
  // devices-list SQL row (which already has the column via SELECT d.*) and
  // the API response shape. Drive merge-device-data directly instead.
  const response = await executeFunction(loadNode('merge-device-data'), {
    msg: {
      devices_to_format: [{
        deveui: 'A840410000000108', name: 'SDI12 dev', type_id: 'DRAGINO_SDI12',
        sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: 'manual',
        sdi12_identity: null, sdi12_value_count: 5,
        sdi12_channel_layout_json: JSON.stringify({
          version: 1,
          address: 'L',
          sensors: [{ channel: 10, response_position: 1, depth_cm: 100, type: 'TRISCAN' }],
        }),
      }],
      payload: [{ deveui: 'A840410000000108', vwc_10: 27.5, soil_vic_10: 0.041 }],
    },
    env: {},
    db: seedScopedDb(),
  });
  assert.equal(response.result.payload[0].sdi12_value_count, 5,
    'GET /api/devices must return the learned sdi12_value_count, not silently drop it');
  assert.equal(response.result.payload[0].sdi12_channel_layout_json.sensors[0].channel, 10);
  assert.equal(response.result.payload[0].sdi12_layout_status, 'configured');
  assert.equal(response.result.payload[0].latest_data.vwc_10, 27.5);
  assert.equal(response.result.payload[0].latest_data.soil_vic_10, 0.041);
});

test('B1: GET /api/devices latest-data SQL includes all Sentek columns and prepares successfully', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('format-devices'), {
      msg: { payload: [{ deveui: 'A840410000000108' }] },
      env: {},
      db,
    });
    assert.match(response.result.topic, /dd\.vwc_10,/);
    assert.match(response.result.topic, /dd\.soil_vic_10,/);
    assert.doesNotThrow(() => db.prepare(response.result.topic));
  } finally {
    db.close();
  }
});

test('B1: GET /api/devices surfaces malformed stored Sentek layouts', async () => {
  const response = await executeFunction(loadNode('merge-device-data'), {
    msg: {
      devices_to_format: [{
        deveui: 'A840410000000112', name: 'Broken layout', type_id: 'DRAGINO_SDI12',
        sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_channel_layout_json: '{broken',
      }],
      payload: [],
    },
    env: {},
    db: seedScopedDb(),
  });
  assert.equal(response.result.payload[0].sdi12_channel_layout_json, null);
  assert.equal(response.result.payload[0].sdi12_layout_status, 'invalid');
});

test('B2 (Fable A6 review SHOULD-FIX 2): PUT /sdi12/config nulls a stale value_count when switching to a fixed-shape profile', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, sdi12_probe_profile, sdi12_probe_status, sdi12_value_count, created_at, updated_at)
      VALUES ('A840410000000109', 'SDI12 switch', 'DRAGINO_SDI12', 1, 'SENTEK_ENVIROSCAN', 'manual', 5, '2026-01-01', '2026-01-01');
    `);
    // Modal hides the value-count field for fixed-shape profiles, so a
    // real PUT switching to HYDRASCOUT never sends value_count at all.
    const response = await executeFunction(loadNode('sdi12-config-action-fn'), {
      msg: { req: { body: { probe_profile: 'HYDRASCOUT' } }, deviceRow: { deveui: 'A840410000000109' } },
      env: ENV,
      db,
    });
    assert.equal(response.result.statusCode, undefined, 'must not error: ' + JSON.stringify(response.result.payload));
    assert.equal(response.result.payload.value_count, null, 'response must report the count as cleared');
    const row = db.prepare("SELECT sdi12_probe_profile, sdi12_value_count FROM devices WHERE deveui='A840410000000109'").get();
    assert.equal(row.sdi12_probe_profile, 'HYDRASCOUT');
    assert.equal(row.sdi12_value_count, null,
      'a stale learned count from the prior variable profile must not survive a switch to a fixed-shape profile');
  } finally {
    db.close();
  }
});

test('Sentek layout save is canonical, bound, and updates its compatibility projection atomically', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`INSERT INTO devices (deveui,name,type_id,user_id,sdi12_probe_profile,sdi12_value_count,created_at,updated_at)
      VALUES ('A840410000000110','Sentek layout','DRAGINO_SDI12',1,'SENTEK_ENVIROSCAN',5,'2026-01-01','2026-01-01')`);
    const sensors = [
      { channel: 7, response_position: 2, depth_cm: 80, type: 'ENVIROSCAN' },
      { channel: 9, response_position: 1, depth_cm: 70, type: 'TRISCAN' },
    ];
    const response = await executeFunction(loadNode('sdi12-config-action-fn'), {
      msg: { req: { body: { probe_profile: 'SENTEK_ENVIROSCAN', address: 'L', sensors } }, deviceRow: { deveui: 'A840410000000110' } },
      env: ENV, db,
    });
    assert.equal(response.result.statusCode, undefined, JSON.stringify(response.result.payload));
    const row = db.prepare(`SELECT sdi12_value_count,sdi12_channel_layout_json,
      soil_moisture_probe_depths_json,sync_version FROM devices WHERE deveui='A840410000000110'`).get();
    assert.equal(row.sdi12_value_count, null);
    assert.deepEqual(JSON.parse(row.sdi12_channel_layout_json).sensors.map((sensor) => sensor.channel), [9, 7]);
    assert.deepEqual(JSON.parse(row.soil_moisture_probe_depths_json), { vwc_9: 70, soil_vic_9: 70, vwc_7: 80 });
    assert.equal(row.sync_version, 2);
    assert.equal(response.result.payload.layout_status, 'vic_framing_unverified');
  } finally { db.close(); }
});

test('Sentek layout save rejects mixed legacy fields and invalid duplicate positions without writing', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`INSERT INTO devices (deveui,name,type_id,user_id,created_at,updated_at)
      VALUES ('A840410000000111','Sentek invalid','DRAGINO_SDI12',1,'2026-01-01','2026-01-01')`);
    const sensor = { channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' };
    const mixed = await executeFunction(loadNode('sdi12-config-action-fn'), {
      msg: { req: { body: { probe_profile: 'SENTEK_ENVIROSCAN', address: 'L', sensors: [sensor], value_count: 1 } }, deviceRow: { deveui: 'A840410000000111' } }, env: ENV, db,
    });
    assert.equal(mixed.result.statusCode, 400);
    const duplicate = await executeFunction(loadNode('sdi12-config-action-fn'), {
      msg: { req: { body: { probe_profile: 'SENTEK_ENVIROSCAN', address: 'L', sensors: [sensor, { channel: 2, response_position: 1, depth_cm: 20, type: 'ENVIROSCAN' }] } }, deviceRow: { deveui: 'A840410000000111' } }, env: ENV, db,
    });
    assert.equal(duplicate.result.statusCode, 400);
    assert.equal(db.prepare("SELECT sdi12_channel_layout_json FROM devices WHERE deveui='A840410000000111'").get().sdi12_channel_layout_json, null);
  } finally { db.close(); }
});
