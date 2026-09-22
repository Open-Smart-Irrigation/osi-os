#!/usr/bin/env node
'use strict';

// The name rule on the four create paths (spec 5.1 and the 5.3 table):
// post-zone-auth, scoped-zone-create-router, post-devices-auth and
// cs-reg-cloud-fn. Each runs the shipped function-node source.
//
// Run: node --test scripts/test-entity-name-create-paths.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

// scoped-zone-create-router calls osiLib.require('scope') before it ever
// reaches the entity-name seam, so a test that fakes an unloadable
// entity-name module for that node must still hand it a real scope module
// (this is the SAME real module scripts/test-scoped-access-writes.js and
// friends require directly for the same reason).
const REAL_SCOPE_MODULE = require(path.join(
  __dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper'
));

const AUTH_SECRET = 'entity-name-create-paths-test-secret';
const FLAG_OFF = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
const FLAG_ON = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1', DEVICE_EUI: '0016C001F11715E2' };
const OWNER = { userId: 2, username: 'res1' };
const BAD_NAMES = [
  ['empty', '', 'name_empty'],
  ['blank', '   ', 'name_empty'],
  ['tab', 'Row\t7', 'name_control_characters'],
  ['next line', '\u0085North', 'name_control_characters'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['lone high surrogate', '\ud83c', 'name_invalid_unicode'],
];

function token() {
  return makeAuthHeader({ userId: OWNER.userId, username: OWNER.username, secret: AUTH_SECRET });
}

async function callZoneAuth(db, name) {
  return executeFunction(loadNode('post-zone-auth'), {
    msg: {
      req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name } },
      payload: { name },
    },
    env: FLAG_OFF,
    db,
  });
}

async function callScopedZoneCreate(db, name) {
  return executeFunction(loadNode('scoped-zone-create-router'), {
    msg: {
      req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name } },
      payload: { name },
    },
    env: FLAG_ON,
    db,
  });
}

async function callDeviceAuth(db, name) {
  const body = { deveui: '70B3D57ED0061234', name, type_id: 'KIWI_SENSOR', appkey: 'A'.repeat(32) };
  return executeFunction(loadNode('post-devices-auth'), {
    msg: {
      req: { method: 'POST', path: '/api/devices', headers: { authorization: token() }, params: {}, body },
      payload: body,
    },
    env: FLAG_OFF,
    db,
  });
}

test('zone create trims and stores the normalized name', async () => {
  const db = seedScopedDb();
  try {
    const run = await callZoneAuth(db, '\ufeffNorth');
    assert.equal(run.result[1], null, JSON.stringify(run.result[1] && run.result[1].payload));
    assert.equal(run.flowState.new_zone_name, 'North');
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of BAD_NAMES) {
  test('zone create refuses a ' + label + ' name with reason ' + reason, async () => {
    const db = seedScopedDb();
    try {
      const run = await callZoneAuth(db, value);
      assert.equal(run.result[0], null);
      assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
      assert.equal(run.result[1].payload.reason, reason);
      assert.equal(run.flowState.new_zone_name, undefined);
    } finally {
      db.close();
    }
  });
}

test('scoped zone create stores the normalized name on the new row', async () => {
  const db = seedScopedDb();
  try {
    const run = await callScopedZoneCreate(db, '  North block \n');
    assert.equal(run.result[1].statusCode, 201, JSON.stringify(run.result[1].payload));
    assert.equal(run.result[1].payload.name, 'North block');
    const row = db.prepare("SELECT name FROM irrigation_zones WHERE zone_uuid = ?").get(run.result[1].payload.zone_uuid);
    assert.equal(row.name, 'North block');
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of BAD_NAMES) {
  test('scoped zone create refuses a ' + label + ' name with reason ' + reason, async () => {
    const db = seedScopedDb();
    const before = db.prepare('SELECT count(*) n FROM irrigation_zones').get().n;
    try {
      const run = await callScopedZoneCreate(db, value);
      assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
      assert.equal(run.result[1].payload.reason, reason);
      assert.equal(db.prepare('SELECT count(*) n FROM irrigation_zones').get().n, before);
    } finally {
      db.close();
    }
  });
}

test('device create stores the normalized name', async () => {
  const db = seedScopedDb();
  try {
    const run = await callDeviceAuth(db, '\u2028North\u2029');
    assert.equal(run.result[1], null, JSON.stringify(run.result[1] && run.result[1].payload));
    assert.equal(run.flowState.new_device_name, 'North');
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of BAD_NAMES) {
  test('device create refuses a ' + label + ' name with reason ' + reason, async () => {
    const db = seedScopedDb();
    try {
      const run = await callDeviceAuth(db, value);
      assert.equal(run.result[0], null);
      assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
      // An empty or blank name is still caught first by the required-field check,
      // which answers 400 without a reason code; every other violation carries one.
      if (reason !== 'name_empty') assert.equal(run.result[1].payload.reason, reason);
      assert.equal(run.flowState.new_device_name, undefined);
    } finally {
      db.close();
    }
  });
}

test('REGISTER_DEVICE keeps a valid name and never loses the registration to a bad one', () => {
  const node = loadNode('cs-reg-cloud-fn');
  assert.deepEqual(
    node.libs,
    [
      { var: 'osiDb', module: 'osi-db-helper' },
      { var: 'chirpstack', module: 'osi-chirpstack-helper' },
      { var: 'osiLib', module: 'osi-lib' },
    ],
    'cs-reg-cloud-fn must bind the osi-lib seam to reach the entity-name helper'
  );
  assert.match(node.func, /var name = String\(devEui \|\| 'Device'\);/);
  assert.match(node.func, /nameLoad\.value\.normalizeEntityName\(params\.name\)/);
  assert.match(node.func, /using the DevEUI as the label/);
  // The fallback must be a warn, never a return: a bad label cannot fail a
  // registration (spec 5.3).
  const branch = node.func.slice(node.func.indexOf("if (commandType !== 'REGISTER_DEVICE')"), node.func.indexOf("const _db = new osiDb.Database"));
  assert.doesNotMatch(branch, /return \[buildAck\('FAILED'[^)]*name/i);
});

// T4-W1 (controller ruling, corrected -- not in this task's brief): the
// ORIGINAL cs-reg-cloud-fn provisions ChirpStack FIRST and writes the device
// row only after provisioning succeeds; that order stays (a rejected
// registration must leave no device row behind -- test (c) below). The name
// handed to ChirpStack is decided BEFORE provisioning, from the row the
// write is about to produce: with scoped access off, cs-reg-cloud-fn writes
// with INSERT OR IGNORE, so an EXISTING row's stored name survives the
// write untouched, and ChirpStack must receive THAT name, never the
// command's, per spec 5.5 ("ChirpStack must not run ahead of the
// database").
test('T4-W1(a): REGISTER_DEVICE with scoped access off sends ChirpStack the name stored in devices, not the command name', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`
      INSERT INTO devices (
        deveui, name, type_id, user_id, created_at, updated_at
      ) VALUES ('70B3D57ED0069999', 'Stored label', 'KIWI_SENSOR', 2, '2026-01-01', '2026-01-01');
    `);
    let capturedRegistration = null;
    const chirpstack = {
      createProvisioningClientFromEnv: () => ({
        ensureDeviceProvisioned: async (registration) => {
          capturedRegistration = registration;
          return { devEui: registration.devEui, deviceCreated: false };
        },
        deleteDevice: async () => {},
      }),
    };
    const env = {
      OSI_SCOPED_ACCESS: '0',
      DEVICE_EUI: '0016C001F11715E2',
      CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid',
      CHIRPSTACK_PROFILE_KIWI: 'profile-kiwi-uuid',
    };
    const payload = {
      commandType: 'REGISTER_DEVICE',
      commandId: 'cmd-t4w1',
      params: {
        devEui: '70B3D57ED0069999',
        name: 'Command label',
        deviceType: 'KIWI_SENSOR',
        appKey: 'A'.repeat(32),
        userUuid: 'u-res1',
      },
    };
    const run = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify(payload) },
      env,
      db,
      libOverrides: { chirpstack },
    });
    assert.equal(run.result[0].specialAck.result, 'SUCCESS', JSON.stringify(run.result[0] && run.result[0].specialAck));
    assert.ok(capturedRegistration, 'ensureDeviceProvisioned must have been called');
    assert.equal(capturedRegistration.name, 'Stored label');
    // The row itself keeps its stored name too: INSERT OR IGNORE never overwrote it.
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui = ?').get('70B3D57ED0069999').name, 'Stored label');
  } finally {
    db.close();
  }
});

test('T4-W1(b): REGISTER_DEVICE with scoped access on updates an allowed existing row and sends ChirpStack the command name', async () => {
  const db = seedScopedDb();
  try {
    // Owned by user_id 2 (u-res1, the claimant below) so the cross-owner
    // claim fence -- which runs in BOTH flag modes -- does not trip.
    db.exec(`
      INSERT INTO devices (
        deveui, name, type_id, user_id, created_at, updated_at
      ) VALUES ('70B3D57ED006BBBB', 'Stored label', 'KIWI_SENSOR', 2, '2026-01-01', '2026-01-01');
    `);
    let capturedRegistration = null;
    const chirpstack = {
      createProvisioningClientFromEnv: () => ({
        ensureDeviceProvisioned: async (registration) => {
          capturedRegistration = registration;
          return { devEui: registration.devEui, deviceCreated: false };
        },
        deleteDevice: async () => {},
      }),
    };
    const env = {
      OSI_SCOPED_ACCESS: '1',
      DEVICE_EUI: '0016C001F11715E2',
      CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid',
      CHIRPSTACK_PROFILE_KIWI: 'profile-kiwi-uuid',
    };
    const payload = {
      commandType: 'REGISTER_DEVICE',
      commandId: 'cmd-t4w1b',
      params: {
        devEui: '70B3D57ED006BBBB',
        name: 'Command label',
        deviceType: 'KIWI_SENSOR',
        appKey: 'C'.repeat(32),
        userUuid: 'u-res1',
      },
    };
    const run = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify(payload) },
      env,
      db,
      libOverrides: { chirpstack },
    });
    assert.equal(run.result[0].specialAck.result, 'SUCCESS', JSON.stringify(run.result[0] && run.result[0].specialAck));
    assert.ok(capturedRegistration, 'ensureDeviceProvisioned must have been called');
    assert.equal(capturedRegistration.name, 'Command label');
    // The UPDATE branch (existing && scopedOn) actually rewrites the name,
    // so the row and the ChirpStack registration must agree on it.
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui = ?').get('70B3D57ED006BBBB').name, 'Command label');
  } finally {
    db.close();
  }
});

// T4-W1(c) regression: the ORIGINAL order (ChirpStack before the device-row
// write) must survive this fix. A ChirpStack rejection for a brand-new
// device (no existing row) must leave NO row behind and answer the node's
// own FAILED shape -- a device must never sync to the cloud for hardware
// the network server refused to provision.
test('T4-W1(c): a ChirpStack rejection for a brand-new device leaves no device row behind', async () => {
  const db = seedScopedDb();
  try {
    const chirpstack = {
      createProvisioningClientFromEnv: () => ({
        ensureDeviceProvisioned: async () => {
          throw new Error('injected ChirpStack rejection');
        },
        deleteDevice: async () => {},
      }),
    };
    const env = {
      OSI_SCOPED_ACCESS: '0',
      DEVICE_EUI: '0016C001F11715E2',
      CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid',
      CHIRPSTACK_PROFILE_KIWI: 'profile-kiwi-uuid',
    };
    const devEui = '70B3D57ED006CCCC';
    const payload = {
      commandType: 'REGISTER_DEVICE',
      commandId: 'cmd-t4w1c',
      params: {
        devEui,
        name: 'New device',
        deviceType: 'KIWI_SENSOR',
        appKey: 'D'.repeat(32),
        userUuid: 'u-res1',
      },
    };
    const run = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify(payload) },
      env,
      db,
      libOverrides: { chirpstack },
    });
    assert.equal(run.result[0].specialAck.result, 'FAILED', JSON.stringify(run.result[0] && run.result[0].specialAck));
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM devices WHERE deveui = ?').get(devEui).n,
      0,
      'ChirpStack must be asked before any device row is written'
    );
  } finally {
    db.close();
  }
});

test('T4-W1: a rule-breaking command name still falls back to the DevEUI and never fails the registration', async () => {
  const db = seedScopedDb();
  try {
    let capturedRegistration = null;
    const chirpstack = {
      createProvisioningClientFromEnv: () => ({
        ensureDeviceProvisioned: async (registration) => {
          capturedRegistration = registration;
          return { devEui: registration.devEui, deviceCreated: true };
        },
        deleteDevice: async () => {},
      }),
    };
    const env = {
      OSI_SCOPED_ACCESS: '0',
      DEVICE_EUI: '0016C001F11715E2',
      CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid',
      CHIRPSTACK_PROFILE_KIWI: 'profile-kiwi-uuid',
    };
    const payload = {
      commandType: 'REGISTER_DEVICE',
      commandId: 'cmd-t4w1-bad-name',
      params: {
        devEui: '70B3D57ED006AAAA',
        name: 'Row\t7',
        deviceType: 'KIWI_SENSOR',
        appKey: 'B'.repeat(32),
        userUuid: 'u-res1',
      },
    };
    const run = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify(payload) },
      env,
      db,
      libOverrides: { chirpstack },
    });
    assert.equal(run.result[0].specialAck.result, 'SUCCESS', JSON.stringify(run.result[0] && run.result[0].specialAck));
    assert.equal(capturedRegistration.name, '70B3D57ED006AAAA');
    assert.equal(db.prepare('SELECT name FROM devices WHERE deveui = ?').get('70B3D57ED006AAAA').name, '70B3D57ED006AAAA');
  } finally {
    db.close();
  }
});

// --- Final fix wave / M3: a REGISTER_DEVICE that carries no name at all is
// the normal legacy shape, not an operator mistake. Running it through
// normalizeEntityName made it throw name_empty, so every nameless
// registration logged a warning and buried the one that matters: a name that
// WAS supplied and broke the rule. The fallback label is unchanged either way.

function registerDeviceEnv() {
  return {
    OSI_SCOPED_ACCESS: '0',
    DEVICE_EUI: '0016C001F11715E2',
    CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid',
    CHIRPSTACK_PROFILE_KIWI: 'profile-kiwi-uuid',
  };
}

async function runRegisterDevice(db, { devEui, params, commandId }) {
  const box = {};
  const chirpstack = {
    createProvisioningClientFromEnv: () => ({
      ensureDeviceProvisioned: async (registration) => {
        box.registration = registration;
        return { devEui: registration.devEui, deviceCreated: true };
      },
      deleteDevice: async () => {},
    }),
  };
  const run = await executeFunction(loadNode('cs-reg-cloud-fn'), {
    msg: {
      payload: JSON.stringify({
        commandType: 'REGISTER_DEVICE',
        commandId,
        params: Object.assign({
          devEui,
          deviceType: 'KIWI_SENSOR',
          appKey: 'E'.repeat(32),
          userUuid: 'u-res1',
        }, params),
      }),
    },
    env: registerDeviceEnv(),
    db,
    libOverrides: { chirpstack },
  });
  return { run, registration: box.registration };
}

for (const [label, devEui, params] of [
  ['omits the name key', '70B3D57ED006D001', {}],
  ['sends name: null', '70B3D57ED006D002', { name: null }],
]) {
  test('M3: a REGISTER_DEVICE that ' + label + ' provisions without a warning', async () => {
    const db = seedScopedDb();
    try {
      const { run, registration } = await runRegisterDevice(db, {
        devEui,
        params,
        commandId: 'cmd-m3-' + devEui,
      });
      assert.equal(run.result[0].specialAck.result, 'SUCCESS', JSON.stringify(run.result[0] && run.result[0].specialAck));
      assert.deepEqual(run.warnings, [], 'a nameless REGISTER_DEVICE is the legacy norm, not a fault');
      assert.equal(registration.name, devEui, 'the DevEUI is still the label');
      assert.equal(db.prepare('SELECT name FROM devices WHERE deveui = ?').get(devEui).name, devEui);
    } finally {
      db.close();
    }
  });
}

test('M3: a supplied name that breaks the rule still warns with its reason code', async () => {
  const db = seedScopedDb();
  const devEui = '70B3D57ED006D003';
  try {
    const { run, registration } = await runRegisterDevice(db, {
      devEui,
      params: { name: 'Row\t7' },
      commandId: 'cmd-m3-bad',
    });
    assert.equal(run.result[0].specialAck.result, 'SUCCESS', JSON.stringify(run.result[0] && run.result[0].specialAck));
    assert.ok(
      run.warnings.some((warning) => /name_control_characters/.test(warning)),
      JSON.stringify(run.warnings)
    );
    assert.equal(registration.name, devEui);
  } finally {
    db.close();
  }
});

// --- Fix round 1 (reviewer findings I1/I2 on the three HTTP nodes; T9-M4) -
//
// I1: normalizeEntityName is only ever documented to throw one of the four
// reviewed reason codes (osi-entity-name/index.js). A throw with any other
// (or no) .code is a server-side fault, not a bad request, and must answer
// 500 with an English message and no `reason` key -- the same shape
// zone-rename-fn/device-rename-fn already carry (T6-M3 precedent below).
//
// I2: node.error(text, msg) in a handler that answers msg.res itself races
// the tab-wide catch node (device-api-catch -> device-api-http500), which
// would also try to answer the same msg.res with the raw internal error
// text. The harness's node.error stub ignores a second argument, so these
// tests cannot catch a reintroduced `, msg` by themselves -- that pin lives
// in scripts/verify-sync-flow.js. What these tests DO prove: the response
// payload never carries anything beyond the node's own English message.

function entityNameThrowsCodeless() {
  return {
    normalizeEntityName: () => { throw new Error('unexpected internal failure'); }, // no .code at all
  };
}

// A name-aware osiLib stub: real scope (scoped-zone-create-router needs it
// to get past its own guard before ever reaching the name seam), faked
// entity-name failure.
function entityNameUnavailableOsiLib() {
  return {
    require: (name) => {
      if (name === 'entity-name') return { ok: false, error: 'entity-name module unavailable (test)' };
      if (name === 'scope') return { ok: true, value: REAL_SCOPE_MODULE };
      return { ok: false, error: 'unexpected osiLib.require: ' + name };
    },
  };
}

test('F1(a): post-zone-auth answers 500 with no reason key when normalizeEntityName throws without a .code', async () => {
  const db = seedScopedDb();
  try {
    const run = await executeFunction(loadNode('post-zone-auth'), {
      msg: {
        req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name: 'Anything' } },
        payload: { name: 'Anything' },
      },
      env: FLAG_OFF,
      db,
      osiLibModules: { 'entity-name': entityNameThrowsCodeless() },
    });
    assert.equal(run.result[0], null);
    assert.equal(run.result[1].statusCode, 500, JSON.stringify(run.result[1].payload));
    assert.equal(typeof run.result[1].payload.message, 'string');
    assert.equal('reason' in run.result[1].payload, false, 'a 500 must not carry a name-validation reason code');
    assert.equal(run.flowState.new_zone_name, undefined);
  } finally {
    db.close();
  }
});

test('F1(a): post-devices-auth answers 500 with no reason key when normalizeEntityName throws without a .code', async () => {
  const db = seedScopedDb();
  try {
    const body = { deveui: '70B3D57ED0061234', name: 'Anything', type_id: 'KIWI_SENSOR', appkey: 'A'.repeat(32) };
    const run = await executeFunction(loadNode('post-devices-auth'), {
      msg: {
        req: { method: 'POST', path: '/api/devices', headers: { authorization: token() }, params: {}, body },
        payload: body,
      },
      env: FLAG_OFF,
      db,
      osiLibModules: { 'entity-name': entityNameThrowsCodeless() },
    });
    assert.equal(run.result[0], null);
    assert.equal(run.result[1].statusCode, 500, JSON.stringify(run.result[1].payload));
    assert.equal(typeof run.result[1].payload.message, 'string');
    assert.equal('reason' in run.result[1].payload, false, 'a 500 must not carry a name-validation reason code');
    assert.equal(run.flowState.new_device_name, undefined);
  } finally {
    db.close();
  }
});

test('F1(a): scoped-zone-create-router answers 500 with no reason key when normalizeEntityName throws without a .code', async () => {
  const db = seedScopedDb();
  const before = db.prepare('SELECT count(*) n FROM irrigation_zones').get().n;
  try {
    const run = await executeFunction(loadNode('scoped-zone-create-router'), {
      msg: {
        req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name: 'Anything' } },
        payload: { name: 'Anything' },
      },
      env: FLAG_ON,
      db,
      osiLibModules: { 'entity-name': entityNameThrowsCodeless() },
    });
    assert.equal(run.result[1].statusCode, 500, JSON.stringify(run.result[1].payload));
    assert.equal(typeof run.result[1].payload.message, 'string');
    assert.equal('reason' in run.result[1].payload, false, 'a 500 must not carry a name-validation reason code');
    assert.equal(db.prepare('SELECT count(*) n FROM irrigation_zones').get().n, before);
  } finally {
    db.close();
  }
});

test('F1(b): post-zone-auth answers 500 with no internal text when the entity-name helper cannot be loaded', async () => {
  const db = seedScopedDb();
  try {
    const run = await executeFunction(loadNode('post-zone-auth'), {
      msg: {
        req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name: 'Anything' } },
        payload: { name: 'Anything' },
      },
      env: FLAG_OFF,
      db,
      libOverrides: { osiLib: entityNameUnavailableOsiLib() },
    });
    assert.equal(run.result[0], null);
    assert.equal(run.result[1].statusCode, 500, JSON.stringify(run.result[1].payload));
    assert.equal(run.result[1].payload.message, 'Entity name helper unavailable');
    assert.doesNotMatch(run.result[1].payload.message, /unavailable \(test\)/, 'the response must never carry the internal osiLib.require error text');
    assert.equal(run.flowState.new_zone_name, undefined);
  } finally {
    db.close();
  }
});

test('F1(b): post-devices-auth answers 500 with no internal text when the entity-name helper cannot be loaded', async () => {
  const db = seedScopedDb();
  try {
    const body = { deveui: '70B3D57ED0061234', name: 'Anything', type_id: 'KIWI_SENSOR', appkey: 'A'.repeat(32) };
    const run = await executeFunction(loadNode('post-devices-auth'), {
      msg: {
        req: { method: 'POST', path: '/api/devices', headers: { authorization: token() }, params: {}, body },
        payload: body,
      },
      env: FLAG_OFF,
      db,
      libOverrides: { osiLib: entityNameUnavailableOsiLib() },
    });
    assert.equal(run.result[0], null);
    assert.equal(run.result[1].statusCode, 500, JSON.stringify(run.result[1].payload));
    assert.equal(run.result[1].payload.message, 'Entity name helper unavailable');
    assert.doesNotMatch(run.result[1].payload.message, /unavailable \(test\)/, 'the response must never carry the internal osiLib.require error text');
    assert.equal(run.flowState.new_device_name, undefined);
  } finally {
    db.close();
  }
});

test('F1(b): scoped-zone-create-router answers 500 with no internal text when the entity-name helper cannot be loaded', async () => {
  const db = seedScopedDb();
  const before = db.prepare('SELECT count(*) n FROM irrigation_zones').get().n;
  try {
    const run = await executeFunction(loadNode('scoped-zone-create-router'), {
      msg: {
        req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name: 'Anything' } },
        payload: { name: 'Anything' },
      },
      env: FLAG_ON,
      db,
      libOverrides: { osiLib: entityNameUnavailableOsiLib() },
    });
    assert.equal(run.result[1].statusCode, 500, JSON.stringify(run.result[1].payload));
    assert.equal(run.result[1].payload.message, 'Entity name helper unavailable');
    assert.doesNotMatch(run.result[1].payload.message, /unavailable \(test\)/, 'the response must never carry the internal osiLib.require error text');
    assert.equal(db.prepare('SELECT count(*) n FROM irrigation_zones').get().n, before);
  } finally {
    db.close();
  }
});

test('T9-M4: post-zone-auth answers "Zone name is required" with reason name_empty for an empty name', async () => {
  const db = seedScopedDb();
  try {
    const run = await callZoneAuth(db, '');
    assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
    assert.equal(run.result[1].payload.message, 'Zone name is required');
    assert.equal(run.result[1].payload.reason, 'name_empty');
  } finally {
    db.close();
  }
});

test('T9-M4: scoped-zone-create-router answers "Zone name is required" with reason name_empty for an empty name', async () => {
  const db = seedScopedDb();
  try {
    const run = await callScopedZoneCreate(db, '');
    assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
    assert.equal(run.result[1].payload.message, 'Zone name is required');
    assert.equal(run.result[1].payload.reason, 'name_empty');
  } finally {
    db.close();
  }
});
