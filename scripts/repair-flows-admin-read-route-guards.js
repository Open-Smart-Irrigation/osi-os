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
const byId = new Map(flows.filter((node) => node.id).map((node) => [node.id, node]));

function restoreWrappedNode(id, originalMarker, originalLibs) {
  const node = byId.get(id);
  if (!node) throw new Error(`node not found: ${id}`);
  const markerAt = node.func.indexOf(originalMarker);
  if (!node.func.startsWith('return (async () => {') || markerAt < 0) {
    throw new Error(`unexpected wrapped source: ${id}`);
  }
  node.func = node.func.slice(markerAt, -'\n})();'.length);
  if (originalLibs === null) delete node.libs;
  else node.libs = originalLibs;
}

restoreWrappedNode(
  'a85523a4041eb6f4',
  'msg.statusCode = 403;',
  [{ var: 'crypto', module: 'crypto' }]
);
restoreWrappedNode('sys-stats-fn', 'var FAN_PROBE_FAILURES_CONTEXT_KEY', null);
restoreWrappedNode('fn_build_sql_params', '// Builds a prepared SQL query', null);

{
  const node = byId.get('sync-state-build');
  if (!node) throw new Error('sync-state-build not found');
  const guardStart = node.func.indexOf(
    "  if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {",
    node.func.indexOf("_db = new osiDb.Database('/data/db/farming.db');")
  );
  const queryStart = node.func.indexOf('  const q =', guardStart);
  if (guardStart < 0 || queryStart < 0) throw new Error('sync-state guard anchors missing');
  node.func = node.func.slice(0, guardStart) + node.func.slice(queryStart);
  node.libs = node.libs.filter((lib) => !(lib.var === 'osiLib' && lib.module === 'osi-lib'));
}

const guardSource = `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
const dbLoad = osiLib.require('osi-db-helper');
const scopeLoad = osiLib.require('scope');
if (!dbLoad.ok || !scopeLoad.ok) {
  const detail = [dbLoad, scopeLoad]
    .filter(function(load) { return !load.ok; })
    .map(function(load) { return load.error; })
    .join('; ');
  node.error('admin-read: helpers unavailable: ' + detail, msg);
  msg.statusCode = 500;
  msg.payload = { message: 'admin authorization unavailable' };
  return [null, msg];
}
try {
  await scopeLoad.value.authorizeAdminRead({
    Database: dbLoad.value.Database,
    authorization: msg.req && msg.req.headers && msg.req.headers.authorization,
    configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
    fs: global.get('fs'),
    warn: function(message) { node.warn(message); }
  });
  return [msg, null];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = { message: msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error) };
  return [null, msg];
}
})();`;

const routes = [
  {
    routeId: 'bd3ab55ea0347a5b',
    guardId: 'database-download-admin-read-guard',
    name: 'Admin Read Guard: Database Download',
    successId: 'f68c8140f5d6eb39',
    errorId: 'ff201b44f81e458b',
  },
  {
    routeId: 'sync-state-http',
    guardId: 'sync-state-admin-read-guard',
    name: 'Admin Read Guard: Sync State',
    successId: 'sync-state-build',
    errorId: 'sync-state-response',
  },
  {
    routeId: 'sys-stats-in',
    guardId: 'system-stats-admin-read-guard',
    name: 'Admin Read Guard: System Stats',
    successId: 'sys-stats-fn',
    errorId: 'sys-resp',
  },
  {
    routeId: 'httpin_download_fieldtest',
    guardId: 'fieldtest-download-admin-read-guard',
    name: 'Admin Read Guard: Field-Test Export',
    successId: 'fn_build_sql_params',
    errorId: 'httpresp_download_fieldtest',
  },
];

for (const spec of routes) {
  const route = byId.get(spec.routeId);
  if (!route) throw new Error(`route not found: ${spec.routeId}`);
  if (byId.has(spec.guardId)) throw new Error(`guard already exists: ${spec.guardId}`);
  route.wires = [[spec.guardId]];
  flows.push({
    id: spec.guardId,
    type: 'function',
    z: route.z,
    name: spec.name,
    func: guardSource,
    outputs: 2,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [{ var: 'osiLib', module: 'osi-lib' }],
    x: Number(route.x || 200) + 220,
    y: Number(route.y || 200),
    wires: [[spec.successId], [spec.errorId]],
  });
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
