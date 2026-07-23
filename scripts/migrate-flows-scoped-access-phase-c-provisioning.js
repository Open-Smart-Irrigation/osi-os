#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

function getNode(id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

function addRouteGuard(routeId, guardId, name, func, extraLibs = []) {
  const route = getNode(routeId);
  const legacyWires = route.wires;
  route.wires = [[guardId]];
  flows.push({
    id: guardId,
    type: 'function',
    z: route.z,
    name,
    func,
    outputs: 2,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [
      { var: 'osiLib', module: 'osi-lib' },
      { var: 'osiDb', module: 'osi-db-helper' },
      ...extraLibs,
    ],
    x: 350,
    y: route.y,
    wires: [legacyWires[0], ['device-response']],
  });
}

const prelude = `const scopeLoad = osiLib.require('scope');
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
if (actorScope.role === 'viewer') {
  throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
}`;

const helpers = `let db;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
const run = function(sql, params) {
  return new Promise(function(resolve, reject) {
    db.run(sql, params || [], function(error) {
      if (error) return reject(error);
      resolve({ changes: Number(this && this.changes || 0), lastID: Number(this && this.lastID || 0) });
    });
  });
};`;

const catchAndClose = `} catch (error) {
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
})();`;

addRouteGuard(
  'post-devices-http',
  'scoped-device-claim-router',
  'Scoped Device Claim',
  `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
${helpers}
try {
${prelude}
  const body = msg.req && msg.req.body || msg.payload || {};
  const deveui = String(body.deveui || '').trim().toUpperCase();
  if (!deveui) throw Object.assign(new Error('Device EUI is required'), { statusCode: 400 });
  const targetZoneId = Number(body.irrigation_zone_id);
  if (!Number.isInteger(targetZoneId)) {
    if (actorScope.role !== 'admin') {
      throw Object.assign(new Error('irrigation_zone_id is required in scoped mode'), { statusCode: 400 });
    }
    msg._scopedTargetZoneId = null;
  } else {
    const targetZoneUuid = await scope.resolveZoneUuidById(db, targetZoneId);
    if (!targetZoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
    await scope.assertFreshZoneAccess(
      db,
      actor.user_uuid,
      targetZoneUuid,
      { scopedMode: true }
    );
    msg._scopedTargetZoneId = targetZoneId;
  }
  const existing = await db.get(
    'SELECT d.deveui, iz.zone_uuid FROM devices d ' +
    'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL ' +
    'WHERE d.deveui = ? AND d.deleted_at IS NULL',
    [deveui]
  );
  if (existing && existing.zone_uuid) {
    await scope.assertFreshDeviceAccess(
      db,
      actor.user_uuid,
      deveui,
      { scopedMode: true }
    );
  }
  msg._scopedActorUserUuid = actor.user_uuid;
  return [msg, null];
${catchAndClose}`,
  [{ var: 'crypto', module: 'crypto' }]
);

addRouteGuard(
  'assign-device-http',
  'scoped-device-assign-router',
  'Scoped Device Assignment',
  `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
${helpers}
try {
${prelude}
  const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  if (!Number.isInteger(zoneId) || !deveui) {
    throw Object.assign(new Error('Invalid assignment request'), { statusCode: 400 });
  }
  const zoneUuid = await scope.resolveZoneUuidById(db, zoneId);
  if (!zoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
  await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  const changed = await run(
    'UPDATE devices SET irrigation_zone_id = ?, sync_version = COALESCE(sync_version, 0) + 1, ' +
    'updated_at = ? WHERE deveui = ? AND deleted_at IS NULL',
    [zoneId, new Date().toISOString(), deveui]
  );
  if (!changed.changes) throw Object.assign(new Error('device not found'), { statusCode: 404 });
  const device = await db.get(
    'SELECT gateway_device_eui, sync_version FROM devices WHERE deveui = ?',
    [deveui]
  );
  msg.statusCode = 200;
  msg.payload = {
    message: 'Device assigned to zone successfully',
    deveui,
    irrigation_zone_id: zoneId,
    irrigation_zone_uuid: zoneUuid,
    gateway_device_eui: device && device.gateway_device_eui || null,
    sync_version: Number(device && device.sync_version || 0),
    deleted_at: null
  };
  return [null, msg];
${catchAndClose}`
);

addRouteGuard(
  'unassign-device-http',
  'scoped-device-unassign-router',
  'Scoped Device Removal From Zone',
  `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
${helpers}
try {
${prelude}
  const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  if (!Number.isInteger(zoneId) || !deveui) {
    throw Object.assign(new Error('Invalid assignment request'), { statusCode: 400 });
  }
  const zoneUuid = await scope.resolveZoneUuidById(db, zoneId);
  if (!zoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
  await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  const changed = await run(
    'UPDATE devices SET irrigation_zone_id = NULL, sync_version = COALESCE(sync_version, 0) + 1, ' +
    'updated_at = ? WHERE deveui = ? AND irrigation_zone_id = ? AND deleted_at IS NULL',
    [new Date().toISOString(), deveui, zoneId]
  );
  if (!changed.changes) throw Object.assign(new Error('device not found'), { statusCode: 404 });
  const device = await db.get(
    'SELECT gateway_device_eui, sync_version FROM devices WHERE deveui = ?',
    [deveui]
  );
  msg.statusCode = 200;
  msg.payload = {
    message: 'Device removed from zone successfully',
    deveui,
    irrigation_zone_id: null,
    gateway_device_eui: device && device.gateway_device_eui || null,
    sync_version: Number(device && device.sync_version || 0),
    deleted_at: null
  };
  return [null, msg];
${catchAndClose}`
);

addRouteGuard(
  'delete-device-http',
  'scoped-device-delete-router',
  'Scoped Device Delete',
  `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
${helpers}
try {
${prelude}
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  if (!deveui) throw Object.assign(new Error('Device EUI is required'), { statusCode: 400 });
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  const gatewayEui = String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase();
  const changed = await run(
    'UPDATE devices SET user_id = NULL, irrigation_zone_id = NULL, gateway_device_eui = ?, ' +
    'sync_version = COALESCE(sync_version, 0) + 1, updated_at = ? ' +
    'WHERE deveui = ? AND deleted_at IS NULL',
    [gatewayEui, new Date().toISOString(), deveui]
  );
  if (!changed.changes) throw Object.assign(new Error('device not found'), { statusCode: 404 });
  msg.statusCode = 200;
  msg.payload = {
    message: 'Device removed successfully',
    device_eui: deveui,
    gateway_device_eui: gatewayEui
  };
  return [null, msg];
${catchAndClose}`
);

addRouteGuard(
  's2120-zones-put-http',
  'scoped-weather-zone-assign-router',
  'Scoped Weather Zone Assignments',
  `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
${helpers}
let transactionOpen = false;
try {
${prelude}
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  const rawZoneIds = msg.payload && msg.payload.zone_ids;
  if (!Array.isArray(rawZoneIds)) {
    throw Object.assign(new Error('zone_ids must be an array'), { statusCode: 400 });
  }
  const zoneIds = [...new Set(rawZoneIds.map(Number))];
  if (zoneIds.some(function(zoneId) { return !Number.isInteger(zoneId); })) {
    throw Object.assign(new Error('zone_ids must contain only integers'), { statusCode: 400 });
  }
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  for (const zoneId of zoneIds) {
    const zoneUuid = await scope.resolveZoneUuidById(db, zoneId);
    if (!zoneUuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
    await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });
  }
  await run('BEGIN IMMEDIATE');
  transactionOpen = true;
  await run('DELETE FROM weather_station_zones WHERE deveui = ?', [deveui]);
  for (const zoneId of zoneIds) {
    await run(
      'INSERT OR IGNORE INTO weather_station_zones(deveui, zone_id) VALUES(?, ?)',
      [deveui, zoneId]
    );
  }
  await run('COMMIT');
  transactionOpen = false;
  const rows = await new Promise(function(resolve, reject) {
    db.all(
      'SELECT wsz.zone_id, iz.name AS zone_name FROM weather_station_zones wsz ' +
      'LEFT JOIN irrigation_zones iz ON iz.id = wsz.zone_id WHERE wsz.deveui = ? ORDER BY wsz.zone_id',
      [deveui],
      function(error, result) { error ? reject(error) : resolve(result || []); }
    );
  });
  msg.statusCode = 200;
  msg.payload = {
    zone_ids: rows.map(function(row) { return row.zone_id; }),
    zone_names: rows.map(function(row) { return row.zone_name; })
  };
  msg.headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  return [null, msg];
} catch (error) {
  if (transactionOpen) {
    try {
      await run('ROLLBACK');
    } catch (rollbackError) {
      node.warn('weather zone assignment rollback: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError));
    }
  }
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    error: msg.statusCode === 404 ? 'Device not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  msg.headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  return [null, msg];
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('weather zone assignment close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
})();`
);

const insertNode = getNode('post-devices-insert');
insertNode.func = insertNode.func
  .replace(
    `  sql = "UPDATE devices SET user_id = " + userId\n    + ", name = '"`,
    `  sql = "UPDATE devices SET user_id = " + userId\n    + ", irrigation_zone_id = " + (Number.isInteger(msg._scopedTargetZoneId) ? msg._scopedTargetZoneId : 'NULL')\n    + ", name = '"`
  )
  .replace(
    `"INSERT INTO devices (deveui,name,type_id,user_id,current_state,target_state,gateway_device_eui,sync_version,deleted_at,created_at,updated_at,claimed_at) VALUES ('"`,
    `"INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,current_state,target_state,gateway_device_eui,sync_version,deleted_at,created_at,updated_at,claimed_at) VALUES ('"`
  )
  .replace(
    `+ deveui.replace(/'/g, "''") + "','" + name.replace(/'/g, "''") + "','" + type_id + "'," + userId + ","\n    + valveStateExpr`,
    `+ deveui.replace(/'/g, "''") + "','" + name.replace(/'/g, "''") + "','" + type_id + "'," + userId + ","\n    + (Number.isInteger(msg._scopedTargetZoneId) ? msg._scopedTargetZoneId : 'NULL') + ","\n    + valveStateExpr`
  );
if (!insertNode.func.includes('irrigation_zone_id = " + (Number.isInteger(msg._scopedTargetZoneId)')) {
  throw new Error('failed to patch existing-device claim zone assignment');
}
if (!insertNode.func.includes('user_id,irrigation_zone_id,current_state')) {
  throw new Error('failed to patch new-device claim zone assignment');
}

const responseNode = getNode('post-devices-response');
responseNode.func = responseNode.func.replace(
  '  irrigation_zone_id: null,',
  '  irrigation_zone_id: Number.isInteger(msg._scopedTargetZoneId) ? msg._scopedTargetZoneId : null,'
);

const serialized = `${JSON.stringify(flows, null, 2)}\n`;
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
