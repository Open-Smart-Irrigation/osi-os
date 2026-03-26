#!/usr/bin/env node

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const flowPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'flows.json');
const nodeRedRoot = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red');
const helperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-chirpstack-helper'),
  path.join(nodeRedRoot, 'osi-chirpstack-helper')
];
const packageJsonPath = path.join(nodeRedRoot, 'package.json');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));

const requiredHttpRoutes = [
  '/api/account-link',
  '/api/account-link/status',
  '/api/sync/state',
  '/api/sync/force'
];

const requiredFunctionNodes = [
  'Validate & decode token',
  'Handle server auth response',
  'Handle claim response & build UPDATE',
  'Set Download Headers',
  'Daily Dendrometer Analytics',
  'Sync Init Schema + Triggers',
  'Build Cloud Bootstrap',
  'Mark Bootstrap Synced',
  'Build Edge Event Batch',
  'Mark Synced Events Delivered',
  'Build Pending Command Pull',
  'Replay Pending Commands',
  'Build Sync Token Refresh',
  'Store Refreshed Sync Token',
  'Run Force Sync'
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function findNodeByName(name) {
  return flows.find((node) => node.name === name);
}

function expectIncludes(nodeName, needle, description) {
  const node = findNodeByName(nodeName);
  if (!node) {
    fail(`missing function node ${nodeName}`);
    return;
  }
  if (!node.func.includes(needle)) {
    fail(`${nodeName} missing ${description}`);
  } else {
    console.log(`OK ${nodeName} ${description}`);
  }
}

function expectExcludes(nodeName, needle, description) {
  const node = findNodeByName(nodeName);
  if (!node) {
    fail(`missing function node ${nodeName}`);
    return;
  }
  if (node.func.includes(needle)) {
    fail(`${nodeName} still contains ${description}`);
  } else {
    console.log(`OK ${nodeName} removed ${description}`);
  }
}

for (const route of requiredHttpRoutes) {
  const node = flows.find((candidate) => candidate.type === 'http in' && candidate.url === route);
  if (!node) {
    fail(`missing HTTP route ${route}`);
  } else {
    console.log(`OK route ${route}`);
  }
}

for (const name of requiredFunctionNodes) {
  const node = findNodeByName(name);
  if (!node) {
    fail(`missing function node ${name}`);
    continue;
  }
  try {
    new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${node.func}\n})`);
    console.log(`OK compile ${name}`);
  } catch (error) {
    fail(`function node ${name} does not compile: ${error.message}`);
  }
}

const bootstrapInject = flows.find((node) => node.id === 'sync-bootstrap-inject');
if (!bootstrapInject) {
  fail('missing sync-bootstrap-inject node');
} else if (bootstrapInject.repeat !== '21600') {
  fail(`unexpected sync bootstrap repeat interval: ${bootstrapInject.repeat}`);
} else {
  console.log('OK bootstrap repeat 21600');
}

const refreshInject = flows.find((node) => node.id === 'sync-refresh-inject');
if (!refreshInject) {
  fail('missing sync-refresh-inject node');
} else if (refreshInject.repeat !== '3600') {
  fail(`unexpected sync refresh repeat interval: ${refreshInject.repeat}`);
} else {
  console.log('OK refresh repeat 3600');
}

const bootstrapNode = findNodeByName('Build Cloud Bootstrap');
if (bootstrapNode) {
  for (const key of ['sensorData', 'dendroReadings', 'dendroDaily', 'zoneRecommendations', 'zoneEnvironments', 'irrigationEvents']) {
    if (!bootstrapNode.func.includes(`${key}:`)) {
      fail(`bootstrap payload missing ${key}`);
    } else {
      console.log(`OK bootstrap includes ${key}`);
    }
  }
}

expectIncludes('Validate & decode token', 'const auth = verifyBearer', 'uses decoded local auth');
expectIncludes('Handle server auth response', 'statusCode >= 400 && statusCode < 500', 'maps remote auth failures away from 401');
expectIncludes('Handle server auth response', 'Server authentication returned no sync token', 'requires sync token on successful link');
expectIncludes('Handle claim response & build UPDATE', 'return [null, msg];', 'can stop before mutating local auth state');
expectIncludes('Set Download Headers', 'Database download is disabled', 'keeps database download disabled');
expectIncludes('Login User', 'ORDER BY CASE WHEN username', 'prefers local username matches');
expectIncludes('Process Result', 'Multiple accounts match this username', 'rejects ambiguous linked logins');
expectIncludes('Process Result', 'osi_auth_token_secret', 'uses a persisted local auth secret');
expectIncludes('CS Register Device', 'chirpstack.createProvisioningClientFromEnv(env)', 'uses shared ChirpStack provisioning helper');
expectIncludes('CS Register Device', 'ensureDeviceProvisioned', 'provisions devices through gRPC helper');
expectExcludes('CS Register Device', '/api/devices', 'legacy ChirpStack REST device endpoint');
expectIncludes('CS Register (cloud cmd)', 'chirpstack.createProvisioningClientFromEnv(env)', 'uses shared ChirpStack provisioning helper');
expectIncludes('CS Register (cloud cmd)', 'ensureDeviceProvisioned', 'provisions cloud-triggered devices through gRPC helper');
expectExcludes('CS Register (cloud cmd)', '/api/devices', 'legacy ChirpStack REST device endpoint');
expectIncludes('Sync Init Schema + Triggers', 'AFTER INSERT ON dendrometer_daily', 'emits dendro daily outbox rows from dendrometer_daily');
expectIncludes('Sync Init Schema + Triggers', 'AFTER UPDATE ON dendrometer_daily', 'updates dendro daily outbox rows from dendrometer_daily');
expectIncludes('Daily Dendrometer Analytics', 'const recoveryThreshold=(calibration.thresholds.mild||CALIBRATIONS.default.thresholds.mild)*(phenoMod>0?phenoMod:1.0);', 'uses calibration-aware recovery threshold');
expectIncludes('Daily Dendrometer Analytics', 't.twd_night_um<recoveryThreshold', 'uses absolute night TWD in recovery verification');
expectIncludes('Daily Dendrometer Analytics', "date>=date('${ANALYTICS_DATE}','-3 days')", 'uses the exact previous-three-day recovery window');

const authNodes = flows.filter((node) => typeof node.func === 'string' && node.func.includes('function getAuthSecret()'));
for (const insecureNeedle of ['osi-os-default-auth-secret', "env.get('CHIRPSTACK_API_KEY')"]) {
  const offendingNode = authNodes.find((node) => node.func.includes(insecureNeedle));
  if (offendingNode) {
    fail(`${offendingNode.name || offendingNode.id} still contains insecure auth secret fallback: ${insecureNeedle}`);
  } else {
    console.log(`OK removed insecure auth fallback ${insecureNeedle}`);
  }
}

if (!fs.existsSync(packageJsonPath)) {
  fail(`missing Node-RED package manifest at ${packageJsonPath}`);
} else {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  for (const dependency of ['@chirpstack/chirpstack-api', '@grpc/grpc-js', '@rakwireless/field-tester-server', 'bcryptjs', 'node-red-node-sqlite', 'osi-chirpstack-helper', 'sqlite3']) {
    if (!packageJson.dependencies || !packageJson.dependencies[dependency]) {
      fail(`package.json missing dependency ${dependency}`);
    } else {
      console.log(`OK package.json includes ${dependency}`);
    }
  }
}

const helperPath = helperCandidates.find((candidate) => fs.existsSync(candidate));
if (!helperPath) {
  fail(`missing ChirpStack helper module at one of: ${helperCandidates.join(', ')}`);
} else {
  try {
    const helper = require(helperPath);
    for (const exportName of ['createClient', 'createProvisioningClientFromEnv', 'normalizeApiUrl']) {
      if (typeof helper[exportName] !== 'function') {
        fail(`helper missing export ${exportName}`);
      } else {
        console.log(`OK helper exports ${exportName}`);
      }
    }
  } catch (error) {
    fail(`failed to load ChirpStack helper: ${error.message}`);
  }
}

if (!process.exitCode) {
  console.log('Sync flow verification passed');
}
