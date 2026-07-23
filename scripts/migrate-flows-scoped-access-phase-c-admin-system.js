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

const guardFunction = `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {
  return [msg, null];
}
let db;
const closeDb = function() {
  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
};
try {
  const scopeLoad = osiLib.require('scope');
  if (!scopeLoad.ok) {
    node.error('admin system write scope: module unavailable: ' + scopeLoad.error, msg);
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
  msg.actor_user_uuid = actor.user_uuid;
  return [msg, null];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    error: msg.statusCode === 403 ? 'Forbidden' :
      (msg.statusCode === 401 ? 'Unauthorized' : String(error && error.message || error))
  };
  return [null, msg];
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('admin system write scope close: ' +
      String(closeError && closeError.message ? closeError.message : closeError));
  }
}
})();`;

const routes = [
  {
    routeId: 'sync-force-http',
    guardId: 'sync-force-admin-write-guard',
    responseId: 'sync-force-response',
    name: 'Admin Guard: Force Sync',
  },
  {
    routeId: 'sys-reboot-in',
    guardId: 'system-reboot-admin-write-guard',
    responseId: 'sys-resp',
    name: 'Admin Guard: System Reboot',
  },
  {
    routeId: 'sys-fan-in',
    guardId: 'system-fan-admin-write-guard',
    responseId: 'sys-resp',
    name: 'Admin Guard: System Fan',
  },
  {
    routeId: 'al-link-in',
    guardId: 'account-link-admin-write-guard',
    responseId: 'al-link-resp',
    name: 'Admin Guard: Account Link',
  },
  {
    routeId: 'al-unlink-in',
    guardId: 'account-unlink-admin-write-guard',
    responseId: 'al-unlink-resp',
    name: 'Admin Guard: Account Unlink',
  },
  {
    routeId: 'history-rollups-run-http',
    guardId: 'history-rollups-admin-write-guard',
    responseId: 'history-api-response',
    name: 'Admin Guard: History Rollups',
  },
];

for (const routeSpec of routes) {
  const route = getNode(routeSpec.routeId);
  const response = getNode(routeSpec.responseId);
  if (response.z !== route.z) {
    throw new Error(`${routeSpec.routeId}: response must be on the same tab`);
  }
  const legacyWires = route.wires[0];
  if (!Array.isArray(legacyWires) || legacyWires.length === 0) {
    throw new Error(`${routeSpec.routeId}: missing legacy wire`);
  }
  route.wires = [[routeSpec.guardId]];
  flows.push({
    id: routeSpec.guardId,
    type: 'function',
    z: route.z,
    name: routeSpec.name,
    func: guardFunction,
    outputs: 2,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [
      { var: 'osiLib', module: 'osi-lib' },
      { var: 'osiDb', module: 'osi-db-helper' },
    ],
    x: Number(route.x || 0) + 260,
    y: route.y,
    wires: [
      legacyWires,
      [routeSpec.responseId],
    ],
  });
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
console.log(`guarded ${routes.length} admin-only system write routes`);
