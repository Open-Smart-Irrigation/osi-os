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

function addLib(node, variable, moduleName) {
  node.libs = Array.isArray(node.libs) ? node.libs : [];
  if (!node.libs.some((lib) => lib.var === variable && lib.module === moduleName)) {
    node.libs.push({ var: variable, module: moduleName });
  }
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing ${label} anchor`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`ambiguous ${label} anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function existingAuthGuard(label, databaseVariable = 'db') {
  return `  if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('${label}: scope module unavailable: ' + scopeLoad.error, msg);
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      throw error;
    }
    await scopeLoad.value.assertAuthenticatedRole(
      ${databaseVariable},
      auth,
      'admin',
      { scopedMode: true }
    );
  }
`;
}

function wrapStandalone(node, label, errorReturn) {
  const original = node.func;
  node.func = `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  try {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('${label}: scope module unavailable: ' + scopeLoad.error, msg);
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      throw error;
    }
    await scopeLoad.value.authorizeAdminRead({
      Database: osiDb.Database,
      authorization: msg.req && msg.req.headers && msg.req.headers.authorization,
      configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
      fs: global.get('fs'),
      warn: function(message) { node.warn(message); }
    });
  } catch (error) {
    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = { message: msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error) };
    return ${errorReturn};
  }
}
${original}
})();`;
  addLib(node, 'osiLib', 'osi-lib');
  addLib(node, 'osiDb', 'osi-db-helper');
}

{
  const node = getNode('sync-state-build');
  node.func = replaceOnce(
    node.func,
    `  _db = new osiDb.Database('/data/db/farming.db');
  const q =`,
    `  _db = new osiDb.Database('/data/db/farming.db');
${existingAuthGuard('sync-state', '_db')}
  const q =`,
    'sync state database open'
  );
  addLib(node, 'osiLib', 'osi-lib');
}

{
  const node = getNode('al-status-decode');
  node.func = replaceOnce(
    node.func,
    `  db = new osiDb.Database('/data/db/farming.db');
  const q =`,
    `  db = new osiDb.Database('/data/db/farming.db');
${existingAuthGuard('account-link-status')}
  const q =`,
    'account-link status database open'
  );
  node.func = node.func
    .replace(
      /catch \(_\) \{\}/g,
      "catch (error) { node.warn('account-link-status: ' + String(error && error.message ? error.message : error)); }"
    );
  addLib(node, 'osiLib', 'osi-lib');
}

{
  const node = getNode('improvement-requests-api-router');
  const guard = existingAuthGuard('improvement-requests-read')
    .replace(
      `  if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {`,
      `  if (requestMethod === 'GET' &&
      (requestPath === '/api/improvement-requests' ||
       requestPath === '/api/improvement-requests/diagnostics-preview') &&
      String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {`
    );
  node.func = replaceOnce(
    node.func,
    `  db = new osiDb.Database('/data/db/farming.db');
  const userRows =`,
    `  db = new osiDb.Database('/data/db/farming.db');
${guard}
  const userRows =`,
    'improvement request database open'
  );
  addLib(node, 'osiLib', 'osi-lib');
}

for (const [id, label, errorReturn] of [
  ['a85523a4041eb6f4', 'database-download', 'msg'],
  ['sys-stats-fn', 'system-stats', 'msg'],
  ['fn_build_sql_params', 'field-test-export', 'msg'],
  ['get-gateway-location-auth-fn', 'gateway-location', '[null, msg]'],
]) {
  wrapStandalone(getNode(id), label, errorReturn);
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
