'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedTestDb,
} = require('./lib/flow-node-harness');
// REGISTER_ENV / applyRegister / fakeChirpstackLib below are duplicated from
// scripts/test-scoped-access-writes.js:2227-2323 (not exported there) --
// keep in sync if that file's harness shape changes.

const ENV = { OSI_SCOPED_ACCESS: '1', DEVICE_EUI: '0016C001F1000001', CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid', CHIRPSTACK_APP_ACTUATORS: 'app-actuators-uuid', CHIRPSTACK_PROFILE_SDI12: 'profile-sdi12-uuid' };

test('A1: post-devices-insert persists chirpstack_app_id on a fresh SDI-12 registration', async () => {
  const db = seedTestDb();
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
  const db = seedTestDb();
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
  const db = seedTestDb();
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
  const db = seedTestDb();
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
  const db = seedTestDb();
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
  const db = seedTestDb();
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
  const db = seedTestDb();
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
    db: seedTestDb(),
  });
  assert.equal(response.result.payload[0].sdi12_value_count, 5,
    'GET /api/devices must return the learned sdi12_value_count, not silently drop it');
  assert.equal(response.result.payload[0].sdi12_channel_layout_json.sensors[0].channel, 10);
  assert.equal(response.result.payload[0].sdi12_layout_status, 'configured');
  assert.equal(response.result.payload[0].latest_data.vwc_10, 27.5);
  assert.equal(response.result.payload[0].latest_data.soil_vic_10, 0.041);
});

test('B1: GET /api/devices latest-data SQL includes all Sentek columns and prepares successfully', async () => {
  const db = seedTestDb();
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
    db: seedTestDb(),
  });
  assert.equal(response.result.payload[0].sdi12_channel_layout_json, null);
  assert.equal(response.result.payload[0].sdi12_layout_status, 'invalid');
});

test('B2 (Fable A6 review SHOULD-FIX 2): PUT /sdi12/config nulls a stale value_count when switching to a fixed-shape profile', async () => {
  const db = seedTestDb();
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
  const db = seedTestDb();
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
    assert.equal(response.result.payload.layout_status, 'configured');
  } finally { db.close(); }
});

test('Sentek layout save rejects mixed legacy fields and invalid duplicate positions without writing', async () => {
  const db = seedTestDb();
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

test('recipe auth routes empty Apply/Rollback bodies and rejects bodies on the wrong action', async () => {
  const db = seedTestDb();
  const deveui = 'A840410000000131';
  const authHeader = makeAuthHeader({ userId: 1, username: 'admin1' });
  const env = {
    OSI_SCOPED_ACCESS: '0',
    AUTH_TOKEN_SECRET: 'scoped-access-test-secret',
  };
  const run = (suffix, method, body) => executeFunction(loadNode('sdi12-config-auth-fn'), {
    msg: {
      req: {
        method,
        path: `/api/devices/${deveui}${suffix}`,
        params: { deveui },
        headers: { authorization: authHeader },
        body,
      },
    },
    env,
    db,
  });
  try {
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at)
      VALUES ('${deveui}', 'Recipe auth', 'DRAGINO_SDI12', 1, '2026-01-01', '2026-01-01')
    `);

    const apply = await run('/sdi12/recipe/apply', 'POST', {});
    assert.equal(apply.result.length, 4);
    assert.equal(apply.result[0], null);
    assert.equal(apply.result[1].deviceRow.deveui, deveui);
    assert.equal(apply.result[2], null);
    assert.equal(apply.result[3], null);

    const rollback = await run('/sdi12/recipe/rollback', 'POST', null);
    assert.equal(rollback.result[2].deviceRow.deveui, deveui);

    const applyWithInput = await run('/sdi12/recipe/apply', 'POST', { recipe: 'browser bytes' });
    assert.equal(applyWithInput.result[3].statusCode, 400);

    const emptySave = await run('/sdi12/config', 'PUT', {});
    assert.equal(emptySave.result[3].statusCode, 400);

    const save = await run('/sdi12/config', 'PUT', { probe_profile: 'HYDRASCOUT' });
    assert.equal(save.result[0].deviceRow.deveui, deveui);
  } finally {
    db.close();
  }
});

test('recipe auth uses stable 400/401/404/409/500 mappings before any deployment action', async () => {
  const db = seedTestDb();
  const ownedSdi12 = 'A840410000000132';
  const inaccessibleSdi12 = 'A840410000000133';
  const wrongType = 'A840410000000134';
  const validAuth = makeAuthHeader({ userId: 1, username: 'admin1' });
  const env = {
    OSI_SCOPED_ACCESS: '0',
    AUTH_TOKEN_SECRET: 'scoped-access-test-secret',
  };
  const run = (deveui, authorization, globals) => executeFunction(loadNode('sdi12-config-auth-fn'), {
    msg: {
      req: {
        method: 'POST',
        path: `/api/devices/${deveui}/sdi12/recipe/apply`,
        params: { deveui },
        headers: authorization ? { authorization } : {},
        body: {},
      },
    },
    env,
    db,
    globals,
  });
  try {
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES
        ('${ownedSdi12}', 'Owned SDI-12', 'DRAGINO_SDI12', 1, '2026-01-01', '2026-01-01'),
        ('${inaccessibleSdi12}', 'Other SDI-12', 'DRAGINO_SDI12', 2, '2026-01-01', '2026-01-01'),
        ('${wrongType}', 'Owned LSN50', 'DRAGINO_LSN50', 1, '2026-01-01', '2026-01-01')
    `);

    const invalid = await run('bad-eui', validAuth);
    assert.equal(invalid.result[3].statusCode, 400);

    const unauthorized = await run(ownedSdi12, null);
    assert.equal(unauthorized.result[3].statusCode, 401);

    const inaccessible = await run(inaccessibleSdi12, validAuth);
    assert.equal(inaccessible.result[1], null, 'inaccessible EUI must not reach Apply');
    assert.equal(inaccessible.result[2], null, 'inaccessible EUI must not reach Rollback');
    assert.equal(inaccessible.result[3].statusCode, 404);

    const wrong = await run(wrongType, validAuth);
    assert.equal(wrong.result[3].statusCode, 409);

    const unavailableSecret = await executeFunction(loadNode('sdi12-config-auth-fn'), {
      msg: {
        req: {
          method: 'POST',
          path: `/api/devices/${ownedSdi12}/sdi12/recipe/apply`,
          params: { deveui: ownedSdi12 },
          headers: { authorization: 'Bearer a.b' },
          body: {},
        },
      },
      env: { OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: '', JWT_SECRET: '' },
      db,
      globals: {
        fs: {
          readFileSync: () => { throw new Error('unavailable'); },
          writeFileSync: () => { throw new Error('unavailable'); },
        },
      },
    });
    assert.equal(unavailableSecret.result[3].statusCode, 500);
  } finally {
    db.close();
  }
});

// Not ported: 'scoped recipe route denies a viewer with 403 before device lookup'
// drives AgroLink's scoped-device-config-guard (a 28-output scoped-access fan-out)
// with OSI_SCOPED_ACCESS=1 and a viewer-role token. This line has no scoped-access
// schema -- no users.role, no guard node -- so the test has no subject here. The
// recipe routes' authentication is covered instead by test-sdi12-recipe-flow.js,
// which pins that sdi12-recipe-{apply,rollback}-action-fn are reachable only
// through the authenticating sdi12-config-auth-fn.

test('manual Sentek layout save cancels discovery and states that hardware is not applied', async () => {
  const db = seedTestDb();
  const deveui = 'A840410000000136';
  try {
    db.exec(`
      INSERT INTO devices (
        deveui, name, type_id, user_id, sdi12_probe_profile, created_at, updated_at
      ) VALUES (
        '${deveui}', 'Manual layout', 'DRAGINO_SDI12', 1,
        'SENTEK_ENVIROSCAN', '2026-01-01', '2026-01-01'
      );
      INSERT INTO sdi12_identify_attempts (
        deveui, stage, discovered_address, requested_at, updated_at
      ) VALUES (
        '${deveui}', 'discovering', NULL,
        '2026-08-29T10:00:00.000Z', '2026-08-29T10:00:00.000Z'
      );
    `);
    const response = await executeFunction(loadNode('sdi12-config-action-fn'), {
      msg: {
        req: {
          body: {
            probe_profile: 'SENTEK_ENVIROSCAN',
            address: 'C',
            sensors: [
              { channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' },
            ],
          },
        },
        deviceRow: { deveui },
      },
      env: ENV,
      db,
    });
    assert.equal(response.result.statusCode, undefined, JSON.stringify(response.result.payload));
    assert.equal(response.result.payload.message, 'Layout saved; acquisition configuration not applied.');
    assert.equal(response.result.payload.deployment_status, 'not_applied');
    assert.equal(
      db.prepare('SELECT 1 FROM sdi12_identify_attempts WHERE deveui = ?').get(deveui),
      undefined
    );
  } finally {
    db.close();
  }
});
