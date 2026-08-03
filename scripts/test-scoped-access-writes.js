#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  facadeDb,
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

// E3 (Critical): PHYSICAL device commands must require an actor once scoped access is on.
// Before this fix, `if (scopedOn && actorUuid)` skipped the scope check entirely when
// actorUuid was absent -- exactly the shape of a cloud-dispatched command that never
// carried one -- so a revoked user could still actuate a valve via the cloud path.
test('E3: a scoped physical command without an actor is rejected fail-closed and never actuates', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: expectationMessage(null),
      env: ENV,
      db,
    });
    assert.equal(
      response.result,
      null,
      'an actor-less physical command must never reach the downlink builder wired to this node\'s single output'
    );
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='manual-scope-test'"
      ).get().n,
      0,
      'no actuation expectation row may be written -- the command must never actuate'
    );
    const applied = db.prepare(
      "SELECT result, result_detail FROM applied_commands WHERE command_id='manual-scope-test'"
    ).get();
    assert.ok(applied, 'a terminal rejection must still be recorded so a replay is recognized');
    assert.equal(applied.result, 'REJECTED_PERMANENT');
    assert.equal(JSON.parse(applied.result_detail).reason, 'scope_actor_required');
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id='manual-scope-test'"
      ).get().n,
      1,
      'the rejection must be queued for delivery back to the cloud, not silently dropped'
    );
  } finally {
    db.close();
  }
});

test('E3: a scoped actor with view-only zone access cannot actuate a valve', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    // u-view1 (role 'viewer') is genuinely granted to z-1 (g-2), the zone VALVE1 lives
    // in -- assertFreshDeviceAccess alone would have let this actor through. Before this
    // fix there was no role check at all on this path, only the device/zone-access check.
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: expectationMessage('u-view1'),
      env: ENV,
      db,
    });
    assert.equal(response.result, null, 'a viewer must never actuate a valve, even with real zone access');
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='manual-scope-test'"
      ).get().n,
      0
    );
  } finally {
    db.close();
  }
});

test('E3: flag-off preserves the legacy no-actor-required behavior', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: expectationMessage(null),
      env: { ...ENV, OSI_SCOPED_ACCESS: '0' },
      db,
    });
    assert.ok(response.result, 'flag-off must still accept a physical command with no actor at all');
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='manual-scope-test'"
      ).get().n,
      1
    );
  } finally {
    db.close();
  }
});

// R3: the pre-existing missing_or_invalid_expectation_duration branch used to `return msg`
// (pass through to the downlink builder) *before* the scope/actor gate ever ran, so an
// actor-less, duration-less command -- exactly the shape of a real cloud VALVE_COMMAND,
// which carries no duration at all -- skipped E3 entirely instead of being caught by it.
function noDurationExpectationMessage(actorUuid) {
  return {
    actor_user_uuid: actorUuid,
    _actorUserUuid: actorUuid,
    _stregaExpectationCommand: {
      command_type: 'VALVE_COMMAND',
      action: 'OPEN_FOR_DURATION',
      device_eui: 'VALVE1',
      zone_id: 1,
      command_id: actorUuid ? 'r3-no-duration-with-actor' : 'r3-no-duration-no-actor',
      // deliberately no duration_seconds / duration_minutes anywhere in this object.
    },
    payload: {
      type: 'actuator_command',
      device: { devEui: 'VALVE1', zone_id: 1 },
      data: { action: 'OPEN_FOR_DURATION' },
    },
  };
}

test('R3: an actor-less, duration-less command is rejected by the actor gate, not passed through', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: noDurationExpectationMessage(null),
      env: ENV,
      db,
    });
    assert.equal(response.result, null, 'must never reach the downlink builder');
    const applied = db.prepare(
      "SELECT result, result_detail FROM applied_commands WHERE command_id='r3-no-duration-no-actor'"
    ).get();
    assert.ok(applied, 'a terminal rejection must be recorded');
    assert.equal(applied.result, 'REJECTED_PERMANENT');
    assert.equal(
      JSON.parse(applied.result_detail).reason,
      'scope_actor_required',
      'the actor gate must be the one that catches this, proving it now runs before duration parsing'
    );
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='r3-no-duration-no-actor'"
      ).get().n,
      0
    );
  } finally {
    db.close();
  }
});

test('R3: an authorized actor with an invalid/missing duration is rejected under scope, not passed through', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: noDurationExpectationMessage('u-res1'),
      env: ENV,
      db,
    });
    assert.equal(response.result, null, 'must never reach the downlink builder');
    const applied = db.prepare(
      "SELECT result, result_detail FROM applied_commands WHERE command_id='r3-no-duration-with-actor'"
    ).get();
    assert.ok(applied, 'a terminal rejection must be recorded even though the actor was authorized');
    assert.equal(applied.result, 'REJECTED_PERMANENT');
    assert.equal(JSON.parse(applied.result_detail).reason, 'missing_or_invalid_expectation_duration');
  } finally {
    db.close();
  }
});

test('R3: flag-off keeps the legacy invalid-duration pass-through behavior', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg: noDurationExpectationMessage(null),
      env: { ...ENV, OSI_SCOPED_ACCESS: '0' },
      db,
    });
    assert.ok(response.result, 'flag-off must preserve the legacy pass-through for a malformed duration');
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM applied_commands WHERE command_id='r3-no-duration-no-actor'"
      ).get().n,
      0,
      'flag-off never wrote an ack for this branch before and still must not'
    );
  } finally {
    db.close();
  }
});

// R1 (Critical): the cloud embeds the acting user in the command payload
// (cmd.actor_user_uuid), but Route Command built brand-new msg.payload/_stregaExpectationCommand
// shapes for VALVE_COMMAND/OPEN_FOR_DURATION/CLOSE without ever copying it onto the message
// itself, so write-strega-expectation's scope gate never saw it -- every scoped
// cloud-dispatched physical command was rejected scope_actor_required, authorized or not.
// This exercises the real two-node pipeline: Route Command's output feeds directly into
// write-strega-expectation (see test-flows-wiring.js C5 / Route Command wires).
test('R1: a cloud command with actor_user_uuid only in the payload crosses Route Command intact and enforces scope', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  db.exec(`
    INSERT INTO user_zone_assignments (
      assignment_uuid, user_uuid, zone_uuid, assigned_by_user_uuid, created_at
    ) VALUES ('g-r1-admin', 'u-admin', 'z-1', 'u-admin', '2026-01-01');
  `);
  function cloudCommandMsg(actorUuid, commandId) {
    return {
      payload: {
        commandType: 'VALVE_COMMAND',
        action: 'OPEN_FOR_DURATION',
        deviceEui: 'VALVE1',
        duration_minutes: 10,
        commandId,
        actor_user_uuid: actorUuid,
      },
    };
  }
  async function routeThenWrite(actorUuid, commandId) {
    const routed = await executeFunction(loadNode('934bf2bc19a8ce22'), {
      msg: cloudCommandMsg(actorUuid, commandId),
      env: ENV,
      db,
    });
    const routedMsg = routed.result[0];
    assert.ok(routedMsg, 'Route Command must route a VALVE_COMMAND to output 0');
    assert.equal(
      routedMsg._actorUserUuid,
      actorUuid,
      'Route Command must copy the payload actor onto the message itself'
    );
    return executeFunction(loadNode('write-strega-expectation'), {
      msg: routedMsg,
      env: ENV,
      db,
    });
  }
  try {
    // Granted researcher (owns VALVE1's zone directly): actuates.
    const granted = await routeThenWrite('u-res1', 'r1-granted');
    assert.ok(granted.result, 'a granted researcher must actuate');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='r1-granted'").get().n,
      1
    );

    // Revoked claimer: admin was granted z-1 above, then the grant is revoked -- a fresh
    // scope check (not a stale cache) must deny the very next command.
    scopeHelper._resetForTests();
    db.prepare("UPDATE user_zone_assignments SET deleted_at='2026-07-01' WHERE assignment_uuid='g-r1-admin'").run();
    const revoked = await routeThenWrite('u-admin', 'r1-revoked');
    assert.equal(revoked.result, null, 'a revoked claimer must not actuate');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='r1-revoked'").get().n,
      0
    );

    // Viewer with real zone access (g-2: u-view1 -> z-1): denied by role, not by zone access.
    scopeHelper._resetForTests();
    const viewer = await routeThenWrite('u-view1', 'r1-viewer');
    assert.equal(viewer.result, null, 'a viewer must not actuate even with real zone access');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='r1-viewer'").get().n,
      0
    );
  } finally {
    db.close();
  }
});

// R2: the irrigation scheduler dispatches OPEN_FOR_DURATION with no actor at all (it is not
// a user action). Without an exemption, E3 silently drops every automated irrigation
// decision once scoped access is on -- warn, no ack, no expectation, no downlink.
test('R2: a genuine scheduler dispatch (real message-level marker) actuates under scope with no actor', async () => {
  scopeHelper._resetForTests();
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
          valve_deveui: 'VALVE1',
          scheduling_mode: 'local',
          enabled_scope_holders: 1,
        },
        payload: [{ mean_kpa: 25, n_points: 5 }],
      },
      env: ENV,
      db,
    });
    const actuatorMsg = decision.result[0];
    assert.ok(actuatorMsg, 'the scheduler must dispatch an actuator command for this decision');
    assert.equal(
      actuatorMsg._systemActuation,
      true,
      'the scheduler must set the message-level system-actuation marker immediately before dispatch'
    );

    const written = await executeFunction(loadNode('write-strega-expectation'), {
      msg: actuatorMsg,
      env: ENV,
      db,
    });
    assert.ok(written.result, 'a genuine scheduler dispatch must actuate even with no actor, under scope');
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE device_eui='VALVE1'"
      ).get().n,
      1
    );
  } finally {
    db.close();
  }
});

test('R2: a payload/body-embedded system-actuation claim is never honored, only the true message-level flag', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    // Every one of these is exactly what an HTTP request body or a cloud command payload
    // could set -- none of them is msg._systemActuation itself, which only the scheduler's
    // own wire ever sets, immediately before dispatch (Route Command always builds a fresh
    // msg from the wire payload; GUI paths are bearer-authenticated and never copy arbitrary
    // client-supplied msg properties onto the outgoing msg).
    const msg = {
      payload: {
        _systemActuation: true,
        type: 'actuator_command',
        device: { devEui: 'VALVE1', zone_id: 1 },
        data: { action: 'OPEN_FOR_DURATION', duration_minutes: 10, _systemActuation: true },
      },
      body: { _systemActuation: true },
      req: { body: { _systemActuation: true } },
      _stregaExpectationCommand: {
        command_type: 'VALVE_COMMAND',
        action: 'OPEN_FOR_DURATION',
        device_eui: 'VALVE1',
        zone_id: 1,
        duration_minutes: 10,
        command_id: 'r2-smuggle-attempt',
        _systemActuation: true,
      },
    };
    const response = await executeFunction(loadNode('write-strega-expectation'), {
      msg,
      env: ENV,
      db,
    });
    assert.equal(
      response.result,
      null,
      'a payload/body-embedded marker must never exempt the actor requirement'
    );
    const applied = db.prepare(
      "SELECT result, result_detail FROM applied_commands WHERE command_id='r2-smuggle-attempt'"
    ).get();
    assert.ok(applied, 'a terminal rejection must still be recorded');
    assert.equal(applied.result, 'REJECTED_PERMANENT');
    assert.equal(JSON.parse(applied.result_detail).reason, 'scope_actor_required');
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE command_id='r2-smuggle-attempt'"
      ).get().n,
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

test('E8: disable-all scopes an admin to owned-plus-granted zones like every other write surface', async () => {
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
    // admin1 (id 1) owns zone 2 ('z-2') but has no grant to zone 1 ('z-1', owned by
    // res1). Before the fix, admin was exempt from the zone filter entirely and this
    // disabled both zones -- an admin-only fleet-wide bypass every other scoped write
    // surface (zone list, valve actuation) does not have.
    const admin = await executeFunction(loadNode('settings-disable-schedules-fn'), {
      msg: scopedRequest(1, 'admin1', 'POST', '/api/irrigation-zones/schedules/disable-all'),
      env: ENV,
      db,
    });
    assert.equal(admin.result.statusCode, 200);
    assert.equal(
      db.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled,
      1,
      'a zone the admin neither owns nor is granted must not be touched'
    );
    assert.equal(
      db.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=2').get().enabled,
      0,
      "the admin's own zone must still be disabled"
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
    assert.equal(assigned.result[1].payload.sync_version, 2);
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
    assert.equal(removed.result[1].payload.sync_version, 3);
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

const ZONE_CONFIG_ROUTES = [
  ['PUT', '/api/irrigation-zones/1/timezone', { zone_id: '1' }],
  ['PUT', '/api/irrigation-zones/1/location', { zone_id: '1' }],
  ['PUT', '/api/irrigation-zones/1/config', { zone_id: '1' }],
  ['POST', '/api/irrigation-zones/1/calibration', { id: '1' }],
];

test('W7: every zone-config route fresh-checks scope and records the actor', async () => {
  const db = seedScopedDb();
  try {
    for (const [index, [method, path, params]] of ZONE_CONFIG_ROUTES.entries()) {
      scopeHelper._resetForTests();
      const allowed = await executeFunction(loadNode('scoped-zone-config-guard'), {
        msg: scopedRequest(2, 'res1', method, path, params),
        env: ENV,
        db,
      });
      assert.equal(allowed.result[index].actor_user_uuid, 'u-res1');
      assert.equal(allowed.result[index]._scopedZoneOwnerId, 2);
      assert.equal(allowed.flowState.actor_user_uuid, 'u-res1');

      scopeHelper._resetForTests();
      const foreignAdmin = await executeFunction(loadNode('scoped-zone-config-guard'), {
        msg: scopedRequest(1, 'admin1', method, path, params),
        env: ENV,
        db,
      });
      assert.equal(foreignAdmin.result.at(-1).statusCode, 404);

      scopeHelper._resetForTests();
      const viewer = await executeFunction(loadNode('scoped-zone-config-guard'), {
        msg: scopedRequest(3, 'view1', method, path, params),
        env: ENV,
        db,
      });
      assert.equal(viewer.result.at(-1).statusCode, 403);
    }
  } finally {
    db.close();
  }
});

test('W7: a grantee reaches the legacy zone write as the resource owner', async () => {
  const db = seedScopedDb();
  try {
    const guarded = await executeFunction(loadNode('scoped-zone-config-guard'), {
      msg: scopedRequest(
        2,
        'res1',
        'PUT',
        '/api/irrigation-zones/2/location',
        { zone_id: '2' },
        { latitude: 47.1, longitude: 8.2 }
      ),
      env: ENV,
      db,
    });
    assert.equal(guarded.result[1]._scopedZoneOwnerId, 1);
    const written = await executeFunction(loadNode('dendro-location-fn'), {
      msg: guarded.result[1],
      env: ENV,
      db,
    });
    assert.equal(written.result.statusCode, 200);
    const zone = db.prepare(
      'SELECT latitude,longitude FROM irrigation_zones WHERE id=2'
    ).get();
    assert.equal(zone.latitude, 47.1);
    assert.equal(zone.longitude, 8.2);
  } finally {
    db.close();
  }
});

async function adminApi(db, userId, username, method, path, params = {}, body = {}) {
  scopeHelper._resetForTests();
  return executeFunction(loadNode('scoped-admin-account-router'), {
    msg: scopedRequest(userId, username, method, path, params, body),
    env: { ...ENV, DEVICE_EUI: '0016C001F1000001' },
    db,
  });
}

test('W8: admin account CRUD omits hashes and protects the last enabled admin', async () => {
  const db = seedScopedDb();
  try {
    const created = await adminApi(
      db,
      1,
      'admin1',
      'POST',
      '/api/users',
      {},
      { username: 'research2', password: 'temporary-pass', role: 'researcher' }
    );
    assert.equal(created.result.statusCode, 201);
    const userUuid = created.result.payload.user_uuid;

    const listed = await adminApi(db, 1, 'admin1', 'GET', '/api/users');
    assert.equal(listed.result.statusCode, 200);
    assert.ok(listed.result.payload.users.some((user) => user.user_uuid === userUuid));
    assert.ok(
      listed.result.payload.users.every(
        (user) => !Object.prototype.hasOwnProperty.call(user, 'password_hash')
      )
    );

    const reset = await adminApi(
      db,
      1,
      'admin1',
      'POST',
      `/api/users/${userUuid}/password-reset`,
      { uuid: userUuid },
      { password: 'new-temporary-pass' }
    );
    assert.deepEqual(reset.result.payload, { success: true });

    const promoted = await adminApi(
      db,
      1,
      'admin1',
      'PUT',
      `/api/users/${userUuid}/role`,
      { uuid: userUuid },
      { role: 'viewer' }
    );
    assert.equal(promoted.result.statusCode, 200);
    assert.equal(
      db.prepare('SELECT role FROM users WHERE user_uuid=?').get(userUuid).role,
      'viewer'
    );

    const disabledResearcher = await adminApi(
      db,
      1,
      'admin1',
      'PUT',
      `/api/users/${userUuid}/disabled`,
      { uuid: userUuid },
      { disabled: true }
    );
    assert.equal(disabledResearcher.result.statusCode, 200);

    const lastAdmin = await adminApi(
      db,
      1,
      'admin1',
      'PUT',
      '/api/users/u-admin/disabled',
      { uuid: 'u-admin' },
      { disabled: true }
    );
    assert.equal(lastAdmin.result.statusCode, 409);
    assert.equal(
      db.prepare("SELECT disabled_at FROM users WHERE user_uuid='u-admin'").get().disabled_at,
      null
    );
  } finally {
    db.close();
  }
});

test('W8: serialized admin disable attempts leave at least one enabled admin', async () => {
  const db = seedScopedDb();
  try {
    const created = await adminApi(
      db,
      1,
      'admin1',
      'POST',
      '/api/users',
      {},
      { username: 'admin2', password: 'temporary-pass', role: 'admin' }
    );
    const admin2Uuid = created.result.payload.user_uuid;
    const first = await adminApi(
      db,
      1,
      'admin1',
      'PUT',
      `/api/users/${admin2Uuid}/disabled`,
      { uuid: admin2Uuid },
      { disabled: true }
    );
    assert.equal(first.result.statusCode, 200);
    const second = await adminApi(
      db,
      1,
      'admin1',
      'PUT',
      '/api/users/u-admin/disabled',
      { uuid: 'u-admin' },
      { disabled: true }
    );
    assert.equal(second.result.statusCode, 409);
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled_at IS NULL"
      ).get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('W8: zone and plot grants invalidate into the next resolved scope', async () => {
  const db = seedScopedDb();
  const scopedDb = facadeDb(db);
  try {
    const zoneGrant = await adminApi(
      db,
      1,
      'admin1',
      'POST',
      '/api/grants/zone',
      {},
      { user_uuid: 'u-view1', zone_uuid: 'z-2' }
    );
    assert.equal(zoneGrant.result.statusCode, 201);
    let resolved = await scopeHelper.resolveScope(scopedDb, 'u-view1', { scopedMode: true });
    assert.ok(resolved.zoneUuids.has('z-2'));
    const zoneAssignment = zoneGrant.result.payload.assignment_uuid;
    const zoneDelete = await adminApi(
      db,
      1,
      'admin1',
      'DELETE',
      `/api/grants/zone/${zoneAssignment}`,
      { assignmentUuid: zoneAssignment }
    );
    assert.equal(zoneDelete.result.statusCode, 200);
    resolved = await scopeHelper.resolveScope(scopedDb, 'u-view1', { scopedMode: true });
    assert.ok(!resolved.zoneUuids.has('z-2'));

    const plotGrant = await adminApi(
      db,
      1,
      'admin1',
      'POST',
      '/api/grants/plot',
      {},
      { user_uuid: 'u-view1', plot_uuid: 'p-2' }
    );
    assert.equal(plotGrant.result.statusCode, 201);
    resolved = await scopeHelper.resolveScope(scopedDb, 'u-view1', { scopedMode: true });
    assert.ok(resolved.plotUuids.has('p-2'));
    const plotAssignment = plotGrant.result.payload.assignment_uuid;
    await adminApi(
      db,
      1,
      'admin1',
      'DELETE',
      `/api/grants/plot/${plotAssignment}`,
      { assignmentUuid: plotAssignment }
    );
    resolved = await scopeHelper.resolveScope(scopedDb, 'u-view1', { scopedMode: true });
    assert.ok(!resolved.plotUuids.has('p-2'));
  } finally {
    db.close();
  }
});

test('E7: a missing zone_uuid on a grant POST is a 400, not a stringified-undefined 404', async () => {
  const db = seedScopedDb();
  try {
    // Before the fix, `String(isZoneGrant ? body.zone_uuid : body.plot_uuid || '')`
    // parsed as `isZoneGrant ? body.zone_uuid : (body.plot_uuid || '')`: a missing
    // body.zone_uuid on a zone grant became the literal string 'undefined', which then
    // failed the resource lookup and was misreported as "User or resource not found" (404)
    // instead of a validation error.
    const missingZoneUuid = await adminApi(
      db, 1, 'admin1', 'POST', '/api/grants/zone', {}, { user_uuid: 'u-view1' }
    );
    assert.equal(missingZoneUuid.result.statusCode, 400);

    const missingPlotUuid = await adminApi(
      db, 1, 'admin1', 'POST', '/api/grants/plot', {}, { user_uuid: 'u-view1' }
    );
    assert.equal(missingPlotUuid.result.statusCode, 400);

    // A genuinely nonexistent resource (uuid supplied, but no such row) must still 404.
    const nonexistentZone = await adminApi(
      db, 1, 'admin1', 'POST', '/api/grants/zone', {},
      { user_uuid: 'u-view1', zone_uuid: 'z-does-not-exist' }
    );
    assert.equal(nonexistentZone.result.statusCode, 404);
  } finally {
    db.close();
  }
});

test('W8: every account and grant endpoint rejects non-admins', async () => {
  const db = seedScopedDb();
  const endpoints = [
    ['GET', '/api/users', {}],
    ['POST', '/api/users', {}],
    ['POST', '/api/users/u-view1/password-reset', { uuid: 'u-view1' }],
    ['PUT', '/api/users/u-view1/role', { uuid: 'u-view1' }],
    ['PUT', '/api/users/u-view1/disabled', { uuid: 'u-view1' }],
    ['POST', '/api/grants/zone', {}],
    ['DELETE', '/api/grants/zone/g-1', { assignmentUuid: 'g-1' }],
    ['POST', '/api/grants/plot', {}],
    ['DELETE', '/api/grants/plot/g-plot', { assignmentUuid: 'g-plot' }],
  ];
  try {
    for (const [method, path, params] of endpoints) {
      const response = await adminApi(db, 2, 'res1', method, path, params);
      assert.equal(response.result.statusCode, 403, `${method} ${path}`);
    }
  } finally {
    db.close();
  }
});

const ADMIN_SYSTEM_WRITES = [
  ['sync-force-admin-write-guard', 'POST', '/api/sync/force'],
  ['system-reboot-admin-write-guard', 'POST', '/api/system/reboot'],
  ['system-fan-admin-write-guard', 'POST', '/api/system/fan'],
  ['account-link-admin-write-guard', 'POST', '/api/account-link'],
  ['account-unlink-admin-write-guard', 'DELETE', '/api/account-link'],
  ['history-rollups-admin-write-guard', 'POST', '/api/history/rollups/run'],
];

async function adminSystemWrite(db, nodeId, userId, username, method, path, env = ENV) {
  scopeHelper._resetForTests();
  return executeFunction(loadNode(nodeId), {
    msg: scopedRequest(userId, username, method, path),
    env,
    db,
  });
}

test('W9: every system write allows only a fresh enabled admin', async () => {
  const db = seedScopedDb();
  try {
    for (const [nodeId, method, path] of ADMIN_SYSTEM_WRITES) {
      const admin = await adminSystemWrite(db, nodeId, 1, 'admin1', method, path);
      assert.ok(admin.result[0], `${method} ${path} allows an enabled admin`);
      assert.equal(admin.result[0].actor_user_uuid, 'u-admin');

      const researcher = await adminSystemWrite(db, nodeId, 2, 'res1', method, path);
      assert.equal(
        researcher.result[1].statusCode,
        403,
        `${method} ${path} rejects researchers`
      );

      const viewer = await adminSystemWrite(db, nodeId, 3, 'view1', method, path);
      assert.equal(viewer.result[1].statusCode, 403, `${method} ${path} rejects viewers`);
    }

    db.prepare("UPDATE users SET disabled_at='2026-07-01' WHERE id=1").run();
    for (const [nodeId, method, path] of ADMIN_SYSTEM_WRITES) {
      const disabled = await adminSystemWrite(db, nodeId, 1, 'admin1', method, path);
      assert.equal(
        disabled.result[1].statusCode,
        403,
        `${method} ${path} rejects a disabled admin`
      );
    }
  } finally {
    db.close();
  }
});

test('W9: flag-off system writes preserve every legacy branch', async () => {
  const db = seedScopedDb();
  try {
    for (const [nodeId, method, path] of ADMIN_SYSTEM_WRITES) {
      const response = await adminSystemWrite(
        db,
        nodeId,
        2,
        'res1',
        method,
        path,
        { ...ENV, OSI_SCOPED_ACCESS: '0' }
      );
      assert.ok(response.result[0], `${method} ${path} reaches its legacy handler`);
      assert.equal(response.result[0].req.path, path);
      assert.equal(response.result[1], null);
    }
  } finally {
    db.close();
  }
});

test('W10: local irrigation config writes version only their own aggregate', () => {
  const schedule = loadNode('d7e5c762c820aa16').func;
  assert.match(schedule, /nextScheduleSyncVersion\s*=\s*Number\(zone\.schedule_sync_version/);
  assert.match(schedule, /sync_version\s*=\s*\$\{nextScheduleSyncVersion\}/);
  assert.doesNotMatch(schedule, /UPDATE irrigation_zones SET sync_version/);

  const calibration = loadNode('zone-calibration-fn').func;
  assert.match(calibration, /calibration_sync_version/);
  assert.match(calibration, /nextCalibrationSyncVersion/);
  assert.match(calibration, /sync_version=excluded\.sync_version/);
  assert.match(calibration, /run\(\s*[\s\S]*\[\s*zoneId,/);
  assert.doesNotMatch(calibration, /UPDATE irrigation_zones SET sync_version/);
  const upsertStart = calibration.indexOf("'INSERT INTO zone_irrigation_calibration(");
  const upsertEnd = calibration.indexOf('  await close();', upsertStart);
  assert.ok(upsertStart >= 0 && upsertEnd > upsertStart);
  assert.doesNotMatch(
    calibration.slice(upsertStart, upsertEnd),
    /valve_device_eui/,
    'local calibration upsert preserves the existing valve binding'
  );
});

// E6: every mutation gate used a `role === 'viewer'` DENYLIST. A role value that is
// neither 'viewer' nor a recognized writer (a corrupted column, a hand-edited row, a
// future role SQLite's own CHECK should have rejected but a caller must not assume)
// fell through as write-capable. The fix is an ALLOWLIST (scope.canMutate). Simulate a
// corrupted role by bypassing the users.role CHECK the same way a direct SQLite edit on
// a live Pi could, and prove every gate now fails closed while reads remain unaffected.
function corruptRole(db, userUuid, role) {
  db.exec('PRAGMA ignore_check_constraints = ON;');
  db.prepare('UPDATE users SET role = ? WHERE user_uuid = ?').run(role, userUuid);
  db.exec('PRAGMA ignore_check_constraints = OFF;');
  assert.equal(
    db.prepare('SELECT role FROM users WHERE user_uuid = ?').get(userUuid).role,
    role,
    'test setup: the corrupted role must actually be persisted'
  );
}

test('E6: an unrecognized role fails closed on every mutation gate while reads stay scope-governed', async () => {
  const db = seedScopedDb();
  corruptRole(db, 'u-res1', 'gibberish');
  try {
    // Reads are ungated by role entirely -- they must behave exactly per zone/plot scope,
    // not be denied just because the role column is corrupted.
    scopeHelper._resetForTests();
    const devicesResponse = await executeFunction(loadNode('get-devices-query'), {
      msg: { payload: [{ id: 2 }], authUserId: 2 },
      env: ENV,
      db,
    });
    const devices = db.prepare(devicesResponse.result[0].topic).all();
    assert.deepEqual(devices.map((row) => row.deveui).sort(), ['DENDRO1', 'DENDRO2', 'VALVE1', 'WX1']);

    scopeHelper._resetForTests();
    const schedule = await executeFunction(loadNode('70fcbea336401bd1'), {
      msg: scopedRequest(
        2, 'res1', 'PUT', '/api/irrigation-zones/2/schedule', { id: '2' },
        { trigger_metric: 'SWT_1', threshold_kpa: 20 }
      ),
      env: ENV,
      db,
    });
    assert.equal(schedule.result[1].statusCode, 403, 'schedule mutation');

    scopeHelper._resetForTests();
    const disableAll = await executeFunction(loadNode('settings-disable-schedules-fn'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/irrigation-zones/schedules/disable-all'),
      env: ENV,
      db,
    });
    assert.equal(disableAll.result.statusCode, 403, 'disable-all schedules');

    scopeHelper._resetForTests();
    const zoneCreate = await executeFunction(loadNode('scoped-zone-create-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/irrigation-zones', {}, { name: 'Blocked zone' }),
      env: Object.assign({}, ENV, { DEVICE_EUI: 'A84041ABCDEF0002' }),
      db,
    });
    assert.equal(zoneCreate.result[1].statusCode, 403, 'zone create');

    scopeHelper._resetForTests();
    const zoneDelete = await executeFunction(loadNode('scoped-zone-delete-router'), {
      msg: scopedRequest(2, 'res1', 'DELETE', '/api/irrigation-zones/1', { id: '1' }),
      env: ENV,
      db,
    });
    assert.equal(zoneDelete.result[1].statusCode, 403, 'zone delete');

    scopeHelper._resetForTests();
    const deviceClaim = await executeFunction(loadNode('scoped-device-claim-router'), {
      msg: scopedRequest(2, 'res1', 'POST', '/api/devices', {}, {
        deveui: 'NEWROLE1', name: 'Blocked sensor', type_id: 'DRAGINO_LSN50',
      }),
      env: ENV,
      db,
    });
    assert.equal(deviceClaim.result[1].statusCode, 403, 'device claim');

    scopeHelper._resetForTests();
    const deviceAssign = await executeFunction(loadNode('scoped-device-assign-router'), {
      msg: scopedRequest(2, 'res1', 'PUT', '/api/irrigation-zones/2/devices/DENDRO1', { id: '2', deveui: 'DENDRO1' }),
      env: ENV,
      db,
    });
    assert.equal(deviceAssign.result[1].statusCode, 403, 'device assign');

    scopeHelper._resetForTests();
    const deviceUnassign = await executeFunction(loadNode('scoped-device-unassign-router'), {
      msg: scopedRequest(2, 'res1', 'DELETE', '/api/irrigation-zones/1/devices/DENDRO1', { id: '1', deveui: 'DENDRO1' }),
      env: ENV,
      db,
    });
    assert.equal(deviceUnassign.result[1].statusCode, 403, 'device unassign');

    scopeHelper._resetForTests();
    const deviceDelete = await executeFunction(loadNode('scoped-device-delete-router'), {
      msg: scopedRequest(2, 'res1', 'DELETE', '/api/devices/DENDRO1', { deveui: 'DENDRO1' }),
      env: ENV,
      db,
    });
    assert.equal(deviceDelete.result[1].statusCode, 403, 'device delete');

    scopeHelper._resetForTests();
    const weatherZones = await executeFunction(loadNode('scoped-weather-zone-assign-router'), {
      msg: scopedRequest(2, 'res1', 'PUT', '/api/devices/WX1/zone-assignments', { deveui: 'WX1' }, { zone_ids: [1] }),
      env: ENV,
      db,
    });
    assert.equal(weatherZones.result[1].statusCode, 403, 'weather zone assignment');

    for (const [method, suffix] of DEVICE_CONFIG_ROUTES) {
      scopeHelper._resetForTests();
      const response = await executeFunction(loadNode('scoped-device-config-guard'), {
        msg: scopedRequest(2, 'res1', method, `/api/devices/DENDRO1${suffix}`, { deveui: 'DENDRO1' }),
        env: ENV,
        db,
      });
      assert.equal(response.result.at(-1).statusCode, 403, `device-config ${method} ${suffix}`);
    }

    for (const [method, path, params] of ZONE_CONFIG_ROUTES) {
      scopeHelper._resetForTests();
      const response = await executeFunction(loadNode('scoped-zone-config-guard'), {
        msg: scopedRequest(2, 'res1', method, path, params),
        env: ENV,
        db,
      });
      assert.equal(response.result.at(-1).statusCode, 403, `zone-config ${method} ${path}`);
    }

    scopeHelper._resetForTests();
    const cancelValve = await executeFunction(loadNode('cancel-strega-actuation-fn'), {
      msg: {
        req: {
          headers: {
            authorization: makeAuthHeader({ userId: 2, username: 'res1', secret: AUTH_SECRET }),
          },
          params: { deveui: 'VALVE1' },
        },
        payload: {},
      },
      env: ENV,
      db,
    });
    assert.equal(cancelValve.result.statusCode, 403, 'cancel STREGA actuation');
  } finally {
    db.close();
  }
});
