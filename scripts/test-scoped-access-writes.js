#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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

function valveRequest(userId, username, deveui = 'VALVE1') {
  return {
    req: {
      headers: {
        authorization: makeAuthHeader({
          userId,
          username,
          secret: AUTH_SECRET,
        }),
      },
      params: { deveui },
      query: {},
    },
    payload: {
      action: 'OPEN_FOR_DURATION',
      duration_minutes: 10,
    },
  };
}

async function executeValveBoundary(db, userId, username, deveui) {
  scopeHelper._resetForTests();
  return executeFunction(loadNode('83bb4a452dd9ae37'), {
    msg: valveRequest(userId, username, deveui),
    env: ENV,
    db,
  });
}

test('W1: valve boundary allows in-scope researchers and records the actor', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeValveBoundary(db, 2, 'res1', 'VALVE1');
    assert.ok(response.result[0]);
    assert.equal(response.result[0].actor_user_uuid, 'u-res1');
  } finally {
    db.close();
  }
});

test('W1: valve boundary hides foreign devices and rejects viewers or disabled users', async () => {
  const db = seedScopedDb();
  try {
    const foreign = await executeValveBoundary(db, 1, 'admin1', 'VALVE1');
    assert.equal(foreign.result[1].statusCode, 404);

    const viewer = await executeValveBoundary(db, 3, 'view1', 'VALVE1');
    assert.equal(viewer.result[1].statusCode, 403);

    db.prepare("UPDATE users SET disabled_at = '2026-07-01' WHERE id = 2").run();
    const disabled = await executeValveBoundary(db, 2, 'res1', 'VALVE1');
    assert.equal(disabled.result[1].statusCode, 403);
  } finally {
    db.close();
  }
});

function expectationMessage(actorUuid = 'u-res1') {
  return {
    actor_user_uuid: actorUuid,
    _actorUserUuid: actorUuid,
    _stregaExpectationCommand: {
      command_type: 'OPEN_FOR_DURATION',
      action: 'OPEN_FOR_DURATION',
      duration_minutes: 10,
      device_eui: 'VALVE1',
      zone_id: 1,
      command_id: 'manual-scope-test',
    },
    payload: {
      type: 'actuator_command',
      device: { devEui: 'VALVE1', zone_id: 1 },
      data: {
        action: 'OPEN_FOR_DURATION',
        duration_minutes: 10,
      },
    },
  };
}

test('W1: enqueue rechecks fresh scope and records applied-command originator', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: expectationMessage(),
      env: ENV,
      db,
    });
    assert.ok(response.result, 'authorized command continues to downlink');
    assert.equal(
      db.prepare(
        "SELECT originator FROM applied_commands WHERE command_id='manual-scope-test'"
      ).get().originator,
      'u-res1'
    );
  } finally {
    db.close();
  }
});

test('W1: revocation immediately stops enqueue before physical effect', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    UPDATE irrigation_zones SET user_id = 1 WHERE id = 1;
    UPDATE user_zone_assignments
       SET deleted_at = '2026-07-01'
     WHERE user_uuid = 'u-res1' AND zone_uuid = 'z-1';
  `);
  try {
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: expectationMessage(),
      env: ENV,
      db,
    });
    assert.equal(response.result, null);
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM applied_commands WHERE command_id='manual-scope-test'"
      ).get().count,
      0
    );
  } finally {
    db.close();
  }
});
