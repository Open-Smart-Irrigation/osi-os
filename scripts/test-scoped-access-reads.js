#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  executeFunction,
  facadeDb,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');
const journalApi = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal'
);
const scopeHelper = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper'
);

const AUTH_SECRET = 'scoped-access-test-secret';
const ENV = {
  AUTH_TOKEN_SECRET: AUTH_SECRET,
  OSI_SCOPED_ACCESS: '1',
};

function requestFor(userId, username, params = {}) {
  return {
    req: {
      headers: {
        authorization: makeAuthHeader({
          userId,
          username,
          secret: AUTH_SECRET,
        }),
      },
      params,
      query: {},
    },
    payload: {},
  };
}

function seedReusedUsername(db) {
  db.exec(`
    UPDATE users SET username = 'res1-renamed' WHERE id = 2;
    INSERT INTO users (
      username, password_hash, created_at, user_uuid, role, sync_version
    ) VALUES (
      'res1', 'h', '2026-07-29', 'u-reused-name', 'researcher', 1
    );
    INSERT INTO user_zone_assignments (
      assignment_uuid, user_uuid, zone_uuid, created_at
    ) VALUES (
      'g-reused-name', 'u-reused-name', 'z-1', '2026-07-29'
    );
  `);
}

test('immutable token subject prevents /api/me from following a reused username', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  seedReusedUsername(db);
  try {
    const authResult = await executeFunction(loadNode('api-me-auth'), {
      msg: requestFor(2, 'res1'),
      env: ENV,
      db,
    });
    assert.equal(authResult.result.authUserId, 2);
    assert.equal(authResult.result.authUsername, 'res1');

    const response = await executeFunction(loadNode('api-me-fn'), {
      msg: authResult.result,
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 403);
  } finally {
    db.close();
  }
});

test('immutable token subject blocks username reuse across scoped shared reads', async () => {
  const cases = [
    ['zone environment', 'zone-env-fn', { zone_id: '1' }],
    ['dendrometer recommendations', 'dendro-zone-rec-fn', { zone_id: '1' }],
    ['device history', 'dendro-daily-fn', { deveui: 'DENDRO1' }],
    ['today liters', 'strega-today-liters-fn', { deveui: 'VALVE1' }],
  ];
  for (const [label, nodeId, params] of cases) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    seedReusedUsername(db);
    try {
      const response = await executeFunction(loadNode(nodeId), {
        msg: requestFor(2, 'res1', params),
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        403,
        `${label} must reject a stale subject/name pair`
      );
    } finally {
      db.close();
    }
  }
});

test('immutable token subject blocks username reuse in sensor export and history', async () => {
  for (const [label, nodeId, msg] of [
    ['sensor export', 'fn_build_sensor_sql_params', requestFor(2, 'res1')],
    [
      'history',
      'history-api-router-fn',
      historyRequest(2, 'res1', 'GET', '/api/history/zones/1/cards', { zoneId: '1' }),
    ],
  ]) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    seedReusedUsername(db);
    try {
      const response = await executeFunction(loadNode(nodeId), {
        msg,
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        403,
        `${label} must reject a stale subject/name pair`
      );
    } finally {
      db.close();
    }
  }
});

test('F2: every enabled role reads any zone environment summary', async () => {
  const node = loadNode('zone-env-fn');
  for (const [userId, username] of [[1, 'admin1'], [2, 'res1'], [3, 'view1']]) {
    for (const zoneId of ['1', '2']) {
      scopeHelper._resetForTests();
      const db = seedScopedDb();
      try {
        const response = await executeFunction(node, {
          msg: requestFor(userId, username, { zone_id: zoneId }),
          env: ENV,
          db,
        });
        assert.equal(
          response.result && response.result.statusCode,
          200,
          `${username} must read zone ${zoneId}`
        );
      } finally {
        db.close();
      }
    }
  }
});

test('F2: recommendations are account-wide and a disabled account is refused', async () => {
  const node = loadNode('dendro-zone-rec-fn');
  const db = seedScopedDb();
  try {
    const viewer = await executeFunction(node, {
      msg: requestFor(3, 'view1', { zone_id: '2' }),
      env: ENV,
      db,
    });
    assert.equal(viewer.result && viewer.result.statusCode, 200);
    assert.equal(viewer.result.payload.length, 1);
  } finally {
    db.close();
  }

  scopeHelper._resetForTests();
  const disabledDb = seedScopedDb();
  disabledDb.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  try {
    const disabled = await executeFunction(node, {
      msg: requestFor(3, 'view1', { zone_id: '2' }),
      env: ENV,
      db: disabledDb,
    });
    assert.equal(disabled.result && disabled.result.statusCode, 403);
  } finally {
    disabledDb.close();
    scopeHelper._resetForTests();
  }
});

test('F2: a missing zone is still 404 for everyone', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('zone-env-fn'), {
      msg: requestFor(1, 'admin1', { zone_id: '999' }),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 404);
  } finally {
    db.close();
  }
});

async function zoneList(db, userId, env = ENV) {
  const response = await executeFunction(loadNode('get-zones-query'), {
    msg: {
      payload: [{ id: userId }],
      authUserId: userId,
    },
    env,
    db,
  });
  return (response.result && response.result[0] && response.result[0].payload) || [];
}

async function deviceList(db, userId, env = ENV) {
  const response = await executeFunction(loadNode('get-devices-query'), {
    msg: {
      payload: [{ id: userId }],
      authUserId: userId,
    },
    env,
    db,
  });
  const output = response.result && response.result[0];
  return output ? db.prepare(output.topic).all() : [];
}

function seedUnassignedDevice(db) {
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('UNASSIGNED1', 'Fresh LSN50', 'DRAGINO_LSN50', 1, NULL, '2026-01-01', '2026-01-01');
  `);
}

function seedUnclaimedDevice(db) {
  // What DELETE /api/devices/:deveui leaves behind: user_id NULL, no tombstone.
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('UNCLAIMED1', 'Deleted LSN50', 'DRAGINO_LSN50', NULL, NULL, '2026-01-01', '2026-01-01');
  `);
}

test('F1: every enabled role lists every zone and device on the gateway', async () => {
  const db = seedScopedDb();
  seedUnassignedDevice(db);
  try {
    for (const userId of [1, 2, 3]) {
      scopeHelper._resetForTests();
      assert.deepEqual(
        (await zoneList(db, userId)).map((row) => row.zone_uuid).sort(),
        ['z-1', 'z-2'],
        `user ${userId} must see every zone`
      );
      assert.deepEqual(
        (await deviceList(db, userId)).map((row) => row.deveui).sort(),
        ['DENDRO1', 'DENDRO2', 'UNASSIGNED1', 'VALVE1', 'WX1'],
        `user ${userId} must see every device, including the unassigned bucket`
      );
    }
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F1: an unclaimed device is out of the account-wide list for everyone', async () => {
  const db = seedScopedDb();
  seedUnclaimedDevice(db);
  try {
    for (const userId of [1, 2, 3]) {
      scopeHelper._resetForTests();
      const deveuis = (await deviceList(db, userId)).map((row) => row.deveui);
      assert.ok(
        !deveuis.includes('UNCLAIMED1'),
        `user ${userId} must not see an unclaimed device: delete unclaims rather than tombstoning, ` +
        'so d.user_id IS NOT NULL is the lifecycle filter that makes deletion visible'
      );
      assert.ok(deveuis.includes('DENDRO1'), `user ${userId} must still see claimed devices`);
    }
    assert.ok(
      db.prepare("SELECT deveui FROM devices WHERE deveui='UNCLAIMED1'").get(),
      'the row itself must survive — this is a list filter, not a delete'
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F1: a cloud-assigned device with no local owner is visible', async () => {
  const db = seedScopedDb();
  // What the REGISTER_DEVICE applier leaves behind: INSERT OR IGNORE keeps an
  // existing row's user_id, and a cloud-introduced row has none, while the
  // zoneUuid resolution assigns it. user_id IS NOT NULL alone hides it.
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('CLOUDONLY1', 'Cloud LSN50', 'DRAGINO_LSN50', NULL, 1, '2026-01-01', '2026-01-01');
  `);
  try {
    for (const userId of [1, 2, 3]) {
      scopeHelper._resetForTests();
      const deveuis = (await deviceList(db, userId)).map((row) => row.deveui);
      assert.ok(
        deveuis.includes('CLOUDONLY1'),
        `user ${userId} must see a zone-assigned device the cloud introduced`
      );
    }
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F1: flag-off list behavior remains owner-only', async () => {
  const db = seedScopedDb();
  const flagOff = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
  try {
    assert.deepEqual(
      (await zoneList(db, 2, flagOff)).map((row) => row.zone_uuid),
      ['z-1']
    );
    assert.deepEqual(
      (await deviceList(db, 2, flagOff)).map((row) => row.deveui).sort(),
      ['DENDRO1', 'VALVE1']
    );
  } finally {
    db.close();
  }
});

test('P1: a disabled account is denied on both list reads', async () => {
  for (const [label, nodeId, pick] of [
    ['devices', 'get-devices-query', (result) => result[1]],
    ['zones', 'get-zones-query', (result) => result[1]],
  ]) {
    const db = seedScopedDb();
    db.prepare(
      "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-res1'"
    ).run();
    scopeHelper._resetForTests();
    try {
      const response = await executeFunction(loadNode(nodeId), {
        msg: { payload: [{ id: 2 }], authUserId: 2 },
        env: ENV,
        db,
      });
      const denied = pick(response.result);
      assert.ok(denied, `${label}: a disabled account must be rejected, not served an empty list`);
      assert.equal(denied.statusCode, 403, `${label}: disabled account must get 403`);
      assert.equal(response.result[0], null, `${label}: no success output for a disabled account`);
    } finally {
      db.close();
      scopeHelper._resetForTests();
    }
  }
});

test('F3: every device-detail read is account-wide for every enabled role', async () => {
  const cases = [
    ['dendro daily', 'dendro-daily-fn', { deveui: 'DENDRO2' }],
    ['dendro raw', 'dendro-raw-fn', { deveui: 'DENDRO2' }],
    ['dendro history', 'dendro-history-fn', { deveui: 'DENDRO2' }],
    ['rain history', 'rain-history-fn', { deveui: 'DENDRO2' }],
    ['sensor history', 'sensor-history-fn', { deveui: 'DENDRO2' }],
    ['today liters', 'strega-today-liters-fn', { deveui: 'VALVE1' }],
    ['zone assignments', 's2120-zones-get-fn', { deveui: 'WX1' }],
  ];
  for (const [label, nodeId, params] of cases) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    try {
      const msg = requestFor(3, 'view1', params);
      if (nodeId === 'sensor-history-fn') msg.req.query.field = 'swt_1';
      const response = await executeFunction(loadNode(nodeId), {
        msg,
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        200,
        `${label}: a viewer must read a device outside its write scope`
      );
    } finally {
      db.close();
    }
  }
});

test('P5: an unassigned device is readable, not a 404', async () => {
  for (const [label, nodeId] of [
    ['sensor history', 'sensor-history-fn'],
    ['dendro daily', 'dendro-daily-fn'],
    ['rain history', 'rain-history-fn'],
  ]) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    db.exec(`
      INSERT INTO devices (
        deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
      ) VALUES
        ('UNASSIGNED1', 'Fresh LSN50', 'DRAGINO_LSN50', 1, NULL, '2026-01-01', '2026-01-01');
    `);
    try {
      const msg = requestFor(2, 'res1', { deveui: 'UNASSIGNED1' });
      if (nodeId === 'sensor-history-fn') msg.req.query.field = 'swt_1';
      const response = await executeFunction(loadNode(nodeId), {
        msg,
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        200,
        `${label}: a device with no zone must not 404 (P5)`
      );
    } finally {
      db.close();
    }
  }
  scopeHelper._resetForTests();
});

test('P1: device-detail reads still refuse a request with no bearer token', async () => {
  const db = seedScopedDb();
  try {
    for (const [label, nodeId, params] of [
      ['sensor history', 'sensor-history-fn', { deveui: 'DENDRO1' }],
      ['dendro daily', 'dendro-daily-fn', { deveui: 'DENDRO1' }],
      ['today liters', 'strega-today-liters-fn', { deveui: 'VALVE1' }],
      ['zone assignments', 's2120-zones-get-fn', { deveui: 'WX1' }],
    ]) {
      const response = await executeFunction(loadNode(nodeId), {
        msg: { req: { headers: {}, params, query: {} } },
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        401,
        `${label}: an unauthenticated read must still be 401`
      );
    }
  } finally {
    db.close();
  }
});

test('P1: device-detail reads still refuse a disabled account', async () => {
  const db = seedScopedDb();
  db.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  scopeHelper._resetForTests();
  try {
    for (const [label, nodeId, params] of [
      ['sensor history', 'sensor-history-fn', { deveui: 'DENDRO1' }],
      ['today liters', 'strega-today-liters-fn', { deveui: 'VALVE1' }],
      ['zone assignments', 's2120-zones-get-fn', { deveui: 'WX1' }],
    ]) {
      const msg = requestFor(3, 'view1', params);
      if (nodeId === 'sensor-history-fn') msg.req.query.field = 'swt_1';
      const response = await executeFunction(loadNode(nodeId), {
        msg,
        env: ENV,
        db,
      });
      assert.equal(
        responseMessage(response.result).statusCode,
        403,
        `${label}: a disabled account must be refused`
      );
    }
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F3: the sensor export is account-wide and keeps its flag-off behavior', async () => {
  const scopedDb = seedScopedDb();
  try {
    const scoped = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: requestFor(3, 'view1'),
      env: ENV,
      db: scopedDb,
    });
    const output = scoped.result && scoped.result[0];
    assert.doesNotMatch(output.topic, /iz\.zone_uuid IN/);
    assert.doesNotMatch(output.topic, /SENSECAP_S2120/);
    assert.deepEqual(output.params, []);
  } finally {
    scopedDb.close();
  }

  scopeHelper._resetForTests();
  const disabledDb = seedScopedDb();
  disabledDb.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  try {
    const disabled = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: requestFor(3, 'view1'),
      env: ENV,
      db: disabledDb,
    });
    assert.equal(disabled.result && disabled.result[1] && disabled.result[1].statusCode, 403);
  } finally {
    disabledDb.close();
    scopeHelper._resetForTests();
  }

  const unscopedDb = seedScopedDb();
  try {
    const unscoped = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: { req: { headers: {}, params: {}, query: {} } },
      env: { OSI_SCOPED_ACCESS: '0' },
      db: unscopedDb,
    });
    const output = unscoped.result && unscoped.result[0];
    assert.doesNotMatch(output.topic, /iz\.zone_uuid IN/);
    assert.deepEqual(output.params, []);
  } finally {
    unscopedDb.close();
  }
});

test('W1: history of an unclaimed device stays exportable and stays in recent actuations', async () => {
  // Deliberate asymmetry with the device LIST (Task 1), pinned so nobody
  // "fixes" it later: unclaiming is a device-lifecycle act, not a retraction of
  // the measurements taken while the device was installed. The export has never
  // had a user_id filter in either mode; recent actuations gains one row that
  // flag-off would have hidden.
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('UNCLAIMED1', 'Deleted valve', 'STREGA_VALVE', NULL, NULL, '2026-01-01', '2026-01-01');
    INSERT INTO device_data(deveui, recorded_at, swt_1) VALUES
      ('UNCLAIMED1', '2026-01-02T08:00:00.000Z', 33);
    INSERT INTO valve_actuation_expectations (
      expectation_id, device_eui, zone_id, command_id, commanded_at,
      commanded_duration_seconds, expected_close_at, flow_rate_lpm,
      estimated_gross_liters, volume_source, reconciliation_state, created_at
    ) VALUES
      ('e-unclaimed', 'UNCLAIMED1', NULL, 'c-unclaimed', '2026-01-02T08:00:00.000Z', 60,
       '2026-01-02T08:01:00.000Z', 10, 10, 'calibrated', 'PENDING_OBSERVATION', '2026-01-02T08:00:00.000Z');
  `);
  try {
    const exported = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: requestFor(3, 'view1'),
      env: ENV,
      db,
    });
    const output = exported.result && exported.result[0];
    assert.doesNotMatch(
      output.topic,
      /d\.user_id/,
      'the sensor export must not gain a lifecycle filter it never had'
    );
    const rows = db.prepare(output.topic).all(...output.params);
    assert.ok(
      rows.some((row) => row.deveui === 'UNCLAIMED1'),
      "an unclaimed device's historical measurements stay exportable"
    );

    scopeHelper._resetForTests();
    const actuations = await executeFunction(loadNode('get-actuations-query'), {
      msg: { payload: [{ id: 1 }], authUserId: 1, authUsername: 'admin1' },
      env: ENV,
      db,
    });
    const message = responseMessage(actuations.result);
    const list = (message.payload && message.payload.actuations) || message.payload;
    assert.ok(
      list.some((row) => row.device_eui === 'UNCLAIMED1'),
      "an unclaimed valve's actuation history stays visible (accepted asymmetry with flag-off)"
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F3: today-liters remains callable without auth while the flag is off', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('strega-today-liters-fn'), {
      msg: { req: { headers: {}, params: { deveui: 'VALVE1' }, query: {} } },
      env: { OSI_SCOPED_ACCESS: '0' },
      db,
    });
    assert.equal(response.result && response.result.statusCode, 200);
  } finally {
    db.close();
  }
});

function historyRequest(userId, username, method, path, params = {}, body = {}) {
  const msg = requestFor(userId, username, params);
  msg.req.method = method;
  msg.req.path = path;
  msg.req.body = body;
  return msg;
}

function seedAnalysisDevices(db) {
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id,
      dendro_enabled, created_at, updated_at
    ) VALUES
      ('A84041D000000001', 'Scoped tree', 'DRAGINO_LSN50', 2, 1, 1, '2026-01-01', '2026-01-01'),
      ('A84041D000000002', 'Granted tree', 'DRAGINO_LSN50', 1, 2, 1, '2026-01-01', '2026-01-01');
  `);
}

test('W2: journal entries and plots are account-wide on the scoped-access matrix', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  const gatewayEui = '0016C001F1000001';
  db.exec(`
    UPDATE journal_plots SET gateway_device_eui = '${gatewayEui}';
    INSERT INTO journal_plot_settings (plot_uuid, layout_code, context_json, updated_at, updated_by_principal_uuid, sync_version)
      SELECT plot_uuid, 'default', '{}', '2026-01-01T00:00:00.000Z', owner_user_uuid, 1 FROM journal_plots;
  `);
  const viewerPrincipal = {
    user_id: 3,
    owner_user_uuid: 'u-view1',
    author_principal_uuid: 'u-view1',
    author_label: 'view1',
    gateway_device_eui: gatewayEui,
    origin: 'edge-ui',
    scope: scopeHelper,
    scoped: true,
  };
  try {
    const { plots } = await journalApi.listPlots(facadeDb(db), viewerPrincipal);
    assert.deepEqual(
      plots.map((plot) => plot.plot_uuid).sort(),
      ['p-1', 'p-2'],
      'a viewer with no plot grant must read every plot on the gateway (W2)'
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F4: history zone reads are account-wide for every enabled role', async () => {
  for (const [userId, username] of [[1, 'admin1'], [2, 'res1'], [3, 'view1']]) {
    for (const zoneId of ['1', '2']) {
      scopeHelper._resetForTests();
      const db = seedScopedDb();
      try {
        const response = await executeFunction(loadNode('history-api-router-fn'), {
          msg: historyRequest(userId, username, 'GET', `/api/history/zones/${zoneId}/cards`, { zoneId }),
          env: ENV,
          db,
        });
        assert.equal(
          response.result && response.result.statusCode,
          200,
          `${username} must read zone ${zoneId} history`
        );
      } finally {
        db.close();
      }
    }
  }
  scopeHelper._resetForTests();
});

test('F4: the account-wide export covers every zone on the gateway', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('AA00000000000001', 'Zone one sensor', 'KIWI_SENSOR', 2, 1, '2026-01-01', '2026-01-01'),
      ('AA00000000000002', 'Zone two sensor', 'KIWI_SENSOR', 1, 2, '2026-01-01', '2026-01-01');
    INSERT INTO device_data(deveui, recorded_at, swt_1) VALUES
      ('AA00000000000001', '2026-01-02T08:00:00.000Z', 20),
      ('AA00000000000002', '2026-01-02T09:00:00.000Z', 40);
  `);
  try {
    const msg = historyRequest(3, 'view1', 'GET', '/api/history/export.csv');
    msg.req.query = {
      scope: 'allZones',
      from: '2026-01-02',
      to: '2026-01-02',
      granularity: 'raw',
    };
    const response = await executeFunction(loadNode('history-api-router-fn'), {
      msg,
      env: ENV,
      db,
    });

    assert.equal(response.result && response.result.statusCode, 200);
    assert.match(response.result.payload, /Z One/);
    assert.match(response.result.payload, /Z Two/);
  } finally {
    db.close();
  }
});

test('P1: history routes refuse a disabled account, reads and preference writes alike', async () => {
  for (const [label, msgFactory] of [
    ['zone cards', () => historyRequest(3, 'view1', 'GET', '/api/history/zones/1/cards', { zoneId: '1' })],
    ['card opened', () => historyRequest(
      3,
      'view1',
      'POST',
      '/api/history/zones/1/cards/some-card/opened',
      { zoneId: '1', cardId: 'some-card' },
      {}
    )],
  ]) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    db.prepare(
      "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
    ).run();
    try {
      const response = await executeFunction(loadNode('history-api-router-fn'), {
        msg: msgFactory(),
        env: ENV,
        db,
      });
      assert.equal(
        response.result && response.result.statusCode,
        403,
        `${label}: a disabled account must be refused`
      );
    } finally {
      db.close();
    }
  }
  scopeHelper._resetForTests();
});

test('F4b: gateway history is admin-only while scoped access is enabled', async () => {
  const researcherDb = seedScopedDb();
  researcherDb.exec("UPDATE irrigation_zones SET gateway_device_eui = 'A84041ABCDEF0002' WHERE id = 2");
  try {
    const researcher = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(2, 'res1', 'GET', '/api/history/gateways/A84041ABCDEF0002/cards', { gatewayEui: 'A84041ABCDEF0002' }),
      env: ENV,
      db: researcherDb,
    });
    assert.equal(researcher.result && researcher.result.statusCode, 403);
  } finally {
    researcherDb.close();
  }

  const adminDb = seedScopedDb();
  adminDb.exec("UPDATE irrigation_zones SET gateway_device_eui = 'A84041ABCDEF0002' WHERE id = 2");
  try {
    const admin = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(1, 'admin1', 'GET', '/api/history/gateways/A84041ABCDEF0002/cards', { gatewayEui: 'A84041ABCDEF0002' }),
      env: ENV,
      db: adminDb,
    });
    assert.equal(admin.result && admin.result.statusCode, 200);
  } finally {
    adminDb.close();
  }
});

test('P2: gateway card-preference writes are admin-only too', async () => {
  for (const [label, method, path, params] of [
    ['preferences PUT', 'PUT', '/api/history/gateways/A84041ABCDEF0002/cards/A84041ABCDEF0002:gateway:hub/preferences',
      { gatewayEui: 'A84041ABCDEF0002', cardId: 'A84041ABCDEF0002:gateway:hub' }],
    ['opened POST', 'POST', '/api/history/gateways/A84041ABCDEF0002/cards/A84041ABCDEF0002:gateway:hub/opened',
      { gatewayEui: 'A84041ABCDEF0002', cardId: 'A84041ABCDEF0002:gateway:hub' }],
  ]) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    db.exec("UPDATE irrigation_zones SET gateway_device_eui = 'A84041ABCDEF0002' WHERE id = 2");
    try {
      const response = await executeFunction(loadNode('history-api-router-fn'), {
        msg: historyRequest(3, 'view1', method, path, params, {}),
        env: ENV,
        db,
      });
      assert.equal(
        response.result && response.result.statusCode,
        403,
        `${label}: a viewer must not write a gateway card preference`
      );
    } finally {
      db.close();
    }
  }
  scopeHelper._resetForTests();
});

test('P2: an admin still writes gateway card preferences', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec("UPDATE irrigation_zones SET gateway_device_eui = 'A84041ABCDEF0002' WHERE id = 2");
  try {
    const response = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(
        1,
        'admin1',
        'POST',
        '/api/history/gateways/A84041ABCDEF0002/cards/A84041ABCDEF0002:gateway:hub/opened',
        { gatewayEui: 'A84041ABCDEF0002', cardId: 'A84041ABCDEF0002:gateway:hub' },
        {}
      ),
      env: ENV,
      db,
    });
    assert.notEqual(
      response.result && response.result.statusCode,
      403,
      'the admin path must not regress into a blanket denial'
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F4b: workspace rows remain owner-only in scoped mode', async () => {
  const db = seedScopedDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      owner_user_uuid TEXT,
      zone_id INTEGER,
      name TEXT NOT NULL,
      workspace_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO history_workspaces (
      user_id, owner_user_uuid, zone_id, name, workspace_json, created_at, updated_at
    ) VALUES (1, 'u-admin', 2, 'Foreign workspace', '{}', '2026-01-01', '2026-01-01');
  `);
  try {
    const response = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(
        2,
        'res1',
        'PUT',
        '/api/history/workspaces/1',
        { id: '1' },
        { name: 'Should not change' }
      ),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 404);
    assert.equal(db.prepare('SELECT name FROM history_workspaces WHERE id = 1').get().name, 'Foreign workspace');
  } finally {
    db.close();
  }
});

test('F4: flag-off history behavior remains owner-only', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(2, 'res1', 'GET', '/api/history/zones/2/cards', { zoneId: '2' }),
      env: { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' },
      db,
    });
    assert.equal(response.result && response.result.statusCode, 404);
  } finally {
    db.close();
  }
});

function responseMessage(result) {
  if (!Array.isArray(result)) return result;
  for (const value of result.flat(Infinity)) {
    if (value && typeof value === 'object' && value.statusCode !== undefined) return value;
  }
  return result.flat(Infinity).find((value) => value && typeof value === 'object');
}

const ADMIN_READ_CASES = [
  {
    label: 'database download',
    nodeId: 'database-download-admin-read-guard',
    path: '/download/database',
  },
  {
    label: 'sync state',
    nodeId: 'sync-state-admin-read-guard',
    path: '/api/sync/state',
  },
  {
    label: 'system stats',
    nodeId: 'system-stats-admin-read-guard',
    path: '/api/system/stats',
  },
  {
    label: 'account-link status',
    nodeId: 'al-status-decode',
    path: '/api/account-link/status',
  },
  {
    label: 'improvement requests',
    nodeId: 'improvement-requests-api-router',
    path: '/api/improvement-requests',
  },
  {
    label: 'improvement diagnostics preview',
    nodeId: 'improvement-requests-api-router',
    path: '/api/improvement-requests/diagnostics-preview',
  },
  {
    label: 'field-test export',
    nodeId: 'fieldtest-download-admin-read-guard',
    path: '/download-fieldtest',
  },
  {
    label: 'gateway location',
    nodeId: 'get-gateway-location-auth-fn',
    path: '/api/gateway/location',
    params: {},
  },
  {
    label: 'gateway location by EUI',
    nodeId: 'get-gateway-location-auth-fn',
    path: '/api/gateways/A84041ABCDEF0002/location',
    params: { gatewayEui: 'A84041ABCDEF0002' },
  },
];

const TEST_FS = {
  existsSync: () => false,
  readFileSync(filePath) {
    if (String(filePath).includes('/thermal/')) return '42000\n';
    if (String(filePath).endsWith('/period')) return '100\n';
    if (String(filePath).endsWith('/duty_cycle')) return '50\n';
    return '';
  },
  readdirSync: () => [],
  accessSync() {
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  },
};
const TEST_OS = {
  loadavg: () => [0.1, 0.2, 0.3],
  totalmem: () => 1024 * 1024 * 1024,
  freemem: () => 512 * 1024 * 1024,
  cpus: () => [{}, {}],
};

async function executeAdminRead(testCase, userId, username, mutateDb) {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  if (mutateDb) mutateDb(db);
  try {
    const msg = historyRequest(
      userId,
      username,
      'GET',
      testCase.path,
      testCase.params || {}
    );
    const response = await executeFunction(loadNode(testCase.nodeId), {
      msg,
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      globals: { fs: TEST_FS, os: TEST_OS },
      db,
    });
    return responseMessage(response.result);
  } finally {
    db.close();
  }
}

test('F6: every diagnostic and gateway read rejects non-admin accounts', async () => {
  for (const testCase of ADMIN_READ_CASES) {
    const response = await executeAdminRead(testCase, 2, 'res1');
    assert.equal(
      response && response.statusCode,
      403,
      `${testCase.label} must reject a researcher`
    );
  }
});

test('F6: every diagnostic and gateway read rejects a disabled admin', async () => {
  for (const testCase of ADMIN_READ_CASES) {
    const response = await executeAdminRead(testCase, 1, 'admin1', (db) => {
      db.prepare("UPDATE users SET disabled_at = '2026-07-01' WHERE id = 1").run();
    });
    assert.equal(
      response && response.statusCode,
      403,
      `${testCase.label} must reject a disabled admin`
    );
  }
});

test('F6: enabled admins pass every route guard', async () => {
  for (const testCase of ADMIN_READ_CASES) {
    const response = await executeAdminRead(testCase, 1, 'admin1');
    assert.notEqual(
      response && response.statusCode,
      403,
      `${testCase.label} must pass the admin guard`
    );
  }
});

test('F6: database download remains disabled after the admin guard', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('a85523a4041eb6f4'), {
      msg: historyRequest(1, 'admin1', 'GET', '/download/database'),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 403);
    assert.deepEqual(response.result && response.result.payload, {
      error: 'Database download is disabled',
    });
  } finally {
    db.close();
  }
});

test('F7: catalog is available to every enabled authenticated role', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const enabled = await executeFunction(loadNode('catalog-authenticated-read-guard'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/catalog'),
      env: ENV,
      db,
    });
    assert.ok(enabled.result && enabled.result[0], 'enabled viewer reaches the catalog');

    db.prepare("UPDATE users SET disabled_at = '2026-07-01' WHERE id = 3").run();
    scopeHelper._resetForTests();
    const disabled = await executeFunction(loadNode('catalog-authenticated-read-guard'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/catalog'),
      env: ENV,
      db,
    });
    assert.equal(disabled.result && disabled.result[1].statusCode, 403);
  } finally {
    db.close();
  }
});

test('F7: scoped analysis catalog uses an explicit account-wide array', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    seedAnalysisDevices(db);
    const response = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/analysis/channels'),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    assert.equal(response.result && response.result.statusCode, 200);
    const zoneIds = new Set(
      (response.result.payload.channels || []).map((channel) => String(channel.zoneId ?? ''))
    );
    assert.ok(zoneIds.has('1'), 'zone 1 channels must be present');
    assert.ok(zoneIds.has('2'), 'zone 2 channels must be present for a viewer (W1)');
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('P2: flag-off analysis catalog stays owner-only', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  seedAnalysisDevices(db);
  try {
    const response = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(2, 'res1', 'GET', '/api/analysis/channels'),
      env: {
        AUTH_TOKEN_SECRET: AUTH_SECRET,
        OSI_SCOPED_ACCESS: '0',
        DEVICE_EUI: 'A84041ABCDEF0002',
      },
      db,
    });
    assert.equal(response.result && response.result.statusCode, 200);
    const zoneIds = new Set(
      (response.result.payload.channels || []).map((channel) => String(channel.zoneId ?? ''))
    );
    assert.ok(zoneIds.has('1'), 'flag-off owner still sees the owned zone');
    assert.ok(!zoneIds.has('2'), 'flag-off analysis must not widen to a foreign zone');
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('P1: analysis reads still refuse a disabled account', async () => {
  const db = seedScopedDb();
  db.prepare(
    "UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'"
  ).run();
  scopeHelper._resetForTests();
  try {
    const response = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/analysis/channels'),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 403);
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F7: recent actuations are account-wide', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO valve_actuation_expectations (
      expectation_id, device_eui, zone_id, command_id, commanded_at,
      commanded_duration_seconds, expected_close_at, flow_rate_lpm,
      estimated_gross_liters, volume_source, reconciliation_state, created_at
    ) VALUES
      ('e-1', 'VALVE1', 1, 'c-1', '2026-01-02T08:00:00.000Z', 60,
       '2026-01-02T08:01:00.000Z', 10, 10, 'calibrated', 'PENDING_OBSERVATION', '2026-01-02T08:00:00.000Z');
  `);
  try {
    const response = await executeFunction(loadNode('get-actuations-query'), {
      msg: { payload: [{ id: 1 }], authUserId: 1, authUsername: 'admin1' },
      env: ENV,
      db,
    });
    const message = responseMessage(response.result);
    assert.equal(message.statusCode || 200, 200);
    const actuations = (message.payload && message.payload.actuations) || message.payload;
    assert.equal(
      actuations.length,
      1,
      'admin1 owns no zone-1 device but must still see its actuation (W1)'
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('F7: analysis views remain per-user while selectors are account-wide', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  seedAnalysisDevices(db);
  try {
    const catalog = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(2, 'res1', 'GET', '/api/analysis/channels'),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    const foreign = (catalog.result.payload.channels || []).find(
      (channel) => channel.zoneId === 2
    );
    assert.ok(foreign);

    db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        owner_user_uuid TEXT,
        name TEXT NOT NULL,
        view_json TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare(
      'INSERT INTO analysis_views(user_id, owner_user_uuid, name, view_json) VALUES (?,?,?,?)'
    ).run(3, 'u-view1', 'Viewer view', JSON.stringify({
      schemaVersion: 1,
      name: 'Viewer view',
      selectors: [{ seriesId: foreign.seriesId }],
    }));
    db.prepare(
      'INSERT INTO analysis_views(user_id, owner_user_uuid, name, view_json) VALUES (?,?,?,?)'
    ).run(2, 'u-res1', 'Other user view', JSON.stringify({
      schemaVersion: 1,
      name: 'Other user view',
      selectors: [],
    }));

    scopeHelper._resetForTests();
    const response = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/analysis/views'),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    assert.equal(response.result.payload.views.length, 1);
    assert.equal(response.result.payload.views[0].name, 'Viewer view');
    assert.deepEqual(response.result.payload.views[0].selectors, [{ seriesId: foreign.seriesId }]);
    assert.deepEqual(response.result.payload.views[0].droppedSeriesIds, []);
  } finally {
    db.close();
  }
});

test('F7: analysis view deletion cannot cross user ownership', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      owner_user_uuid TEXT,
      name TEXT NOT NULL,
      view_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO analysis_views(user_id, owner_user_uuid, name, view_json) VALUES
      (2, 'u-res1', 'Researcher view', '{"schemaVersion":1,"selectors":[]}'),
      (3, 'u-view1', 'Viewer view', '{"schemaVersion":1,"selectors":[]}');
  `);
  try {
    const foreign = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'DELETE', '/api/analysis/views/1', { id: '1' }),
      env: ENV,
      db,
    });
    assert.equal(foreign.result && foreign.result.statusCode, 404);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_views WHERE id = 1').get().count, 1);

    scopeHelper._resetForTests();
    const own = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'DELETE', '/api/analysis/views/2', { id: '2' }),
      env: ENV,
      db,
    });
    assert.equal(own.result && own.result.statusCode, 204);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_views WHERE id = 2').get().count, 0);
  } finally {
    db.close();
  }
});

test('F6: flag-off field-test and system-stat routes remain unauthenticated', async () => {
  for (const nodeId of ['fn_build_sql_params', 'sys-stats-fn']) {
    const db = seedScopedDb();
    try {
      const response = await executeFunction(loadNode(nodeId), {
        msg: { req: { headers: {}, params: {}, query: {}, method: 'GET' } },
        env: { OSI_SCOPED_ACCESS: '0' },
        globals: { fs: TEST_FS, os: TEST_OS },
        db,
      });
      assert.notEqual(responseMessage(response.result).statusCode, 401);
    } finally {
      db.close();
    }
  }
});
