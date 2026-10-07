#!/usr/bin/env node
'use strict';

// The raw sensor export (GET /download-sensordata), the valve litres read
// (GET /api/v1/devices/:deveui/today-liters) and the reference-tree switch
// (PUT /api/devices/:deveui/reference-tree) need a signed-in session in both
// flag states, like the history and export routes beside them. Before this
// fix, with OSI_SCOPED_ACCESS off, the first two answered without any token
// and the third accepted any header that started with "Bearer ".
//
// Each case runs the shipped function-node source against an in-memory
// SQLite fixture (scripts/lib/scoped-access-harness.js).

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
const FLAG_STATES = [
  ['flag off', { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' }],
  ['flag on', { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' }],
];
const NO_SESSION = [
  ['no Authorization header', {}],
  ['a bare Bearer prefix', { authorization: 'Bearer x' }],
  ['a token signed with another secret', {
    authorization: makeAuthHeader({ userId: 2, username: 'res1', secret: 'not-the-gateway-secret' }),
  }],
  ['an expired token', {
    authorization: makeAuthHeader({ userId: 2, username: 'res1', secret: AUTH_SECRET, expiresAt: Date.now() - 1000 }),
  }],
];
const SESSION = { authorization: makeAuthHeader({ userId: 2, username: 'res1', secret: AUTH_SECRET }) };

// The sensor export node has two outputs: [to the SQLite query, to the error
// response]. The other two answer on their single output.
function exportResponse(result) {
  assert.ok(Array.isArray(result), 'the export node answers on its two outputs');
  return result;
}

function seedLitres(db) {
  const today = new Date();
  today.setHours(1, 0, 0, 0);
  db.exec(`
    INSERT INTO valve_actuation_expectations (
      expectation_id, device_eui, commanded_at, commanded_duration_seconds,
      expected_close_at, estimated_gross_liters, volume_source,
      reconciliation_state, created_at
    ) VALUES (
      'exp-1', 'VALVE1', '${today.toISOString()}', 600,
      '${today.toISOString()}', 123.44, 'flow_meter',
      'OBSERVED_COMPLETE', '${today.toISOString()}'
    );
  `);
}

for (const [flagLabel, env] of FLAG_STATES) {
  test(`${flagLabel}: GET /download-sensordata refuses a request without a session with 401`, async () => {
    for (const [label, headers] of NO_SESSION) {
      scopeHelper._resetForTests();
      const db = seedScopedDb();
      try {
        const response = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
          msg: { req: { headers, query: { from: '2026-01-01' } } },
          env,
          db,
        });
        const [toQuery, toResponse] = exportResponse(response.result);
        assert.equal(toQuery, null, `${label}: must not reach the device_data query`);
        assert.equal(toResponse && toResponse.statusCode, 401, label);
        assert.equal(typeof toResponse.payload.message, 'string', label);
      } finally {
        db.close();
      }
    }
  });

  test(`${flagLabel}: GET /download-sensordata builds the same query for a signed-in session`, async () => {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    try {
      const response = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
        msg: {
          req: {
            headers: SESSION,
            query: { from: '2026-01-01', to: '2026-02-01', deveui: 'DENDRO1', zone_id: '1' },
          },
        },
        env,
        db,
      });
      const [toQuery, toResponse] = exportResponse(response.result);
      assert.equal(toResponse, null);
      assert.match(toQuery.topic, /FROM device_data dd/);
      assert.match(toQuery.topic, /AND dd\.recorded_at >= \? AND dd\.recorded_at <= \? AND dd\.deveui = \? AND d\.irrigation_zone_id = \? ORDER BY dd\.recorded_at;$/);
      assert.deepEqual(toQuery.params, ['2026-01-01', '2026-02-01', 'DENDRO1', '1']);
    } finally {
      db.close();
    }
  });

  test(`${flagLabel}: GET /api/v1/devices/:deveui/today-liters refuses a request without a session with 401`, async () => {
    for (const [label, headers] of NO_SESSION) {
      scopeHelper._resetForTests();
      const db = seedScopedDb();
      seedLitres(db);
      try {
        const response = await executeFunction(loadNode('strega-today-liters-fn'), {
          msg: { req: { headers, params: { deveui: 'VALVE1' }, query: {} } },
          env,
          db,
        });
        assert.equal(response.result && response.result.statusCode, 401, label);
        assert.equal(response.result.payload.liters, undefined, `${label}: must not answer litres`);
      } finally {
        db.close();
      }
    }
  });

  test(`${flagLabel}: GET /api/v1/devices/:deveui/today-liters answers a signed-in session as before`, async () => {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    seedLitres(db);
    try {
      const response = await executeFunction(loadNode('strega-today-liters-fn'), {
        msg: { req: { headers: SESSION, params: { deveui: 'valve1' }, query: {} } },
        env,
        db,
      });
      assert.equal(response.result.statusCode, 200);
      assert.deepEqual(response.result.payload, { liters: 123.4, source: 'flow_meter' });
    } finally {
      db.close();
    }
  });

  test(`${flagLabel}: PUT /api/devices/:deveui/reference-tree refuses a request without a session with 401`, async () => {
    for (const [label, headers] of NO_SESSION) {
      const db = seedScopedDb();
      try {
        const response = await executeFunction(loadNode('dendro-ref-tree-fn'), {
          msg: { req: { headers, params: { deveui: 'DENDRO1' }, body: { is_reference_tree: 1 } } },
          env,
          db,
        });
        assert.equal(response.result && response.result.statusCode, 401, label);
        const row = db.prepare("SELECT is_reference_tree FROM devices WHERE deveui = 'DENDRO1'").get();
        assert.equal(row.is_reference_tree, 0, `${label}: must not change the device`);
      } finally {
        db.close();
      }
    }
  });

  test(`${flagLabel}: PUT /api/devices/:deveui/reference-tree still sets the flag for a signed-in session`, async () => {
    const db = seedScopedDb();
    try {
      const response = await executeFunction(loadNode('dendro-ref-tree-fn'), {
        msg: { req: { headers: SESSION, params: { deveui: 'dendro1' }, body: { is_reference_tree: 1 } } },
        env,
        db,
      });
      assert.equal(response.result.statusCode, 200);
      assert.deepEqual(response.result.payload, { success: true, deveui: 'DENDRO1', is_reference_tree: 1 });
      const row = db.prepare("SELECT is_reference_tree FROM devices WHERE deveui = 'DENDRO1'").get();
      assert.equal(row.is_reference_tree, 1);
    } finally {
      db.close();
    }
  });
}

// On a gateway the token secret lives in /data/db/osi_auth_token_secret, not
// in the environment (the login node writes it there on first use). The
// routes now resolve it the way the login node and every other route do, so a
// signed-in session also works in scoped mode; before, these two answered 500
// to any valid token there.
test('flag on: the export and litres routes accept a session signed with the stored secret', async () => {
  const storedSecret = 'stored-gateway-secret';
  const fsStub = {
    readFileSync(filePath) {
      if (filePath === '/data/db/osi_auth_token_secret') return storedSecret + '\n';
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
    writeFileSync() {
      throw new Error('the stored secret exists; nothing may be written');
    },
  };
  const headers = { authorization: makeAuthHeader({ userId: 2, username: 'res1', secret: storedSecret }) };
  const env = { OSI_SCOPED_ACCESS: '1' };

  scopeHelper._resetForTests();
  let db = seedScopedDb();
  try {
    const exported = await executeFunction(loadNode('fn_build_sensor_sql_params'), {
      msg: { req: { headers, query: {} } },
      env,
      db,
      globals: { fs: fsStub },
    });
    const [toQuery, toResponse] = exportResponse(exported.result);
    assert.equal(toResponse, null, toResponse ? JSON.stringify(toResponse.payload) : '');
    assert.match(toQuery.topic, /FROM device_data dd/);
  } finally {
    db.close();
  }

  scopeHelper._resetForTests();
  db = seedScopedDb();
  seedLitres(db);
  try {
    const litres = await executeFunction(loadNode('strega-today-liters-fn'), {
      msg: { req: { headers, params: { deveui: 'VALVE1' }, query: {} } },
      env,
      db,
      globals: { fs: fsStub },
    });
    assert.equal(litres.result.statusCode, 200, JSON.stringify(litres.result.payload));
  } finally {
    db.close();
  }
});
