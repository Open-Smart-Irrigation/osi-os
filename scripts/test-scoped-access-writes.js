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

function scopedRequest(userId, username, method, path, params = {}, body = {}) {
  return {
    req: {
      method,
      path,
      headers: {
        authorization: makeAuthHeader({
          userId,
          username,
          secret: AUTH_SECRET,
        }),
      },
      params,
      query: {},
      body,
    },
    payload: body,
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

test('W2: schedule mutation allows grants, hides foreign zones, and rejects viewers', async () => {
  const db = seedScopedDb();
  try {
    const granted = await executeFunction(loadNode('70fcbea336401bd1'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/irrigation-zones/2/schedule',
        { id: '2' },
        { trigger_metric: 'SWT_1', threshold_kpa: 20 }
      ),
      env: ENV,
      db,
    });
    assert.ok(granted.result[0]);
    assert.equal(granted.result[0].actor_user_uuid, 'u-res1');

    scopeHelper._resetForTests();
    const foreign = await executeFunction(loadNode('70fcbea336401bd1'), {
      msg: scopedRequest(
        1,
        'admin1',
        'PUT',
        '/api/irrigation-zones/1/schedule',
        { id: '1' },
        { trigger_metric: 'SWT_1', threshold_kpa: 20 }
      ),
      env: ENV,
      db,
    });
    assert.equal(foreign.result[1].statusCode, 404);

    scopeHelper._resetForTests();
    const viewer = await executeFunction(loadNode('70fcbea336401bd1'), {
      msg: scopedRequest(
        3,
        'view1',
        'PUT',
        '/api/irrigation-zones/1/schedule',
        { id: '1' },
        { trigger_metric: 'SWT_1', threshold_kpa: 20 }
      ),
      env: ENV,
      db,
    });
    assert.equal(viewer.result[1].statusCode, 403);
  } finally {
    db.close();
  }
});

test('W2: disable-all updates only researcher scope and rejects viewers', async () => {
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO irrigation_schedules (
      irrigation_zone_id, trigger_metric, threshold_kpa,
      duration_minutes, enabled, created_at, updated_at
    ) VALUES
      (1, 'SWT_1', 20, 10, 1, '2026-01-01', '2026-01-01'),
      (2, 'SWT_1', 20, 10, 1, '2026-01-01', '2026-01-01');
  `);
  try {
    const response = await executeFunction(loadNode('settings-disable-schedules-fn'), {
      msg: scopedRequest(
        3,
        'view1',
        'POST',
        '/api/irrigation-zones/schedules/disable-all'
      ),
      env: ENV,
      db,
    });
    assert.equal(response.result.statusCode, 403);

    scopeHelper._resetForTests();
    db.prepare(
      "UPDATE user_zone_assignments SET deleted_at='2026-07-01' WHERE assignment_uuid='g-3'"
    ).run();
    const researcher = await executeFunction(loadNode('settings-disable-schedules-fn'), {
      msg: scopedRequest(
        2,
        'res1',
        'POST',
        '/api/irrigation-zones/schedules/disable-all'
      ),
      env: ENV,
      db,
    });
    assert.equal(researcher.result.statusCode, 200);
    assert.equal(
      db.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled,
      0
    );
    assert.equal(
      db.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=2').get().enabled,
      1
    );
  } finally {
    db.close();
  }
});

test('W2: scheduler query counts enabled scope holders and disables an empty zone', async () => {
  const queryNode = loadNode('a0a61f4b7dca1c2e');
  assert.match(queryNode.func, /enabled_scope_holders/);
  assert.match(queryNode.func, /user_zone_assignments/);

  const db = seedScopedDb();
  try {
    const decision = await executeFunction(loadNode('5f0d2b7e9b9b1b3a'), {
      msg: {
        zone: {
          zone_id: 1,
          user_id: 2,
          trigger_metric: 'SWT_1',
          threshold_kpa: 20,
          duration_minutes: 10,
          enabled_scope_holders: 0,
        },
        payload: [],
      },
      env: ENV,
      db,
    });
    assert.equal(decision.result[0], null);
    assert.match(decision.result[2].topic, /SET enabled = 0/);
  } finally {
    db.close();
  }
});
