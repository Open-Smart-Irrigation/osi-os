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
const node = flows.find((candidate) => candidate.id === 'history-api-router-fn');
if (!node) throw new Error('history-api-router-fn not found');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing ${label} anchor`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`ambiguous ${label} anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

let source = node.func;

source = replaceOnce(
  source,
  `async function getActiveZoneSeason(q, zoneId) {
  const rows = await q('SELECT * FROM zone_seasons WHERE zone_id = ? AND is_active = 1 ORDER BY starts_on DESC, id DESC LIMIT 1', [zoneId]);
  return rows[0] || null;
}

async function getOwnedZoneContext(q, auth, zoneId) {
  const rows = await q('SELECT * FROM irrigation_zones WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [zoneId, auth.userId]);
  if (!rows.length) HR.httpError(404, 'Zone not found or access denied');
  const zone = rows[0];
  const devices = await q('SELECT * FROM devices WHERE irrigation_zone_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY deveui ASC', [zoneId, auth.userId]);`,
  `async function getActiveZoneSeason(q, zoneId) {
  const rows = await q('SELECT * FROM zone_seasons WHERE zone_id = ? AND is_active = 1 ORDER BY starts_on DESC, id DESC LIMIT 1', [zoneId]);
  return rows[0] || null;
}

async function scopeCheckForRoute(db, scope, principal, route) {
  if (!principal || !principal.scoped || !route) return;
  const user = await db.get(
    'SELECT user_uuid, disabled_at FROM users WHERE username = ?',
    [principal.username]
  );
  if (!user || user.disabled_at) HR.httpError(403, 'forbidden');
  if (route.kind === 'zone') {
    const zoneUuid = await scope.resolveZoneUuidById(db, route.zoneId);
    if (!zoneUuid) HR.httpError(404, 'zone not found');
    await scope.assertZoneAccess(db, user.user_uuid, zoneUuid, { scopedMode: true });
    return;
  }
  if (route.kind === 'gateway') {
    await scope.assertRole(db, user.user_uuid, 'admin', { scopedMode: true });
  }
  // Workspaces remain owner-only through their unconditional user_id filters.
  // Resolving the user above adds only the disabled-account check in scoped mode.
}

function scopeRouteForRequest(method, requestPath, params) {
  if (method === 'GET' && /^\\/api\\/history\\/zones\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'zone', zoneId: HR.parseZoneId(params && params.zoneId) };
  }
  if (method === 'GET' && /^\\/api\\/history\\/gateways\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'gateway' };
  }
  if (/^\\/api\\/history\\/workspaces(?:\\/[^/]+)?$/.test(requestPath)) {
    return { kind: 'workspace' };
  }
  return null;
}

async function getOwnedZoneContext(q, auth, zoneId) {
  const rows = scopedReadZoneAccess
    ? await q('SELECT * FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL LIMIT 1', [zoneId])
    : await q('SELECT * FROM irrigation_zones WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [zoneId, auth.userId]);
  if (!rows.length) HR.httpError(404, 'Zone not found or access denied');
  const zone = rows[0];
  const devices = scopedReadZoneAccess
    ? await q('SELECT * FROM devices WHERE irrigation_zone_id = ? AND deleted_at IS NULL ORDER BY deveui ASC', [zoneId])
    : await q('SELECT * FROM devices WHERE irrigation_zone_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY deveui ASC', [zoneId, auth.userId]);`,
  'zone context'
);

source = replaceOnce(
  source,
  `async function getGatewayContext(q, auth, gatewayEui) {
  const zones = await q('SELECT * FROM irrigation_zones WHERE gateway_device_eui = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id ASC', [gatewayEui, auth.userId]);
  const devices = await q('SELECT * FROM devices WHERE gateway_device_eui = ? AND user_id = ? AND deleted_at IS NULL ORDER BY deveui ASC', [gatewayEui, auth.userId]);`,
  `async function getGatewayContext(q, auth, gatewayEui) {
  const zones = scopedGatewayReadAccess
    ? await q('SELECT * FROM irrigation_zones WHERE gateway_device_eui = ? AND deleted_at IS NULL ORDER BY id ASC', [gatewayEui])
    : await q('SELECT * FROM irrigation_zones WHERE gateway_device_eui = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id ASC', [gatewayEui, auth.userId]);
  const devices = scopedGatewayReadAccess
    ? await q('SELECT * FROM devices WHERE gateway_device_eui = ? AND deleted_at IS NULL ORDER BY deveui ASC', [gatewayEui])
    : await q('SELECT * FROM devices WHERE gateway_device_eui = ? AND user_id = ? AND deleted_at IS NULL ORDER BY deveui ASC', [gatewayEui, auth.userId]);`,
  'gateway context'
);

source = replaceOnce(
  source,
  `const requestMethod = String(msg.req && msg.req.method || '').toUpperCase();
const requestPath = String(msg.req && (msg.req.path || (msg.req.originalUrl || '').split('?')[0]) || '');
const requestStartedAt = Date.now();`,
  `const requestMethod = String(msg.req && msg.req.method || '').toUpperCase();
const requestPath = String(msg.req && (msg.req.path || (msg.req.originalUrl || '').split('?')[0]) || '');
const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
const scopedReadZoneAccess = scopedOn && requestMethod === 'GET';
const scopedGatewayReadAccess = scopedOn && requestMethod === 'GET';
const requestStartedAt = Date.now();`,
  'request metadata'
);

source = replaceOnce(
  source,
  `  db = new osiDb.Database('/data/db/farming.db');
  markPhase('dbOpen', phaseStartedAt);
  phaseStartedAt = Date.now();
  if (global.get('historySchemaGuardVersion') !== HISTORY_SCHEMA_GUARD_VERSION) {`,
  `  db = new osiDb.Database('/data/db/farming.db');
  markPhase('dbOpen', phaseStartedAt);
  let scope = null;
  if (scopedOn) {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('history-router: scope module unavailable: ' + scopeLoad.error, msg);
      HR.httpError(500, 'scope resolver unavailable');
    }
    scope = scopeLoad.value;
  }
  await scopeCheckForRoute(
    db,
    scope,
    { username: auth.username, scoped: scopedOn },
    scopeRouteForRequest(requestMethod, requestPath, msg.req && msg.req.params)
  );
  phaseStartedAt = Date.now();
  if (global.get('historySchemaGuardVersion') !== HISTORY_SCHEMA_GUARD_VERSION) {`,
  'scope enforcement'
);

node.func = source;
if (!node.libs.some((lib) => lib.var === 'osiLib' && lib.module === 'osi-lib')) {
  node.libs.push({ var: 'osiLib', module: 'osi-lib' });
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
