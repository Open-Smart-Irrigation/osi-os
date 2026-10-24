#!/usr/bin/env node
'use strict';

/*
 * Task 6b2b route-level fixtures.  The older scoped-access suite proves the
 * authorization wrappers with legacy-only rows.  These fixtures deliberately
 * seed a conditional policy, its valve schedule, and an occurrence before
 * invoking each wrapper so the assertions cover the canonical lifecycle
 * mutation and its durable command ACK boundary.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const {
  executeFunction,
  facadeDb,
  loadNode,
  makeAuthHeader,
  profilePaths,
  seedScopedDb,
} = require('./lib/scoped-access-harness');
const scopeHelper = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper'
);
const policyService = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy'
);

const PROFILES = ['bcm2712', 'bcm2709'];
function profileSpec(profile) {
  const paths = profilePaths(profile);
  return {
    ...paths,
    service: require(path.join(paths.nodeRedModules, 'osi-irrigation-policy')),
    push: require(path.join(paths.nodeRedModules, 'osi-valve-control', 'push.js')),
    dispatch: require(path.join(paths.nodeRedModules, 'osi-valve-control', 'dispatch.js')),
  };
}

async function runNode(profile, nodeId, options) {
  const spec = profileSpec(profile);
  return executeFunction(loadNode(nodeId, spec.flowsPath), {
    ...options,
    nodeRedModules: spec.nodeRedModules,
  });
}

const AUTH_SECRET = 'scoped-access-test-secret';
const GATEWAY = '0016C001F1000002';
const VALVE = '0016C001F1000001';
const SOURCE = 'DENDRO1';
const TARGET = 'DENDRO2';
const ZONE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-19T10:00:00.000Z';
const ENV = {
  AUTH_TOKEN_SECRET: AUTH_SECRET,
  DEVICE_EUI: GATEWAY,
  OSI_SCOPED_ACCESS: '1',
};

function request(userId, username, method, path, params = {}, body = {}) {
  return {
    req: {
      method,
      path,
      headers: { authorization: makeAuthHeader({ userId, username, secret: AUTH_SECRET }) },
      params,
      query: {},
      body,
    },
    payload: body,
  };
}

function policyFixture(db, {
  zoneId = 1,
  zoneUuid = 'z-1',
  policyUuid = 'policy-route',
  scheduleUuid = 'schedule-route',
  sourceDevice = SOURCE,
  valve = VALVE,
  enabled = 1,
} = {}) {
  db.exec(`
    INSERT INTO irrigation_policies (
      policy_uuid, zone_uuid, condition_json, timezone, enabled,
      observation_window_minutes, min_interval_minutes, max_daily_minutes,
      delivery_settings_json, sync_version, created_at, updated_at
    ) VALUES (
      '${policyUuid}', '${zoneUuid}',
      '${JSON.stringify({ kind: 'SWT', threshold_kpa: 10, sources: [{ device_eui: sourceDevice, channel: 'swt_1' }] }).replace(/'/g, "''")}',
      'UTC', ${enabled}, 60, 60, 240, '{}', 4, '${AT}', '${AT}'
    );
    INSERT INTO valve_schedules (
      schedule_uuid, device_eui, kind, label, weekdays_mask, start_time,
      duration_minutes, timezone, enabled, sync_version, created_at, updated_at,
      condition_policy_uuid
    ) VALUES (
      '${scheduleUuid}', '${valve}', 'WEEKLY', 'Conditional route fixture', 127,
      '06:00', 10, 'UTC', 1, 7, '${AT}', '${AT}', '${policyUuid}'
    );
    INSERT INTO irrigation_occurrences (
      schedule_uuid, local_date, local_time, policy_uuid, zone_uuid, device_eui,
      due_at, policy_revision, schedule_revision, policy_sync_version,
      schedule_sync_version, state, created_at, updated_at
    ) VALUES (
      '${scheduleUuid}', '2026-10-20', '06:00', '${policyUuid}', '${zoneUuid}',
      '${valve}', '2026-10-20T06:00:00.000Z', 1, 1, 4, 7, 'PENDING', '${AT}', '${AT}'
    );
  `);
  return { zoneId, zoneUuid, policyUuid, scheduleUuid };
}

function legacyFixture(db, zoneId = 1) {
  db.prepare(`
    INSERT INTO irrigation_schedules (
      irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes,
      enabled, response_mode, sync_version, created_at, updated_at
    ) VALUES (?, 'SWT_1', 20, 10, 1, 'proportional', 3, ?, ?)
  `).run(zoneId, AT, AT);
}

function lifecycleRows(db, policyUuid = 'policy-route', scheduleUuid = 'schedule-route') {
  return {
    policy: db.prepare('SELECT enabled, deleted_at, sync_version FROM irrigation_policies WHERE policy_uuid=?').get(policyUuid),
    schedule: db.prepare('SELECT enabled, deleted_at, condition_policy_uuid, sync_version FROM valve_schedules WHERE schedule_uuid=?').get(scheduleUuid),
    occurrence: db.prepare('SELECT state, decision, decision_reason FROM irrigation_occurrences WHERE schedule_uuid=?').get(scheduleUuid),
  };
}

function clearState(db, deviceEui = VALVE) {
  return {
    settings: db.prepare('SELECT * FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)').all(deviceEui),
    pushes: db.prepare('SELECT * FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) ORDER BY push_id').all(deviceEui),
  };
}

function assertRetired(db, policyUuid = 'policy-route', scheduleUuid = 'schedule-route') {
  const rows = lifecycleRows(db, policyUuid, scheduleUuid);
  assert.equal(rows.policy.enabled, 0);
  assert.equal(rows.policy.deleted_at, null);
  assert.equal(rows.policy.sync_version, 5);
  assert.equal(rows.schedule.enabled, 0);
  assert.ok(rows.schedule.deleted_at);
  assert.equal(rows.schedule.condition_policy_uuid, policyUuid);
  assert.equal(rows.schedule.sync_version, 8);
  assert.equal(rows.occurrence.state, 'SKIPPED');
  assert.equal(rows.occurrence.decision, 'SKIPPED');
}

function assertZoneRetired(db, policyUuid = 'policy-route', scheduleUuid = 'schedule-route') {
  const rows = lifecycleRows(db, policyUuid, scheduleUuid);
  assert.equal(rows.policy.enabled, 0);
  assert.ok(rows.policy.deleted_at);
  assert.equal(rows.policy.sync_version, 5);
  assert.equal(rows.schedule.enabled, 0);
  assert.ok(rows.schedule.deleted_at);
  assert.equal(rows.schedule.condition_policy_uuid, policyUuid);
  assert.equal(rows.schedule.sync_version, 8);
  assert.equal(rows.occurrence.state, 'SKIPPED');
  assert.equal(rows.occurrence.decision, 'SKIPPED');
}

function assertPaused(db, policyUuid = 'policy-route', scheduleUuid = 'schedule-route') {
  const rows = lifecycleRows(db, policyUuid, scheduleUuid);
  assert.equal(rows.policy.enabled, 0);
  assert.equal(rows.policy.deleted_at, null);
  assert.equal(rows.policy.sync_version, 5);
  assert.equal(rows.schedule.enabled, 1);
  assert.equal(rows.schedule.deleted_at, null);
  assert.equal(rows.schedule.condition_policy_uuid, policyUuid);
  assert.equal(rows.schedule.sync_version, 7);
  assert.equal(rows.occurrence.state, 'SKIPPED');
  assert.equal(rows.occurrence.decision, 'SKIPPED');
}

function assertNoRetirement(db) {
  const policy = db.prepare("SELECT enabled, sync_version FROM irrigation_policies WHERE policy_uuid='policy-route'").get();
  const schedule = db.prepare("SELECT enabled, deleted_at, sync_version FROM valve_schedules WHERE schedule_uuid='schedule-route'").get();
  assert.equal(policy.enabled, 1);
  assert.equal(policy.sync_version, 4);
  assert.equal(schedule.enabled, 1);
  assert.equal(schedule.deleted_at, null);
  assert.equal(schedule.sync_version, 7);
}

function close(db) {
  try { db.close(); } catch (_) { /* test cleanup */ }
}

test('scoped wrappers apply conditional lifecycle to zone delete, unassign, and assign', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb(VALVE);
  try {
    policyFixture(db);
    const deleted = await executeFunction(loadNode('scoped-zone-delete-router'), {
      // z-1 has both the owner and a viewer grant; an admin is required for
      // this configured multi-holder zone-delete route.
      msg: request(1, 'admin1', 'DELETE', '/api/irrigation-zones/1', { id: '1' }),
      env: ENV,
      db,
    });
    assert.equal(deleted.result[1].statusCode, 202);
    assert.ok(db.prepare("SELECT deleted_at FROM irrigation_zones WHERE id=1").get().deleted_at);
    assertZoneRetired(db);
    assert.equal(db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui=?").get(SOURCE).irrigation_zone_id, null);

    close(db);

    const assignedDb = seedScopedDb(VALVE);
    try {
      policyFixture(assignedDb, { sourceDevice: TARGET });
      assignedDb.prepare('UPDATE devices SET irrigation_zone_id=NULL, updated_at=? WHERE deveui=?').run(AT, TARGET);
      const assigned = await executeFunction(loadNode('scoped-device-assign-router'), {
        msg: request(2, 'res1', 'POST', '/api/irrigation-zones/1/devices/DENDRO2', { id: '1', deveui: TARGET }),
        env: ENV,
        db: assignedDb,
      });
      assert.equal(assigned.result[1].statusCode, 200);
      assert.equal(assignedDb.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(TARGET).irrigation_zone_id, 1);
      assertNoRetirement(assignedDb);
    } finally {
      close(assignedDb);
    }
  } finally {
    // The first database was closed before the assignment fixture.
    close(db);
  }
});

test('scoped unassign wrapper pauses a configured policy and preserves device identity', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb(VALVE);
  try {
    policyFixture(db, { sourceDevice: SOURCE });
    const result = await executeFunction(loadNode('scoped-device-unassign-router'), {
      msg: request(2, 'res1', 'DELETE', '/api/irrigation-zones/1/devices/DENDRO1', { id: '1', deveui: SOURCE }),
      env: ENV,
      db,
    });
    assert.equal(result.result[1].statusCode, 202);
    const device = db.prepare('SELECT user_id, irrigation_zone_id, sync_version FROM devices WHERE deveui=?').get(SOURCE);
    assert.equal(device.user_id, 2);
    assert.equal(device.irrigation_zone_id, null);
    assert.equal(device.sync_version, 2);
    assertPaused(db);
  } finally {
    close(db);
  }
});

test('flag-off wrappers still use the canonical mutation boundary for legacy disable, disable-all, and unclaim', async () => {
  const offEnv = { ...ENV, OSI_SCOPED_ACCESS: '0' };

  const legacyDb = seedScopedDb(VALVE);
  try {
    policyFixture(legacyDb);
    legacyFixture(legacyDb);
    legacyDb.prepare('UPDATE devices SET irrigation_zone_id=2 WHERE deveui=?').run(VALVE);
    const result = await executeFunction(loadNode('conditional-legacy-schedule-adapter'), {
      msg: {
        payload: [legacyDb.prepare('SELECT * FROM irrigation_zones WHERE id=1').get()],
        authUsername: 'res1',
        osi: { request: { kind: 'zone_schedule_put', zoneId: 1, actorId: 2, username: 'res1', validatedPatch: { enabled: false } } },
      },
      env: offEnv,
      db: legacyDb,
    });
    assert.equal(result.result[1].statusCode, 202);
    assert.equal(result.result[1].payload.clear_results.length, 1);
    assert.equal(result.result[1].payload.clear_results[0].pending, true);
    assert.equal(legacyDb.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 0);
    assertPaused(legacyDb);
    assert.equal(legacyDb.prepare("SELECT json_extract(conditional_control_json, '$.mode') AS mode FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)").get(VALVE).mode, 'LIFECYCLE_CLEAR');
  } finally {
    close(legacyDb);
  }

  const disableAllDb = seedScopedDb(VALVE);
  try {
    policyFixture(disableAllDb);
    disableAllDb.prepare('UPDATE devices SET irrigation_zone_id=2 WHERE deveui=?').run(VALVE);
    const result = await executeFunction(loadNode('settings-disable-schedules-fn'), {
      msg: request(2, 'res1', 'POST', '/api/irrigation-zones/schedules/disable-all'),
      env: offEnv,
      db: disableAllDb,
    });
    assert.equal(result.result.statusCode, 202);
    assertPaused(disableAllDb);
    assert.equal(disableAllDb.prepare("SELECT json_extract(conditional_control_json, '$.mode') AS mode FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)").get(VALVE).mode, 'LIFECYCLE_CLEAR');
    assert.equal(disableAllDb.prepare("SELECT COUNT(*) AS n FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose='WEEKDAY_PLAN'").get(VALVE).n, 7);
  } finally {
    close(disableAllDb);
  }

  const unclaimDb = seedScopedDb(VALVE);
  try {
    policyFixture(unclaimDb);
    const result = await executeFunction(loadNode('delete-device-unlink'), {
      msg: {
        payload: [{ id: 2 }],
      },
      env: offEnv,
      flowState: { delete_device_deveui: VALVE },
      db: unclaimDb,
    });
    // S6: a detach that applied answers 200; the pending clear is reported as valve_cleanup.
    assert.equal(result.result[1].statusCode, 200);
    assert.equal(result.result[1].payload.valve_cleanup.outcome, 'clearing_scheduled');
    assert.equal(result.result[1].payload.clear_results[0].pending, true);
    const device = unclaimDb.prepare('SELECT user_id, irrigation_zone_id, gateway_device_eui FROM devices WHERE deveui=?').get(VALVE);
    assert.equal(device.user_id, null);
    assert.equal(device.irrigation_zone_id, null);
    assert.equal(device.gateway_device_eui, GATEWAY);
    assertRetired(unclaimDb);
  } finally {
    close(unclaimDb);
  }
});

test('flag-off assign and unassign wrappers require the owner actor before mutation', async () => {
  const offEnv = { ...ENV, OSI_SCOPED_ACCESS: '0' };
  const assignDb = seedScopedDb(VALVE);
  try {
    assignDb.prepare('UPDATE devices SET irrigation_zone_id=NULL WHERE deveui=?').run(TARGET);
    policyFixture(assignDb, { sourceDevice: TARGET });
    const deniedAssign = await executeFunction(loadNode('assign-device-update'), {
      msg: { payload: [assignDb.prepare('SELECT * FROM devices WHERE deveui=?').get(TARGET)] },
      env: offEnv,
      flowState: {
        assign_zone_id: 1,
        assign_deveui: TARGET,
        assign_user_id: 1,
        assign_zone_gateway_device_eui: GATEWAY,
      },
      db: assignDb,
    });
    assert.equal(deniedAssign.result[1].statusCode, 404);
    assertNoRetirement(assignDb);
    assert.equal(assignDb.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(TARGET).irrigation_zone_id, null);
  } finally {
    close(assignDb);
  }

  const unassignDb = seedScopedDb(VALVE);
  try {
    policyFixture(unassignDb);
    const deniedUnassign = await executeFunction(loadNode('unassign-device-update'), {
      msg: {
        payload: [{ id: 1 }],
        req: { params: { id: '1', deveui: SOURCE } },
      },
      env: offEnv,
      db: unassignDb,
    });
    assert.equal(deniedUnassign.result[1].statusCode, 404);
    assertNoRetirement(unassignDb);
    assert.equal(unassignDb.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(SOURCE).irrigation_zone_id, 1);
  } finally {
    close(unassignDb);
  }
});

for (const profile of PROFILES) {
  test(`${profile}: complete scoped and flag-off lifecycle wrapper matrix keeps DENDRO membership and physical clear outcomes`, async () => {
    scopeHelper._resetForTests();
    const scopedDeleteDb = seedScopedDb(VALVE);
    try {
      policyFixture(scopedDeleteDb);
      const result = await runNode(profile, 'scoped-zone-delete-router', {
        msg: request(1, 'admin1', 'DELETE', '/api/irrigation-zones/1', { id: '1' }), env: ENV, db: scopedDeleteDb,
      });
      assert.equal(result.result[1].statusCode, 202);
      assertZoneRetired(scopedDeleteDb);
    } finally { close(scopedDeleteDb); }

    const scopedAssignDb = seedScopedDb(VALVE);
    try {
      policyFixture(scopedAssignDb, { sourceDevice: TARGET });
      scopedAssignDb.prepare('UPDATE devices SET irrigation_zone_id=NULL, user_id=2 WHERE deveui=?').run(TARGET);
      const result = await runNode(profile, 'scoped-device-assign-router', {
        msg: request(2, 'res1', 'POST', '/api/irrigation-zones/1/devices/DENDRO2', { id: '1', deveui: TARGET }), env: ENV, db: scopedAssignDb,
      });
      assert.equal(result.result[1].statusCode, 200);
      assertNoRetirement(scopedAssignDb);
      assert.equal(scopedAssignDb.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(TARGET).irrigation_zone_id, 1);
    } finally { close(scopedAssignDb); }

    const scopedDendroDb = seedScopedDb(VALVE);
    try {
      policyFixture(scopedDendroDb, { sourceDevice: SOURCE });
      scopedDendroDb.prepare('UPDATE devices SET dendro_enabled=1 WHERE deveui=?').run(SOURCE);
      scopedDendroDb.prepare('UPDATE irrigation_policies SET condition_json=? WHERE policy_uuid=?').run(JSON.stringify({ kind: 'DENDRO', sources: [] }), 'policy-route');
      const result = await runNode(profile, 'scoped-device-unassign-router', {
        msg: request(2, 'res1', 'DELETE', '/api/irrigation-zones/1/devices/DENDRO1', { id: '1', deveui: SOURCE }), env: ENV, db: scopedDendroDb,
      });
      assert.equal(result.result[1].statusCode, 202);
      assertPaused(scopedDendroDb);
    } finally { close(scopedDendroDb); }

    const scopedUnclaimDb = seedScopedDb(VALVE);
    try {
      policyFixture(scopedUnclaimDb);
      const result = await runNode(profile, 'scoped-device-delete-router', {
        msg: request(2, 'res1', 'DELETE', '/api/devices/0016C001F1000001', { deveui: VALVE }), env: ENV, db: scopedUnclaimDb,
      });
      // S6: a detach that applied answers 200; the pending clear is reported as valve_cleanup.
      assert.equal(result.result[1].statusCode, 200);
      assert.equal(result.result[1].payload.valve_cleanup.outcome, 'clearing_scheduled');
      assert.equal(result.result[1].payload.clear_results[0].pending, true);
      assertRetired(scopedUnclaimDb);
      assert.equal(scopedUnclaimDb.prepare('SELECT user_id FROM devices WHERE deveui=?').get(VALVE).user_id, null);
    } finally { close(scopedUnclaimDb); }

    const offEnv = { ...ENV, OSI_SCOPED_ACCESS: '0' };
    const flagDeleteDb = seedScopedDb(VALVE);
    try {
      policyFixture(flagDeleteDb);
      const result = await runNode(profile, 'scoped-zone-delete-router', {
        msg: request(2, 'res1', 'DELETE', '/api/irrigation-zones/1', { id: '1' }), env: offEnv, db: flagDeleteDb,
      });
      assert.equal(result.result[1].statusCode, 202);
      assertZoneRetired(flagDeleteDb);
    } finally { close(flagDeleteDb); }

    const flagAssignDb = seedScopedDb(VALVE);
    try {
      policyFixture(flagAssignDb, { sourceDevice: TARGET });
      flagAssignDb.prepare('UPDATE devices SET irrigation_zone_id=NULL, user_id=2 WHERE deveui=?').run(TARGET);
      const result = await runNode(profile, 'assign-device-update', {
        msg: { payload: [flagAssignDb.prepare('SELECT * FROM devices WHERE deveui=?').get(TARGET)] }, env: offEnv,
        flowState: { assign_zone_id: 1, assign_deveui: TARGET, assign_user_id: 2, assign_zone_gateway_device_eui: GATEWAY }, db: flagAssignDb,
      });
      assert.equal(result.result[1].statusCode, 200);
      assertNoRetirement(flagAssignDb);
    } finally { close(flagAssignDb); }

    const flagUnassignDb = seedScopedDb(VALVE);
    try {
      policyFixture(flagUnassignDb);
      const result = await runNode(profile, 'unassign-device-update', {
        msg: { payload: [{ id: 2 }], req: { params: { id: '1', deveui: SOURCE } } }, env: offEnv, db: flagUnassignDb,
      });
      assert.equal(result.result[1].statusCode, 202);
      assertPaused(flagUnassignDb);
    } finally { close(flagUnassignDb); }

    const flagUnclaimDb = seedScopedDb(VALVE);
    try {
      policyFixture(flagUnclaimDb);
      const result = await runNode(profile, 'delete-device-unlink', {
        msg: { payload: [{ id: 2 }] }, env: offEnv, flowState: { delete_device_deveui: VALVE }, db: flagUnclaimDb,
      });
      // S6: a detach that applied answers 200; the pending clear is reported as valve_cleanup.
      assert.equal(result.result[1].statusCode, 200);
      assert.equal(result.result[1].payload.valve_cleanup.outcome, 'clearing_scheduled');
      assert.equal(result.result[1].payload.clear_results[0].pending, true);
      assertRetired(flagUnclaimDb);
    } finally { close(flagUnclaimDb); }

    const scopedLegacyDb = seedScopedDb(VALVE);
    try {
      policyFixture(scopedLegacyDb);
      legacyFixture(scopedLegacyDb);
      const result = await runNode(profile, 'conditional-legacy-schedule-adapter', {
        msg: {
          payload: [scopedLegacyDb.prepare('SELECT * FROM irrigation_zones WHERE id=1').get()],
          authUsername: 'res1',
          osi: { request: { kind: 'zone_schedule_put', zoneId: 1, actorId: 2, username: 'res1', validatedPatch: { enabled: false } } },
        },
        env: ENV,
        db: scopedLegacyDb,
      });
      assert.equal(result.result[1].statusCode, 202);
      assert.equal(result.result[1].payload.clear_results.length, 1);
      assert.equal(result.result[1].payload.clear_results[0].pending, true);
      assert.equal(scopedLegacyDb.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 0);
      assertPaused(scopedLegacyDb);
    } finally { close(scopedLegacyDb); }

    const scopedDisableAllDb = seedScopedDb(VALVE);
    try {
      policyFixture(scopedDisableAllDb);
      const result = await runNode(profile, 'settings-disable-schedules-fn', {
        msg: request(2, 'res1', 'POST', '/api/irrigation-zones/schedules/disable-all'),
        env: ENV,
        db: scopedDisableAllDb,
      });
      assert.equal(result.result.statusCode, 202);
      assert.equal(result.result.payload.disabledSchedules, 1);
      assertPaused(scopedDisableAllDb);
    } finally { close(scopedDisableAllDb); }

    const flagLegacyDb = seedScopedDb(VALVE);
    try {
      policyFixture(flagLegacyDb);
      legacyFixture(flagLegacyDb);
      flagLegacyDb.prepare('UPDATE devices SET irrigation_zone_id=2 WHERE deveui=?').run(VALVE);
      const result = await runNode(profile, 'conditional-legacy-schedule-adapter', {
        msg: {
          payload: [flagLegacyDb.prepare('SELECT * FROM irrigation_zones WHERE id=1').get()],
          authUsername: 'res1',
          osi: { request: { kind: 'zone_schedule_put', zoneId: 1, actorId: 2, username: 'res1', validatedPatch: { enabled: false } } },
        },
        env: offEnv,
        db: flagLegacyDb,
      });
      assert.equal(result.result[1].statusCode, 202);
      assert.equal(result.result[1].payload.clear_results.length, 1);
      assert.equal(result.result[1].payload.clear_results[0].pending, true);
      assert.equal(flagLegacyDb.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 0);
      assertPaused(flagLegacyDb);
    } finally { close(flagLegacyDb); }

    const flagDisableAllDb = seedScopedDb(VALVE);
    try {
      policyFixture(flagDisableAllDb);
      flagDisableAllDb.prepare('UPDATE devices SET irrigation_zone_id=2 WHERE deveui=?').run(VALVE);
      const result = await runNode(profile, 'settings-disable-schedules-fn', {
        msg: request(2, 'res1', 'POST', '/api/irrigation-zones/schedules/disable-all'),
        env: offEnv,
        db: flagDisableAllDb,
      });
      assert.equal(result.result.statusCode, 202);
      assert.equal(result.result.payload.disabledSchedules, 1);
      assertPaused(flagDisableAllDb);
    } finally { close(flagDisableAllDb); }
  });
}

test('scoped fresh scope denial after writer discovery leaves policy and membership unchanged', async () => {
    scopeHelper._resetForTests();
    const db = seedScopedDb(VALVE);
  const originalApply = policyService.applyLifecycleMutation;
  let freshAuthCalls = 0;
  policyService.applyLifecycleMutation = async function(options) {
    return originalApply.call(this, {
      ...options,
      authorizeAfterWriters: async function(freshDb, input) {
        freshAuthCalls += 1;
        db.prepare("UPDATE user_zone_assignments SET deleted_at=? WHERE assignment_uuid='g-1'").run(AT);
        db.prepare('UPDATE irrigation_zones SET user_id=1 WHERE id=1').run();
        return options.authorizeAfterWriters(freshDb, input);
      },
    });
  };
  try {
    policyFixture(db);
    const result = await executeFunction(loadNode('scoped-device-unassign-router'), {
      msg: request(2, 'res1', 'DELETE', '/api/irrigation-zones/1/devices/DENDRO1', { id: '1', deveui: SOURCE }),
      env: ENV,
      db,
    });
    assert.equal(result.result[1].statusCode, 404);
    assert.equal(freshAuthCalls, 1, 'route must perform a fresh authorization after writer discovery');
    assertNoRetirement(db);
    assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(SOURCE).irrigation_zone_id, 1);
  } finally {
    policyService.applyLifecycleMutation = originalApply;
    scopeHelper._resetForTests();
    close(db);
  }
});

test('lifecycle wrappers fail closed when context or helpers are missing without mutating state', async () => {
  const db = seedScopedDb(VALVE);
  try {
    const beforeZone = db.prepare('SELECT deleted_at, sync_version FROM irrigation_zones WHERE id=1').get();
    // F5 (#377): the node checks its own zone_delete envelope before the lifecycle runs and
    // fails closed by throwing to the tab's catch (500), the contract
    // scripts/test-request-context-isolation.js pins for every zone delete chain node.
    await assert.rejects(executeFunction(loadNode('delete-zone-unassign'), {
      msg: { payload: [db.prepare('SELECT * FROM irrigation_zones WHERE id=1').get()] },
      env: ENV,
      db,
    }), /^Error: zone delete request context mismatch$/);
    assert.deepEqual(db.prepare('SELECT deleted_at, sync_version FROM irrigation_zones WHERE id=1').get(), beforeZone);

    const missingHelpers = await executeFunction(loadNode('delete-device-unlink'), {
      msg: { payload: [{ id: 2 }] },
      env: ENV,
      flowState: { delete_device_deveui: VALVE },
      db,
      libOverrides: { osiDb: undefined, osiLib: undefined },
    });
    assert.equal(missingHelpers.result[1].statusCode, 503);
    const unchanged = db.prepare('SELECT user_id, irrigation_zone_id FROM devices WHERE deveui=?').get(VALVE);
    assert.equal(unchanged.user_id, 2);
    assert.equal(unchanged.irrigation_zone_id, 1);
  } finally {
    close(db);
  }
});

function cloudEnvelope(commandId, commandType, payload, effectKey = `lifecycle:${commandType}:${commandId}`) {
  return {
    commandId,
    commandType,
    eventUuid: `11111111-1111-4111-8111-${String(commandId).padStart(12, '0')}`,
    aggregateType: 'DEVICE',
    aggregateKey: payload.deviceEui || payload.device_eui || VALVE,
    effectKey,
    payload: {
      ...payload,
      commandType,
      effect_key: effectKey,
      appliedSyncVersion: payload.appliedSyncVersion == null ? 1 : payload.appliedSyncVersion,
    },
  };
}

async function cloudCall(db, envelope, profile = 'bcm2712', options = {}) {
  const transportState = options.transportState || null;
  const transport = {
    async getDeviceQueue() { return []; },
    async flushDeviceQueue() { return { ok: true }; },
    async enqueueDownlink() {
      if (transportState) transportState.enqueueCalls = Number(transportState.enqueueCalls || 0) + 1;
      return { ok: true };
    },
  };
  return runNode(profile, 'conditional-lifecycle-command-adapter', {
    msg: { payload: { _pendingCommandEnvelope: envelope }, _commandTypeRecognized: true },
    env: options.env || ENV,
    db,
    libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } },
  });
}

for (const profile of PROFILES) {
  test(`${profile}: cloud lifecycle wrapper applies assign, unassign, unclaim, and managed legacy disable with durable ACKs`, async () => {
    const offset = PROFILES.indexOf(profile) * 10;
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db, { sourceDevice: TARGET });
      db.prepare('UPDATE devices SET irrigation_zone_id=NULL WHERE deveui=?').run(TARGET);

      const assign = await cloudCall(db, cloudEnvelope(501 + offset, 'ASSIGN_DEVICE_TO_ZONE', {
        deviceEui: TARGET, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2,
      }), profile);
      assert.equal(assign.result[1].payload.result, 'APPLIED');
      assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(TARGET).irrigation_zone_id, 1);
      assertNoRetirement(db);

      const unassign = await cloudCall(db, cloudEnvelope(502 + offset, 'REMOVE_DEVICE_FROM_ZONE', {
        deviceEui: TARGET, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      }), profile);
      assert.equal(unassign.result[1].payload.result, 'APPLIED');
      assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(TARGET).irrigation_zone_id, null);

      const unclaim = await cloudCall(db, cloudEnvelope(503 + offset, 'UNCLAIM_DEVICE', {
        deviceEui: VALVE, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 4,
      }), profile);
      assert.equal(unclaim.result[1].payload.result, 'APPLIED');
      assert.equal(db.prepare('SELECT user_id, irrigation_zone_id FROM devices WHERE deveui=?').get(VALVE).user_id, null);
      assertRetired(db);
      const ackCount = db.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n;
      assert.equal(ackCount, 3);
    } finally {
      close(db);
    }

    const legacyDb = seedScopedDb(VALVE);
    try {
      policyFixture(legacyDb);
      legacyFixture(legacyDb);
      const transportState = { enqueueCalls: 0 };
      const legacy = await cloudCall(legacyDb, cloudEnvelope(504 + offset, 'UPDATE_SCHEDULE', {
        zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, enabled: false, appliedSyncVersion: 5,
      }), profile, { transportState });
      assert.equal(legacy.result[1].payload.result, 'APPLIED');
      assert.equal(legacyDb.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 0);
      assertPaused(legacyDb);
      assert.equal(transportState.enqueueCalls, 7);
      assert.equal(legacyDb.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
      assert.equal(legacyDb.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
    } finally {
      close(legacyDb);
    }
  });
}

for (const profile of PROFILES) {
  test(`${profile}: cloud lifecycle adapter persists a terminal ACK through the real route`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      const result = await cloudCall(db, cloudEnvelope(550 + PROFILES.indexOf(profile), 'UNCLAIM_DEVICE', {
        deviceEui: VALVE, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2,
      }), profile);
      assert.equal(result.result[1].payload.result, 'APPLIED');
      assert.equal(db.prepare('SELECT user_id, irrigation_zone_id FROM devices WHERE deveui=?').get(VALVE).user_id, null);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
    } finally {
      close(db);
    }
  });
}

for (const profile of PROFILES) {
  test(`${profile}: generic cloud lifecycle versions reject stale conflicts before mutation and accept exact replay`, async () => {
    const staleAssignDb = seedScopedDb(VALVE);
    try {
      policyFixture(staleAssignDb, { sourceDevice: TARGET });
      staleAssignDb.prepare('UPDATE devices SET irrigation_zone_id=2, sync_version=9 WHERE deveui=?').run(TARGET);
      const before = staleAssignDb.prepare('SELECT irrigation_zone_id, sync_version FROM devices WHERE deveui=?').get(TARGET);
      const result = await cloudCall(staleAssignDb, cloudEnvelope(5700 + PROFILES.indexOf(profile), 'ASSIGN_DEVICE_TO_ZONE', {
        deviceEui: TARGET, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      }), profile);
      assert.equal(result.result[1].payload.result, 'REJECTED_PERMANENT');
      assert.equal(result.result[1].payload.reason, 'stale_sync_version');
      assert.deepEqual(staleAssignDb.prepare('SELECT irrigation_zone_id, sync_version FROM devices WHERE deveui=?').get(TARGET), before);
      assertNoRetirement(staleAssignDb);
    } finally { close(staleAssignDb); }

    const staleRemoveDb = seedScopedDb(VALVE);
    try {
      policyFixture(staleRemoveDb);
      staleRemoveDb.prepare('UPDATE devices SET sync_version=9 WHERE deveui=?').run(SOURCE);
      const before = staleRemoveDb.prepare('SELECT irrigation_zone_id, sync_version FROM devices WHERE deveui=?').get(SOURCE);
      const result = await cloudCall(staleRemoveDb, cloudEnvelope(5710 + PROFILES.indexOf(profile), 'REMOVE_DEVICE_FROM_ZONE', {
        deviceEui: SOURCE, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      }), profile);
      assert.equal(result.result[1].payload.result, 'REJECTED_PERMANENT');
      assert.equal(result.result[1].payload.reason, 'stale_sync_version');
      assert.deepEqual(staleRemoveDb.prepare('SELECT irrigation_zone_id, sync_version FROM devices WHERE deveui=?').get(SOURCE), before);
      assertNoRetirement(staleRemoveDb);
    } finally { close(staleRemoveDb); }

    const staleUnclaimDb = seedScopedDb(VALVE);
    try {
      policyFixture(staleUnclaimDb);
      staleUnclaimDb.prepare('UPDATE devices SET sync_version=9 WHERE deveui=?').run(VALVE);
      const before = staleUnclaimDb.prepare('SELECT user_id, irrigation_zone_id, gateway_device_eui, sync_version FROM devices WHERE deveui=?').get(VALVE);
      const result = await cloudCall(staleUnclaimDb, cloudEnvelope(5720 + PROFILES.indexOf(profile), 'UNCLAIM_DEVICE', {
        deviceEui: VALVE, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      }), profile);
      assert.equal(result.result[1].payload.result, 'REJECTED_PERMANENT');
      assert.equal(result.result[1].payload.reason, 'stale_sync_version');
      assert.deepEqual(staleUnclaimDb.prepare('SELECT user_id, irrigation_zone_id, gateway_device_eui, sync_version FROM devices WHERE deveui=?').get(VALVE), before);
      assertNoRetirement(staleUnclaimDb);
    } finally { close(staleUnclaimDb); }

    const exactAssignDb = seedScopedDb(VALVE);
    try {
      policyFixture(exactAssignDb, { sourceDevice: TARGET });
      exactAssignDb.prepare('UPDATE devices SET irrigation_zone_id=1, gateway_device_eui=?, sync_version=3 WHERE deveui=?').run(GATEWAY, TARGET);
      const beforeDevice = exactAssignDb.prepare('SELECT irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(TARGET);
      const beforeLife = lifecycleRows(exactAssignDb);
      const beforeClear = clearState(exactAssignDb);
      const transportState = { enqueueCalls: 0 };
      const envelope = cloudEnvelope(5760 + PROFILES.indexOf(profile) * 10, 'ASSIGN_DEVICE_TO_ZONE', {
        deviceEui: TARGET, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      });
      const first = await cloudCall(exactAssignDb, envelope, profile, { transportState });
      const firstAck = first.result[1].payload;
      assert.equal(firstAck.result, 'APPLIED');
      assert.deepEqual(exactAssignDb.prepare('SELECT irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(TARGET), beforeDevice);
      assert.deepEqual(lifecycleRows(exactAssignDb), beforeLife);
      assert.deepEqual(clearState(exactAssignDb), beforeClear);
      assert.equal(transportState.enqueueCalls, 0);
      const replay = await cloudCall(exactAssignDb, envelope, profile, { transportState });
      assert.deepEqual(replay.result[1].payload, firstAck);
      assert.deepEqual(exactAssignDb.prepare('SELECT irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(TARGET), beforeDevice);
      assert.deepEqual(lifecycleRows(exactAssignDb), beforeLife);
      assert.deepEqual(clearState(exactAssignDb), beforeClear);
      assert.equal(exactAssignDb.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get(String(envelope.commandId)).n, 1);
      assert.equal(exactAssignDb.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get(String(envelope.commandId)).n, 1);
      assert.equal(transportState.enqueueCalls, 0);
    } finally { close(exactAssignDb); }

    const exactRemoveDb = seedScopedDb(VALVE);
    try {
      policyFixture(exactRemoveDb);
      exactRemoveDb.prepare('UPDATE devices SET irrigation_zone_id=NULL, sync_version=3 WHERE deveui=?').run(SOURCE);
      const beforeDevice = exactRemoveDb.prepare('SELECT irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(SOURCE);
      const beforeLife = lifecycleRows(exactRemoveDb);
      const beforeClear = clearState(exactRemoveDb);
      const transportState = { enqueueCalls: 0 };
      const envelope = cloudEnvelope(5761 + PROFILES.indexOf(profile) * 10, 'REMOVE_DEVICE_FROM_ZONE', {
        deviceEui: SOURCE, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      });
      const first = await cloudCall(exactRemoveDb, envelope, profile, { transportState });
      const firstAck = first.result[1].payload;
      assert.equal(firstAck.result, 'APPLIED');
      assert.deepEqual(exactRemoveDb.prepare('SELECT irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(SOURCE), beforeDevice);
      assert.deepEqual(lifecycleRows(exactRemoveDb), beforeLife);
      assert.deepEqual(clearState(exactRemoveDb), beforeClear);
      assert.equal(transportState.enqueueCalls, 0);
      const replay = await cloudCall(exactRemoveDb, envelope, profile, { transportState });
      assert.deepEqual(replay.result[1].payload, firstAck);
      assert.deepEqual(exactRemoveDb.prepare('SELECT irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(SOURCE), beforeDevice);
      assert.deepEqual(lifecycleRows(exactRemoveDb), beforeLife);
      assert.deepEqual(clearState(exactRemoveDb), beforeClear);
      assert.equal(exactRemoveDb.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get(String(envelope.commandId)).n, 1);
      assert.equal(exactRemoveDb.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get(String(envelope.commandId)).n, 1);
      assert.equal(transportState.enqueueCalls, 0);
    } finally { close(exactRemoveDb); }

    const exactUnclaimDb = seedScopedDb(VALVE);
    try {
      policyFixture(exactUnclaimDb);
      exactUnclaimDb.prepare('UPDATE devices SET user_id=NULL, irrigation_zone_id=NULL, gateway_device_eui=?, sync_version=3 WHERE deveui=?').run(GATEWAY, VALVE);
      const beforeDevice = exactUnclaimDb.prepare('SELECT user_id, irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(VALVE);
      const beforeLife = lifecycleRows(exactUnclaimDb);
      const beforeClear = clearState(exactUnclaimDb);
      const transportState = { enqueueCalls: 0 };
      const envelope = cloudEnvelope(5762 + PROFILES.indexOf(profile) * 10, 'UNCLAIM_DEVICE', {
        deviceEui: VALVE, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      });
      const first = await cloudCall(exactUnclaimDb, envelope, profile, { transportState });
      const firstAck = first.result[1].payload;
      assert.equal(firstAck.result, 'APPLIED');
      assert.deepEqual(exactUnclaimDb.prepare('SELECT user_id, irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(VALVE), beforeDevice);
      assert.deepEqual(lifecycleRows(exactUnclaimDb), beforeLife);
      assert.deepEqual(clearState(exactUnclaimDb), beforeClear);
      assert.equal(transportState.enqueueCalls, 0);
      const replay = await cloudCall(exactUnclaimDb, envelope, profile, { transportState });
      assert.deepEqual(replay.result[1].payload, firstAck);
      assert.deepEqual(exactUnclaimDb.prepare('SELECT user_id, irrigation_zone_id, gateway_device_eui, sync_version, updated_at FROM devices WHERE deveui=?').get(VALVE), beforeDevice);
      assert.deepEqual(lifecycleRows(exactUnclaimDb), beforeLife);
      assert.deepEqual(clearState(exactUnclaimDb), beforeClear);
      assert.equal(exactUnclaimDb.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get(String(envelope.commandId)).n, 1);
      assert.equal(exactUnclaimDb.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get(String(envelope.commandId)).n, 1);
      assert.equal(transportState.enqueueCalls, 0);
    } finally { close(exactUnclaimDb); }

    for (const commandType of ['UPSERT_SCHEDULE', 'UPDATE_SCHEDULE']) {
      const staleScheduleDb = seedScopedDb(VALVE);
      try {
        policyFixture(staleScheduleDb);
        legacyFixture(staleScheduleDb);
        staleScheduleDb.prepare('UPDATE irrigation_schedules SET sync_version=9, trigger_metric=\'SWT_WM2\' WHERE irrigation_zone_id=1').run();
        const before = staleScheduleDb.prepare('SELECT trigger_metric, enabled, sync_version FROM irrigation_schedules WHERE irrigation_zone_id=1').get();
        const result = await cloudCall(staleScheduleDb, cloudEnvelope(5730 + PROFILES.indexOf(profile) * 2 + (commandType === 'UPDATE_SCHEDULE' ? 1 : 0), commandType, {
          zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, triggerMetric: 'OLDER', thresholdKpa: 1, durationMinutes: 1, enabled: false, appliedSyncVersion: 3,
        }), profile);
        assert.equal(result.result[1].payload.result, 'REJECTED_PERMANENT');
        assert.equal(result.result[1].payload.reason, 'stale_sync_version');
        assert.deepEqual(staleScheduleDb.prepare('SELECT trigger_metric, enabled, sync_version FROM irrigation_schedules WHERE irrigation_zone_id=1').get(), before);
        assertNoRetirement(staleScheduleDb);
      } finally { close(staleScheduleDb); }
    }

    const managedOmittedEnabledDb = seedScopedDb(VALVE);
    try {
      policyFixture(managedOmittedEnabledDb);
      legacyFixture(managedOmittedEnabledDb);
      managedOmittedEnabledDb.prepare('UPDATE irrigation_schedules SET sync_version=3 WHERE irrigation_zone_id=1').run();
      const before = managedOmittedEnabledDb.prepare('SELECT enabled, sync_version FROM irrigation_policies WHERE policy_uuid=?').get('policy-route');
      const result = await cloudCall(managedOmittedEnabledDb, cloudEnvelope(5735 + PROFILES.indexOf(profile), 'UPDATE_SCHEDULE', {
        zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, triggerMetric: 'SWT_1', thresholdKpa: 20, durationMinutes: 10, responseMode: 'proportional', appliedSyncVersion: 3,
      }), profile);
      assert.equal(result.result[1].payload.result, 'REJECTED_PERMANENT');
      assert.equal(result.result[1].payload.reason, 'managed_schedule_conflict');
      assert.deepEqual(managedOmittedEnabledDb.prepare('SELECT enabled, sync_version FROM irrigation_policies WHERE policy_uuid=?').get('policy-route'), before);
      assert.equal(managedOmittedEnabledDb.prepare('SELECT enabled, sync_version FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 1);
    } finally { close(managedOmittedEnabledDb); }

    const managedNullEnabledDb = seedScopedDb(VALVE);
    try {
      policyFixture(managedNullEnabledDb);
      legacyFixture(managedNullEnabledDb);
      managedNullEnabledDb.prepare('UPDATE irrigation_schedules SET sync_version=3 WHERE irrigation_zone_id=1').run();
      const result = await cloudCall(managedNullEnabledDb, cloudEnvelope(5737 + PROFILES.indexOf(profile), 'UPDATE_SCHEDULE', {
        zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, triggerMetric: 'SWT_1', thresholdKpa: 20, durationMinutes: 10, responseMode: 'proportional', enabled: null, appliedSyncVersion: 3,
      }), profile);
      assert.equal(result.result[1].payload.result, 'REJECTED_PERMANENT');
      assert.equal(result.result[1].payload.reason, 'managed_schedule_conflict');
      assert.equal(managedNullEnabledDb.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 1);
    } finally { close(managedNullEnabledDb); }

    const managedExactReplayDb = seedScopedDb(VALVE);
    try {
      policyFixture(managedExactReplayDb);
      legacyFixture(managedExactReplayDb);
      managedExactReplayDb.prepare('UPDATE irrigation_policies SET enabled=0 WHERE policy_uuid=?').run('policy-route');
      managedExactReplayDb.prepare('UPDATE irrigation_schedules SET enabled=0, sync_version=3 WHERE irrigation_zone_id=1').run();
      const result = await cloudCall(managedExactReplayDb, cloudEnvelope(5738 + PROFILES.indexOf(profile), 'UPDATE_SCHEDULE', {
        zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, triggerMetric: 'SWT_1', thresholdKpa: 20, durationMinutes: 10, responseMode: 'proportional', enabled: false, appliedSyncVersion: 3,
      }), profile);
      assert.equal(result.result[1].payload.result, 'APPLIED');
      assert.equal(managedExactReplayDb.prepare("SELECT COUNT(*) AS n FROM valve_settings WHERE UPPER(device_eui)=UPPER(?) AND conditional_control_json IS NOT NULL").get(VALVE).n, 0);
      assert.equal(managedExactReplayDb.prepare('SELECT sync_version FROM irrigation_schedules WHERE irrigation_zone_id=1').get().sync_version, 3);
    } finally { close(managedExactReplayDb); }

    const equalConflictDb = seedScopedDb(VALVE);
    try {
      legacyFixture(equalConflictDb);
      equalConflictDb.prepare('UPDATE irrigation_schedules SET sync_version=3 WHERE irrigation_zone_id=1').run();
      const result = await cloudCall(equalConflictDb, cloudEnvelope(5736 + PROFILES.indexOf(profile), 'UPSERT_SCHEDULE', {
        zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, triggerMetric: 'SWT_WM2', thresholdKpa: 20, durationMinutes: 10, enabled: true, responseMode: 'proportional', appliedSyncVersion: 3,
      }), profile);
      assert.equal(result.result[1].payload.result, 'REJECTED_PERMANENT');
      assert.equal(result.result[1].payload.reason, 'version_conflict');
      assert.equal(equalConflictDb.prepare('SELECT trigger_metric, sync_version FROM irrigation_schedules WHERE irrigation_zone_id=1').get().trigger_metric, 'SWT_1');
    } finally { close(equalConflictDb); }

    const replayDb = seedScopedDb(VALVE);
    try {
      legacyFixture(replayDb);
      replayDb.prepare('UPDATE irrigation_schedules SET trigger_metric=\'SWT_1\', threshold_kpa=20, duration_minutes=10, enabled=1, response_mode=\'proportional\', sync_version=3 WHERE irrigation_zone_id=1').run();
      const replay = await cloudCall(replayDb, cloudEnvelope(5740 + PROFILES.indexOf(profile), 'UPDATE_SCHEDULE', {
        zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, triggerMetric: 'SWT_1', thresholdKpa: 20, durationMinutes: 10, enabled: true, responseMode: 'proportional', appliedSyncVersion: 3,
      }), profile);
      assert.equal(replay.result[1].payload.result, 'APPLIED');
      assert.equal(replayDb.prepare('SELECT sync_version FROM irrigation_schedules WHERE irrigation_zone_id=1').get().sync_version, 3);
      assert.equal(replayDb.prepare('SELECT COUNT(*) AS n FROM irrigation_policies').get().n, 0);
    } finally { close(replayDb); }
  });
}

function versionedDeleteEnvelope(commandId, base = 1, gateway = GATEWAY, zoneGateway = gateway) {
  const target = base + 1;
  const eventUuid = `22222222-2222-4222-8222-${String(commandId).padStart(12, '0')}`;
  return {
    commandId,
    commandType: 'DELETE_ZONE',
    eventUuid,
    aggregateType: 'ZONE',
    aggregateKey: ZONE_UUID,
    appliedSyncVersion: target,
    effectKey: `zone_delete:${ZONE_UUID}:${base}`,
    payload: {
      command_id: `33333333-3333-4333-8333-${String(commandId).padStart(12, '0')}`,
      command_type: 'DELETE_ZONE',
      effect_key: `zone_delete:${ZONE_UUID}:${base}`,
      zone_uuid: ZONE_UUID,
      gateway_device_eui: gateway,
      base_sync_version: base,
      target_sync_version: target,
      zone: {
        contract_version: 1,
        zone_uuid: ZONE_UUID,
        gateway_device_eui: zoneGateway,
        sync_version: target,
        deleted_at: '2026-10-19T12:00:00.000Z',
      },
    },
  };
}

function canonicalizeZone(db) {
  db.prepare('UPDATE irrigation_zones SET zone_uuid=? WHERE id=1').run(ZONE_UUID);
  db.prepare('UPDATE irrigation_policies SET zone_uuid=? WHERE zone_uuid=?').run(ZONE_UUID, 'z-1');
  db.prepare('UPDATE user_zone_assignments SET zone_uuid=? WHERE zone_uuid=?').run(ZONE_UUID, 'z-1');
  db.prepare('UPDATE journal_plots SET zone_uuid=? WHERE zone_uuid=?').run(ZONE_UUID, 'z-1');
  db.prepare('UPDATE irrigation_occurrences SET zone_uuid=? WHERE zone_uuid=?').run(ZONE_UUID, 'z-1');
}

function seedUnknownHistory(db) {
  db.prepare(`
    INSERT INTO irrigation_occurrences (
      schedule_uuid, local_date, local_time, policy_uuid, zone_uuid, device_eui,
      due_at, policy_revision, schedule_revision, policy_sync_version,
      schedule_sync_version, state, created_at, updated_at
    ) VALUES ('schedule-route', '2026-10-21', '06:00', 'policy-route', 'z-1', ?,
      '2026-10-21T06:00:00.000Z', 1, 1, 4, 7, 'UNKNOWN', ?, ?)
  `).run(VALVE, AT, AT);
  db.prepare(`
    INSERT INTO irrigation_events (
      user_id, irrigation_zone_id, action, reason, duration_minutes,
      valve_deveui, event_uuid, created_at
    ) VALUES (2, 1, 'OPEN_FOR_DURATION', 'history-fixture', 10, ?, ?, ?)
  `).run(VALVE, '44444444-4444-4444-8444-444444444444', AT);
  db.prepare(`
    INSERT INTO valve_actuation_expectations (
      expectation_id, device_eui, zone_id, command_id, effect_key,
      commanded_at, commanded_duration_seconds, expected_close_at,
      volume_source, reconciliation_state, created_at, transport_json
    ) VALUES ('expectation-unknown', ?, 1, 'cloud-owner-1', 'owner:1', ?, 600, ?,
      'unknown', 'PENDING_OBSERVATION', ?, ?)
  `).run(VALVE, AT, '2026-10-19T12:20:00.000Z', AT, JSON.stringify({ phase: 'UNKNOWN' }));
}

for (const profile of PROFILES) {
  test(`${profile}: managed legacy conflict and unmanaged legacy route preserve the old branch`, async () => {
    const managedDb = seedScopedDb(VALVE);
    try {
      policyFixture(managedDb);
      const conflict = await runNode(profile, 'conditional-legacy-schedule-adapter', {
        msg: {
          payload: [managedDb.prepare('SELECT * FROM irrigation_zones WHERE id=1').get()],
          authUsername: 'res1',
          osi: { request: { kind: 'zone_schedule_put', zoneId: 1, actorId: 2, username: 'res1', validatedPatch: { enabled: true, duration_minutes: 99 } } },
        },
        env: ENV,
        db: managedDb,
      });
      assert.equal(conflict.result[1].statusCode, 409);
      assertNoRetirement(managedDb);
    } finally {
      close(managedDb);
    }

    const unmanagedDb = seedScopedDb(VALVE);
    try {
      legacyFixture(unmanagedDb);
      const pass = await runNode(profile, 'conditional-legacy-schedule-adapter', {
        msg: {
          payload: [unmanagedDb.prepare('SELECT * FROM irrigation_zones WHERE id=1').get()],
          authUsername: 'res1',
          osi: { request: { kind: 'zone_schedule_put', zoneId: 1, actorId: 2, username: 'res1', validatedPatch: { enabled: true } } },
        },
        env: ENV,
        db: unmanagedDb,
      });
      assert.equal(pass.result[1].statusCode, 200, 'unmanaged zones must complete through the lifecycle transaction');
      assert.equal(unmanagedDb.prepare('SELECT enabled FROM irrigation_schedules WHERE irrigation_zone_id=1').get().enabled, 1);
    } finally {
      close(unmanagedDb);
    }
  });

  test(`${profile}: scoped disable-all pauses policy-only zones and returns a distinct-zone count`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      const targetValve = '0016C001F1000003';
      db.prepare("INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES (?, 'Valve 2', 'STREGA_VALVE', 1, 2, ?, ?)").run(targetValve, AT, AT);
      policyFixture(db, { zoneId: 2, zoneUuid: 'z-2', policyUuid: 'policy-route-2', scheduleUuid: 'schedule-route-2', sourceDevice: TARGET, valve: targetValve });
      const result = await runNode(profile, 'settings-disable-schedules-fn', {
        msg: request(2, 'res1', 'POST', '/api/irrigation-zones/schedules/disable-all'),
        env: ENV,
        db,
      });
      assert.equal(result.result.statusCode, 202);
      assert.equal(result.result.payload.disabledSchedules, 2);
      assert.equal(db.prepare("SELECT enabled FROM irrigation_policies WHERE policy_uuid='policy-route'").get().enabled, 0);
      assert.equal(db.prepare("SELECT enabled FROM irrigation_policies WHERE policy_uuid='policy-route-2'").get().enabled, 0);
      assert.equal(db.prepare("SELECT enabled,deleted_at FROM valve_schedules WHERE schedule_uuid='schedule-route-2'").get().enabled, 1);
      assert.equal(db.prepare("SELECT deleted_at FROM irrigation_policies WHERE policy_uuid='policy-route-2'").get().deleted_at, null);
    } finally {
      close(db);
    }
  });

  test(`${profile}: versioned DELETE_ZONE rejects stale and wrong-owner commands without retirement, then clears after commit and replays`, async () => {
    const staleDb = seedScopedDb(VALVE);
    try {
      policyFixture(staleDb);
      canonicalizeZone(staleDb);
      const stale = await runNode(profile, 'zone-command-apply-fn', {
        msg: { payload: { _pendingCommandEnvelope: versionedDeleteEnvelope(601, 0), }, _commandTypeRecognized: true },
        env: ENV,
        db: staleDb,
      });
      const staleAck = JSON.parse(stale.result[1].payload);
      assert.equal(staleAck.result, 'CONFLICT');
      assertNoRetirement(staleDb);
      assert.equal(staleDb.prepare('SELECT deleted_at FROM irrigation_zones WHERE id=1').get().deleted_at, null);
      assert.equal(staleDb.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=601').get().n, 1);
    } finally {
      close(staleDb);
    }

    const wrongOwnerDb = seedScopedDb(VALVE);
    try {
      policyFixture(wrongOwnerDb);
      canonicalizeZone(wrongOwnerDb);
      wrongOwnerDb.prepare('UPDATE irrigation_zones SET gateway_device_eui=? WHERE id=1').run('0016C001F10000FF');
      const wrong = await runNode(profile, 'zone-command-apply-fn', {
        msg: { payload: { _pendingCommandEnvelope: versionedDeleteEnvelope(602), }, _commandTypeRecognized: true },
        env: ENV,
        db: wrongOwnerDb,
      });
      const wrongAck = JSON.parse(wrong.result[1].payload);
      assert.equal(wrongAck.result, 'REJECTED_PERMANENT');
      assertNoRetirement(wrongOwnerDb);
    } finally {
      close(wrongOwnerDb);
    }

    const appliedDb = seedScopedDb(VALVE);
    try {
      policyFixture(appliedDb);
      seedUnknownHistory(appliedDb);
      canonicalizeZone(appliedDb);
      const transport = {
        async getDeviceQueue() { return []; },
        async flushDeviceQueue() { throw Object.assign(new Error('unknown owner'), { code: 'transport_uncertain' }); },
        async enqueueDownlink() { throw Object.assign(new Error('must not enqueue while owner unknown'), { code: 'unexpected_enqueue' }); },
      };
      const envelope = versionedDeleteEnvelope(603);
      const options = {
        msg: { payload: { _pendingCommandEnvelope: envelope }, _commandTypeRecognized: true },
        env: ENV,
        db: appliedDb,
        libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } },
      };
      const first = await runNode(profile, 'zone-command-apply-fn', options);
      const firstAck = JSON.parse(first.result[1].payload);
      assert.equal(firstAck.result, 'APPLIED');
      assert.equal(firstAck.clear_results.length, 1);
      assert.equal(firstAck.clear_results[0].pending, true);
      assert.equal(appliedDb.prepare('SELECT deleted_at FROM irrigation_zones WHERE id=1').get().deleted_at, '2026-10-19T12:00:00.000Z');
      assert.equal(appliedDb.prepare("SELECT state FROM irrigation_occurrences WHERE local_date='2026-10-21'").get().state, 'UNKNOWN');
      assert.equal(appliedDb.prepare("SELECT state FROM irrigation_occurrences WHERE local_date='2026-10-20'").get().state, 'SKIPPED');
      assert.equal(appliedDb.prepare('SELECT COUNT(*) AS n FROM irrigation_events').get().n, 1);
      assert.equal(appliedDb.prepare('SELECT COUNT(*) AS n FROM valve_actuation_expectations').get().n, 1);
      assert.equal(appliedDb.prepare('SELECT user_id FROM irrigation_events WHERE event_uuid=?').get('44444444-4444-4444-8444-444444444444').user_id, 2);
      assert.equal(appliedDb.prepare('SELECT command_id FROM valve_actuation_expectations WHERE expectation_id=?').get('expectation-unknown').command_id, 'cloud-owner-1');
      const replay = await runNode(profile, 'zone-command-apply-fn', options);
      const replayAck = JSON.parse(replay.result[1].payload);
      assert.equal(replayAck.commandId, 603);
      assert.equal(replayAck.duplicate, false, 'exact replay returns the durable terminal ACK');
      assert.equal(appliedDb.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=603').get().n, 1);
      assert.equal(appliedDb.prepare('SELECT sync_version FROM irrigation_zones WHERE id=1').get().sync_version, 2);
    } finally {
      close(appliedDb);
    }
  });

  test(`${profile}: stale post-commit sender is obsolete and cannot enqueue against a reclaimed valve`, async () => {
    const spec = profileSpec(profile);
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      let enqueueCalls = 0;
      const transport = {
        async getDeviceQueue() { return []; },
        async flushDeviceQueue() { return { ok: true }; },
        async enqueueDownlink() { enqueueCalls += 1; return { ok: true, queue_id: 'q-stale' }; },
      };
      const result = await spec.service.applyLifecycleMutation({
        db: {
          ...require('./lib/scoped-access-harness').facadeDb(db),
        },
        operation: 'device_unclaim',
        deviceEui: VALVE,
        gatewayDeviceEui: GATEWAY,
        now: '2026-10-19T13:00:00.000Z',
        sendPreparedLifecycleClear: async (clear) => {
          db.prepare('UPDATE devices SET irrigation_zone_id=1,user_id=2 WHERE deveui=?').run(VALVE);
          return spec.push.sendPreparedLifecycleClear({ db: clear.db, deviceEui: clear.device_eui, revision: clear.revision, transport, now: clear.now });
        },
      });
      assert.equal(result.clear_results.length, 1);
      assert.equal(result.clear_results[0].obsolete, true);
      assert.equal(enqueueCalls, 0);
    } finally {
      close(db);
    }
  });
}

for (const profile of PROFILES) {
  test(`${profile}: DELETE_ZONE retires an attached policy schedule after its valve moved without clearing new-zone authority`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      canonicalizeZone(db);
      db.prepare('UPDATE devices SET irrigation_zone_id=2 WHERE deveui=?').run(VALVE);
      db.prepare(`
        INSERT INTO valve_schedules (
          schedule_uuid, device_eui, kind, label, weekdays_mask, start_time,
          duration_minutes, timezone, enabled, sync_version, created_at, updated_at
        ) VALUES ('schedule-current', ?, 'WEEKLY', 'Current authority', 127,
          '07:00', 5, 'UTC', 1, 2, ?, ?)
      `).run(VALVE, AT, AT);
      const result = await runNode(profile, 'zone-command-apply-fn', {
        msg: { payload: { _pendingCommandEnvelope: versionedDeleteEnvelope(650 + PROFILES.indexOf(profile)) }, _commandTypeRecognized: true },
        env: ENV,
        db,
      });
      const ack = JSON.parse(result.result[1].payload);
      assert.equal(ack.result, 'APPLIED');
      assert.equal((ack.clear_results || []).length, 0);
      assert.ok(db.prepare("SELECT deleted_at FROM valve_schedules WHERE schedule_uuid='schedule-route'").get().deleted_at);
      assert.equal(db.prepare("SELECT enabled, deleted_at FROM valve_schedules WHERE schedule_uuid='schedule-current'").get().enabled, 1);
      assert.equal(db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui=?").get(VALVE).irrigation_zone_id, 2);
    } finally {
      close(db);
    }
  });

  test(`${profile}: DELETE_ZONE sends one durable physical clear for a moved valve with no replacement authority`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      seedUnknownHistory(db);
      canonicalizeZone(db);
      db.prepare('UPDATE devices SET irrigation_zone_id=2 WHERE deveui=?').run(VALVE);
      let enqueueCalls = 0;
      const transport = {
        async getDeviceQueue() { return []; },
        async flushDeviceQueue() { return { ok: true }; },
        async enqueueDownlink() { enqueueCalls += 1; return { ok: true, queue_id: `q-clear-${enqueueCalls}` }; },
      };
      const result = await runNode(profile, 'zone-command-apply-fn', {
        msg: { payload: { _pendingCommandEnvelope: versionedDeleteEnvelope(670 + PROFILES.indexOf(profile)) }, _commandTypeRecognized: true },
        env: ENV,
        db,
        libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } },
      });
      const ack = JSON.parse(result.result[1].payload);
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.clear_results.length, 1);
      assert.equal(ack.clear_results[0].sent, 7);
      assert.equal(enqueueCalls, 7);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose='WEEKDAY_PLAN'").get(VALVE).n, 7);
      assert.ok(db.prepare("SELECT deleted_at FROM valve_schedules WHERE schedule_uuid='schedule-route'").get().deleted_at);
      assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(VALVE).irrigation_zone_id, 2);
      assert.equal(db.prepare("SELECT condition_policy_uuid FROM valve_schedules WHERE schedule_uuid='schedule-route'").get().condition_policy_uuid, 'policy-route');
      assert.equal(db.prepare("SELECT json_extract(conditional_control_json, '$.mode') AS mode FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)").get(VALVE).mode, 'LIFECYCLE_CLEAR');
      assert.equal(db.prepare('SELECT user_id FROM irrigation_events WHERE event_uuid=?').get('44444444-4444-4444-8444-444444444444').user_id, 2);
      assert.equal(db.prepare('SELECT command_id FROM valve_actuation_expectations WHERE expectation_id=?').get('expectation-unknown').command_id, 'cloud-owner-1');
    } finally { close(db); }
  });
}

test('writer membership drift while the real writer is held rolls back and retries with the fresh complete set', async () => {
  const spec = profileSpec('bcm2712');
  const db = seedScopedDb(VALVE);
  let release;
  let held;
  const heldReady = new Promise((resolve) => { held = resolve; });
  const releaseHeld = new Promise((resolve) => { release = resolve; });
  try {
    policyFixture(db);
    const writerHold = spec.dispatch.withValveWriters([VALVE], async () => {
      held();
      await releaseHeld;
    });
    await heldReady;
    const pending = spec.service.applyLifecycleMutation({
      db: facadeDb(db),
      operation: 'device_unassign', deviceEui: SOURCE, zoneId: 1, now: '2026-10-19T14:00:00.000Z',
    });
    await new Promise((resolve) => setImmediate(resolve));
    db.prepare("INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES ('0016C001F1000004','Valve drift','STREGA_VALVE',2,1,?,?)").run(AT, AT);
    release();
    const [result] = await Promise.all([pending, writerHold]);
    assert.equal(result.status, 202);
    assert.equal(db.prepare('SELECT irrigation_zone_id FROM devices WHERE deveui=?').get(SOURCE).irrigation_zone_id, null);
  } finally {
    close(db);
  }
});

test('opposite-order multiwriter requests serialize on one canonical valve order', async () => {
  const spec = profileSpec('bcm2712');
  const secondValve = '0016C001F1000003';
  const entered = [];
  let release;
  const releaseHeld = new Promise((resolve) => { release = resolve; });
  const first = spec.dispatch.withValveWriters([VALVE, secondValve], async () => {
    entered.push('first');
    await releaseHeld;
    return 'first-done';
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = spec.dispatch.withValveWriters([secondValve, VALVE], async () => {
    entered.push('second');
    return 'second-done';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, ['first'], 'reverse request must wait behind the shared ordered writer set');
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first-done', 'second-done']);
  assert.deepEqual(entered, ['first', 'second']);
});

// S6 (owner decision 2026-10-22): the lifecycle service owns unclaim on both paths. A detach
// that applied answers 200 (local) or APPLIED (cloud) whatever the cleanup did, carries W1's
// AUTH-09 cleanup outcome (valve_cleanup on the body, valveCleanup + reason on the ACK), an
// unknown device answers 404 / REJECTED_PERMANENT, and nothing sends a CLOSE.
const CLEANUP_KEYS = ['attempted', 'clearing_downlinks_sent', 'device_eui', 'final', 'in_flight_cancel', 'in_flight_cancel_error',
  'may_still_hold_plan', 'outcome', 'plan_clear_confirmed', 'reason', 'schedules_cleared', 'whole_queue_flushed'];

function assertNoClose(db, deviceEui = VALVE) {
  const pushes = db.prepare('SELECT fport, payload_hex, purpose FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?)').all(deviceEui);
  for (const row of pushes) {
    assert.ok(!(Number(row.fport) === 1 && String(row.payload_hex).toLowerCase() === '30'), 'unclaim must never queue a CLOSE');
    assert.notEqual(row.purpose, 'VALVE_COMMAND');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?)').get(deviceEui).n, 0,
    'unclaim must never create an actuation');
}

async function localUnclaim(profile, db, deviceEui, { scoped = false } = {}) {
  if (scoped) {
    return runNode(profile, 'scoped-device-delete-router', {
      msg: request(2, 'res1', 'DELETE', '/api/devices/' + deviceEui, { deveui: deviceEui }), env: ENV, db,
    });
  }
  return runNode(profile, 'delete-device-unlink', {
    msg: { payload: [{ id: 2 }] }, env: { ...ENV, OSI_SCOPED_ACCESS: '0' }, flowState: { delete_device_deveui: deviceEui }, db,
  });
}

for (const profile of PROFILES) {
  for (const scoped of [false, true]) {
    const mode = scoped ? 'scoped' : 'flag-off';
    test(`${profile} ${mode}: local unclaim of a programmed valve answers 200 with valve_cleanup clearing_scheduled and no CLOSE`, async () => {
      const db = seedScopedDb(VALVE);
      try {
        policyFixture(db);
        const result = await localUnclaim(profile, db, VALVE, { scoped });
        const response = result.result[1];
        assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
        // R19 finding 1: the message says the clear is scheduled, not plain success.
        assert.equal(response.payload.message, 'Device removed. Clearing the valve plan is scheduled; the valve may keep its program until it confirms the clear.');
        const cleanup = response.payload.valve_cleanup;
        assert.deepEqual(Object.keys(cleanup).sort(), CLEANUP_KEYS);
        assert.equal(cleanup.outcome, 'clearing_scheduled');
        assert.equal(cleanup.attempted, true);
        assert.equal(cleanup.device_eui, VALVE);
        assert.equal(cleanup.schedules_cleared, 1);
        assert.equal(cleanup.may_still_hold_plan, true);
        assert.equal(cleanup.plan_clear_confirmed, false);
        assert.equal(db.prepare('SELECT user_id FROM devices WHERE deveui=?').get(VALVE).user_id, null);
        assertRetired(db);
        assertNoClose(db);
      } finally { close(db); }
    });

    test(`${profile} ${mode}: local unclaim of a sensor answers 200 with valve_cleanup not_applicable`, async () => {
      const db = seedScopedDb(VALVE);
      try {
        const result = await localUnclaim(profile, db, SOURCE, { scoped });
        const response = result.result[1];
        assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
        assert.equal(response.payload.valve_cleanup.outcome, 'not_applicable');
        assert.equal(response.payload.valve_cleanup.reason, 'not_a_valve');
        assert.equal(response.payload.valve_cleanup.may_still_hold_plan, false);
      } finally { close(db); }
    });

    test(`${profile} ${mode}: local unclaim of an unprogrammed valve answers 200 with no_plan_to_clear`, async () => {
      const db = seedScopedDb(VALVE);
      try {
        const result = await localUnclaim(profile, db, VALVE, { scoped });
        const response = result.result[1];
        assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
        assert.equal(response.payload.valve_cleanup.outcome, 'no_plan_to_clear');
        assert.equal(response.payload.valve_cleanup.may_still_hold_plan, null);
        assertNoClose(db);
      } finally { close(db); }
    });

    test(`${profile} ${mode}: local unclaim of an unknown device answers 404`, async () => {
      const db = seedScopedDb(VALVE);
      try {
        const result = await localUnclaim(profile, db, 'AABBCCDDEEFF0099', { scoped });
        assert.equal(result.result[1].statusCode, 404);
      } finally { close(db); }
    });
  }
}

for (const profile of PROFILES) {
  const offset = 9100 + PROFILES.indexOf(profile) * 20;
  test(`${profile}: cloud UNCLAIM_DEVICE ACK carries valveCleanup and reason, durably, and stays APPLIED`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      const envelope = cloudEnvelope(offset + 1, 'UNCLAIM_DEVICE', {
        deviceEui: VALVE, zoneId: 1, zoneUuid: 'z-1', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2,
      });
      const first = await cloudCall(db, envelope, profile);
      const ack = first.result[1].payload;
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.status, 'ACKED');
      assert.deepEqual(Object.keys(ack.valveCleanup).sort(), CLEANUP_KEYS);
      assert.equal(ack.valveCleanup.outcome, 'clearing_scheduled');
      assert.equal(ack.valveCleanup.schedules_cleared, 1);
      assert.equal(ack.valveCleanup.may_still_hold_plan, true);
      assert.equal(ack.valveCleanup.plan_clear_confirmed, false);
      assert.equal(ack.reason, 'valve_cleanup_clearing_scheduled');
      const queued = JSON.parse(db.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').get(String(envelope.commandId)).payload_json);
      assert.deepEqual(queued.valveCleanup, ack.valveCleanup, 'the outbox ACK carries the cleanup outcome');
      const replay = await cloudCall(db, envelope, profile);
      assert.deepEqual(replay.result[1].payload.valveCleanup, ack.valveCleanup, 'a replay reports the committed outcome');
      assertNoClose(db);
    } finally { close(db); }
  });

  test(`${profile}: cloud UNCLAIM_DEVICE of a sensor keeps the old reason beside a not_applicable valveCleanup`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      const ack = (await cloudCall(db, cloudEnvelope(offset + 2, 'UNCLAIM_DEVICE', {
        deviceEui: SOURCE, gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2,
      }), profile)).result[1].payload;
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.valveCleanup.outcome, 'not_applicable');
      assert.equal(ack.valveCleanup.reason, 'not_a_valve');
      assert.equal(ack.reason, null);
    } finally { close(db); }
  });

  test(`${profile}: cloud UNCLAIM_DEVICE refused by the fence is REJECTED_PERMANENT stale_sync_version, cleanup not attempted`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      db.prepare('UPDATE devices SET sync_version=9 WHERE deveui=?').run(VALVE);
      const ack = (await cloudCall(db, cloudEnvelope(offset + 3, 'UNCLAIM_DEVICE', {
        deviceEui: VALVE, gatewayDeviceEui: GATEWAY, appliedSyncVersion: 3,
      }), profile)).result[1].payload;
      assert.equal(ack.result, 'REJECTED_PERMANENT');
      assert.equal(ack.reason, 'stale_sync_version');
      assert.equal(ack.valveCleanup.outcome, 'not_attempted');
      assert.equal(ack.valveCleanup.reason, 'stale_sync_version');
      assert.equal(ack.valveCleanup.attempted, false);
      assertNoRetirement(db);
    } finally { close(db); }
  });

  test(`${profile}: cloud UNCLAIM_DEVICE of an unknown device is REJECTED_PERMANENT device_not_found`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      const ack = (await cloudCall(db, cloudEnvelope(offset + 4, 'UNCLAIM_DEVICE', {
        deviceEui: 'AABBCCDDEEFF0099', gatewayDeviceEui: GATEWAY, appliedSyncVersion: 1,
      }), profile)).result[1].payload;
      assert.equal(ack.result, 'REJECTED_PERMANENT');
      assert.equal(ack.reason, 'device_not_found');
      assert.equal(ack.valveCleanup.outcome, 'not_applicable');
      assert.equal(ack.valveCleanup.reason, 'not_found');
    } finally { close(db); }
  });

  test(`${profile}: cloud UNCLAIM_DEVICE whose clear send fails is still APPLIED with the clear scheduled`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      const failing = {
        async getDeviceQueue() { throw new Error('chirpstack down'); },
        async flushDeviceQueue() { throw new Error('chirpstack down'); },
        async enqueueDownlink() { throw new Error('chirpstack down'); },
      };
      const result = await runNode(profile, 'conditional-lifecycle-command-adapter', {
        msg: { payload: { _pendingCommandEnvelope: cloudEnvelope(offset + 5, 'UNCLAIM_DEVICE', {
          deviceEui: VALVE, gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2,
        }) }, _commandTypeRecognized: true },
        env: ENV, db,
        libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => failing } },
      });
      const ack = result.result[1].payload;
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.valveCleanup.outcome, 'clearing_scheduled');
      assert.equal(db.prepare('SELECT user_id FROM devices WHERE deveui=?').get(VALVE).user_id, null);
      assertNoClose(db);
    } finally { close(db); }
  });
}

// Owner decision 2026-10-22: the unclaim cancels queued opens through the D19(a) cancel path,
// never sends a CLOSE, lets a running open run out, and in_flight_cancel reports the outcome.
// Owner decision 2026-10-24 (fail closed, Codex P1 on PR #515): a flushed queued open is reported
// handed_off, since the pre-flush read cannot prove it undelivered; it stays observed.
function seedOpen(db, id, state) {
  db.prepare("INSERT INTO valve_actuation_expectations(expectation_id, device_eui, commanded_at, commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, trigger, created_at, transport_json) VALUES (?, ?, ?, 900, ?, 'unknown', ?, 'manual', ?, ?)")
    .run(id, VALVE, AT, '2026-10-19T10:15:00.000Z', state, AT, JSON.stringify({ phase: 'ACCEPTED', queue_id: 'q-' + id, attempted_at: AT }));
}

function queueTransport(queue) {
  const calls = { flush: 0, enqueued: [] };
  return {
    calls,
    async getDeviceQueue() { return queue; },
    async flushDeviceQueue() { calls.flush += 1; return {}; },
    async enqueueDownlink(item) { calls.enqueued.push(item); return { id: 'q-new-' + calls.enqueued.length }; },
  };
}

function expectationState(db, id) {
  return db.prepare('SELECT reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?').get(id).reconciliation_state;
}

for (const profile of PROFILES) {
  for (const scoped of [false, true]) {
    const mode = scoped ? 'scoped' : 'flag-off';
    const nodeId = scoped ? 'scoped-device-delete-router' : 'delete-device-unlink';
    const call = (db, transport) => runNode(profile, nodeId, scoped
      ? { msg: request(2, 'res1', 'DELETE', '/api/devices/' + VALVE, { deveui: VALVE }), env: ENV, db, libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } } }
      : { msg: { payload: [{ id: 2 }] }, env: { ...ENV, OSI_SCOPED_ACCESS: '0' }, flowState: { delete_device_deveui: VALVE }, db, libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } } });

    test(`${profile} ${mode}: local unclaim with a queued open flushes it (in_flight_cancel handed_off), no CLOSE`, async () => {
      const db = seedScopedDb(VALVE);
      try {
        policyFixture(db);
        seedOpen(db, 'e-queued', 'PENDING_OBSERVATION');
        const transport = queueTransport([{ id: 'q-e-queued', fPort: 2, data: 'QQ8=', isPending: false }]);
        const response = (await call(db, transport)).result[1];
        assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
        assert.equal(response.payload.valve_cleanup.in_flight_cancel, 'handed_off');
        assert.match(response.payload.valve_cleanup.reason, /queued_open_may_have_been_sent/);
        assert.equal(expectationState(db, 'e-queued'), 'PENDING_OBSERVATION');
        assert.ok(transport.calls.flush >= 1);
        assert.ok(transport.calls.enqueued.every((item) => Number(item.fPort) !== 1), 'no CLOSE');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM valve_actuation_expectations').get().n, 1, 'unclaim creates no actuation');
      } finally { close(db); }
    });

    test(`${profile} ${mode}: local unclaim during a running open leaves it bounded and says so, no CLOSE`, async () => {
      const db = seedScopedDb(VALVE);
      try {
        policyFixture(db);
        seedOpen(db, 'e-run', 'OBSERVED_RUNNING');
        const transport = queueTransport([]);
        const response = (await call(db, transport)).result[1];
        assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
        assert.equal(response.payload.valve_cleanup.in_flight_cancel, 'already_running');
        assert.match(response.payload.valve_cleanup.reason, /open_running: closes by itself at 2026-10-19T10:15:00.000Z/);
        assert.equal(expectationState(db, 'e-run'), 'OBSERVED_RUNNING');
        assert.ok(transport.calls.enqueued.every((item) => Number(item.fPort) !== 1), 'no CLOSE');
      } finally { close(db); }
    });
  }

  const base = 9300 + PROFILES.indexOf(profile) * 20;
  test(`${profile}: cloud UNCLAIM_DEVICE with a queued open: ACK reports in_flight_cancel handed_off, durably`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      seedOpen(db, 'e-queued', 'PENDING_OBSERVATION');
      const transport = queueTransport([{ id: 'q-e-queued', fPort: 2, data: 'QQ8=', isPending: false }]);
      const envelope = cloudEnvelope(base + 1, 'UNCLAIM_DEVICE', { deviceEui: VALVE, gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2 });
      const run = () => runNode(profile, 'conditional-lifecycle-command-adapter', {
        msg: { payload: { _pendingCommandEnvelope: envelope }, _commandTypeRecognized: true },
        env: ENV, db, libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } },
      });
      const ack = (await run()).result[1].payload;
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.valveCleanup.in_flight_cancel, 'handed_off');
      assert.equal(expectationState(db, 'e-queued'), 'PENDING_OBSERVATION');
      const queued = JSON.parse(db.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id=?').get(String(envelope.commandId)).payload_json);
      assert.equal(queued.valveCleanup.in_flight_cancel, 'handed_off', 'the outbox ACK carries the post-commit outcome');
      assert.equal(ack.valveCleanup.final, true, 'the amended ACK is final');
      assert.equal(queued.valveCleanup.final, true);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get(String(envelope.commandId)).n, 1, 'an undelivered ACK is amended in place');
      const replay = (await run()).result[1].payload;
      assert.deepEqual(replay.valveCleanup, ack.valveCleanup);
      assert.ok(transport.calls.enqueued.every((item) => Number(item.fPort) !== 1), 'no CLOSE');
    } finally { close(db); }
  });

  test(`${profile}: cloud UNCLAIM_DEVICE during a running open: APPLIED, no CLOSE, in_flight_cancel already_running`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      seedOpen(db, 'e-run', 'OBSERVED_RUNNING');
      const transport = queueTransport([]);
      const ack = (await runNode(profile, 'conditional-lifecycle-command-adapter', {
        msg: { payload: { _pendingCommandEnvelope: cloudEnvelope(base + 2, 'UNCLAIM_DEVICE', { deviceEui: VALVE, gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2 }) }, _commandTypeRecognized: true },
        env: ENV, db, libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } },
      })).result[1].payload;
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.valveCleanup.in_flight_cancel, 'already_running');
      assert.match(ack.reason, /open_running: closes by itself/);
      assert.equal(expectationState(db, 'e-run'), 'OBSERVED_RUNNING');
      assert.ok(transport.calls.enqueued.every((item) => Number(item.fPort) !== 1), 'no CLOSE');
    } finally { close(db); }
  });
}

// W13 c215e2a3c: when the commit-time ACK was delivered before the in-flight cancel finished, the
// final outcome goes out as a new ACK row for the same command; final tells the two apart.
for (const profile of PROFILES) {
  test(`${profile}: cloud UNCLAIM_DEVICE whose commit-time ACK was delivered queues a final ACK row`, async () => {
    const db = seedScopedDb(VALVE);
    try {
      policyFixture(db);
      seedOpen(db, 'e-queued', 'PENDING_OBSERVATION');
      const envelope = cloudEnvelope(9400 + PROFILES.indexOf(profile), 'UNCLAIM_DEVICE', { deviceEui: VALVE, gatewayDeviceEui: GATEWAY, appliedSyncVersion: 2 });
      const transport = queueTransport([{ id: 'q-e-queued', fPort: 2, data: 'QQ8=', isPending: false }]);
      const flush = transport.flushDeviceQueue;
      // The ACK sender flushes the outbox while the cancel's flush RPC is in flight.
      transport.flushDeviceQueue = async (...args) => {
        db.prepare("UPDATE command_ack_outbox SET delivered_at='2026-10-19T10:00:01.000Z' WHERE command_id=? AND delivered_at IS NULL").run(String(envelope.commandId));
        return flush(...args);
      };
      const ack = (await runNode(profile, 'conditional-lifecycle-command-adapter', {
        msg: { payload: { _pendingCommandEnvelope: envelope }, _commandTypeRecognized: true },
        env: ENV, db, libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => transport } },
      })).result[1].payload;
      const rows = db.prepare('SELECT payload_json, delivered_at FROM command_ack_outbox WHERE command_id=? ORDER BY id').all(String(envelope.commandId));
      assert.equal(rows.length, 2, 'the final outcome is queued as a second ACK row');
      const provisional = JSON.parse(rows[0].payload_json);
      const final = JSON.parse(rows[1].payload_json);
      assert.notEqual(rows[0].delivered_at, null);
      assert.equal(rows[1].delivered_at, null);
      assert.equal(provisional.result, 'APPLIED');
      assert.equal(provisional.valveCleanup.final, false);
      assert.equal(provisional.valveCleanup.in_flight_cancel, null);
      assert.equal(final.result, 'APPLIED');
      assert.equal(final.valveCleanup.final, true);
      assert.equal(final.valveCleanup.in_flight_cancel, 'handed_off');
      assert.deepEqual(ack, final);
    } finally { close(db); }
  });
}
