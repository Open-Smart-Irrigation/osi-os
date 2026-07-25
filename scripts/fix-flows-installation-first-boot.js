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
  if (count !== 1) {
    throw new Error(`${node.name}: expected one replacement anchor, found ${count}`);
  }
  node.func = node.func.replace(before, after);
}

const buildAuth = find('Build server auth request');
replaceOnce(
  buildAuth,
  `  const installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state FROM installation_identity WHERE singleton_id=1', []);
  if (installationRows.length !== 1) throw new Error('Installation identity is missing');`,
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
  if (installationRows.length !== 1) throw new Error('Installation identity is missing');`
);

const bootstrap = find('Build Cloud Bootstrap');
replaceOnce(
  bootstrap,
  `  const installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state FROM installation_identity WHERE singleton_id=1');
  if (installationRows.length !== 1) throw new Error('Installation identity is missing');
  const installationUuid = installation.normalizeInstallationUuid(installationRows[0].installation_uuid);
  if (!installationUuid) throw new Error('Installation identity is invalid');
  if (!installation.canonicalWritesAllowed(installationRows[0].recovery_state)) {
    throw new Error('Installation recovery must reconcile before normal bootstrap');
  }`,
  `  let installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1');
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
  if (!installationUuid) throw new Error('Installation identity is invalid');`
);
replaceOnce(
  bootstrap,
  `    installationUuid,
    edgeBuildVersion,`,
  `    installationUuid,
    recoveryState: installationRows[0].recovery_state,
    recoveryOperationUuid: installationRows[0].recovery_operation_uuid || null,
    edgeBuildVersion,`
);

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
console.log('Made installation identity creation first-boot safe in both maintained profiles');
