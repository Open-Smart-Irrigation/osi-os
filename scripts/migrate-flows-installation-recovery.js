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

function find(name) {
  const matches = flows.filter((node) => node.name === name);
  if (matches.length !== 1) throw new Error(`${name}: expected one node, found ${matches.length}`);
  return matches[0];
}

function replaceOnce(node, before, after) {
  const count = node.func.split(before).length - 1;
  if (count !== 1) throw new Error(`${node.name}: expected one replacement anchor, found ${count}: ${before.slice(0, 80)}`);
  node.func = node.func.replace(before, after);
}

function addOsiLib(node) {
  node.libs = Array.isArray(node.libs) ? node.libs : [];
  if (!node.libs.some((lib) => lib.var === 'osiLib')) {
    node.libs.push({ var: 'osiLib', module: 'osi-lib' });
  }
}

const buildAuth = find('Build server auth request');
addOsiLib(buildAuth);
replaceOnce(
  buildAuth,
  'return (async () => {\nfunction gatewayIdentityRestartPending() {',
  `return (async () => {
const installationLoad = osiLib.require('installation');
if (!installationLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'Installation identity helper is unavailable' };
  return [null, msg];
}
const installation = installationLoad.value;
function gatewayIdentityRestartPending() {`
);
replaceOnce(
  buildAuth,
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1'];",
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1', 'installation_recovery_v1'];"
);
replaceOnce(
  buildAuth,
  "const close = () => new Promise((resolve) => db.close(() => resolve()));",
  `const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
const close = () => new Promise((resolve) => db.close(() => resolve()));`
);
replaceOnce(
  buildAuth,
  "  const userRows = await q('SELECT id, user_uuid FROM users WHERE id = ? AND username = ?', [localUserId, localUsername]);",
  `  let installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1', []);
  if (installationRows.length === 0) {
    const createdInstallationUuid = installation.newInstallationUuid();
    const createdAt = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, ?, '[]', 'ACTIVE', ?, ?)",
      [createdInstallationUuid, gatewayDeviceEui, createdAt, createdAt]
    );
    installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1', []);
  }
  if (installationRows.length !== 1) throw new Error('Installation identity is missing');
  const installationUuid = installation.normalizeInstallationUuid(installationRows[0].installation_uuid);
  if (!installationUuid) throw new Error('Installation identity is invalid');
  let previousGatewayDeviceEuis = [];
  try {
    previousGatewayDeviceEuis = JSON.parse(installationRows[0].previous_gateway_device_euis_json || '[]');
  } catch (error) {
    node.warn('Account link installation EUI history is invalid: ' + String(error && error.message ? error.message : error));
    throw new Error('Installation gateway history is invalid');
  }
  const mergedInstallation = installation.mergeGatewayHistory(
    installationRows[0].current_gateway_device_eui,
    previousGatewayDeviceEuis,
    gatewayDeviceEui
  );
  await run(
    'UPDATE installation_identity SET current_gateway_device_eui=?, previous_gateway_device_euis_json=?, updated_at=? WHERE singleton_id=1',
    [mergedInstallation.currentGatewayDeviceEui, JSON.stringify(mergedInstallation.previousGatewayDeviceEuis), new Date().toISOString()]
  );
  flow.set('al_installation_uuid', installationUuid);
  const userRows = await q('SELECT id, user_uuid FROM users WHERE id = ? AND username = ?', [localUserId, localUsername]);`
);
replaceOnce(
  buildAuth,
  '  msg.payload = { action, username, email, password, gatewayDeviceEui, deviceEuis, localUserUuid, localUsernameSnapshot: localUsername, edgeBuildVersion, syncCapabilities };',
  '  msg.payload = { action, username, email, password, gatewayDeviceEui, installationUuid, deviceEuis, localUserUuid, localUsernameSnapshot: localUsername, edgeBuildVersion, syncCapabilities };'
);

const handleAuth = find('Handle server auth response');
addOsiLib(handleAuth);
replaceOnce(
  handleAuth,
  'return (async () => {\nconst statusCode',
  `return (async () => {
const installationLoad = osiLib.require('installation');
if (!installationLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'Installation identity helper is unavailable' };
  return [null, msg];
}
const installation = installationLoad.value;
const statusCode`
);
replaceOnce(
  handleAuth,
  "const offlineVerifierVersion = Number(data.offlineVerifierVersion || data.offline_verifier_version || 0);",
  `const offlineVerifierVersion = Number(data.offlineVerifierVersion || data.offline_verifier_version || 0);
const localInstallationUuid = installation.normalizeInstallationUuid(flow.get('al_installation_uuid'));
const remoteInstallationUuid = installation.normalizeInstallationUuid(data.installationUuid || data.installation_uuid || '');
try {
  installation.assertMatchingInstallation(localInstallationUuid, remoteInstallationUuid);
} catch (error) {
  msg.statusCode = 502;
  msg.payload = { message: 'Server authentication returned an installation identity mismatch' };
  return [null, msg];
}`
);
replaceOnce(
  handleAuth,
  "if (!Number.isFinite(offlineVerifierVersion) || offlineVerifierVersion <= 0) requiredFieldErrors.push('offline verifier version');",
  "if (!Number.isFinite(offlineVerifierVersion) || offlineVerifierVersion < 2) requiredFieldErrors.push('offline verifier v2');"
);
replaceOnce(
  handleAuth,
  "flow.set('al_offline_verifier_version', offlineVerifierVersion);",
  `flow.set('al_offline_verifier_version', offlineVerifierVersion);
flow.set('al_installation_uuid', remoteInstallationUuid);`
);

const lookupAuth = find('Lookup Auth User');
replaceOnce(
  lookupAuth,
  "'SELECT * FROM users WHERE username = ? OR server_username = ? ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id ASC',",
  "'SELECT users.*, (SELECT installation_uuid FROM installation_identity WHERE singleton_id=1) AS installation_uuid FROM users WHERE username = ? OR server_username = ? ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id ASC',"
);
replaceOnce(
  lookupAuth,
  '    try { await close(); } catch (_) {}',
  "    try { await close(); } catch (error) { node.warn('Auth lookup DB close failed: ' + String(error && error.message ? error.message : error)); }"
);

const processAuth = find('Process Result');
addOsiLib(processAuth);
replaceOnce(
  processAuth,
  'const result = msg.payload;\n\nfunction getAuthSecret() {',
  `const result = msg.payload;
const installationLoad = osiLib.require('installation');
if (!installationLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'Installation identity helper is unavailable' };
  return [null, msg];
}
const installation = installationLoad.value;

function getAuthSecret() {`
);
replaceOnce(
  processAuth,
  `function linkedPasswordValue(password, user) {
  return String(password || '') + '::' + linkedGatewayDeviceEui(user);
}`,
  `function linkedPasswordValue(password, user) {
  return installation.verifierSubject(
    password,
    Number(user && user.server_offline_verifier_version || 1),
    user && user.installation_uuid,
    linkedGatewayDeviceEui(user)
  );
}`
);

const finalizeAuth = find('Finalize linked account state');
addOsiLib(finalizeAuth);
replaceOnce(
  finalizeAuth,
  'return (async () => {\nconst localUsername',
  `return (async () => {
const installationLoad = osiLib.require('installation');
if (!installationLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'Installation identity helper is unavailable' };
  return [null, msg];
}
const installation = installationLoad.value;
const localUsername`
);
replaceOnce(
  finalizeAuth,
  "const cloudUserId = Number(flow.get('al_cloud_user_id') || 0);",
  `const cloudUserId = Number(flow.get('al_cloud_user_id') || 0);
const installationUuid = installation.normalizeInstallationUuid(flow.get('al_installation_uuid'));`
);
replaceOnce(
  finalizeAuth,
  '|| !gatewayDeviceEui) {',
  '|| !gatewayDeviceEui || !installationUuid || offlineVerifierVersion < 2) {'
);
replaceOnce(
  finalizeAuth,
  `"INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at) VALUES('cloud', 1, ?, ?, ?, ?) ON CONFLICT(peer_node) DO UPDATE SET linked=1, server_url=excluded.server_url, cloud_user_id=excluded.cloud_user_id, gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at`,
  `"INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at, installation_uuid) VALUES('cloud', 1, ?, ?, ?, ?, ?) ON CONFLICT(peer_node) DO UPDATE SET linked=1, server_url=excluded.server_url, cloud_user_id=excluded.cloud_user_id, gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at, installation_uuid=excluded.installation_uuid`
);
replaceOnce(
  finalizeAuth,
  '[serverUrl, String(cloudUserId), gatewayDeviceEui, now]',
  '[serverUrl, String(cloudUserId), gatewayDeviceEui, now, installationUuid]'
);
replaceOnce(
  finalizeAuth,
  '  try { await close(); } catch (_) {}',
  "  try { await close(); } catch (closeError) { node.warn('Linked account finalization DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError)); }"
);

const bootstrap = find('Build Cloud Bootstrap');
addOsiLib(bootstrap);
replaceOnce(
  bootstrap,
  "  const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1'];",
  "  const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1', 'installation_recovery_v1'];"
);
replaceOnce(
  bootstrap,
  `  const identity = requireStableGatewayIdentity(setSyncState, 'bootstrap sync');
  const migration = await runGatewayMigrationPreflight(_db, q, run, setSyncState, identity, 'bootstrap');
  const edgeBuildVersion`,
  `  const identity = requireStableGatewayIdentity(setSyncState, 'bootstrap sync');
  const migration = await runGatewayMigrationPreflight(_db, q, run, setSyncState, identity, 'bootstrap');
  const installationLoad = osiLib.require('installation');
  if (!installationLoad.ok) throw new Error('Installation identity helper is unavailable');
  const installation = installationLoad.value;
  let installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1');
  if (installationRows.length === 0) {
    const createdInstallationUuid = installation.newInstallationUuid();
    const createdAt = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, ?, '[]', 'ACTIVE', ?, ?)",
      [createdInstallationUuid, identity.deviceEui, createdAt, createdAt]
    );
    installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1');
  }
  if (installationRows.length !== 1) throw new Error('Installation identity is missing');
  const installationUuid = installation.normalizeInstallationUuid(installationRows[0].installation_uuid);
  if (!installationUuid) throw new Error('Installation identity is invalid');
  let storedPreviousGatewayDeviceEuis = [];
  try {
    storedPreviousGatewayDeviceEuis = JSON.parse(installationRows[0].previous_gateway_device_euis_json || '[]');
  } catch (error) {
    node.warn('Bootstrap installation EUI history is invalid: ' + String(error && error.message ? error.message : error));
    throw new Error('Installation gateway history is invalid');
  }
  const mergedInstallation = installation.mergeGatewayHistory(
    installationRows[0].current_gateway_device_eui,
    storedPreviousGatewayDeviceEuis.concat(migration.previousGatewayDeviceEuis),
    identity.deviceEui
  );
  await run(
    'UPDATE installation_identity SET current_gateway_device_eui=?, previous_gateway_device_euis_json=?, updated_at=? WHERE singleton_id=1',
    [mergedInstallation.currentGatewayDeviceEui, JSON.stringify(mergedInstallation.previousGatewayDeviceEuis), new Date().toISOString()]
  );
  const edgeBuildVersion`
);
replaceOnce(
  bootstrap,
  '    previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis,\n    edgeBuildVersion,',
  '    previousGatewayDeviceEuis: mergedInstallation.previousGatewayDeviceEuis,\n    installationUuid,\n    recoveryState: installationRows[0].recovery_state,\n    recoveryOperationUuid: installationRows[0].recovery_operation_uuid || null,\n    edgeBuildVersion,'
);
replaceOnce(
  bootstrap,
  '  msg._gatewayMigrationPreviousGatewayDeviceEuis = migration.previousGatewayDeviceEuis;',
  '  msg._gatewayMigrationPreviousGatewayDeviceEuis = mergedInstallation.previousGatewayDeviceEuis;'
);

const forceSync = find('Run Force Sync');
addOsiLib(forceSync);
replaceOnce(
  forceSync,
  `  const migration = await runGatewayMigrationPreflight(_db, q, run, setSyncState, identity, 'force-sync');
  const edgeBuildVersion`,
  `  const migration = await runGatewayMigrationPreflight(_db, q, run, setSyncState, identity, 'force-sync');
  const installationLoad = osiLib.require('installation');
  if (!installationLoad.ok) throw new Error('Installation identity helper is unavailable');
  const installation = installationLoad.value;
  let installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1');
  if (installationRows.length === 0) {
    const createdInstallationUuid = installation.newInstallationUuid();
    const createdAt = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, ?, '[]', 'ACTIVE', ?, ?)",
      [createdInstallationUuid, identity.deviceEui, createdAt, createdAt]
    );
    installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1');
  }
  if (installationRows.length !== 1) throw new Error('Installation identity is missing');
  const installationUuid = installation.normalizeInstallationUuid(installationRows[0].installation_uuid);
  if (!installationUuid) throw new Error('Installation identity is invalid');
  let storedPreviousGatewayDeviceEuis = [];
  try {
    storedPreviousGatewayDeviceEuis = JSON.parse(installationRows[0].previous_gateway_device_euis_json || '[]');
  } catch (error) {
    node.warn('Force sync installation EUI history is invalid: ' + String(error && error.message ? error.message : error));
    throw new Error('Installation gateway history is invalid');
  }
  const mergedInstallation = installation.mergeGatewayHistory(
    installationRows[0].current_gateway_device_eui,
    storedPreviousGatewayDeviceEuis.concat(migration.previousGatewayDeviceEuis),
    identity.deviceEui
  );
  await run(
    'UPDATE installation_identity SET current_gateway_device_eui=?, previous_gateway_device_euis_json=?, updated_at=? WHERE singleton_id=1',
    [mergedInstallation.currentGatewayDeviceEui, JSON.stringify(mergedInstallation.previousGatewayDeviceEuis), new Date().toISOString()]
  );
  const edgeBuildVersion`
);
replaceOnce(
  forceSync,
  "  const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1'];",
  "  const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1', 'weather_station_zones_desired_state_v1', 'installation_recovery_v1'];"
);
replaceOnce(
  forceSync,
  `  const bootstrapGatewayIdentity = {
    previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis,
    edgeBuildVersion,`,
  `  const bootstrapGatewayIdentity = {
    previousGatewayDeviceEuis: mergedInstallation.previousGatewayDeviceEuis,
    installationUuid,
    recoveryState: installationRows[0].recovery_state,
    recoveryOperationUuid: installationRows[0].recovery_operation_uuid || null,
    edgeBuildVersion,`
);
replaceOnce(
  forceSync,
  '  summary.gatewayIdentity.previousGatewayDeviceEuis = migration.previousGatewayDeviceEuis;',
  '  summary.gatewayIdentity.previousGatewayDeviceEuis = mergedInstallation.previousGatewayDeviceEuis;'
);

const syncState = find('Build Sync State');
replaceOnce(
  syncState,
  '  const state = flow.get(\'sync_state\') || {};',
  `  const installationRows = await q("SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid, restore_started_at, reconciled_at FROM installation_identity WHERE singleton_id=1");
  const installationRow = installationRows[0] || {};
  let previousGatewayDeviceEuis = [];
  try {
    previousGatewayDeviceEuis = JSON.parse(installationRow.previous_gateway_device_euis_json || '[]');
  } catch (error) {
    node.warn('Sync state installation EUI history is invalid: ' + String(error && error.message ? error.message : error));
  }
  const state = flow.get('sync_state') || {};`
);
replaceOnce(
  syncState,
  '    gatewayIdentity,\n    linkedAuthPackageValid,',
  `    gatewayIdentity,
    installationIdentity: {
      installationUuid: installationRow.installation_uuid || null,
      currentGatewayDeviceEui: installationRow.current_gateway_device_eui || null,
      previousGatewayDeviceEuis,
      recoveryState: installationRow.recovery_state || 'BLOCKED',
      recoveryOperationUuid: installationRow.recovery_operation_uuid || null,
      restoreStartedAt: installationRow.restore_started_at || null,
      reconciledAt: installationRow.reconciled_at || null
    },
    linkedAuthPackageValid,`
);

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
console.log('Updated installation recovery flow contract in both maintained profiles');
