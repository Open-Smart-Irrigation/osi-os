'use strict';

// Flow adapters live here so the Node-RED Function nodes stay thin and the
// same lifecycle boundary is exercised by local and cloud routes.

async function scopedZoneDelete(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
let db;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
try {
const scopeLoad = osiLib.require('scope');
if (!scopeLoad.ok) {
  node.error('zone lifecycle: scope module unavailable: ' + scopeLoad.error, msg);
  const error = new Error('scope resolver unavailable');
  error.statusCode = 500;
  throw error;
}
const scope = scopeLoad.value;
const auth = scope.verifyBearer(
  msg.req && msg.req.headers && msg.req.headers.authorization,
  {
    configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
    fs: global.get('fs'),
    warn: function(message) { node.warn(message); }
  }
);
db = new osiDb.Database('/data/db/farming.db');
const actor = await db.get(
  'SELECT id, user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
  [auth.userId, auth.username]
);
if (!actor || !actor.user_uuid) {
  const error = new Error('Unauthorized');
  error.statusCode = 401;
  throw error;
}
const actorScope = await scope.assertFreshRole(
  db,
  actor.user_uuid,
  actor.role,
  { scopedMode: true }
);
if (scopedOn && !scope.canMutate(actorScope.role)) {
  const error = new Error('insufficient role');
  error.statusCode = 403;
  throw error;
}
  const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);
  if (!Number.isInteger(zoneId)) {
    const error = new Error('Invalid zone ID');
    error.statusCode = 400;
    throw error;
  }
  const zone = await db.get(
    'SELECT id, zone_uuid, user_id, sync_version FROM irrigation_zones ' +
    'WHERE id = ? AND deleted_at IS NULL',
    [zoneId]
  );
  if (!zone || !zone.zone_uuid) {
    const error = new Error('zone not found');
    error.statusCode = 404;
    throw error;
  }

  const grantees = await db.all(
    'SELECT user_uuid FROM user_zone_assignments ' +
    'WHERE zone_uuid = ? AND deleted_at IS NULL ORDER BY user_uuid',
    [zone.zone_uuid]
  );
  if (!scopedOn) {
    if (Number(zone.user_id) !== Number(actor.id)) {
      const error = new Error('zone not found');
      error.statusCode = 404;
      throw error;
    }
  } else if (actorScope.role !== 'admin') {
    await scope.assertFreshZoneAccess(
      db,
      actor.user_uuid,
      zone.zone_uuid,
      { scopedMode: true }
    );
    const soleGrant =
      grantees.length === 1 &&
      grantees[0].user_uuid === actor.user_uuid;
    const soleOwner =
      Number(zone.user_id) === Number(actor.id) &&
      grantees.length === 0;
    if (!soleGrant && !soleOwner) {
      const error = new Error('zone has other scope holders; admin required');
      error.statusCode = 409;
      throw error;
    }
  }

  const lifecycleLoad = osiLib.require('osi-irrigation-policy');
  if (!lifecycleLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await lifecycleLoad.value.applyLifecycleMutation({
    db,
    operation: 'zone_delete',
    zoneId,
    actor: { user_id: actor.id, user_uuid: actor.user_uuid, role: actor.role },
    authorizeAfterWriters: async function(freshDb) {
      const freshActor = await freshDb.get('SELECT id, user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1', [actor.id, auth.username]);
      if (!freshActor || !freshActor.user_uuid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      const freshRole = await scope.assertFreshRole(freshDb, freshActor.user_uuid, freshActor.role, { scopedMode: true });
      if (scopedOn && !scope.canMutate(freshRole.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
      const freshZone = await freshDb.get('SELECT id, zone_uuid, user_id FROM irrigation_zones WHERE id=? AND deleted_at IS NULL', [zoneId]);
      if (!freshZone) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
      if (!scopedOn) {
        if (Number(freshZone.user_id) !== Number(freshActor.id)) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
      } else {
        const freshGrantees = await freshDb.all('SELECT user_uuid FROM user_zone_assignments WHERE zone_uuid=? AND deleted_at IS NULL ORDER BY user_uuid', [freshZone.zone_uuid]);
        if (freshRole.role !== 'admin') {
        await scope.assertFreshZoneAccess(freshDb, freshActor.user_uuid, freshZone.zone_uuid, { scopedMode: true });
        const soleGrant = freshGrantees.length === 1 && freshGrantees[0].user_uuid === freshActor.user_uuid;
        const soleOwner = Number(freshZone.user_id) === Number(freshActor.id) && freshGrantees.length === 0;
        if (!soleGrant && !soleOwner) throw Object.assign(new Error('zone has other scope holders; admin required'), { statusCode: 409 });
        }
      }
    },
    now: new Date().toISOString(),
  });
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Zone removed successfully', zone_uuid: zone.zone_uuid, disabledSchedules: lifecycleResult.disabledSchedules || 0, clear_results: lifecycleResult.clear_results || [] };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 404
      ? 'zone not found'
      : (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  return [null, msg];
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('zone delete close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
}

async function scopedDeviceAssign(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
let db;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
try {
const scopeLoad = osiLib.require('scope');
if (!scopeLoad.ok) {
  node.error('scoped provisioning: scope module unavailable: ' + scopeLoad.error, msg);
  throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });
}
const scope = scopeLoad.value;
const auth = scope.verifyBearer(
  msg.req && msg.req.headers && msg.req.headers.authorization,
  {
    configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
    fs: global.get('fs'),
    warn: function(message) { node.warn(message); }
  }
);
db = new osiDb.Database('/data/db/farming.db');
const actor = await db.get(
  'SELECT id, user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
  [auth.userId, auth.username]
);
if (!actor || !actor.user_uuid) {
  throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
}
const actorScope = await scope.assertFreshRole(
  db,
  actor.user_uuid,
  actor.role,
  { scopedMode: true }
);
if (!scope.canMutate(actorScope.role)) {
  throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
}
  const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  if (!Number.isInteger(zoneId) || !deveui) {
    throw Object.assign(new Error('Invalid assignment request'), { statusCode: 400 });
  }
  const zoneUuid = await scope.resolveZoneUuidById(db, zoneId);
  if (!zoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
  await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });
  // W4/P7: assignment operates only on UNASSIGNED devices. The device no longer
  // has to be in the caller's write scope -- it has to be free. The IS NULL
  // predicate is the race-safe precondition; a lost race lands in the 409 below.
  // P11: still a row-wise UPDATE, so trg_sync_devices_outbox_au fires.
  const currentAssignment = await db.get('SELECT irrigation_zone_id FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deveui]);
  if (!currentAssignment) throw Object.assign(new Error('device not found'), { statusCode: 404 });
  if (Number(currentAssignment.irrigation_zone_id) === zoneId) {
    const device = await db.get('SELECT gateway_device_eui, sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [deveui]);
    msg.statusCode = 202;
    msg.payload = { message: 'Device is already assigned to this zone', deveui, irrigation_zone_id: zoneId, irrigation_zone_uuid: zoneUuid, gateway_device_eui: device && device.gateway_device_eui || null, sync_version: Number(device && device.sync_version || 0), deleted_at: null };
    return [null, msg];
  }
  if (currentAssignment.irrigation_zone_id != null) {
    const currentZone = await db.get('SELECT id AS irrigation_zone_id, name AS zone_name, (deleted_at IS NOT NULL) AS current_zone_deleted FROM irrigation_zones WHERE id=?', [currentAssignment.irrigation_zone_id]);
    throw Object.assign(new Error('Device is already assigned to a zone'), { statusCode: 409, conflict: { current_zone_id: Number(currentAssignment.irrigation_zone_id), current_zone_name: currentZone && currentZone.zone_name || null, current_zone_deleted: Boolean(currentZone && currentZone.current_zone_deleted) } });
  }
  const lifecycleLoad = osiLib.require('osi-irrigation-policy');
  if (!lifecycleLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await lifecycleLoad.value.applyLifecycleMutation({
    db,
    operation: 'device_assign',
    deviceEui: deveui,
    zoneId,
    requireUnassigned: true,
    actor: { user_id: actor.id, user_uuid: actor.user_uuid, role: actor.role },
    authorizeAfterWriters: async function(freshDb) {
      const freshActor = await freshDb.get('SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1', [actor.id, auth.username]);
      if (!freshActor || !freshActor.user_uuid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      const freshRole = await scope.assertFreshRole(freshDb, freshActor.user_uuid, freshActor.role, { scopedMode: true });
      if (!scope.canMutate(freshRole.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
      await scope.assertFreshZoneAccess(freshDb, freshActor.user_uuid, zoneUuid, { scopedMode: true });
    },
    now: new Date().toISOString(),
  });
  const assigned = lifecycleResult.device || await db.get('SELECT gateway_device_eui, sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [deveui]);
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Device assigned to zone successfully', deveui, irrigation_zone_id: zoneId, irrigation_zone_uuid: zoneUuid, gateway_device_eui: assigned && assigned.gateway_device_eui || null, sync_version: Number(assigned && assigned.sync_version || 0), deleted_at: null };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 404 ? 'Device not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  if (error && error.conflict) {
    msg.payload.current_zone_id = error.conflict.current_zone_id;
    msg.payload.current_zone_name = error.conflict.current_zone_name;
    msg.payload.current_zone_deleted = error.conflict.current_zone_deleted;
  }
  return [null, msg];
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('scoped provisioning close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
}

async function scopedDeviceUnassign(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
let db;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
try {
const scopeLoad = osiLib.require('scope');
if (!scopeLoad.ok) {
  node.error('scoped provisioning: scope module unavailable: ' + scopeLoad.error, msg);
  throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });
}
const scope = scopeLoad.value;
const auth = scope.verifyBearer(
  msg.req && msg.req.headers && msg.req.headers.authorization,
  {
    configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
    fs: global.get('fs'),
    warn: function(message) { node.warn(message); }
  }
);
db = new osiDb.Database('/data/db/farming.db');
const actor = await db.get(
  'SELECT id, user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
  [auth.userId, auth.username]
);
if (!actor || !actor.user_uuid) {
  throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
}
const actorScope = await scope.assertFreshRole(
  db,
  actor.user_uuid,
  actor.role,
  { scopedMode: true }
);
if (!scope.canMutate(actorScope.role)) {
  throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
}
  const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  if (!Number.isInteger(zoneId) || !deveui) {
    throw Object.assign(new Error('Invalid assignment request'), { statusCode: 400 });
  }
  const zoneUuid = await scope.resolveZoneUuidById(db, zoneId);
  if (!zoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
  await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  const lifecycleLoad = osiLib.require('osi-irrigation-policy');
  if (!lifecycleLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await lifecycleLoad.value.applyLifecycleMutation({
    db,
    operation: 'device_unassign',
    deviceEui: deveui,
    zoneId,
    actor: { user_id: actor.id, user_uuid: actor.user_uuid, role: actor.role },
    authorizeAfterWriters: async function(freshDb) {
      const freshActor = await freshDb.get('SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1', [actor.id, auth.username]);
      if (!freshActor || !freshActor.user_uuid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      const freshRole = await scope.assertFreshRole(freshDb, freshActor.user_uuid, freshActor.role, { scopedMode: true });
      if (!scope.canMutate(freshRole.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
      await scope.assertFreshZoneAccess(freshDb, freshActor.user_uuid, zoneUuid, { scopedMode: true });
      await scope.assertFreshDeviceAccess(freshDb, freshActor.user_uuid, deveui, { scopedMode: true });
    },
    now: new Date().toISOString(),
  });
  const unassigned = lifecycleResult.device || await db.get('SELECT gateway_device_eui, sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [deveui]);
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Device removed from zone successfully', deveui, irrigation_zone_id: null, gateway_device_eui: unassigned && unassigned.gateway_device_eui || null, sync_version: Number(unassigned && unassigned.sync_version || 0), deleted_at: null, clear_results: lifecycleResult.clear_results || [] };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 404 ? 'Device not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  return [null, msg];
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('scoped provisioning close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
}

// Owner decision 2026-10-22: the local unclaim cancels queued opens, so it needs the ChirpStack
// transport. Built lazily (only when there is a queue to touch); null when the node has no
// ChirpStack helper, and the cleanup then reports in_flight_cancel not_attempted.
function unclaimTransport(chirpstack, env, osiLib, node) {
  if (!chirpstack || typeof chirpstack.createProvisioningClientFromEnv !== 'function') return null;
  const valveLoad = osiLib.require('osi-valve-control');
  const push = valveLoad.ok && valveLoad.value && valveLoad.value.push;
  if (!push || typeof push.lazyTransport !== 'function') return null;
  return push.lazyTransport(() => chirpstack.createProvisioningClientFromEnv(env), (message) => node.warn(message));
}

function closeUnclaimTransport(transport) {
  if (transport && typeof transport.close === 'function') transport.close();
}

// S6: the AUTH-09 cleanup outcome of a local unclaim that applied. Building it never turns
// the applied detach into an error: a failure is reported as outcome 'failed'.
function unclaimCleanupFor(lifecycle, deveui, lifecycleResult, node) {
  try {
    return lifecycle.unclaimValveCleanup({ deviceEui: deveui, mutation: lifecycleResult });
  } catch (error) {
    node.error('valve unclaim cleanup outcome failed for ' + deveui + ': ' + String(error && error.message || error));
    return lifecycle.unclaimValveCleanup({ deviceEui: deveui, mutation: lifecycleResult, error });
  }
}

async function scopedDeviceDelete(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
let db;
let scopedTransport = null;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
try {
const scopeLoad = osiLib.require('scope');
if (!scopeLoad.ok) {
  node.error('scoped provisioning: scope module unavailable: ' + scopeLoad.error, msg);
  throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });
}
const scope = scopeLoad.value;
const auth = scope.verifyBearer(
  msg.req && msg.req.headers && msg.req.headers.authorization,
  {
    configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
    fs: global.get('fs'),
    warn: function(message) { node.warn(message); }
  }
);
db = new osiDb.Database('/data/db/farming.db');
const actor = await db.get(
  'SELECT id, user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
  [auth.userId, auth.username]
);
if (!actor || !actor.user_uuid) {
  throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
}
const actorScope = await scope.assertFreshRole(
  db,
  actor.user_uuid,
  actor.role,
  { scopedMode: true }
);
if (!scope.canMutate(actorScope.role)) {
  throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
}
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  if (!deveui) throw Object.assign(new Error('Device EUI is required'), { statusCode: 400 });
  // W10: an unassigned device is deletable by any write role. Without this a
  // mistyped registration is a zombie -- visible and assignable, but never
  // removable, because assertFreshDeviceAccess 404s on a device with no zone.
  // The helper itself is NOT widened: the STREGA actuation dual-gate shares it
  // (P4), so the carve-out lives here, on this route only. A zone-assigned
  // device keeps the unchanged zone write-scope check.
  const target = await db.get(
    'SELECT d.deveui, iz.zone_uuid FROM devices d ' +
    'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL ' +
    'WHERE d.deveui = ? AND d.deleted_at IS NULL',
    [deveui]
  );
  if (!target) throw Object.assign(new Error('device not found'), { statusCode: 404 });
  if (target.zone_uuid) {
    await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  }
  const lifecycleGatewayEui = String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase();
  const lifecycleLoad = osiLib.require('osi-irrigation-policy');
  if (!lifecycleLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const gatewayEui = String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase();
  scopedTransport = unclaimTransport(typeof chirpstack === 'undefined' ? null : chirpstack, env, osiLib, node);
  const lifecycleResult = await lifecycleLoad.value.applyLifecycleMutation({
    db,
    operation: 'device_unclaim',
    deviceEui: deveui,
    gatewayDeviceEui: lifecycleGatewayEui,
    transport: scopedTransport,
    warn: function(message) { node.warn(String(message)); },
    actor: { user_id: actor.id, user_uuid: actor.user_uuid, role: actor.role },
    authorizeAfterWriters: async function(freshDb) {
      const freshActor = await freshDb.get('SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1', [actor.id, auth.username]);
      if (!freshActor || !freshActor.user_uuid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      const freshRole = await scope.assertFreshRole(freshDb, freshActor.user_uuid, freshActor.role, { scopedMode: true });
      if (!scope.canMutate(freshRole.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
      const freshTarget = await freshDb.get('SELECT irrigation_zone_id FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deveui]);
      if (freshTarget && freshTarget.irrigation_zone_id != null) await scope.assertFreshDeviceAccess(freshDb, freshActor.user_uuid, deveui, { scopedMode: true });
    },
    now: new Date().toISOString(),
  });
  // S6: the detach applied, so 200 whatever the valve cleanup did; valve_cleanup says what that was.
  msg.statusCode = 200;
  msg.payload = { message: 'Device removed successfully', device_eui: deveui, gateway_device_eui: lifecycleGatewayEui, valve_cleanup: unclaimCleanupFor(lifecycleLoad.value, deveui, lifecycleResult, node), clear_results: lifecycleResult.clear_results || [] };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 404 ? 'Device not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  return [null, msg];
} finally {
  closeUnclaimTransport(scopedTransport);
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('scoped provisioning close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
}

async function conditionalLegacySchedule(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

  const policyLoad = osiLib.require('osi-irrigation-policy');
  if (!policyLoad.ok) {
    node.error('legacy schedule lifecycle unavailable: ' + policyLoad.error, msg);
    msg.statusCode = 503;
    msg.payload = { message: 'conditional lifecycle service unavailable' };
    return [null, msg];
  }
  let db;
  try {
    const request = (msg.osi || {}).request;
    if (!request || request.kind !== 'zone_schedule_put') throw new Error('schedule request context missing');
    const zone = Array.isArray(msg.payload) ? msg.payload[0] : null;
    if (!zone || Number(zone.id) !== Number(request.zoneId)) {
      msg.statusCode = 404;
      msg.payload = { message: 'Zone not found or access denied' };
      return [null, msg];
    }
    db = new osiDb.Database('/data/db/farming.db');
    const result = await policyLoad.value.applyLifecycleMutation({
      db,
      operation: 'legacy_schedule_write',
      zoneId: request.zoneId,
      actor: { user_id: request.actorId },
      patch: request.validatedPatch,
      authorizeAfterWriters: async function(freshDb) {
        const scoped = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
        const username = String(msg.authUsername || request.username || '').trim();
        const freshActor = username
          ? await freshDb.get('SELECT id, user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1', [request.actorId, username])
          : await freshDb.get('SELECT id, user_uuid, role FROM users WHERE id=? LIMIT 1', [request.actorId]);
        if (!freshActor || !freshActor.user_uuid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
        const freshZone = await freshDb.get('SELECT id, zone_uuid FROM irrigation_zones WHERE id=? AND deleted_at IS NULL', [request.zoneId]);
        if (!freshZone) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
        if (scoped) {
          const scopeLoad = osiLib.require('scope');
          if (!scopeLoad.ok) throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });
          const scope = scopeLoad.value;
          const freshRole = await scope.assertFreshRole(freshDb, freshActor.user_uuid, freshActor.role, { scopedMode: true });
          if (!scope.canMutate(freshRole.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
          await scope.assertFreshZoneAccess(freshDb, freshActor.user_uuid, freshZone.zone_uuid, { scopedMode: true });
        } else {
          const owned = await freshDb.get('SELECT id FROM irrigation_zones WHERE id=? AND user_id=? AND deleted_at IS NULL', [request.zoneId, request.actorId]);
          if (!owned) throw Object.assign(new Error('zone not found or access denied'), { statusCode: 404 });
        }
      },
      now: new Date().toISOString(),
    });
    if (!result.managed) {
      const schedule = result.schedule || {};
      msg.statusCode = result.status || 200;
      msg.payload = {
        irrigation_zone_id: Number(request.zoneId),
        zone_uuid: zone.zone_uuid || null,
        gateway_device_eui: zone.gateway_device_eui || String(env.get('DEVICE_EUI') || 'UNKNOWN').toUpperCase(),
        trigger_metric: schedule.trigger_metric == null ? request.validatedPatch.trigger_metric : schedule.trigger_metric,
        threshold_kpa: schedule.threshold_kpa == null ? request.validatedPatch.threshold_kpa : schedule.threshold_kpa,
        duration_minutes: Number(schedule.duration_minutes == null ? request.validatedPatch.duration_minutes : schedule.duration_minutes),
        enabled: Boolean(Number(schedule.enabled)),
        response_mode: schedule.response_mode || 'proportional',
        sync_version: Number(schedule.sync_version || 0),
        deleted_at: schedule.deleted_at || null,
        last_applied_at: zone.last_applied_at || null,
      };
      return [null, msg];
    }
    msg.statusCode = result.status || 200;
    msg.payload = { message: 'Managed conditional policy paused; legacy schedule disabled', disabledSchedules: result.disabledSchedules || 0, policy: result.policy || null, clear_results: result.clear_results || [] };
    return [null, msg];
  } catch (error) {
    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = { message: error && error.message || 'legacy schedule lifecycle failed', reason: error && error.code || 'lifecycle_error' };
    return [null, msg];
  } finally {
    if (db) {
      try { await new Promise((resolve) => db.close(() => resolve())); }
      catch (closeError) { node.warn('legacy lifecycle DB close failed: ' + String(closeError && closeError.message || closeError)); }
    }
  }
}

async function conditionalLifecycleCommand(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

  const dbLoad = osiLib.require('osi-db-helper');
  const ledgerLoad = osiLib.require('osi-command-ledger');
  const policyLoad = osiLib.require('osi-irrigation-policy');
  const valveLoad = osiLib.require('osi-valve-control');
  if (!dbLoad.ok || !ledgerLoad.ok || !policyLoad.ok || !valveLoad.ok) {
    const detail = [dbLoad, ledgerLoad, policyLoad, valveLoad]
      .filter((load) => !load.ok).map((load) => load.error).join('; ');
    node.error('lifecycle command adapter unavailable: ' + detail, msg);
    return [null, null];
  }
  let command;
  try {
    command = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('lifecycle command parse failed closed: ' + String(parseError && parseError.message || parseError), msg);
    return [null, null];
  }
  const envelope = command._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return [msg, null];
  const commandType = String(envelope.commandType || command.commandType || command.command_type || '').trim().toUpperCase();
  const supported = new Set(['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE', 'UNCLAIM_DEVICE']);
  if (!supported.has(commandType)) return [msg, null];
  const gateway = String(env.get('DEVICE_EUI') || env.get('GATEWAY_DEVICE_EUI') || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(gateway) || !Number.isSafeInteger(envelope.commandId) || envelope.commandId <= 0) {
    node.error('lifecycle command adapter has no trusted gateway or command id', msg);
    return [null, null];
  }
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : command;
  const value = (primary, alternate) => {
    if (payload[primary] !== undefined) return payload[primary];
    if (alternate && payload[alternate] !== undefined) return payload[alternate];
    if (command[primary] !== undefined) return command[primary];
    if (alternate && command[alternate] !== undefined) return command[alternate];
    if (envelope[primary] !== undefined) return envelope[primary];
    if (alternate && envelope[alternate] !== undefined) return envelope[alternate];
    return undefined;
  };
  const requestedSyncVersion = value('appliedSyncVersion', 'applied_sync_version') == null
    ? (value('syncVersion', 'sync_version') == null ? null : Number(value('syncVersion', 'sync_version')))
    : Number(value('appliedSyncVersion', 'applied_sync_version'));
  const input = { now: new Date().toISOString(), syncVersion: requestedSyncVersion };
  let operation;
  if (commandType === 'UPDATE_SCHEDULE' || commandType === 'UPSERT_SCHEDULE') {
    operation = 'legacy_schedule_write';
    input.zoneId = value('zoneId', 'zone_id');
    input.zoneUuid = value('zoneUuid', 'zone_uuid');
    input.patch = {
      trigger_metric: value('triggerMetric', 'trigger_metric') == null ? 'SWT_WM1' : value('triggerMetric', 'trigger_metric'),
      threshold_kpa: value('thresholdKpa', 'threshold_kpa'),
      duration_minutes: value('durationMinutes', 'duration_minutes'),
      response_mode: value('responseMode', 'response_mode') == null ? 'proportional' : value('responseMode', 'response_mode'),
    };
    const enabled = value('enabled');
    if (enabled !== undefined) input.patch.enabled = enabled;
  } else {
    input.deviceEui = value('deviceEui', 'device_eui') || value('devEui', 'dev_eui');
    input.zoneId = value('zoneId', 'zone_id');
    input.zoneUuid = value('zoneUuid', 'zone_uuid');
    input.gatewayDeviceEui = value('gatewayDeviceEui', 'gateway_device_eui') || gateway;
    if (commandType === 'ASSIGN_DEVICE_TO_ZONE') {
      operation = 'device_assign';
      input.zoneId = value('zoneId', 'zone_id');
      input.zoneUuid = value('zoneUuid', 'zone_uuid');
      input.requireUnassigned = false;
    } else if (commandType === 'REMOVE_DEVICE_FROM_ZONE') {
      operation = 'device_unassign';
    } else {
      operation = 'device_unclaim';
    }
  }
  if (requestedSyncVersion != null && (!Number.isSafeInteger(requestedSyncVersion) || requestedSyncVersion < 0)) {
    node.error('lifecycle command has an invalid applied sync version', msg);
    return [null, null];
  }
  const lifecycle = policyLoad.value;
  const dispatch = valveLoad.value.dispatch || valveLoad.value;
  const ledger = ledgerLoad.value;
  const runtime = {
    gateway_device_eui: gateway,
    command_type_recognized: msg._commandTypeRecognized === true,
    now: input.now,
  };
  const ackMessage = (ack) => ({
    topic: 'devices/' + gateway + '/command_ack',
    payload: ack,
    qos: 1,
  });
  const unavailableTransport = () => {
    const fail = () => Promise.reject(Object.assign(new Error('chirpstack_transport_unavailable'), { code: 'transport_unavailable' }));
    return { getDeviceQueue: fail, getQueue: fail, flushDeviceQueue: fail, enqueueDownlink: fail, enqueue: fail };
  };
  let transport;
  try {
    transport = typeof chirpstack !== 'undefined' && chirpstack && typeof chirpstack.createProvisioningClientFromEnv === 'function'
      ? chirpstack.createProvisioningClientFromEnv(env)
      : unavailableTransport();
  } catch (transportError) {
    transport = unavailableTransport();
    node.warn('lifecycle command clear transport unavailable: ' + String(transportError && transportError.message || transportError));
  }
  const db = new dbLoad.value.Database('/data/db/farming.db');
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  const ackBase = {
    commandId: envelope.commandId,
    eventUuid: envelope.eventUuid == null ? (command.eventUuid || null) : envelope.eventUuid,
    aggregateType: envelope.aggregateType == null ? (command.aggregateType || null) : envelope.aggregateType,
    aggregateKey: envelope.aggregateKey == null ? (command.aggregateKey || input.deviceEui || input.zoneUuid || null) : envelope.aggregateKey,
    commandType,
    effectKey: envelope.effectKey || payload.effect_key || payload.effectKey || null,
    deviceEui: input.deviceEui || gateway,
    gatewayDeviceEui: gateway,
    requestedSyncVersion,
    appliedSyncVersion: requestedSyncVersion,
    payload,
  };
  const permanent = (error) => error && Number(error.statusCode || error.status) >= 400 && Number(error.statusCode || error.status) < 500 && error.code !== 'membership_drift';
  const runAckTransaction = (valveEuis, ack) => dispatch.withValveWriters(valveEuis || [], () => ledger.withLifecycleCommandTransaction(db, envelope, runtime, async (scoped) => {
    const durable = await scoped.terminalAck(Object.assign({}, ackBase, ack));
    return { handled: true, ack: durable, clears: [] };
  }));
  let committed;
  let lastError;
  try {
    for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
      let discovered;
      try {
        discovered = await lifecycle.discoverAffectedWriters(db, operation, input);
        const result = await dispatch.withValveWriters(discovered.valveEuis, () => ledger.withLifecycleCommandTransaction(db, envelope, runtime, async (scoped) => {
          if (String(value('gatewayDeviceEui', 'gateway_device_eui') || gateway).trim().toUpperCase() !== gateway) {
            const error = new Error('command gateway does not match this gateway');
            error.statusCode = 409;
            error.code = 'gateway_mismatch';
            throw error;
          }
          const current = await lifecycle.discoverAffectedWriters(scoped.tx, operation, input);
          lifecycle.assertHeld(discovered.valveEuis, current.valveEuis, operation);
          const mutation = await lifecycle.applyLifecycleMutationTx(scoped.tx, operation, input);
          const after = await lifecycle.discoverAffectedWriters(scoped.tx, operation, input);
          lifecycle.assertHeld(discovered.valveEuis, after.valveEuis, operation);
          // S6: UNCLAIM_DEVICE reports the AUTH-09 cleanup outcome with the APPLIED ACK. It is
          // decided in this transaction from the prepared clear and stored with the ACK.
          // A valve's in-flight cancel runs after this commit, so its outcome here is provisional.
          const pendingCancel = !mutation.replayed && String(mutation.device && mutation.device.type_id || '').toUpperCase() === 'STREGA_VALVE';
          const cleanup = operation === 'device_unclaim'
            ? lifecycle.unclaimValveCleanup({ deviceEui: input.deviceEui, mutation, final: !pendingCancel })
            : null;
          const durable = await scoped.terminalAck(Object.assign({}, ackBase, {
            result: 'APPLIED',
            appliedSyncVersion: requestedSyncVersion,
            requestedSyncVersion,
          }, cleanup ? { valveCleanup: cleanup, reason: lifecycle.unclaimAckReason(cleanup) } : {}));
          return { handled: true, ack: durable, clears: mutation.clears || [], unclaimMutation: cleanup && !mutation.replayed ? mutation : null };
        }));
        committed = { result, valveEuis: discovered.valveEuis };
      } catch (error) {
        lastError = error;
        if (error && error.code === 'membership_drift') continue;
        if (permanent(error)) {
          const rejected = await runAckTransaction(discovered ? discovered.valveEuis : [], Object.assign({
            result: 'REJECTED_PERMANENT',
            appliedSyncVersion: requestedSyncVersion,
            requestedSyncVersion,
            reason: error.code || error.message || 'lifecycle_rejected',
            error: error.code || error.message || String(error),
          }, operation === 'device_unclaim'
            ? { valveCleanup: lifecycle.unclaimValveCleanup({ deviceEui: input.deviceEui, refused: error }) }
            : {}));
          committed = { result: rejected, valveEuis: discovered ? discovered.valveEuis : [] };
          break;
        }
        throw error;
      }
    }
    if (!committed) throw lastError || new Error('lifecycle membership kept changing');
    const result = committed.result;
    // Owner decision 2026-10-22: queued opens of the unclaimed valve go before the clear is sent,
    // under the valve writer; the ACK committed with the detach is then amended with the outcome.
    let inFlight;
    if (result && result.unclaimMutation) {
      inFlight = await dispatch.withValveWriters(committed.valveEuis || [], () => lifecycle.cancelUnclaimedValveActuations(db, result.unclaimMutation.device, { transport, warn: (message) => node.warn(String(message)) }, input.now));
    }
    if (result && result.clears && result.clears.length) {
      try {
        result.clear_results = await lifecycle.sendLifecycleClears(db, result.clears, { transport, warn: (message) => node.warn(String(message)) }, input.now);
      } catch (sendError) {
        node.warn('lifecycle clear remains durably pending after command commit: ' + String(sendError && sendError.message || sendError));
      }
    }
    if (result && result.unclaimMutation && inFlight !== undefined) {
      try {
        const cleanup = lifecycle.unclaimValveCleanup({ deviceEui: input.deviceEui, mutation: { ...result.unclaimMutation, in_flight_cancel: inFlight, clear_results: result.clear_results } });
        const reason = lifecycle.unclaimAckReason(cleanup);
        const amended = await ledger.amendTerminalAck(db, envelope.commandId, { valveCleanup: cleanup, reason: reason == null ? null : reason, detail: reason == null ? null : reason });
        if (amended) result.ack = amended;
      } catch (amendError) {
        node.warn('unclaim ACK keeps its commit-time cleanup outcome: ' + String(amendError && amendError.message || amendError));
      }
    }
    return [null, ackMessage(result.ack)];
  } catch (error) {
    node.error('lifecycle command mutation failed closed: ' + String(error && error.message || error), msg);
    try {
      const failure = await runAckTransaction([], Object.assign({
        result: 'FAILED_RETRYABLE',
        appliedSyncVersion: requestedSyncVersion,
        requestedSyncVersion,
        reason: error && error.code || 'lifecycle_retryable',
        error: error && error.message || String(error),
      }, operation === 'device_unclaim'
        ? { valveCleanup: lifecycle.unclaimValveCleanup({ deviceEui: input.deviceEui, refused: { code: 'detach_not_applied' } }) }
        : {}));
      return [null, ackMessage(failure.ack)];
    } catch (ackError) {
      node.error('lifecycle retryable ACK persistence failed: ' + String(ackError && ackError.message || ackError), msg);
      return [null, null];
    }
  } finally {
    try { await close(); } catch (closeError) { node.warn('lifecycle command DB close failed: ' + String(closeError && closeError.message || closeError)); }
  }
}

async function conditionalPolicyCommand(context) {
  const { msg, node, env, osiDb, osiLib, chirpstack } = context;
  const dbLoad = osiLib.require('osi-db-helper');
  const ledgerLoad = osiLib.require('osi-command-ledger');
  const policyLoad = osiLib.require('osi-irrigation-policy');
  const valveLoad = osiLib.require('osi-valve-control');
  const scopeLoad = osiLib.require('scope');
  if (!dbLoad.ok || !ledgerLoad.ok || !policyLoad.ok || !valveLoad.ok || !scopeLoad.ok) {
    const detail = [dbLoad, ledgerLoad, policyLoad, valveLoad, scopeLoad]
      .filter((load) => !load.ok).map((load) => load.error).join('; ');
    node.error('conditional policy command adapter unavailable: ' + detail, msg);
    return [null, null];
  }
  let command;
  try {
    command = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('conditional policy command parse failed closed: ' + String(parseError && parseError.message || parseError), msg);
    return [null, null];
  }
  const envelope = command._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return [msg, null];
  const commandType = String(envelope.commandType || command.commandType || '').trim().toUpperCase();
  const supported = new Set(['UPSERT_IRRIGATION_POLICY', 'PAUSE_IRRIGATION_POLICY', 'RETRY_IRRIGATION_VALVE']);
  if (!supported.has(commandType)) return [msg, null];
  const gateway = String(env.get('DEVICE_EUI') || env.get('GATEWAY_DEVICE_EUI') || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(gateway) || !Number.isSafeInteger(envelope.commandId) || envelope.commandId <= 0) {
    node.error('conditional policy command has no trusted gateway or command id', msg);
    return [null, null];
  }
  const rawPayload = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
    ? envelope.payload
    : command;
  const actorUserUuid = String(envelope.actorUserUuid || envelope.actor_user_uuid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(actorUserUuid)
      && !/^[0-9a-f]{32}$/.test(actorUserUuid)) {
    node.error('conditional policy command has no trusted actor identity', msg);
    return [null, null];
  }
  // The actor comes from the authenticated cloud command creator, carried in
  // the trusted pending-command envelope. Add it to the internal ledger
  // payload so effect-key binding and the canonical API see the same identity;
  // never accept an actor supplied only by the mutable command body.
  const payload = Object.assign({}, rawPayload, { actor_user_uuid: actorUserUuid });
  const payloadGateway = String(payload.gateway_device_eui || payload.gatewayDeviceEui || '').trim().toUpperCase();
  if (payloadGateway !== gateway) {
    node.error('conditional policy command gateway does not match the trusted gateway', msg);
    return [null, null];
  }
  const value = (key, alternate) => {
    if (payload[key] !== undefined) return payload[key];
    if (alternate && payload[alternate] !== undefined) return payload[alternate];
    return undefined;
  };
  const request = {};
  const copy = (key, alternate) => {
    const result = value(key, alternate);
    if (result !== undefined) request[key] = result;
  };
  copy('zone_uuid', 'zoneUuid');
  if (commandType === 'UPSERT_IRRIGATION_POLICY') {
    for (const key of [
      'policy_uuid', 'expected_policy_version', 'condition', 'timezone', 'enabled',
      'observation_window_minutes', 'min_interval_minutes', 'max_daily_minutes',
      'delivery_settings', 'schedules', 'schedule_edits',
    ]) copy(key);
  } else if (commandType === 'PAUSE_IRRIGATION_POLICY') {
    copy('expected_policy_version');
  } else {
    copy('device_eui', 'deviceEui');
  }
  if (!request.zone_uuid) {
    node.error('conditional policy command has no zone scope', msg);
    return [null, null];
  }
  const envelopeSyncVersion = envelope.appliedSyncVersion == null
    ? envelope.applied_sync_version
    : envelope.appliedSyncVersion;
  const requestedSyncVersion = envelopeSyncVersion == null ? null : Number(envelopeSyncVersion);
  const validSyncVersion = envelopeSyncVersion == null
    || (Number.isSafeInteger(requestedSyncVersion) && requestedSyncVersion >= 0);
  const requiredSyncVersion = commandType === 'UPSERT_IRRIGATION_POLICY'
    || commandType === 'PAUSE_IRRIGATION_POLICY';
  if (!validSyncVersion || (requiredSyncVersion && requestedSyncVersion <= 0)) {
    node.error('conditional policy command has no trusted applied sync version', msg);
    return [null, null];
  }
  const runtime = {
    gateway_device_eui: gateway,
    command_type_recognized: msg._commandTypeRecognized === true,
    now: new Date().toISOString(),
  };
  const ledger = ledgerLoad.value;
  const policy = policyLoad.value;
  const dispatch = valveLoad.value.dispatch || valveLoad.value;
  const ackBase = {
    commandId: envelope.commandId,
    eventUuid: envelope.eventUuid == null ? null : envelope.eventUuid,
    aggregateType: envelope.aggregateType == null ? null : envelope.aggregateType,
    aggregateKey: envelope.aggregateKey == null ? request.zone_uuid : envelope.aggregateKey,
    commandType,
    effectKey: envelope.effectKey || payload.effect_key || payload.effectKey || null,
    deviceEui: request.device_eui || gateway,
    gatewayDeviceEui: gateway,
    requestedSyncVersion,
    appliedSyncVersion: requestedSyncVersion,
    // Keep the signed command payload in the durable ACK evidence.  `request`
    // below is the strict local service body and intentionally omits transport
    // metadata such as request_id, effect_key, and gateway_device_eui.
    payload,
  };
  const unavailableTransport = () => {
    const fail = () => Promise.reject(Object.assign(new Error('chirpstack_transport_unavailable'), { code: 'transport_unavailable' }));
    return { getDeviceQueue: fail, getQueue: fail, flushDeviceQueue: fail, enqueueDownlink: fail, enqueue: fail };
  };
  let transport;
  try {
    transport = typeof chirpstack !== 'undefined' && chirpstack && typeof chirpstack.createProvisioningClientFromEnv === 'function'
      ? chirpstack.createProvisioningClientFromEnv(env)
      : unavailableTransport();
  } catch (transportError) {
    transport = unavailableTransport();
    node.warn('conditional policy command transport unavailable: ' + String(transportError && transportError.message || transportError));
  }
  const db = new dbLoad.value.Database('/data/db/farming.db');
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  const txFacade = (tx) => ({
    get: tx.get.bind(tx), all: tx.all.bind(tx), run: tx.run.bind(tx), exec: tx.exec && tx.exec.bind(tx),
    transaction: (callback) => callback(tx),
  });
  const actor = { user_uuid: actorUserUuid, scope: scopeLoad.value, scopedMode: true };
  const trustedEnvelope = Object.assign({}, envelope, { payload });
  const policyOptions = { actor, request, now: runtime.now, transport, deferTransport: true };
  const permanent = (error) => error && Number(error.statusCode || error.status) >= 400
    && Number(error.statusCode || error.status) < 500
    && error.code !== 'membership_drift';
  const persistAck = (ack) => ledger.withLifecycleCommandTransaction(db, trustedEnvelope, runtime, async (scoped) => {
    const durable = await scoped.terminalAck(Object.assign({}, ackBase, ack));
    return { handled: true, ack: durable, clears: [] };
  });
  let committed;
  try {
    const result = await ledger.withLifecycleCommandTransaction(db, trustedEnvelope, runtime, async (scoped) => {
      const options = Object.assign({}, policyOptions, { db: txFacade(scoped.tx) });
      let mutation;
      if (commandType === 'UPSERT_IRRIGATION_POLICY') mutation = await policy.applyPolicyEdit(options);
      else if (commandType === 'PAUSE_IRRIGATION_POLICY') mutation = await policy.pausePolicy(options);
      else mutation = await policy.retryValve(options);
      const durable = await scoped.terminalAck(Object.assign({}, ackBase, {
        result: 'APPLIED',
        appliedSyncVersion: requestedSyncVersion,
        requestedSyncVersion,
      }));
      return { handled: true, ack: durable, mutation };
    });
    committed = result;
    if (result && result.mutation) {
      try {
        const postCommitOptions = { db, actor, request, now: runtime.now, transport, warn: (message) => node.warn(String(message)) };
        if (commandType === 'UPSERT_IRRIGATION_POLICY') {
          await policy.completePolicyEditTransport(postCommitOptions, result.mutation, Date.parse(runtime.now));
        } else if (commandType === 'PAUSE_IRRIGATION_POLICY') {
          await policy.completePauseTransport(postCommitOptions, result.mutation, Date.parse(runtime.now));
        } else {
          await policy.completeRetryValveTransport(postCommitOptions, result.mutation);
        }
      } catch (postCommitError) {
        node.warn('conditional policy command post-commit transport remains pending: ' + String(postCommitError && postCommitError.message || postCommitError));
      }
      try {
        if (typeof policy.notifyProjectionKeys === 'function') {
          const mutation = result.mutation;
          const valveEuis = [
            ...(mutation.revisions || []).map((row) => row.device_eui),
            ...(mutation.fixed_conversions || []),
            ...(mutation.schedules || []).map((row) => row.device_eui),
            ...(mutation.active || mutation.active_expectations || []).map((row) => row.device_eui),
            request.device_eui,
          ];
          const clockStatus = typeof policy.runtimeClockStatus === 'function'
            ? policy.runtimeClockStatus()
            : { trusted: false, reason: 'clock_probe_unavailable' };
          await policy.notifyProjectionKeys({ db, policyKeys: request.zone_uuid, valveKeys: valveEuis, clockStatus });
        }
      } catch (projectionError) {
        node.warn('conditional policy command projection notification remains pending: ' + String(projectionError && projectionError.message || projectionError));
      }
    }
    return [null, { topic: 'devices/' + gateway + '/command_ack', payload: result.ack, qos: 1 }];
  } catch (error) {
    try {
      const failure = await persistAck({
        result: permanent(error) ? 'REJECTED_PERMANENT' : 'FAILED_RETRYABLE',
        appliedSyncVersion: requestedSyncVersion,
        requestedSyncVersion,
        reason: error && error.code || 'conditional_policy_command_failed',
        error: error && error.message || String(error),
      });
      return [null, { topic: 'devices/' + gateway + '/command_ack', payload: failure.ack, qos: 1 }];
    } catch (ackError) {
      node.error('conditional policy command ACK persistence failed: ' + String(ackError && ackError.message || ackError), msg);
      return [null, null];
    }
  } finally {
    try { await close(); } catch (closeError) { node.warn('conditional policy command DB close failed: ' + String(closeError && closeError.message || closeError)); }
  }
}

async function zoneDelete(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

if (!msg.payload || msg.payload.length === 0) {
  msg.statusCode = 404;
  msg.payload = { message: 'Zone not found or access denied' };
  return [null, msg];
}
const zone = msg.payload[0];
const request = (msg.osi || {}).request;
if (!request || request.kind !== 'zone_delete' || Number(zone.id) !== Number(request.zoneId)) {
  msg.statusCode = 400;
  msg.payload = { message: 'Zone delete request context missing' };
  return [null, msg];
}
if (typeof osiDb === 'undefined' || typeof osiLib === 'undefined') {
  msg.statusCode = 503;
  msg.payload = { message: 'conditional lifecycle service unavailable' };
  return [null, msg];
}
let lifecycleDb;
try {
  lifecycleDb = new osiDb.Database('/data/db/farming.db');
  const policyLoad = osiLib.require('osi-irrigation-policy');
  if (!policyLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await policyLoad.value.applyLifecycleMutation({ db: lifecycleDb, operation: 'zone_delete', zoneId: Number(zone.id), actor: { user_id: request.actorId }, requireOwner: true, now: new Date().toISOString() });
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Zone removed successfully', zone_uuid: zone.zone_uuid, clear_results: lifecycleResult.clear_results || [] };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = { message: error && error.message || 'zone lifecycle failed', reason: error && error.code || 'lifecycle_error' };
  return [null, msg];
} finally {
  if (lifecycleDb) { try { await new Promise((resolve) => lifecycleDb.close(() => resolve())); } catch (closeError) { node.warn('zone lifecycle DB close failed: ' + String(closeError && closeError.message || closeError)); } }
}
}

async function deviceAssign(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

if (!msg.payload || msg.payload.length === 0) {
  msg.statusCode = 404;
  msg.payload = { message: 'Device not found or access denied' };
  return [null, msg];
}
const device = msg.payload[0];
const zoneId = Number(flow.get('assign_zone_id'));
const deveui = String(flow.get('assign_deveui') || '').trim().toUpperCase();
const userId = Number(flow.get('assign_user_id'));
const gateway = String(flow.get('assign_zone_gateway_device_eui') || device.gateway_device_eui || env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase();
if (typeof osiDb === 'undefined' || typeof osiLib === 'undefined') {
  msg.statusCode = 503;
  msg.payload = { message: 'conditional lifecycle service unavailable' };
  return [null, msg];
}
let lifecycleDb;
try {
  lifecycleDb = new osiDb.Database('/data/db/farming.db');
  const policyLoad = osiLib.require('osi-irrigation-policy');
  if (!policyLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await policyLoad.value.applyLifecycleMutation({ db: lifecycleDb, operation: 'device_assign', deviceEui: deveui, zoneId, gatewayDeviceEui: gateway, actor: { user_id: userId }, requireOwner: true, requireZoneOwner: true, requireUnassigned: false, now: new Date().toISOString() });
  const assigned = lifecycleResult.device || await lifecycleDb.get('SELECT gateway_device_eui,sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [deveui]);
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Device assigned to zone successfully', deveui, irrigation_zone_id: zoneId, gateway_device_eui: assigned && assigned.gateway_device_eui || null, sync_version: Number(assigned && assigned.sync_version || 0), deleted_at: null };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = { message: error && error.message || 'device assignment failed', reason: error && error.code || 'lifecycle_error' };
  return [null, msg];
} finally {
  if (lifecycleDb) { try { await new Promise((resolve) => lifecycleDb.close(() => resolve())); } catch (closeError) { node.warn('assign lifecycle DB close failed: ' + String(closeError && closeError.message || closeError)); } }
}
}

async function deviceUnassign(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

if (!msg.payload || msg.payload.length === 0) {
  msg.statusCode = 401;
  msg.payload = { message: 'User not found' };
  return [null, msg];
}
const userId = Number(msg.payload[0].id);
const zoneId = parseInt(msg.req.params.id, 10);
const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
if (!Number.isFinite(zoneId)) {
  msg.statusCode = 400;
  msg.payload = { message: 'Invalid zone ID' };
  return [null, msg];
}
if (!deveui) {
  msg.statusCode = 400;
  msg.payload = { message: 'Device EUI is required' };
  return [null, msg];
}
if (typeof osiDb === 'undefined' || typeof osiLib === 'undefined') {
  msg.statusCode = 503;
  msg.payload = { message: 'conditional lifecycle service unavailable' };
  return [null, msg];
}
let lifecycleDb;
try {
  lifecycleDb = new osiDb.Database('/data/db/farming.db');
  const policyLoad = osiLib.require('osi-irrigation-policy');
  if (!policyLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await policyLoad.value.applyLifecycleMutation({ db: lifecycleDb, operation: 'device_unassign', deviceEui: deveui, zoneId, actor: { user_id: userId }, requireOwner: true, now: new Date().toISOString() });
  const removed = lifecycleResult.device || await lifecycleDb.get('SELECT gateway_device_eui,sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [deveui]);
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Device removed from zone successfully', deveui, irrigation_zone_id: null, gateway_device_eui: removed && removed.gateway_device_eui || null, sync_version: Number(removed && removed.sync_version || 0), deleted_at: null, clear_results: lifecycleResult.clear_results || [] };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = { message: error && error.message || 'device unassignment failed', reason: error && error.code || 'lifecycle_error' };
  return [null, msg];
} finally {
  if (lifecycleDb) { try { await new Promise((resolve) => lifecycleDb.close(() => resolve())); } catch (closeError) { node.warn('unassign lifecycle DB close failed: ' + String(closeError && closeError.message || closeError)); } }
}
}

async function deviceUnclaim(context) {
  const { msg, node, flow, global, env, osiDb, osiLib, crypto, chirpstack } = context;

if (!msg.payload || msg.payload.length === 0) {
  msg.statusCode = 401;
  msg.payload = { message: 'User not found' };
  return [null, msg];
}
const userId = msg.payload[0].id;
const deveui = flow.get('delete_device_deveui');
const gatewayDeviceEui = String(env.get('DEVICE_EUI') || 'UNKNOWN').toUpperCase();
if (typeof osiDb === 'undefined' || typeof osiLib === 'undefined') {
  msg.statusCode = 503;
  msg.payload = { message: 'conditional lifecycle service unavailable' };
  return [null, msg];
}
let lifecycleDb;
const transport = unclaimTransport(typeof chirpstack === 'undefined' ? null : chirpstack, env, osiLib, node);
try {
  lifecycleDb = new osiDb.Database('/data/db/farming.db');
  const policyLoad = osiLib.require('osi-irrigation-policy');
  if (!policyLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await policyLoad.value.applyLifecycleMutation({ db: lifecycleDb, operation: 'device_unclaim', deviceEui: deveui, gatewayDeviceEui, actor: { user_id: userId }, requireOwner: true, transport, warn: (message) => node.warn(String(message)), now: new Date().toISOString() });
  // S6: the detach applied, so 200 whatever the valve cleanup did; valve_cleanup says what that was.
  msg.statusCode = 200;
  msg.payload = { message: 'Device removed successfully', device_eui: deveui, gateway_device_eui: gatewayDeviceEui, valve_cleanup: unclaimCleanupFor(policyLoad.value, deveui, lifecycleResult, node), clear_results: lifecycleResult.clear_results || [] };
  return [null, msg];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  // F33: an unknown or foreign DevEUI keeps the route's not-found contract.
  const notFound = msg.statusCode === 404 && error && error.code === 'device_not_found';
  msg.payload = { message: notFound ? 'Device not found or access denied' : (error && error.message || 'device unclaim failed'), reason: error && error.code || 'lifecycle_error' };
  return [null, msg];
} finally {
  closeUnclaimTransport(transport);
  if (lifecycleDb) { try { await new Promise((resolve) => lifecycleDb.close(() => resolve())); } catch (closeError) { node.warn('delete lifecycle DB close failed: ' + String(closeError && closeError.message || closeError)); } }
}
}

module.exports = Object.freeze({ scopedZoneDelete, scopedDeviceAssign, scopedDeviceUnassign, scopedDeviceDelete, conditionalLegacySchedule, conditionalLifecycleCommand, conditionalPolicyCommand, zoneDelete, deviceAssign, deviceUnassign, deviceUnclaim });
