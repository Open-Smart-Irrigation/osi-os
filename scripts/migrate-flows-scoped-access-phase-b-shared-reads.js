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
  if (!node.libs.some((lib) => lib.var === variable)) {
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

{
  const route = getNode('get-catalog-http');
  if (JSON.stringify(route.wires) !== JSON.stringify([['catalog-response']])) {
    throw new Error('catalog route wiring changed');
  }
  route.wires = [['catalog-authenticated-read-guard']];
  flows.push({
    id: 'catalog-authenticated-read-guard',
    type: 'function',
    z: route.z,
    name: 'Require Enabled Account',
    func: `return (async () => {
if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
let db;
try {
  const scopeLoad = osiLib.require('scope');
  if (!scopeLoad.ok) {
    node.error('catalog read: scope module unavailable: ' + scopeLoad.error, msg);
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
  const user = await db.get(
    'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
    [auth.userId, auth.username]
  );
  if (!user || !user.user_uuid) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  await scope.assertEnabledAccount(db, user.user_uuid, { scopedMode: true });
  return [msg, null];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = {
    message: msg.statusCode === 403
      ? 'Forbidden'
      : String(error && error.message || error)
  };
  return [null, msg];
} finally {
  if (db) {
    try {
      await new Promise(function(resolve) { db.close(function() { resolve(); }); });
    } catch (error) {
      node.warn('catalog read close: ' + String(error && error.message ? error.message : error));
    }
  }
}
})();`,
    outputs: 2,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [
      { var: 'osiLib', module: 'osi-lib' },
      { var: 'osiDb', module: 'osi-db-helper' },
    ],
    x: 365,
    y: route.y,
    wires: [['catalog-response'], ['device-response']],
  });
  getNode('catalog-response').x = 600;
}

{
  const node = getNode('analysis-api-router-fn');
  addLib(node, 'osiLib', 'osi-lib');
  node.func = replaceOnce(
    node.func,
    `  const ownerUuid = await ownerUserUuid(q, auth);
  markPhase(phases, 'user', phaseStartedAt);
  const deviceEui = gatewayDeviceEui();
`,
    `  const ownerUuid = await ownerUserUuid(q, auth);
  markPhase(phases, 'user', phaseStartedAt);
  const deviceEui = gatewayDeviceEui();
  let scopeZoneUuids = null;
  if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('analysis reads: scope module unavailable: ' + scopeLoad.error, msg);
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      throw error;
    }
    await scopeLoad.value.assertEnabledAccount(db, ownerUuid, { scopedMode: true });
    scopeZoneUuids = await scopeLoad.value.listScopeZoneUuids(
      db,
      ownerUuid,
      { scopedMode: true }
    );
  }
`,
    'analysis scope setup'
  );
  node.func = node.func
    .replace(
      `{ deviceEui: deviceEui, userId: auth.userId }`,
      `{ deviceEui: deviceEui, userId: auth.userId, zoneUuids: scopeZoneUuids }`
    )
    .replace(
      `      aggregation: body.aggregation
`,
      `      aggregation: body.aggregation,
      zoneUuids: scopeZoneUuids
`
    )
    .replace(
      `{ userId: auth.userId, ownerUserUuid: ownerUuid, deviceEui: deviceEui }`,
      `{ userId: auth.userId, ownerUserUuid: ownerUuid, deviceEui: deviceEui, zoneUuids: scopeZoneUuids }`
    );
}

{
  const node = getNode('get-actuations-query');
  addLib(node, 'osiLib', 'osi-lib');
  node.func = `return (async()=>{
  if (!msg.payload || msg.payload.length === 0) {
    msg.statusCode = 401;
    msg.payload = { message: "User not found" };
    return [null, msg];
  }
  const userId = msg.payload[0].id;
  const _db = new osiDb.Database('/data/db/farming.db');
  const exec = (sql, params) => new Promise((res,rej) => _db.run(sql, params || [], e => e ? rej(e) : res()));
  const query = (sql, params) => new Promise((res,rej) => _db.all(sql, params || [], (e,r) => e ? rej(e) : res(r || [])));
  try {
    await exec(\`CREATE TABLE IF NOT EXISTS valve_actuation_expectations (
  expectation_id             TEXT PRIMARY KEY,
  device_eui                 TEXT NOT NULL,
  zone_id                    INTEGER,
  command_id                 TEXT,
  effect_key                 TEXT,
  commanded_at               TEXT NOT NULL,
  commanded_duration_seconds INTEGER NOT NULL,
  expected_close_at          TEXT NOT NULL,
  flow_rate_lpm              REAL,
  flow_rate_source           TEXT,
  estimated_gross_liters     REAL,
  volume_source              TEXT NOT NULL DEFAULT 'unknown',
  observed_open_at           TEXT,
  observed_close_at          TEXT,
  reconciliation_state       TEXT NOT NULL DEFAULT 'PENDING_OBSERVATION',
  cancel_reason              TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)\`);

    const scopedMode = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
    let zoneUuids = null;
    if (scopedMode) {
      const scopeLoad = osiLib.require('scope');
      if (!scopeLoad.ok) {
        node.error('recent actuations: scope module unavailable: ' + scopeLoad.error, msg);
        const error = new Error('scope resolver unavailable');
        error.statusCode = 500;
        throw error;
      }
      const users = await query(
        'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
        [userId, msg.authUsername]
      );
      if (!users.length || !users[0].user_uuid) {
        const error = new Error('Unauthorized');
        error.statusCode = 401;
        throw error;
      }
      await scopeLoad.value.assertEnabledAccount(
        _db,
        users[0].user_uuid,
        { scopedMode: true }
      );
      zoneUuids = await scopeLoad.value.listScopeZoneUuids(
        _db,
        users[0].user_uuid,
        { scopedMode: true }
      );
    }

    const select = \`
      SELECT
        vae.expectation_id,
        vae.device_eui,
        vae.zone_id,
        vae.command_id,
        vae.commanded_at,
        vae.commanded_duration_seconds,
        vae.expected_close_at,
        vae.flow_rate_lpm,
        vae.estimated_gross_liters,
        vae.observed_open_at,
        vae.observed_close_at,
        vae.reconciliation_state,
        vae.cancel_reason,
        d.name AS device_name,
        iz.name AS zone_name,
        ac.result AS command_result,
        ac.result_detail AS command_result_detail,
        ac.applied_at AS command_applied_at
      FROM valve_actuation_expectations vae
      JOIN devices d ON d.deveui = vae.device_eui
      LEFT JOIN irrigation_zones iz ON iz.id = vae.zone_id
      LEFT JOIN applied_commands ac ON ac.command_id = vae.command_id
    \`;
    let where;
    let params;
    if (zoneUuids !== null) {
      where = zoneUuids.length
        ? \`WHERE iz.zone_uuid IN (\${zoneUuids.map(() => '?').join(',')})\`
        : 'WHERE 1 = 0';
      params = zoneUuids;
    } else {
      where = 'WHERE d.user_id = ?';
      params = [userId];
    }
    const rows = await query(
      select + where + ' ORDER BY vae.commanded_at DESC LIMIT 50',
      params
    );
    msg.payload = rows;
    return [msg, null];
  } catch (error) {
    node.warn('recent actuations query: ' + String(error && error.message ? error.message : error));
    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = { message: msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error) };
    return [null, msg];
  } finally {
    try {
      await new Promise(function(resolve) { _db.close(function() { resolve(); }); });
    } catch (error) {
      node.warn('recent actuations close: ' + String(error && error.message ? error.message : error));
    }
  }
})();`;
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
