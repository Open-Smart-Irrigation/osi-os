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
