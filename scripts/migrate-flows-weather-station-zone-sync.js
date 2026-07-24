#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const HASHES = {
  'device-command-apply-fn':
    '8097919192d658dbd917ba4010e2a13f1806de60b3aa245f6410ff1a5d5d4fbf',
  's2120-zones-put-auth-fn':
    'cdba48b856d40e43792fd6eaab5c0f72397e8ecfa883f226c88b4d88cd02e548',
  'al-link-build-req':
    '79c1d3d4e7430a643ad9554e2aedb60736c1cd39ce4bcb7b34a3a9336ec1b020',
  'sync-bootstrap-build':
    'f083ce22de4e08a41e894d115fa2c376f9ec69ee5769a683c04171107a187110',
  'sync-force-build':
    '5e5162371363ebd8a6286444a4af29087a28ab168f34d04dcedce6fcd0a04e11',
};
const POST_HASHES = {
  'device-command-apply-fn':
    '135ca589659ab1abb0d174607175b4d5e7266de6cecc038d273e4de601df53fe',
  's2120-zones-put-auth-fn':
    '6f33ae73a0999f2b64a258fafcefe17c6b9434a5e7b543312132f2458401ee19',
  'al-link-build-req':
    'c9378c587f244d0c0d3b1d475faf26a87e7796c01531155fda9c7ada0b4a28fc',
  'sync-bootstrap-build':
    'a537fe004819f74125300f417e7041901617c08c8853d3dda87336883eec7061',
  'sync-force-build':
    '1fdb715383b3a7a0117a4ef009e3429aae613b851e656cfe1a121ddeb883d8c2',
};
const OLD_CAPABILITIES =
  "'linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', " +
  "'irrigation_config_desired_state_v1', 'device_desired_state_v1'";
const NEW_CAPABILITIES = OLD_CAPABILITIES +
  ", 'weather_station_zones_desired_state_v1'";

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one source match`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const PUT_FUNCTION = `return (async () => {
  function getAuthSecret() {
    const configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();
    if (configured) return configured;
    const fs = global.get('fs');
    const paths = ['/data/db/osi_auth_token_secret','/var/lib/node-red/.node-red/osi_auth_token_secret'];
    if (fs) {
      for (const p of paths) {
        try {
          const value = String(fs.readFileSync(p, 'utf8') || '').trim();
          if (value) return value;
        } catch (error) {
          node.warn('s2120-zones-put-auth-fn: ' + String(error && error.message ? error.message : error));
        }
      }
    }
    throw Object.assign(new Error('AUTH secret not configured'), { statusCode: 500 });
  }
  function toB64u(value) {
    return Buffer.from(value).toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function fromB64u(value) {
    let result = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (result.length % 4) result += '=';
    return Buffer.from(result, 'base64');
  }
  function verifyBearer(header) {
    delete msg._osiAuthFailure;
    if (!header || !header.startsWith('Bearer ')) {
      msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: 's2120-zones-put-auth-fn' };
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }
    const parts = header.substring(7).trim().split('.');
    if (!parts[0] || !parts[1]) {
      msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 's2120-zones-put-auth-fn' };
      throw Object.assign(new Error('Invalid token'), { statusCode: 401 });
    }
    const expected = toB64u(crypto.createHmac('sha256', getAuthSecret()).update(parts[0]).digest());
    if (parts[1].length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) {
      msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 's2120-zones-put-auth-fn' };
      throw Object.assign(new Error('Invalid token'), { statusCode: 401 });
    }
    const payload = JSON.parse(fromB64u(parts[0]).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: 's2120-zones-put-auth-fn' };
      throw Object.assign(new Error('Token expired'), { statusCode: 401 });
    }
    return { userId: Number(payload.userId) };
  }
  let db = null;
  const closeDb = () => db
    ? new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()))
    : Promise.resolve();
  try {
    const auth = verifyBearer(msg.req.headers.authorization);
    const deviceEui = String(msg.req.params.deveui || '').trim().toUpperCase();
    const rawZoneIds = msg.payload && msg.payload.zone_ids;
    if (!Array.isArray(rawZoneIds)) {
      throw Object.assign(new Error('zone_ids must be an array'), { statusCode: 400 });
    }
    const zoneIds = rawZoneIds.map(Number);
    if (zoneIds.some((value) => !Number.isInteger(value)) ||
        new Set(zoneIds).size !== zoneIds.length) {
      throw Object.assign(new Error('zone_ids must contain unique integers'), { statusCode: 400 });
    }
    const helperLoad = osiLib.require('device-commands');
    if (!helperLoad.ok) {
      throw Object.assign(new Error('Device command helper unavailable: ' + helperLoad.error), { statusCode: 500 });
    }
    db = new osiDb.Database('/data/db/farming.db');
    const devices = await db.all(
      'SELECT deveui FROM devices WHERE deveui=? AND user_id=? ' +
        "AND type_id='SENSECAP_S2120' AND deleted_at IS NULL",
      [deviceEui, auth.userId]
    );
    if (!devices[0]) {
      throw Object.assign(new Error('Device not found'), { statusCode: 404 });
    }
    const rows = zoneIds.length
      ? await db.all(
        'SELECT id,zone_uuid FROM irrigation_zones WHERE id IN (' +
          zoneIds.map(() => '?').join(',') +
          ') AND user_id=? AND deleted_at IS NULL',
        [...zoneIds, auth.userId]
      )
      : [];
    if (rows.length !== zoneIds.length) {
      throw Object.assign(new Error('One or more zones not found'), { statusCode: 400 });
    }
    const result = await helperLoad.value.replaceLocalWeatherStationZones(
      db,
      {
        device_eui: deviceEui,
        zone_uuids: rows.map((row) => row.zone_uuid).sort()
      },
      { gateway_device_eui: String(env.get('DEVICE_EUI') || '').trim().toUpperCase() }
    );
    const assigned = await db.all(
      'SELECT wsz.zone_id,iz.name AS zone_name FROM weather_station_zones wsz ' +
        'JOIN irrigation_zones iz ON iz.id=wsz.zone_id ' +
        'WHERE wsz.deveui=? ORDER BY iz.zone_uuid',
      [deviceEui]
    );
    msg.statusCode = 200;
    msg.payload = {
      zone_ids: assigned.map((row) => row.zone_id),
      zone_names: assigned.map((row) => row.zone_name),
      sync_version: result.sync_version
    };
  } catch (error) {
    msg.statusCode = error.statusCode || 500;
    msg.payload = { error: error.message };
  } finally {
    try {
      await closeDb();
    } catch (error) {
      node.warn('s2120-zones-put-auth-fn: ' + String(error && error.message ? error.message : error));
    }
  }
  msg.headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  return msg;
})();`;

function migrate(relative) {
  const file = path.join(ROOT, relative);
  const nodes = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const observed = Object.fromEntries(Object.keys(HASHES).map((id) => [
    id,
    byId.has(id) ? sha(byId.get(id).func || '') : null,
  ]));
  if (Object.keys(POST_HASHES).every((id) =>
    observed[id] === POST_HASHES[id])) {
    return;
  }
  for (const [id, expected] of Object.entries(HASHES)) {
    if (observed[id] !== expected) {
      throw new Error(`${relative}:${id}: source hash drift`);
    }
  }

  const applier = byId.get('device-command-apply-fn');
  applier.func = replaceOnce(
    applier.func,
    "const protectedTypes = new Set(['UPSERT_DEVICE', 'UNCLAIM_DEVICE']);",
    "const protectedTypes = new Set(['UPSERT_DEVICE', 'UNCLAIM_DEVICE', 'REPLACE_WEATHER_STATION_ZONES']);",
    'device protected types'
  );
  applier.func = replaceOnce(
    applier.func,
    '    || payload.device != null;',
    '    || payload.device != null\\n    || payload.weather_station_zones != null;',
    'device protected shape'
  );
  applier.func = replaceOnce(
    applier.func,
    '    const result = await helper.value.applyDeviceCommand(db, envelope, {',
    "    const applyCommand = commandType === 'REPLACE_WEATHER_STATION_ZONES'\\n" +
      '      ? helper.value.applyWeatherStationZonesCommand\\n' +
      '      : helper.value.applyDeviceCommand;\\n' +
      '    const result = await applyCommand(db, envelope, {',
    'device helper dispatch'
  );

  const put = byId.get('s2120-zones-put-auth-fn');
  put.func = PUT_FUNCTION;
  put.libs = [
    { var: 'crypto', module: 'crypto' },
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiLib', module: 'osi-lib' },
  ];

  for (const id of [
    'al-link-build-req', 'sync-bootstrap-build', 'sync-force-build',
  ]) {
    const node = byId.get(id);
    node.func = replaceOnce(
      node.func, OLD_CAPABILITIES, NEW_CAPABILITIES, `${id} capabilities`
    );
  }
  fs.writeFileSync(file, JSON.stringify(nodes, null, 2) + '\n');
}

for (const file of FLOWS) migrate(file);
console.log('Applied protected weather-station zone flow migration.');
