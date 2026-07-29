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

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function loadWithRoundtripGuard(filePath) {
  const original = fs.readFileSync(filePath);
  const flows = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(flows)) !== 0) {
    throw new Error(`roundtrip guard failed for ${filePath}`);
  }
  return flows;
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one source anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const flows = loadWithRoundtripGuard(canonicalPath);
loadWithRoundtripGuard(mirrorPath);
const forceSync = flows.find((node) => node.id === 'sync-force-build');
if (!forceSync) throw new Error('sync-force-build not found');

forceSync.libs = Array.isArray(forceSync.libs) ? forceSync.libs : [];
if (!forceSync.libs.some((lib) => lib.var === 'osiLib')) {
  forceSync.libs.push({ var: 'osiLib', module: 'osi-lib' });
}

forceSync.func = replaceOnce(
  forceSync.func,
  "  const migration = await runGatewayMigrationPreflight(_db, q, run, setSyncState, identity, 'force-sync');\n" +
    '  const edgeBuildVersion',
  "  const migration = await runGatewayMigrationPreflight(_db, q, run, setSyncState, identity, 'force-sync');\n" +
    "  const installationLoad = osiLib.require('installation');\n" +
    "  if (!installationLoad.ok) throw new Error('Installation identity helper is unavailable');\n" +
    "  const installation = installationLoad.value;\n" +
    "  let installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1');\n" +
    "  if (installationRows.length === 0) {\n" +
    "    const createdInstallationUuid = installation.newInstallationUuid();\n" +
    "    const createdAt = new Date().toISOString();\n" +
    "    await run(\n" +
    "      \"INSERT OR IGNORE INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, ?, '[]', 'ACTIVE', ?, ?)\",\n" +
    "      [createdInstallationUuid, identity.deviceEui, createdAt, createdAt]\n" +
    "    );\n" +
    "    installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1');\n" +
    "  }\n" +
    "  if (installationRows.length !== 1) throw new Error('Installation identity is missing');\n" +
    "  const installationUuid = installation.normalizeInstallationUuid(installationRows[0].installation_uuid);\n" +
    "  if (!installationUuid) throw new Error('Installation identity is invalid');\n" +
    "  let storedPreviousGatewayDeviceEuis = [];\n" +
    "  try {\n" +
    "    storedPreviousGatewayDeviceEuis = JSON.parse(installationRows[0].previous_gateway_device_euis_json || '[]');\n" +
    "  } catch (error) {\n" +
    "    node.warn('Force sync installation EUI history is invalid: ' + String(error && error.message ? error.message : error));\n" +
    "    throw new Error('Installation gateway history is invalid');\n" +
    "  }\n" +
    "  const mergedInstallation = installation.mergeGatewayHistory(\n" +
    "    installationRows[0].current_gateway_device_eui,\n" +
    "    storedPreviousGatewayDeviceEuis.concat(migration.previousGatewayDeviceEuis),\n" +
    "    identity.deviceEui\n" +
    "  );\n" +
    "  await run(\n" +
    "    'UPDATE installation_identity SET current_gateway_device_eui=?, previous_gateway_device_euis_json=?, updated_at=? WHERE singleton_id=1',\n" +
    "    [mergedInstallation.currentGatewayDeviceEui, JSON.stringify(mergedInstallation.previousGatewayDeviceEuis), new Date().toISOString()]\n" +
    "  );\n" +
    '  const edgeBuildVersion',
  'force-sync installation identity'
);
forceSync.func = replaceOnce(
  forceSync.func,
  "  const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1'];",
  "  const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1', 'installation_recovery_v1'];",
  'force-sync recovery capability'
);
forceSync.func = replaceOnce(
  forceSync.func,
  "  const bootstrapGatewayIdentity = {\n" +
    "    previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis,\n" +
    '    edgeBuildVersion,',
  "  const bootstrapGatewayIdentity = {\n" +
    "    previousGatewayDeviceEuis: mergedInstallation.previousGatewayDeviceEuis,\n" +
    "    installationUuid,\n" +
    "    recoveryState: installationRows[0].recovery_state,\n" +
    "    recoveryOperationUuid: installationRows[0].recovery_operation_uuid || null,\n" +
    '    edgeBuildVersion,',
  'force-sync bootstrap identity'
);
forceSync.func = replaceOnce(
  forceSync.func,
  '  summary.gatewayIdentity.previousGatewayDeviceEuis = migration.previousGatewayDeviceEuis;',
  '  summary.gatewayIdentity.previousGatewayDeviceEuis = mergedInstallation.previousGatewayDeviceEuis;',
  'force-sync summary history'
);

const serialized = serialize(flows);
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
loadWithRoundtripGuard(canonicalPath);
loadWithRoundtripGuard(mirrorPath);
console.log('force-sync installation parity migration: OK');
