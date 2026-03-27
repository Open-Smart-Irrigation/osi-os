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
  '/api/sync/force',
  '/api/devices/:deveui/lsn50/mode',
  '/api/devices/:deveui/lsn50/interval'
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
  'Run Force Sync',
  'Auth + Parse LSN50 Mode',
  'Auth + Parse LSN50 Interval',
  'Authorize + Fanout LSN50 Mode',
  'Authorize + Fanout LSN50 Interval',
  'Format LSN50 Mode Response',
  'Format LSN50 Interval Response',
  'Build LSN50 mode downlink'
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function findNodeByName(name) {
  return flows.find((node) => node.name === name);
}

function findNodeById(id) {
  return flows.find((node) => node.id === id);
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

function expectIncludesById(nodeId, needle, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  if (!String(node.func || '').includes(needle)) {
    fail(`${nodeId} missing ${description}`);
  } else {
    console.log(`OK ${nodeId} ${description}`);
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
expectIncludes('Sync Init Schema + Triggers', 'COALESCE(server_username, username)', 'emits linked cloud usernames in device outbox events');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in bootstrap zone snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in bootstrap sensor data');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in force-sync device snapshots');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in force-sync zone snapshots');
expectIncludes('Run Force Sync', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in force-sync sensor data');
expectIncludes('Daily Dendrometer Analytics', 'const recoveryThreshold=(calibration.thresholds.mild||CALIBRATIONS.default.thresholds.mild)*(phenoMod>0?phenoMod:1.0);', 'uses calibration-aware recovery threshold');
expectIncludes('Daily Dendrometer Analytics', 't.twd_night_um<recoveryThreshold', 'uses absolute night TWD in recovery verification');
expectIncludes('Daily Dendrometer Analytics', "date>=date('${ANALYTICS_DATE}','-3 days')", 'uses the exact previous-three-day recovery window');
expectIncludes('Daily Dendrometer Analytics', "stressAdjustment='vpd_downgrade';", 'downgrades stress on high-VPD good-recovery days');
expectIncludes('Daily Dendrometer Analytics', "stressAdjustment='vpd_upgrade';", 'upgrades stress on low-VPD poor-recovery days');
expectIncludes('Daily Dendrometer Analytics', 'sdVpdR2Current=computeR2(', 'computes rolling SD-VPD correlation');
expectIncludes('Daily Dendrometer Analytics', 'sdVpdDecoupled=sdVpdR2Current!=null&&sdVpdR2Current<0.5*bl.sd_vpd_r2_baseline;', 'flags SD-VPD decoupling against the baseline');
expectIncludes('Daily Dendrometer Analytics', 't.baseline_complete===1', 'requires completed baselines for recovery verification pass checks');
expectIncludes('Daily Dendrometer Analytics', 't.mds_norm>0.7', 'requires strong MDS recovery before ending verification');
expectIncludes('Daily Dendrometer Analytics', 'vpd_override_summary:vpdOverrideSummary', 'stores VPD override diagnostics in recommendation_json');
expectIncludes('Daily Dendrometer Analytics', 'sd_vpd_summary:sdVpdSummary', 'stores SD-VPD diagnostics in recommendation_json');
expectIncludes('Get Zone Recommendations', 'zdr.recommendation_json', 'returns recommendation_json from the zone recommendation query');
expectIncludes('Get Zone Recommendations', 'recommendation_json:r.recommendation_json ?? null', 'exposes recommendation_json in the local recommendations API');
expectIncludes('Build Telemetry', 'lsn50_mode_code: observedModeCode', 'publishes observed LSN50 mode in edge telemetry');
expectIncludes('Decode LSN50', 'function detectLsn50ModeCode', 'decodes observed LSN50 mode from raw uplinks');
expectIncludes('Apply Config', 'd.modeCodeToStore = d.observedModeCode != null ? d.observedModeCode : deviceMode;', 'stores observed or configured LSN50 mode on ingest');
expectIncludesById('lsn50-sql-fn', 'lsn50_mode_code, lsn50_mode_label, lsn50_mode_observed_at', 'persists observed LSN50 mode into device_data');
expectIncludesById('format-devices', 'dd.lsn50_mode_code', 'returns observed LSN50 mode in GET /api/devices');
expectIncludesById('merge-device-data', 'device_mode: d.device_mode ?? 1', 'returns configured LSN50 mode in GET /api/devices');
expectIncludes('Route Command', "commandType === 'SET_LSN50_MODE'", 'routes SET_LSN50_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_INTERVAL'", 'routes SET_LSN50_INTERVAL gateway commands');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_MODE') {", 'updates the local configured LSN50 mode for synced commands');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_INTERVAL') {", 'accepts synced LSN50 interval commands on the gateway');
expectIncludes('Build Schedule ACK', "commandType === 'SET_LSN50_MODE' || commandType === 'SET_LSN50_INTERVAL'", 'skips duplicate generic ACKs for LSN50 mode and interval commands');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN lsn50_mode_code INTEGER', 'adds LSN50 mode columns to device_data');
expectIncludes('Sync Init Schema + Triggers', "'lsn50_mode_code', NEW.lsn50_mode_code", 'mirrors observed LSN50 mode in device_data outbox events');
expectIncludes('Auth + Parse LSN50 Mode', "Mode must be one of MOD1..MOD9", 'validates supported LSN50 modes on the local API');
expectIncludes('Auth + Parse LSN50 Interval', "Minutes must be a whole number between 1 and ", 'validates LSN50 uplink interval minutes on the local API');
expectIncludes('Authorize + Fanout LSN50 Mode', "commandType: 'SET_LSN50_MODE'", 'fans out validated local LSN50 mode changes into the shared command path');
expectIncludes('Authorize + Fanout LSN50 Interval', "commandType: 'SET_LSN50_INTERVAL'", 'fans out validated local LSN50 interval changes into the shared command path');
expectIncludes('Format LSN50 Mode Response', "confirmation: 'waiting_for_next_uplink'", 'returns explicit confirmation-waiting state from the local API');
expectIncludes('Format LSN50 Interval Response', "confirmation: 'downlink_queued'", 'returns queued state from the local LSN50 interval API');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_LSN50_INTERVAL'", 'builds Dragino interval downlinks');
expectIncludes('Build LSN50 mode downlink', 'rawBytes = [0x01, (intervalSeconds >> 16) & 0xFF, (intervalSeconds >> 8) & 0xFF, intervalSeconds & 0xFF];', 'encodes Dragino TDC interval bytes');

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
    const helperIndexPath = path.join(helperPath, 'index.js');
    const helperSource = fs.existsSync(helperIndexPath) ? fs.readFileSync(helperIndexPath, 'utf8') : '';
    if (error.code === 'MODULE_NOT_FOUND' && helperSource) {
      console.log(`OK helper source present despite missing local runtime deps: ${error.message}`);
      for (const exportName of ['createClient', 'createProvisioningClientFromEnv', 'normalizeApiUrl']) {
        if (!helperSource.includes(`${exportName}`)) {
          fail(`helper source missing export ${exportName}`);
        } else {
          console.log(`OK helper source includes ${exportName}`);
        }
      }
    } else {
      fail(`failed to load ChirpStack helper: ${error.message}`);
    }
  }
}

if (!process.exitCode) {
  console.log('Sync flow verification passed');
}
