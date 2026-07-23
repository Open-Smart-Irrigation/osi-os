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

function lifecycleNode(id, route, name, func, y) {
  return {
    id,
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
      { var: 'crypto', module: 'crypto' },
    ],
    x: 350,
    y,
    wires: [route.wires[0], ['device-response']],
  };
}

const sharedPrelude = `const scopeLoad = osiLib.require('scope');
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
if (actorScope.role === 'viewer') {
  const error = new Error('insufficient role');
  error.statusCode = 403;
  throw error;
}`;

{
  const route = getNode('post-zone-http');
  const originalWires = route.wires;
  route.wires = [['scoped-zone-create-router']];
  const shim = { ...route, wires: originalWires };
  flows.push(lifecycleNode(
    'scoped-zone-create-router',
    shim,
    'Scoped Zone Create',
    `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
let db;
let transactionOpen = false;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
const run = function(sql, params) {
  return new Promise(function(resolve, reject) {
    db.run(sql, params || [], function(error) {
      if (error) return reject(error);
      resolve({
        changes: this && Number(this.changes || 0),
        lastID: this && Number(this.lastID || 0)
      });
    });
  });
};
try {
${sharedPrelude}
  const body = msg.req && msg.req.body || msg.payload || {};
  const name = String(body.name || '').trim();
  if (!name) {
    const error = new Error('Zone name is required');
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const zoneUuid = crypto.randomBytes(16).toString('hex');
  const assignmentUuid = crypto.randomBytes(16).toString('hex');
  const gatewayEui = String(
    env.get('DEVICE_EUI') || env.get('GATEWAY_DEVICE_EUI') || 'UNKNOWN'
  ).trim().toUpperCase();

  await run('BEGIN IMMEDIATE');
  transactionOpen = true;
  const inserted = await run(
    'INSERT INTO irrigation_zones ' +
    '(name, user_id, zone_uuid, gateway_device_eui, sync_version, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, 1, ?, ?)',
    [name, actor.id, zoneUuid, gatewayEui, now, now]
  );
  await run(
    'INSERT INTO user_zone_assignments ' +
    '(assignment_uuid, user_uuid, zone_uuid, assigned_by_user_uuid, ' +
    'gateway_device_eui, sync_version, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    [
      assignmentUuid,
      actor.user_uuid,
      zoneUuid,
      actor.user_uuid,
      gatewayEui,
      now,
      now
    ]
  );
  await run('COMMIT');
  transactionOpen = false;
  scope.invalidateScope(actor.user_uuid);

  msg.statusCode = 201;
  msg.payload = {
    id: inserted.lastID,
    name,
    zone_uuid: zoneUuid,
    gateway_device_eui: gatewayEui,
    sync_version: 1,
    deleted_at: null,
    device_count: 0,
    created_at: now,
    updated_at: now,
    schedule: null
  };
  return [null, msg];
} catch (error) {
  if (transactionOpen) {
    try {
      await run('ROLLBACK');
    } catch (rollbackError) {
      node.warn('zone create rollback: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError));
    }
  }
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 403
      ? 'Forbidden'
      : String(error && error.message || error)
  };
  return [null, msg];
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('zone create close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
})();`,
    route.y
  ));
}

{
  const route = getNode('delete-zone-http');
  const originalWires = route.wires;
  route.wires = [['scoped-zone-delete-router']];
  const shim = { ...route, wires: originalWires };
  flows.push(lifecycleNode(
    'scoped-zone-delete-router',
    shim,
    'Scoped Zone Delete',
    `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
let db;
let transactionOpen = false;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
const run = function(sql, params) {
  return new Promise(function(resolve, reject) {
    db.run(sql, params || [], function(error) {
      if (error) return reject(error);
      resolve(Number(this && this.changes || 0));
    });
  });
};
try {
${sharedPrelude}
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
  if (actorScope.role !== 'admin') {
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

  const now = new Date().toISOString();
  await run('BEGIN IMMEDIATE');
  transactionOpen = true;
  await run(
    'UPDATE devices SET irrigation_zone_id = NULL, updated_at = ?, ' +
    'sync_version = COALESCE(sync_version, 0) + 1 ' +
    'WHERE irrigation_zone_id = ? AND deleted_at IS NULL',
    [now, zoneId]
  );
  await run(
    'UPDATE journal_plots SET zone_uuid = NULL, updated_at = ?, ' +
    'sync_version = sync_version + 1 ' +
    'WHERE zone_uuid = ? AND deleted_at IS NULL',
    [now, zone.zone_uuid]
  );
  await run(
    'UPDATE user_zone_assignments SET deleted_at = ?, updated_at = ?, ' +
    'sync_version = sync_version + 1 ' +
    'WHERE zone_uuid = ? AND deleted_at IS NULL',
    [now, now, zone.zone_uuid]
  );
  await run(
    'UPDATE irrigation_schedules SET enabled = 0, deleted_at = ?, updated_at = ?, ' +
    'sync_version = COALESCE(sync_version, 0) + 1 ' +
    'WHERE irrigation_zone_id = ? AND deleted_at IS NULL',
    [now, now, zoneId]
  );
  await run(
    'UPDATE irrigation_zones SET deleted_at = ?, updated_at = ?, ' +
    'sync_version = COALESCE(sync_version, 0) + 1 ' +
    'WHERE id = ? AND deleted_at IS NULL',
    [now, now, zoneId]
  );
  await run('COMMIT');
  transactionOpen = false;
  scope.invalidateScope(actor.user_uuid);
  for (const grantee of grantees) scope.invalidateScope(grantee.user_uuid);

  msg.statusCode = 200;
  msg.payload = { message: 'Zone deleted successfully' };
  return [null, msg];
} catch (error) {
  if (transactionOpen) {
    try {
      await run('ROLLBACK');
    } catch (rollbackError) {
      node.warn('zone delete rollback: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError));
    }
  }
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
})();`,
    route.y
  ));
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
