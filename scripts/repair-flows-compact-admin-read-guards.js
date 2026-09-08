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

const targets = [
  ['a85523a4041eb6f4', 'database-download', 'msg', 'msg.statusCode = 403;'],
  ['sys-stats-fn', 'system-stats', 'msg', 'var FAN_PROBE_FAILURES_CONTEXT_KEY'],
  ['fn_build_sql_params', 'field-test-export', 'msg', '// Builds a prepared SQL query'],
  ['get-gateway-location-auth-fn', 'gateway-location', '[null, msg]', 'function getAuthSecret()'],
];

for (const [id, label, errorReturn, originalMarker] of targets) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`node not found: ${id}`);
  const start = "return (async () => {\nlet scopeDb = null;";
  if (!node.func.startsWith(start)) throw new Error(`unexpected wrapper for ${id}`);
  const originalAt = node.func.indexOf(originalMarker);
  if (originalAt < 0) throw new Error(`missing original source marker for ${id}`);
  const original = node.func.slice(originalAt, -"\n})();".length);
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
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
