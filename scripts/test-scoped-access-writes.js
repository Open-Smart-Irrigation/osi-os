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

test('W3: scoped zone creation atomically grants the creator', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('scoped-zone-create-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'POST',
        '/api/irrigation-zones',
        {},
        { name: 'New scoped zone' }
      ),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    assert.equal(response.result[1].statusCode, 201);
    const zoneUuid = response.result[1].payload.zone_uuid;
    assert.equal(
      db.prepare(
        'SELECT user_id FROM irrigation_zones WHERE zone_uuid = ?'
      ).get(zoneUuid).user_id,
      2
    );
    const grant = db.prepare(
      'SELECT user_uuid, assigned_by_user_uuid FROM user_zone_assignments WHERE zone_uuid = ? AND deleted_at IS NULL'
    ).get(zoneUuid);
    assert.equal(grant.user_uuid, 'u-res1');
    assert.equal(grant.assigned_by_user_uuid, 'u-res1');

    const viewer = await executeFunction(loadNode('scoped-zone-create-router'), {
      msg: scopedRequest(
        3,
        'view1',
        'POST',
        '/api/irrigation-zones',
        {},
        { name: 'Forbidden zone' }
      ),
      env: ENV,
      db,
    });
    assert.equal(viewer.result[1].statusCode, 403);
  } finally {
    db.close();
  }
});

test('W3: sole-scope-holder delete tombstones grants and preserves detached plots', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO irrigation_zones (id, name, user_id, zone_uuid)
    VALUES (10, 'Delete me', 2, 'z-delete');
    INSERT INTO user_zone_assignments (
      assignment_uuid, user_uuid, zone_uuid, assigned_by_user_uuid, created_at
    ) VALUES ('g-delete', 'u-res1', 'z-delete', 'u-res1', '2026-01-01');
    INSERT INTO journal_plots (
      plot_uuid, plot_code, name, zone_uuid, owner_user_uuid
    ) VALUES ('p-delete', 'PD', 'Surviving plot', 'z-delete', 'u-res1');
  `);
  try {
    const response = await executeFunction(loadNode('scoped-zone-delete-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'DELETE',
        '/api/irrigation-zones/10',
        { id: '10' }
      ),
      env: ENV,
      db,
    });
    assert.equal(response.result[1].statusCode, 200);
    assert.ok(
      db.prepare('SELECT deleted_at FROM irrigation_zones WHERE id=10').get().deleted_at
    );
    assert.ok(
      db.prepare(
        "SELECT deleted_at FROM user_zone_assignments WHERE assignment_uuid='g-delete'"
      ).get().deleted_at
    );
    assert.equal(
      db.prepare("SELECT zone_uuid FROM journal_plots WHERE plot_uuid='p-delete'").get().zone_uuid,
      null
    );
  } finally {
    db.close();
  }
});

test('W3: researcher cannot delete a multi-holder zone; admin can', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO irrigation_zones (id, name, user_id, zone_uuid)
    VALUES (11, 'Shared zone', 2, 'z-shared');
    INSERT INTO user_zone_assignments (
      assignment_uuid, user_uuid, zone_uuid, assigned_by_user_uuid, created_at
    ) VALUES
      ('g-shared-1', 'u-res1', 'z-shared', 'u-res1', '2026-01-01'),
      ('g-shared-2', 'u-view1', 'z-shared', 'u-res1', '2026-01-01');
  `);
  try {
    const researcher = await executeFunction(loadNode('scoped-zone-delete-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'DELETE',
        '/api/irrigation-zones/11',
        { id: '11' }
      ),
      env: ENV,
      db,
    });
    assert.equal(researcher.result[1].statusCode, 409);
    assert.equal(
      db.prepare('SELECT deleted_at FROM irrigation_zones WHERE id=11').get().deleted_at,
      null
    );

    scopeHelper._resetForTests();
    const admin = await executeFunction(loadNode('scoped-zone-delete-router'), {
      msg: scopedRequest(
        1,
        'admin1',
        'DELETE',
        '/api/irrigation-zones/11',
        { id: '11' }
      ),
      env: ENV,
      db,
    });
    assert.equal(admin.result[1].statusCode, 200);
  } finally {
    db.close();
  }
});

test('W4: scoped claims require an accessible target zone except for admins', async () => {
  const db = seedScopedDb();
  try {
    const researcherMissing = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEW1',
        name: 'New sensor',
        type_id: 'DRAGINO_LSN50',
      }),
      env: ENV,
      db,
    });
    assert.equal(researcherMissing.result[1].statusCode, 400);

    scopeHelper._resetForTests();
    const adminMissing = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(1, 'admin1', 'POST', '/api/devices', {}, {
        deveui: 'NEW1',
        name: 'New sensor',
        type_id: 'DRAGINO_LSN50',
      }),
      env: ENV,
      db,
    });
    assert.ok(adminMissing.result[0]);
    assert.equal(adminMissing.result[0]._scopedTargetZoneId, null);

    scopeHelper._resetForTests();
    const scoped = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEW2',
        name: 'Scoped sensor',
        type_id: 'DRAGINO_LSN50',
        irrigation_zone_id: 1,
      }),
      env: ENV,
      db,
    });
    assert.equal(scoped.result[0]._scopedTargetZoneId, 1);

    scopeHelper._resetForTests();
    const foreignZone = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(1, 'admin1', 'POST', '/api/devices', {}, {
        deveui: 'NEW3',
        name: 'Foreign sensor',
        type_id: 'DRAGINO_LSN50',
        irrigation_zone_id: 1,
      }),
      env: ENV,
      db,
    });
    assert.equal(foreignZone.result[1].statusCode, 404);
  } finally {
    db.close();
  }
});

test('W4: a foreign existing device is hidden before claim or reassignment', async () => {
  const db = seedScopedDb();
  try {
    const claim = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(1, 'admin1', 'POST', '/api/devices', {}, {
        deveui: 'DENDRO1',
        name: 'Tree 1',
        type_id: 'DRAGINO_LSN50',
        irrigation_zone_id: 2,
      }),
      env: ENV,
      db,
    });
    assert.equal(claim.result[1].statusCode, 404);
    assert.deepEqual(claim.result[1].payload, { message: 'Device not found' });

    scopeHelper._resetForTests();
    const assignment = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        1,
        'admin1',
        'PUT',
        '/api/irrigation-zones/2/devices/DENDRO1',
        { id: '2', deveui: 'DENDRO1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(assignment.result[1].statusCode, 404);
    assert.deepEqual(assignment.result[1].payload, { message: 'Device not found' });
  } finally {
    db.close();
  }
});

test('W4: assignment and removal fresh-check both the device and zone', async () => {
  const db = seedScopedDb();
  try {
    const assigned = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/irrigation-zones/2/devices/DENDRO1',
        { id: '2', deveui: 'DENDRO1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(assigned.result[1].statusCode, 200);
    assert.equal(
      db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui='DENDRO1'").get()
        .irrigation_zone_id,
      2
    );

    scopeHelper._resetForTests();
    const removed = await executeFunction(loadNode('scoped-device-unassign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'DELETE',
        '/api/irrigation-zones/2/devices/DENDRO1',
        { id: '2', deveui: 'DENDRO1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(removed.result[1].statusCode, 200);
    assert.equal(
      db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui='DENDRO1'").get()
        .irrigation_zone_id,
      null
    );
  } finally {
    db.close();
  }
});

test('W4: device delete and weather-zone replacement enforce fresh scope', async () => {
  const db = seedScopedDb();
  try {
    const foreignDelete = await executeFunction(loadNode('scoped-device-delete-router'), {
      msg: scopedRequest(
        1,
        'admin1',
        'DELETE',
        '/api/devices/DENDRO1',
        { deveui: 'DENDRO1' }
      ),
      env: ENV,
      db,
    });
    assert.equal(foreignDelete.result[1].statusCode, 404);

    scopeHelper._resetForTests();
    const weather = await executeFunction(loadNode('scoped-weather-zone-assign-router'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/devices/WX1/zone-assignments',
        { deveui: 'WX1' },
        { zone_ids: [1, 2] }
      ),
      env: ENV,
      db,
    });
    assert.equal(weather.result[1].statusCode, 200);
    assert.deepEqual(weather.result[1].payload.zone_ids, [1, 2]);

    scopeHelper._resetForTests();
    const viewer = await executeFunction(loadNode('scoped-weather-zone-assign-router'), {
      msg: scopedRequest(
        3,
        'view1',
        'PUT',
        '/api/devices/WX1/zone-assignments',
        { deveui: 'WX1' },
        { zone_ids: [1] }
      ),
      env: ENV,
      db,
    });
    assert.equal(viewer.result[1].statusCode, 403);
  } finally {
    db.close();
  }
});

const DEVICE_CONFIG_ROUTES = [
  ['PUT', '/dendro'],
  ['PUT', '/temp'],
  ['PUT', '/reference-tree'],
  ['PUT', '/lsn50/mode'],
  ['PUT', '/lsn50/interval'],
  ['PUT', '/kiwi/interval'],
  ['POST', '/kiwi/temperature-humidity/enable'],
  ['PUT', '/strega/interval'],
  ['PUT', '/lsn50/interrupt-mode'],
  ['PUT', '/lsn50/5v-warmup'],
  ['PUT', '/strega/model'],
  ['PUT', '/strega/timed-action'],
  ['PUT', '/strega/magnet'],
  ['PUT', '/strega/partial-opening'],
  ['PUT', '/strega/flushing'],
  ['PUT', '/rain-gauge'],
  ['PUT', '/flow-meter'],
  ['PUT', '/soil-moisture-depths'],
  ['PUT', '/chameleon'],
  ['PUT', '/dendro-config'],
  ['POST', '/dendro-baseline/reset'],
  ['POST', '/chameleon/refresh-calibration'],
  ['PUT', '/chameleon/depth'],
];

test('W5: every device-config route fresh-checks write scope', async () => {
  const db = seedScopedDb();
  try {
    for (const [index, [method, suffix]] of DEVICE_CONFIG_ROUTES.entries()) {
      scopeHelper._resetForTests();
      const path = `/api/devices/DENDRO1${suffix}`;
      const allowed = await executeFunction(loadNode('scoped-device-config-guard'), {
        msg: scopedRequest(
          2,
          'res1',
          method,
          path,
          { deveui: 'DENDRO1' }
        ),
        env: ENV,
        db,
      });
      assert.equal(allowed.result[index].actor_user_uuid, 'u-res1', `${method} ${suffix}`);
      assert.equal(
        allowed.result.filter(Boolean).length,
        1,
        `${method} ${suffix} uses one legacy output`
      );

      scopeHelper._resetForTests();
      const foreignAdmin = await executeFunction(loadNode('scoped-device-config-guard'), {
        msg: scopedRequest(
          1,
          'admin1',
          method,
          path,
          { deveui: 'DENDRO1' }
        ),
        env: ENV,
        db,
      });
      assert.equal(
        foreignAdmin.result.at(-1).statusCode,
        404,
        `${method} ${suffix} does not give admins a scope bypass`
      );

      scopeHelper._resetForTests();
      const viewer = await executeFunction(loadNode('scoped-device-config-guard'), {
        msg: scopedRequest(
          3,
          'view1',
          method,
          path,
          { deveui: 'DENDRO1' }
        ),
        env: ENV,
        db,
      });
      assert.equal(viewer.result.at(-1).statusCode, 403, `${method} ${suffix} rejects viewers`);
    }
  } finally {
    db.close();
  }
});

test('W5: flag-off device-config routing preserves each legacy branch', async () => {
  const db = seedScopedDb();
  try {
    for (const [index, [method, suffix]] of DEVICE_CONFIG_ROUTES.entries()) {
      const path = `/api/devices/DENDRO1${suffix}`;
      const response = await executeFunction(loadNode('scoped-device-config-guard'), {
        msg: scopedRequest(
          2,
          'res1',
          method,
          path,
          { deveui: 'DENDRO1' }
        ),
        env: { ...ENV, OSI_SCOPED_ACCESS: '0' },
        db,
      });
      assert.equal(response.result[index].req.path, path);
      assert.equal(response.result.filter(Boolean).length, 1);
    }
  } finally {
    db.close();
  }
});
