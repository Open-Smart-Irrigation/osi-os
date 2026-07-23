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

const routeIds = [
  'put-dendro-http',
  'put-temp-http',
  'dendro-ref-tree-http',
  'put-lsn50-mode-http',
  'put-lsn50-interval-http',
  'put-kiwi-interval-http',
  'post-kiwi-enable-http',
  'put-strega-interval-http',
  'put-lsn50-interrupt-http',
  'put-lsn50-5v-http',
  'put-strega-model-http',
  'put-strega-timed-http',
  'put-strega-magnet-http',
  'put-strega-partial-http',
  'put-strega-flush-http',
  'put-rain-gauge-http',
  'put-flow-meter-http',
  'put-soil-depth-http',
  'put-chameleon-enabled-http',
  'put-dendro-config-http',
  'post-dendro-baseline-reset-http',
  '7aa47f3149614bb1',
  'b0b3d5c0ff56cd29',
];

const routes = routeIds.map((id) => {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`route not found: ${id}`);
  if (!node.url.startsWith('/api/devices/:deveui/')) {
    throw new Error(`unexpected device-config route: ${id} ${node.url}`);
  }
  return {
    id,
    method: String(node.method || '').toUpperCase(),
    suffix: node.url.slice('/api/devices/:deveui'.length),
    legacyWires: node.wires[0],
    node,
  };
});

const routeTable = routes.map(({ method, suffix }, index) => ({
  method,
  suffix,
  index,
}));

const guardId = 'scoped-device-config-guard';
if (flows.some((node) => node.id === guardId)) {
  throw new Error(`${guardId} already exists`);
}
for (const route of routes) route.node.wires = [[guardId]];

const func = `return (async () => {
const routeTable = ${JSON.stringify(routeTable)};
const method = String(msg.req && msg.req.method || '').toUpperCase();
const requestPath = String(msg.req && (msg.req.path || msg.req.url) || '').split('?')[0];
const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
const prefix = '/api/devices/' + String(msg.req && msg.req.params && msg.req.params.deveui || '');
const suffix = requestPath.startsWith(prefix) ? requestPath.slice(prefix.length) : '';
const route = routeTable.find(function(candidate) {
  return candidate.method === method && candidate.suffix === suffix;
});
const outputs = new Array(routeTable.length + 1).fill(null);
const errorOutput = routeTable.length;
if (!route) {
  msg.statusCode = 404;
  msg.payload = { message: 'Device config route not found' };
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
    node.error('device config scope: module unavailable: ' + scopeLoad.error, msg);
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
    'SELECT user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
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
  await scope.assertFreshDeviceAccess(
    db,
    actor.user_uuid,
    deveui,
    { scopedMode: true }
  );
  msg.actor_user_uuid = actor.user_uuid;
  outputs[route.index] = msg;
  return outputs;
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 404 ? 'Device not found' :
      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
  };
  outputs[errorOutput] = msg;
  return outputs;
} finally {
  try {
    await closeDb();
  } catch (closeError) {
    node.warn('device config scope close: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
}
})();`;

const first = routes[0].node;
flows.push({
  id: guardId,
  type: 'function',
  z: first.z,
  name: 'Fresh Device Config Scope',
  func,
  outputs: routes.length + 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'osiDb', module: 'osi-db-helper' },
  ],
  x: 330,
  y: first.y,
  wires: [
    ...routes.map((route) => route.legacyWires),
    ['device-response'],
  ],
});

const serialized = `${JSON.stringify(flows, null, 4)}\n`;
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
