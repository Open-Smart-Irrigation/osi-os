#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

const scopeSetup = String.raw`
  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  let scopeZoneFilter = null;
  if (scopedOn) {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('zones-list: scope module unavailable: ' + scopeLoad.error, msg);
      msg.statusCode = 500;
      msg.payload = { message: 'scope resolver unavailable' };
      await new Promise((resolve) => _db.close(() => resolve()));
      return [null, msg];
    }
    const user = await _db.get('SELECT user_uuid FROM users WHERE id = ?', [userId]);
    scopeZoneFilter = await scopeLoad.value.listScopeZoneUuids(
      _db,
      user && user.user_uuid,
      { scopedMode: true }
    );
  }
  const escapedZoneUuids = (scopeZoneFilter || []).map(
    (zoneUuid) => "'" + String(zoneUuid).replace(/'/g, "''") + "'"
  );
  const zoneWhereClause = scopedOn
    ? (escapedZoneUuids.length ? 'iz.zone_uuid IN (' + escapedZoneUuids.join(',') + ')' : '1=0')
    : 'iz.user_id = ' + Number(userId);
  const deviceJoinClause = scopedOn
    ? 'd.irrigation_zone_id = iz.id AND d.deleted_at IS NULL'
    : 'd.irrigation_zone_id = iz.id AND d.user_id = ' + Number(userId);`;

const devicesQuerySource = String.raw`return (async () => {
  if (!msg.payload || msg.payload.length === 0) {
    msg.statusCode = 401;
    msg.payload = { message: 'User not found' };
    return [null, msg];
  }

  const userId = Number(msg.payload[0].id);
  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  let whereClause = 'd.user_id = ' + userId;
  if (scopedOn) {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('devices-list: scope module unavailable: ' + scopeLoad.error, msg);
      msg.statusCode = 500;
      msg.payload = { message: 'scope resolver unavailable' };
      return [null, msg];
    }
    const db = new osiDb.Database('/data/db/farming.db');
    try {
      const user = await db.get('SELECT user_uuid FROM users WHERE id = ?', [userId]);
      const zoneUuids = await scopeLoad.value.listScopeZoneUuids(
        db,
        user && user.user_uuid,
        { scopedMode: true }
      );
      const escaped = (zoneUuids || []).map(
        (zoneUuid) => "'" + String(zoneUuid).replace(/'/g, "''") + "'"
      );
      const zonePredicate = escaped.length
        ? 'iz.zone_uuid IN (' + escaped.join(',') + ')'
        : '0';
      whereClause = '(' + zonePredicate +
        " OR d.type_id IN ('SENSECAP_S2120','AQUASCOPE_LORAIN'))";
    } finally {
      try {
        await new Promise((resolve) => db.close(() => resolve()));
      } catch (error) {
        node.warn('devices-list scope db close failed: ' +
          (error && error.message ? error.message : error));
      }
    }
  }

  msg.topic = [
    'SELECT d.*, iz.zone_uuid AS irrigation_zone_uuid,',
    "  (SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_expectation_id,",
    "  (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_reconciliation_state,",
    "  (SELECT vae.commanded_at FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_commanded_at,",
    "  (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_expected_close_at",
    'FROM devices d',
    'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL',
    'WHERE ' + whereClause + ' AND d.deleted_at IS NULL',
    'ORDER BY d.created_at DESC'
  ].join('\n');
  return [msg, null];
})();`;

function addLib(node, entry) {
  node.libs = node.libs || [];
  if (!node.libs.some((candidate) => candidate.var === entry.var)) node.libs.push(entry);
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first === -1 || source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`${label}: expected exactly one reviewed anchor`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function migrate(source) {
  const flows = JSON.parse(source);
  const zones = flows.find((node) => node.id === 'get-zones-query');
  const devices = flows.find((node) => node.id === 'get-devices-query');
  if (!zones || zones.type !== 'function' || !devices || devices.type !== 'function') {
    throw new Error('reviewed list function nodes are missing');
  }
  if (!zones.func.includes("WHERE iz.user_id = ${userId} AND iz.deleted_at IS NULL")) {
    throw new Error('get-zones-query is not at the reviewed pre-Phase-B source');
  }
  zones.func = replaceOnce(
    zones.func,
    "  const query = (sql) => new Promise((res,rej) => _db.all(sql, (e,r) => e ? rej(e) : res(r || [])));\n",
    "  const query = (sql) => new Promise((res,rej) => _db.all(sql, (e,r) => e ? rej(e) : res(r || [])));\n" +
      scopeSetup + "\n",
    'get-zones-query scope setup'
  );
  zones.func = replaceOnce(
    zones.func,
    'LEFT JOIN devices d ON d.irrigation_zone_id = iz.id AND d.user_id = ${userId}',
    'LEFT JOIN devices d ON ${deviceJoinClause}',
    'get-zones-query device join'
  );
  zones.func = replaceOnce(
    zones.func,
    'WHERE iz.user_id = ${userId} AND iz.deleted_at IS NULL',
    'WHERE ${zoneWhereClause} AND iz.deleted_at IS NULL',
    'get-zones-query scope predicate'
  );
  addLib(zones, { var: 'osiLib', module: 'osi-lib' });

  if (!devices.func.includes('WHERE d.user_id = ${userId} AND d.deleted_at IS NULL')) {
    throw new Error('get-devices-query is not at the reviewed pre-Phase-B source');
  }
  devices.func = devicesQuerySource;
  devices.libs = [
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiLib', module: 'osi-lib' },
  ];
  return JSON.stringify(flows, null, 2) + '\n';
}

const original = flowPaths.map((flowPath) => fs.readFileSync(flowPath, 'utf8'));
if (original[0] !== original[1]) throw new Error('maintained flow profiles differ before migration');
const migrated = migrate(original[0]);
for (const flowPath of flowPaths) fs.writeFileSync(flowPath, migrated);
console.log('Scoped list filtering migrated in both maintained profiles.');
