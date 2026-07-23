#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');
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

test('F2: a researcher can read a granted zone environment summary', async () => {
  const node = loadNode('zone-env-fn');
  const db = seedScopedDb();
  try {
    const response = await executeFunction(node, {
      msg: requestFor(2, 'res1', { zone_id: '2' }),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 200);
  } finally {
    db.close();
  }
});

test('F2: a viewer receives 404 for a foreign zone environment summary', async () => {
  const node = loadNode('zone-env-fn');
  const db = seedScopedDb();
  try {
    const response = await executeFunction(node, {
      msg: requestFor(3, 'view1', { zone_id: '2' }),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 404);
  } finally {
    db.close();
  }
});

test('F2: recommendations honor granted-zone reads and hide foreign zones', async () => {
  const node = loadNode('dendro-zone-rec-fn');
  const grantedDb = seedScopedDb();
  try {
    const granted = await executeFunction(node, {
      msg: requestFor(2, 'res1', { zone_id: '2' }),
      env: ENV,
      db: grantedDb,
    });
    assert.equal(granted.result && granted.result.statusCode, 200);
    assert.equal(granted.result && granted.result.payload.length, 1);
  } finally {
    grantedDb.close();
  }

  const foreignDb = seedScopedDb();
  try {
    const foreign = await executeFunction(node, {
      msg: requestFor(3, 'view1', { zone_id: '2' }),
      env: ENV,
      db: foreignDb,
    });
    assert.equal(foreign.result && foreign.result.statusCode, 404);
  } finally {
    foreignDb.close();
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

test('F1: scoped lists use owned-plus-granted zones and keep weather shared', async () => {
  const db = seedScopedDb();
  try {
    const zones = await zoneList(db, 2);
    assert.deepEqual(zones.map((row) => row.zone_uuid).sort(), ['z-1', 'z-2']);
    const devices = await deviceList(db, 2);
    assert.deepEqual(
      devices.map((row) => row.deveui).sort(),
      ['DENDRO1', 'DENDRO2', 'VALVE1', 'WX1']
    );
  } finally {
    db.close();
  }
});

test('F1: admin has no scope bypass and flag-off behavior remains owner-only', async () => {
  const db = seedScopedDb();
  try {
    const adminZones = await zoneList(db, 1);
    assert.deepEqual(adminZones.map((row) => row.zone_uuid), ['z-2']);
    const unscopedZones = await zoneList(db, 2, {
      AUTH_TOKEN_SECRET: AUTH_SECRET,
      OSI_SCOPED_ACCESS: '0',
    });
    assert.deepEqual(unscopedZones.map((row) => row.zone_uuid), ['z-1']);
  } finally {
    db.close();
  }
});

test('F3: device reads allow grants and shared weather, and hide foreign devices', async () => {
  const grantedDb = seedScopedDb();
  try {
    const granted = await executeFunction(loadNode('dendro-daily-fn'), {
      msg: requestFor(2, 'res1', { deveui: 'DENDRO2' }),
      env: ENV,
      db: grantedDb,
    });
    assert.equal(granted.result && granted.result.statusCode, 200);
  } finally {
    grantedDb.close();
  }

  const foreignDb = seedScopedDb();
  try {
    const foreign = await executeFunction(loadNode('dendro-daily-fn'), {
      msg: requestFor(3, 'view1', { deveui: 'DENDRO2' }),
      env: ENV,
      db: foreignDb,
    });
    assert.equal(foreign.result && foreign.result.statusCode, 404);
  } finally {
    foreignDb.close();
  }

  const weatherDb = seedScopedDb();
  try {
    const weather = await executeFunction(loadNode('s2120-zones-get-fn'), {
      msg: requestFor(3, 'view1', { deveui: 'WX1' }),
      env: ENV,
      db: weatherDb,
    });
    assert.equal(weather.result && weather.result.statusCode, 200);
  } finally {
    weatherDb.close();
  }
});

test('F3: scoped today-liters hides a foreign valve', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('strega-today-liters-fn'), {
      msg: requestFor(1, 'admin1', { deveui: 'VALVE1' }),
      env: ENV,
      db,
    });
    assert.equal(response.result && response.result.statusCode, 404);
  } finally {
    db.close();
  }
});

test('F3: sensor export filters scoped rows and keeps flag-off behavior', async () => {
  const scopedDb = seedScopedDb();
  try {
    const scoped = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: requestFor(3, 'view1'),
      env: ENV,
      db: scopedDb,
    });
    const output = scoped.result && scoped.result[0];
    assert.match(output.topic, /iz\.zone_uuid IN/);
    assert.match(output.topic, /SENSECAP_S2120/);
    assert.deepEqual(output.params, ['z-1']);
  } finally {
    scopedDb.close();
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

test('F4: history zone reads allow owned and granted zones but hide foreign zones', async () => {
  const ownDb = seedScopedDb();
  try {
    const own = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(2, 'res1', 'GET', '/api/history/zones/1/cards', { zoneId: '1' }),
      env: ENV,
      db: ownDb,
    });
    assert.equal(own.result && own.result.statusCode, 200);
  } finally {
    ownDb.close();
  }

  const grantedDb = seedScopedDb();
  try {
    const granted = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(2, 'res1', 'GET', '/api/history/zones/2/cards', { zoneId: '2' }),
      env: ENV,
      db: grantedDb,
    });
    assert.equal(granted.result && granted.result.statusCode, 200);
  } finally {
    grantedDb.close();
  }

  const foreignDb = seedScopedDb();
  try {
    const foreign = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/history/zones/2/cards', { zoneId: '2' }),
      env: ENV,
      db: foreignDb,
    });
    assert.equal(foreign.result && foreign.result.statusCode, 404);
  } finally {
    foreignDb.close();
  }
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

test('F7: analysis channels include grants and exclude foreign zones', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  seedAnalysisDevices(db);
  try {
    const granted = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(2, 'res1', 'GET', '/api/analysis/channels'),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    const grantedZoneIds = new Set(
      (granted.result.payload.channels || []).map((channel) => channel.zoneId)
    );
    assert.ok(grantedZoneIds.has(2), 'granted zone appears in the analysis catalog');

    scopeHelper._resetForTests();
    const viewer = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(3, 'view1', 'GET', '/api/analysis/channels'),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    const viewerZoneIds = new Set(
      (viewer.result.payload.channels || []).map((channel) => channel.zoneId)
    );
    assert.ok(!viewerZoneIds.has(2), 'foreign zone is absent from the analysis catalog');
  } finally {
    db.close();
  }
});

test('F7: analysis series cannot resolve a selector from a foreign zone', async () => {
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
    assert.ok(foreign, 'granted user fixture exposes a zone-two selector');

    scopeHelper._resetForTests();
    const response = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: historyRequest(
        3,
        'view1',
        'POST',
        '/api/analysis/series',
        {},
        {
          selectors: [{ seriesId: foreign.seriesId }],
          range: { from: '2026-01-01', to: '2026-01-03' },
        }
      ),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    assert.deepEqual(response.result.payload.series, []);
    assert.deepEqual(response.result.payload.dropped, [
      { seriesId: foreign.seriesId, reason: 'unknown' },
    ]);
  } finally {
    db.close();
  }
});

test('F7: analysis views remain per-user and drop foreign selectors', async () => {
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
    assert.deepEqual(response.result.payload.views[0].selectors, []);
    assert.deepEqual(response.result.payload.views[0].droppedSeriesIds, [foreign.seriesId]);
  } finally {
    db.close();
  }
});

test('F7: recent actuations use owned-plus-granted zone visibility', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO valve_actuation_expectations (
      expectation_id, device_eui, zone_id, commanded_at,
      commanded_duration_seconds, expected_close_at, volume_source, created_at
    ) VALUES
      ('a-owned', 'VALVE1', 1, '2026-01-01', 60, '2026-01-01T00:01:00Z', 'unknown', '2026-01-01'),
      ('a-granted', 'DENDRO2', 2, '2026-01-02', 60, '2026-01-02T00:01:00Z', 'unknown', '2026-01-02');
  `);
  try {
    const response = await executeFunction(loadNode('get-actuations-query'), {
      msg: {
        payload: [{ id: 2 }],
        authUsername: 'res1',
      },
      env: ENV,
      db,
    });
    assert.deepEqual(
      response.result[0].payload.map((row) => row.expectation_id).sort(),
      ['a-granted', 'a-owned']
    );
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
