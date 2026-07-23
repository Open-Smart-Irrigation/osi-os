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

const zoneRouteIds = [
  'dendro-tz-http',
  'dendro-location-http',
  'zone-config-http',
  'zone-calibration-http',
];
const zoneRoutes = zoneRouteIds.map((id, index) => {
  const node = getNode(id);
  const legacyWires = node.wires[0];
  node.wires = [['scoped-zone-config-guard']];
  return {
    id,
    index,
    method: String(node.method).toUpperCase(),
    url: node.url,
    legacyWires,
    node,
  };
});

flows.push({
  id: 'scoped-zone-config-guard',
  type: 'function',
  z: zoneRoutes[0].node.z,
  name: 'Fresh Zone Config Scope',
  func: `return (async () => {
const routes = ${JSON.stringify(zoneRoutes.map(({ method, url, index }) => ({ method, routePath: url, index })))};
const method = String(msg.req && msg.req.method || '').toUpperCase();
const requestPath = String(msg.req && (msg.req.path || msg.req.url) || '').split('?')[0];
const route = routes.find(function(candidate) {
  if (candidate.method !== method) return false;
  const pattern = '^' + candidate.routePath.replace(/:[^/]+/g, '[^/]+') + '$';
  return new RegExp(pattern).test(requestPath);
});
const outputs = new Array(routes.length + 1).fill(null);
const errorOutput = routes.length;
if (!route) {
  msg.statusCode = 404;
  msg.payload = { error: 'Zone config route not found' };
  outputs[errorOutput] = msg;
  return outputs;
}
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {
  outputs[route.index] = msg;
  return outputs;
}
let db;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
try {
  const scopeLoad = osiLib.require('scope');
  if (!scopeLoad.ok) {
    node.error('zone config scope: module unavailable: ' + scopeLoad.error, msg);
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
    'SELECT user_uuid,role FROM users WHERE id=? AND username=? LIMIT 1',
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
  }
  const zoneId = Number(msg.req && msg.req.params &&
    (msg.req.params.zone_id == null ? msg.req.params.id : msg.req.params.zone_id));
  if (!Number.isInteger(zoneId)) {
    throw Object.assign(new Error('Invalid zone ID'), { statusCode: 400 });
  }
  const zone = await db.get(
    'SELECT id,user_id,zone_uuid FROM irrigation_zones WHERE id=? AND deleted_at IS NULL LIMIT 1',
    [zoneId]
  );
  if (!zone || !zone.zone_uuid) {
    throw Object.assign(new Error('zone not found'), { statusCode: 404 });
  }
  await scope.assertFreshZoneAccess(
    db,
    actor.user_uuid,
    zone.zone_uuid,
    { scopedMode: true }
  );
  msg._scopedZoneWriteAuthorized = true;
  msg._scopedZoneOwnerId = Number(zone.user_id);
  msg.actor_user_uuid = actor.user_uuid;
  flow.set('actor_user_uuid', actor.user_uuid);
  outputs[route.index] = msg;
  return outputs;
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    error: msg.statusCode === 404 ? 'Zone not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  outputs[errorOutput] = msg;
  return outputs;
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('zone config scope close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
})();`,
  outputs: zoneRoutes.length + 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'osiDb', module: 'osi-db-helper' },
  ],
  x: 340,
  y: zoneRoutes[0].node.y,
  wires: [
    ...zoneRoutes.map((route) => route.legacyWires),
    ['dendro-http-resp'],
  ],
});

function replaceAllChecked(nodeId, from, to, minimum) {
  const node = getNode(nodeId);
  const before = node.func;
  node.func = node.func.split(from).join(to);
  const replacements = before.split(from).length - 1;
  if (replacements < minimum) {
    throw new Error(`expected at least ${minimum} replacements in ${nodeId}, got ${replacements}`);
  }
}

replaceAllChecked(
  'dendro-location-fn',
  'auth.userId',
  '(msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId)',
  2
);
replaceAllChecked(
  'zone-config-fn',
  'auth.userId',
  '(msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId)',
  3
);
replaceAllChecked(
  'zone-calibration-fn',
  'auth.userId',
  '(msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId)',
  1
);

const authTab = getNode('auth-register-http').z;
const authResponseId = 'auth-response';
const adminRoutes = [
  ['admin-users-list-http', 'get', '/api/users', 'GET /api/users'],
  ['admin-users-create-http', 'post', '/api/users', 'POST /api/users'],
  ['admin-users-password-http', 'post', '/api/users/:uuid/password-reset', 'POST /api/users/:uuid/password-reset'],
  ['admin-users-role-http', 'put', '/api/users/:uuid/role', 'PUT /api/users/:uuid/role'],
  ['admin-users-disabled-http', 'put', '/api/users/:uuid/disabled', 'PUT /api/users/:uuid/disabled'],
  ['admin-zone-grant-http', 'post', '/api/grants/zone', 'POST /api/grants/zone'],
  ['admin-zone-grant-delete-http', 'delete', '/api/grants/zone/:assignmentUuid', 'DELETE /api/grants/zone/:assignmentUuid'],
  ['admin-plot-grant-http', 'post', '/api/grants/plot', 'POST /api/grants/plot'],
  ['admin-plot-grant-delete-http', 'delete', '/api/grants/plot/:assignmentUuid', 'DELETE /api/grants/plot/:assignmentUuid'],
];
adminRoutes.forEach(([id, method, url, name], index) => {
  flows.push({
    id,
    type: 'http in',
    z: authTab,
    name,
    url,
    method,
    upload: false,
    swaggerDoc: '',
    x: 170,
    y: 900 + index * 40,
    wires: [['scoped-admin-account-router']],
  });
});

flows.push({
  id: 'scoped-admin-account-router',
  type: 'function',
  z: authTab,
  name: 'Admin Account + Grant API',
  func: `return (async () => {
const respond = function(statusCode, payload) {
  msg.statusCode = statusCode;
  msg.payload = payload;
  msg.headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
  return msg;
};
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {
  return respond(404, { message: 'Not found' });
}
let db;
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
};
const all = function(sql, params) {
  return new Promise(function(resolve, reject) {
    db.all(sql, params || [], function(error, rows) {
      error ? reject(error) : resolve(rows || []);
    });
  });
};
try {
  const scopeLoad = osiLib.require('scope');
  if (!scopeLoad.ok) {
    node.error('admin account API: scope module unavailable: ' + scopeLoad.error, msg);
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
    'SELECT user_uuid,role FROM users WHERE id=? AND username=? LIMIT 1',
    [auth.userId, auth.username]
  );
  if (!actor || !actor.user_uuid) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
  await scope.assertFreshRole(
    db,
    actor.user_uuid,
    'admin',
    { scopedMode: true }
  );
  const method = String(msg.req && msg.req.method || '').toUpperCase();
  const requestPath = String(msg.req && (msg.req.path || msg.req.url) || '').split('?')[0];
  const body = msg.req && msg.req.body || msg.payload || {};
  const now = new Date().toISOString();

  if (method === 'GET' && requestPath === '/api/users') {
    const users = await all(
      'SELECT username,user_uuid,role,disabled_at,created_at FROM users ORDER BY username'
    );
    return respond(200, { users });
  }
  if (method === 'POST' && requestPath === '/api/users') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = String(body.role || 'researcher').trim().toLowerCase();
    if (!username || password.length < 6 || !['admin', 'researcher', 'viewer'].includes(role)) {
      throw Object.assign(new Error('Valid username, password, and role are required'), { statusCode: 400 });
    }
    const userUuid = crypto.randomUUID();
    await run(
      'INSERT INTO users ' +
        '(username,password_hash,created_at,updated_at,user_uuid,role,edge_originated,sync_version) ' +
        'VALUES(?,?,?,?,?,?,1,1)',
      [username, bcrypt.hashSync(password, 10), now, now, userUuid, role]
    );
    scope.invalidateScope(userUuid);
    return respond(201, {
      username,
      user_uuid: userUuid,
      role,
      disabled_at: null,
      created_at: now
    });
  }
  const userUuid = String(msg.req && msg.req.params && msg.req.params.uuid || '').trim();
  if (method === 'POST' && /\\/api\\/users\\/[^/]+\\/password-reset$/.test(requestPath)) {
    const password = String(body.password || body.temporary_password || '');
    if (password.length < 6) {
      throw Object.assign(new Error('Password must be at least 6 characters'), { statusCode: 400 });
    }
    const changed = await run(
      'UPDATE users SET password_hash=?,updated_at=?,sync_version=sync_version+1 WHERE user_uuid=?',
      [bcrypt.hashSync(password, 10), now, userUuid]
    );
    if (!changed.changes) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    return respond(200, { success: true });
  }
  if (method === 'PUT' && /\\/api\\/users\\/[^/]+\\/role$/.test(requestPath)) {
    const role = String(body.role || '').trim().toLowerCase();
    if (!['admin', 'researcher', 'viewer'].includes(role)) {
      throw Object.assign(new Error('Invalid role'), { statusCode: 400 });
    }
    const guardedSql = scope.buildDeroleUserGuardedSql().replace(
      'SET role = ?',
      'SET role = ?, updated_at = ?, sync_version = sync_version + 1'
    );
    const changed = await run(guardedSql, [role, now, userUuid, role]);
    if (!changed.changes) {
      const exists = await db.get('SELECT 1 AS found FROM users WHERE user_uuid=?', [userUuid]);
      throw Object.assign(
        new Error(exists ? 'Cannot remove the last enabled admin' : 'User not found'),
        { statusCode: exists ? 409 : 404 }
      );
    }
    scope.invalidateScope(userUuid);
    return respond(200, { success: true, user_uuid: userUuid, role });
  }
  if (method === 'PUT' && /\\/api\\/users\\/[^/]+\\/disabled$/.test(requestPath)) {
    if (typeof body.disabled !== 'boolean') {
      throw Object.assign(new Error('disabled must be boolean'), { statusCode: 400 });
    }
    let changed;
    if (body.disabled) {
      const guardedSql = scope.buildDisableUserGuardedSql().replace(
        'SET disabled_at =',
        'SET updated_at = ?, sync_version = sync_version + 1, disabled_at ='
      );
      changed = await run(guardedSql, [now, userUuid]);
    } else {
      changed = await run(
        'UPDATE users SET disabled_at=NULL,updated_at=?,sync_version=sync_version+1 WHERE user_uuid=?',
        [now, userUuid]
      );
    }
    if (!changed.changes) {
      const exists = await db.get('SELECT 1 AS found FROM users WHERE user_uuid=?', [userUuid]);
      throw Object.assign(
        new Error(exists ? 'Cannot disable the last enabled admin' : 'User not found'),
        { statusCode: exists ? 409 : 404 }
      );
    }
    scope.invalidateScope(userUuid);
    return respond(200, { success: true, user_uuid: userUuid, disabled: body.disabled });
  }
  const isZoneGrant = requestPath === '/api/grants/zone';
  const isPlotGrant = requestPath === '/api/grants/plot';
  if (method === 'POST' && (isZoneGrant || isPlotGrant)) {
    const targetUserUuid = String(body.user_uuid || '').trim();
    const resourceUuid = String(isZoneGrant ? body.zone_uuid : body.plot_uuid || '').trim();
    const user = await db.get(
      'SELECT user_uuid FROM users WHERE user_uuid=? LIMIT 1',
      [targetUserUuid]
    );
    const resource = await db.get(
      isZoneGrant
        ? 'SELECT zone_uuid FROM irrigation_zones WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1'
        : 'SELECT plot_uuid FROM journal_plots WHERE plot_uuid=? AND deleted_at IS NULL LIMIT 1',
      [resourceUuid]
    );
    if (!user || !resource) {
      throw Object.assign(new Error('User or resource not found'), { statusCode: 404 });
    }
    const assignmentUuid = crypto.randomBytes(16).toString('hex');
    const table = isZoneGrant ? 'user_zone_assignments' : 'user_plot_assignments';
    const column = isZoneGrant ? 'zone_uuid' : 'plot_uuid';
    await run(
      'INSERT INTO ' + table + ' ' +
        '(assignment_uuid,user_uuid,' + column + ',assigned_by_user_uuid,' +
        'gateway_device_eui,sync_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
      [
        assignmentUuid,
        targetUserUuid,
        resourceUuid,
        actor.user_uuid,
        String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase(),
        now,
        now
      ]
    );
    scope.invalidateScope(targetUserUuid);
    return respond(201, {
      assignment_uuid: assignmentUuid,
      user_uuid: targetUserUuid,
      [column]: resourceUuid
    });
  }
  const zoneGrantDelete = method === 'DELETE' && /\\/api\\/grants\\/zone\\/[^/]+$/.test(requestPath);
  const plotGrantDelete = method === 'DELETE' && /\\/api\\/grants\\/plot\\/[^/]+$/.test(requestPath);
  if (zoneGrantDelete || plotGrantDelete) {
    const assignmentUuid = String(
      msg.req && msg.req.params && msg.req.params.assignmentUuid || ''
    ).trim();
    const table = zoneGrantDelete ? 'user_zone_assignments' : 'user_plot_assignments';
    const assignment = await db.get(
      'SELECT user_uuid FROM ' + table + ' WHERE assignment_uuid=? AND deleted_at IS NULL LIMIT 1',
      [assignmentUuid]
    );
    if (!assignment) {
      throw Object.assign(new Error('Grant not found'), { statusCode: 404 });
    }
    await run(
      'UPDATE ' + table + ' SET deleted_at=?,updated_at=?,sync_version=sync_version+1 ' +
        'WHERE assignment_uuid=? AND deleted_at IS NULL',
      [now, now, assignmentUuid]
    );
    scope.invalidateScope(assignment.user_uuid);
    return respond(200, { success: true, assignment_uuid: assignmentUuid });
  }
  return respond(404, { message: 'Not found' });
} catch (error) {
  const statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  const constraint = /(?:SQLITE_CONSTRAINT|UNIQUE constraint)/.test(String(error && error.message || error));
  return respond(constraint ? 409 : statusCode, {
    message: statusCode === 403 ? 'Forbidden' : String(error && error.message || error)
  });
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('admin account API close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
})();`,
  outputs: 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'crypto', module: 'crypto' },
    { var: 'bcrypt', module: 'bcryptjs' },
  ],
  x: 500,
  y: 1060,
  wires: [[authResponseId]],
});

const serialized = `${JSON.stringify(flows, null, 2)}\n`;
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
