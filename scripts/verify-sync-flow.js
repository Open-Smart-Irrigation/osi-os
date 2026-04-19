#!/usr/bin/env node

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const flowPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'flows.json');
const nodeRedRoot = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red');
const deployScriptPath = path.resolve(__dirname, '..', 'deploy.sh');
const nodeRedInitPath = path.resolve(__dirname, '..', 'feeds', 'chirpstack-openwrt-feed', 'apps', 'node-red', 'files', 'node-red.init');
const osiServerDefaultsPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'etc', 'uci-defaults', '96_osi_server_config');
const sx1301GatewayDefaultPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'etc', 'uci-defaults', '99_set_sx1301_gateway_id');
const gatewayIdentityHelperPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'libexec', 'osi-gateway-identity.sh');
const chirpstackBootstrapPath = path.resolve(__dirname, 'chirpstack-bootstrap.js');
const lsn50CodecPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'codecs', 'dragino_lsn50_decoder.js');
const reactGuiApiPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'services', 'api.ts');
const farmingTypesPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'types', 'farming.ts');
const dendroMonitorPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'DendrometerMonitor.tsx');
const dendroDrawerPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'dendrometer', 'DendrometerMonitor.tsx');
const draginoTempCardPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'DraginoTempCard.tsx');
const helperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-chirpstack-helper'),
  path.join(nodeRedRoot, 'osi-chirpstack-helper')
];
const dbHelperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-db-helper'),
  path.join(nodeRedRoot, 'osi-db-helper')
];
const dendroHelperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-dendro-helper'),
  path.join(nodeRedRoot, 'osi-dendro-helper')
];
const packageJsonPath = path.join(nodeRedRoot, 'package.json');
const deployScript = fs.readFileSync(deployScriptPath, 'utf8');
const nodeRedInitScript = fs.readFileSync(nodeRedInitPath, 'utf8');
const osiServerDefaultsScript = fs.readFileSync(osiServerDefaultsPath, 'utf8');
const sx1301GatewayDefaultScript = fs.readFileSync(sx1301GatewayDefaultPath, 'utf8');
const gatewayIdentityHelperScript = fs.readFileSync(gatewayIdentityHelperPath, 'utf8');
const chirpstackBootstrapScript = fs.readFileSync(chirpstackBootstrapPath, 'utf8');
const lsn50CodecSource = fs.existsSync(lsn50CodecPath) ? fs.readFileSync(lsn50CodecPath, 'utf8') : '';
const reactGuiApiSource = fs.readFileSync(reactGuiApiPath, 'utf8');
const farmingTypesSource = fs.readFileSync(farmingTypesPath, 'utf8');
const dendroMonitorSource = fs.readFileSync(dendroMonitorPath, 'utf8');
const dendroDrawerSource = fs.readFileSync(dendroDrawerPath, 'utf8');
const draginoTempCardSource = fs.readFileSync(draginoTempCardPath, 'utf8');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const pendingChecks = [];

const requiredHttpRoutes = [
  '/api/account-link',
  '/api/account-link/status',
  '/api/sync/state',
  '/api/sync/force',
  '/api/devices/:deveui/lsn50/mode',
  '/api/devices/:deveui/lsn50/interval',
  '/api/devices/:deveui/lsn50/interrupt-mode',
  '/api/devices/:deveui/lsn50/5v-warmup',
  '/api/devices/:deveui/kiwi/interval',
  '/api/devices/:deveui/kiwi/temperature-humidity/enable',
  '/api/devices/:deveui/strega/interval',
  '/api/devices/:deveui/strega/model',
  '/api/devices/:deveui/strega/timed-action',
  '/api/devices/:deveui/strega/magnet',
  '/api/devices/:deveui/strega/partial-opening',
  '/api/devices/:deveui/strega/flushing',
  '/api/devices/:deveui/dendro-config',
  '/api/devices/:deveui/dendro-baseline/reset',
  '/api/devices/:deveui/zone-assignments',
  '/api/gateway/location',
  '/api/gateways/:gatewayEui/location',
  '/api/irrigation-zones/:zone_id/environment-summary'
];

const requiredFunctionNodes = [
  'Validate & decode token',
  'Build server auth request',
  'Handle server auth response',
  'Finalize linked account state',
  'Persist MQTT Broker Config',
  'Rollback MQTT Broker Config',
  'Schedule Link Restart',
  'Clear link flow state',
  'Clear MQTT Broker Config',
  'Decode token & build UPDATE',
  'Clear linked account state',
  'Restore MQTT Broker Config',
  'Schedule Unlink Restart',
  'Set Download Headers',
  'Daily Dendrometer Analytics',
  'Sync Init Schema + Triggers',
  'Build Cloud Bootstrap',
  'Mark Bootstrap Synced',
  'Build Edge Event Batch',
  'Mark Synced Events Delivered',
  'Build Pending Command Pull',
  'Build Sync State',
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
  'Auth + Parse LSN50 Interrupt',
  'Auth + Parse LSN50 5V Warmup',
  'Authorize + Fanout LSN50 Advanced',
  'Format LSN50 Advanced Response',
  'Auth + Parse Kiwi Interval',
  'Authorize + Fanout Kiwi Interval',
  'Format Kiwi Interval Response',
  'Auth + Parse Kiwi Temp/Humidity',
  'Authorize + Fanout Kiwi Temp/Humidity',
  'Format Kiwi Temp/Humidity Response',
  'Auth + Parse STREGA Interval',
  'Authorize + Fanout STREGA Interval',
  'Format STREGA Interval Response',
  'Auth + Parse STREGA Model',
  'Auth + Parse STREGA Timed Action',
  'Auth + Parse STREGA Magnet',
  'Auth + Parse STREGA Partial Opening',
  'Auth + Parse STREGA Flushing',
  'Authorize + Fanout STREGA Advanced',
  'Format STREGA Advanced Response',
  'Auth + Parse Dendro Config',
  'Format Dendro Config Response',
  'CS Register (cloud cmd)',
  'Build Special Command ACK',
  'Build LSN50 mode downlink',
  'Process S2120',
  'Aggregate Zone Rain',
  'Get Zone Assignments',
  'Auth + Set Zone Assignments',
  'Auth + Query Gateway Location',
  'Format Gateway Location Response',
  'Get Zone Environment Summary'
];

const directDbOpenCount = flows.filter((node) =>
  typeof node.func === 'string' && node.func.includes("new sqlite3.Database('/data/db/farming.db')")
).length;
if (directDbOpenCount > 0) {
  fail(`found ${directDbOpenCount} direct sqlite database opens in flows.json`);
} else {
  console.log('OK no direct sqlite database opens remain in flows.json');
}

const helperAliasIssues = flows.filter((node) => {
  const libs = Array.isArray(node.libs) ? node.libs : [];
  const helperVars = libs
    .filter((item) => item && item.module === 'osi-db-helper')
    .map((item) => item.var);
  if (!helperVars.length) return false;
  return !helperVars.includes('osiDb') || helperVars.includes('sqlite3');
});
if (helperAliasIssues.length > 0) {
  fail(`found ${helperAliasIssues.length} osi-db-helper nodes without the osiDb alias`);
} else {
  console.log('OK osi-db-helper nodes consistently use the osiDb alias');
}

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
  const func = String(node.func || '');
  if (!func.includes(needle)) {
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
  const func = String(node.func || '');
  if (func.includes(needle)) {
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

function expectExcludesById(nodeId, needle, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  if (String(node.func || '').includes(needle)) {
    fail(`${nodeId} still contains ${description}`);
  } else {
    console.log(`OK ${nodeId} removed ${description}`);
  }
}

function expectMissingNodeById(nodeId, description) {
  if (findNodeById(nodeId)) {
    fail(`${nodeId} still exists: ${description}`);
  } else {
    console.log(`OK ${nodeId} removed ${description}`);
  }
}

function expectLibById(nodeId, varName, moduleName, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  const libs = Array.isArray(node.libs) ? node.libs : [];
  const found = libs.some((item) => item && item.var === varName && item.module === moduleName);
  if (!found) {
    fail(`${nodeId} missing ${description}`);
  } else {
    console.log(`OK ${nodeId} ${description}`);
  }
}

function expectWireById(nodeId, targetId, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  const wires = Array.isArray(node.wires) ? node.wires.flat() : [];
  if (!wires.includes(targetId)) {
    fail(`${nodeId} missing ${description}`);
  } else {
    console.log(`OK ${nodeId} ${description}`);
  }
}

function expectFileIncludes(fileLabel, content, needle, description) {
  if (!content.includes(needle)) {
    fail(`${fileLabel} missing ${description}`);
  } else {
    console.log(`OK ${fileLabel} ${description}`);
  }
}

function expectFileExcludes(fileLabel, content, needle, description) {
  if (content.includes(needle)) {
    fail(`${fileLabel} still contains ${description}`);
  } else {
    console.log(`OK ${fileLabel} removed ${description}`);
  }
}

function expectCondition(condition, successMessage, failureMessage) {
  if (!condition) {
    fail(failureMessage || successMessage);
  } else {
    console.log(`OK ${successMessage}`);
  }
}

function expectEqual(actual, expected, description) {
  if (actual !== expected) {
    fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`OK ${description}`);
  }
}

function expectApprox(actual, expected, epsilon, description) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon) {
    fail(`${description}: expected ${expected} +/- ${epsilon}, got ${actual}`);
  } else {
    console.log(`OK ${description}`);
  }
}

function expectIncludesForEach(nodeNames, needle, description) {
  for (const nodeName of nodeNames) {
    expectIncludes(nodeName, needle, description);
  }
}

function expectExcludesForEach(nodeNames, needle, description) {
  for (const nodeName of nodeNames) {
    expectExcludes(nodeName, needle, description);
  }
}

async function executeFunctionNodeById(nodeId, msg, options = {}) {
  const node = findNodeById(nodeId);
  if (!node) {
    throw new Error(`missing node ${nodeId}`);
  }
  const flowState = new Map(Object.entries(options.flowState || {}));
  const fn = new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${node.func}\n})`).runInNewContext({
    Buffer,
    console,
    require,
    process,
    setTimeout,
    clearTimeout,
  });
  const flowApi = {
    get(key) {
      return flowState.get(key);
    },
    set(key, value) {
      if (value === undefined) flowState.delete(key);
      else flowState.set(key, value);
    },
  };
  const envValues = options.env || {};
  const envApi = {
    get(key) {
      return envValues[key];
    },
  };
  const noopStore = {
    get() {
      return undefined;
    },
    set() {},
  };
  const nodeApi = Object.assign(
    {
      error() {},
      warn() {},
      status() {},
    },
    options.node || {}
  );
  return fn(msg, nodeApi, flowApi, envApi, options.context || noopStore, options.global || noopStore, () => undefined, () => {});
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
  for (const key of ['sensorData', 'dendroReadings', 'dendroDaily', 'zoneRecommendations', 'zoneEnvironments', 'gatewayLocations', 'irrigationEvents']) {
    if (!bootstrapNode.func.includes(`${key}:`) && !bootstrapNode.func.includes(`${key},`) && !bootstrapNode.func.includes(`const ${key} =`)) {
      fail(`bootstrap payload missing ${key}`);
    } else {
      console.log(`OK bootstrap includes ${key}`);
    }
  }
}

expectIncludes('Validate & decode token', 'const auth = verifyBearer', 'uses decoded local auth');
expectIncludes('Validate & decode token', 'function allowPrivateTargets()', 'supports a private-target maintenance override');
expectIncludes('Validate & decode token', 'ALLOW_PRIVATE_SERVER_URLS', 'accepts the runtime private-target override flag');
expectIncludes('Validate & decode token', 'ALLOW_INSECURE_SERVER_URL', 'accepts the legacy runtime private-target override flag');
expectIncludes('Validate & decode token', 'allow_private_target', 'accepts the persisted UCI private-target override flag');
expectIncludes('Validate & decode token', "normalizeGatewayDeviceEui(env.get('DEVICE_EUI'))", 'uses the canonical runtime gateway identity');
expectIncludes('Validate & decode token', "env.get('DEVICE_EUI_CONFIDENCE')", 'reads runtime gateway identity confidence');
expectIncludes('Validate & decode token', "flow.set('al_gateway_device_eui_source'", 'stores resolved gateway identity metadata in link flow state');
expectIncludes('Validate & decode token', "flow.set('al_gateway_device_eui_confidence'", 'stores resolved gateway identity confidence in link flow state');
expectIncludes('Validate & decode token', 'Gateway identity is not ready yet. Wait for ChirpStack gateway detection before linking.', 'blocks account linking while gateway identity remains provisional');
expectExcludes('Validate & decode token', "gateway/([0-9A-Fa-f]{16})/event/", 'ad hoc ChirpStack log gateway probing');
expectExcludes('Validate & decode token', "chirpstack-concentratord.@sx1302[0].gateway_id", 'ad hoc concentratord gateway probing');
expectExcludes('Validate & decode token', "uci -q get osi-server.cloud.device_eui 2>/dev/null || true", 'ad hoc UCI gateway probing');
expectExcludes('Validate & decode token', "/sys/class/net/eth0/address", 'ad hoc MAC-derived gateway probing');
expectIncludes('Handle server auth response', 'statusCode >= 400 && statusCode < 500', 'maps remote auth failures away from 401');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('sync token')", 'requires sync token on successful link');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('offline verifier')", 'requires offline verifier on successful link');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('MQTT password')", 'requires MQTT password on successful link');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('MQTT broker URL')", 'requires MQTT broker URL on successful link');
expectIncludes('Handle server auth response', 'const mqttPassword = String(data.mqttPassword || data.mqtt_password || \'\').trim();', 'accepts MQTT credentials from local-sync');
expectIncludes('Handle server auth response', "flow.set('al_mqtt_password', mqttPassword);", 'stores MQTT password from local-sync');
expectIncludes('Handle server auth response', "flow.set('al_mqtt_broker_url', mqttBrokerUrl);", 'stores MQTT broker URL from local-sync');
expectIncludes('Handle server auth response', 'function extractHostFromAbsoluteUrl(value)', 'uses a runtime-compatible MQTT URL parser');
expectIncludes('Handle server auth response', "const match = text.match(new RegExp('^[a-z][a-z0-9+.-]*://([^/?#]+)', 'i'));", 'falls back to regex host extraction when URL is unavailable');
expectExcludes('Handle server auth response', 'new URL(mqttBrokerUrl);', 'a direct MQTT broker URL constructor check that can fail on older runtimes');
expectExcludes('Handle server auth response', 'UPDATE users SET server_username', 'direct linked-account DB mutation');
expectIncludes('Build server auth request', 'deviceEuis,', 'sends local device claims in the authenticated local-sync request');
expectIncludes('Build server auth request', "new osiDb.Database('/data/db/farming.db')", 'loads local device claims before cloud linking');
expectIncludes('Build server auth request', 'Gateway identity is not configured yet', 'fails locally when no canonical gateway EUI is available');
expectIncludes('Build server auth request', 'Gateway identity is not ready yet. Wait for ChirpStack gateway detection before linking.', 'fails linking while gateway identity remains provisional');
expectIncludes('Build server auth request', 'localUserUuid', 'sends the local user UUID for linked-auth targeting');
expectIncludes('Build server auth request', 'localUsernameSnapshot', 'sends the local username snapshot for linked-auth targeting');
expectIncludes('Build server auth request', 'edgeBuildVersion', 'sends the edge build version during local-sync');
expectIncludes('Build server auth request', 'syncCapabilities', 'advertises linked-auth sync capabilities during local-sync');
expectIncludes('Build server auth request', 'linked_auth_sync_v1', 'advertises the linked-auth sync capability');
expectIncludes('Build server auth request', 'force_edge_sync_v1', 'advertises the force-edge-sync capability');
expectIncludes('Handle server auth response', "const claimed = Array.isArray(data.claimed)", 'accepts claimed device results directly from local-sync');
expectIncludes('Handle server auth response', 'offlineVerifierVersion', 'requires and stores the offline verifier version from local-sync');
expectIncludes('Decode token & build query', 'server_offline_verifier_version', 'loads linked-auth verifier metadata for account-link status');
expectIncludes('Format status response', 'linkedAuthPackageValid', 'reports linked-auth package validity in account-link status');
expectIncludes('Format status response', 'linkedAuthRepairRequired', 'reports linked-auth repair requirements in account-link status');
expectIncludes('Format status response', "linkedAuthRepairRequired ? 'repair_required'", 'downgrades stale linked-auth state in account-link status');
expectIncludes('Build Sync State', 'lastMirroredEventAt', 'returns the last mirrored sync event timestamp');
expectIncludes('Build Sync State', 'dbHealth: {', 'returns a DB health block in sync state');
expectIncludes('Build Sync State', "journalMode: helperHealth.journalMode || null", 'returns SQLite journal mode in sync state');
expectIncludes('Build Sync State', "quickCheck: quickCheck.status", 'returns quick-check status in sync state');
expectIncludes('Build Sync State', "lastError: helperHealth.lastError || null", 'returns helper DB errors in sync state');
expectIncludes('Build Sync State', 'linkedAuthPackageValid', 'reports linked-auth package validity in sync state');
expectIncludes('Build Sync State', 'linkedAuthRepairRequired', 'reports linked-auth repair requirements in sync state');
expectIncludes('Build Sync State', 'migrationCandidateSources', 'reports gateway migration candidate sources in sync state');
expectIncludes('Build Sync State', 'rejectedMigrationCandidates', 'reports rejected gateway migration candidates in sync state');
expectIncludes('Finalize linked account state', 'UPDATE users SET server_username = ?', 'commits linked-account DB state only after MQTT persistence');
expectIncludes('Finalize linked account state', "auth_mode = ?", 'finalizes linked auth mode explicitly');
expectIncludes('Finalize linked account state', 'server_offline_verifier_version = ?', 'persists the synced offline verifier version locally');
expectIncludes('Finalize linked account state', 'last_auth_sync_status = ?', 'marks linked auth as up to date after local-sync finalization');
expectIncludes('Finalize linked account state', 'return [null, msg];', 'can stop before reporting link success');
expectIncludes('Set Download Headers', 'Database download is disabled', 'keeps database download disabled');
expectIncludes('Lookup Auth User', 'ORDER BY CASE WHEN username = ?', 'prefers local username matches');
expectIncludes('Process Result', 'Multiple accounts match this username', 'rejects ambiguous linked logins');
expectIncludes('Process Result', 'osi_auth_token_secret', 'uses a persisted local auth secret');
expectIncludes('Process Result', "env.get('LINK_GATEWAY_DEVICE_EUI')", 'uses the linked gateway identity captured at account-link time');
expectIncludes('Process Result', 'decodeGatewayDeviceEuiFromSyncToken', 'falls back to the gateway encoded into the sync token');
expectIncludes('Process Result', "env.get('DEVICE_EUI')", 'uses canonical runtime gateway identity only as a last resort');
expectExcludes('Process Result', "gateway/([0-9A-Fa-f]{16})/event/", 'ad hoc ChirpStack log gateway probing during linked login');
expectExcludes('Process Result', "chirpstack-concentratord.@sx1302[0].gateway_id", 'ad hoc concentratord gateway probing during linked login');
expectExcludes('Process Result', "uci -q get osi-server.cloud.device_eui 2>/dev/null || true", 'ad hoc UCI gateway probing during linked login');
expectExcludes('Process Result', "/sys/class/net/eth0/address", 'ad hoc MAC-derived gateway probing during linked login');
expectIncludes('Route Command', "device: { devEui: String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase() }", 'routes valve commands from either deviceEui or devEui');
expectIncludes('Route Command', "commandType === 'SYNC_LINKED_AUTH'", 'routes linked-auth sync commands through the special command handler');
expectIncludes('Route Command', "commandType === 'FORCE_EDGE_SYNC'", 'routes force-edge-sync commands through the special command handler');
expectIncludes('CS Register Device', 'chirpstack.createProvisioningClientFromEnv(env)', 'uses shared ChirpStack provisioning helper');
expectIncludes('CS Register Device', 'ensureDeviceProvisioned', 'provisions devices through gRPC helper');
expectExcludes('CS Register Device', '/api/devices', 'legacy ChirpStack REST device endpoint');
expectIncludes('CS Register (cloud cmd)', 'chirpstack.createProvisioningClientFromEnv(env)', 'uses shared ChirpStack provisioning helper');
expectIncludes('CS Register (cloud cmd)', 'ensureDeviceProvisioned', 'provisions cloud-triggered devices through gRPC helper');
expectExcludes('CS Register (cloud cmd)', '/api/devices', 'legacy ChirpStack REST device endpoint');
expectIncludes('CS Register (cloud cmd)', "commandType === 'SYNC_LINKED_AUTH'", 'handles linked-auth sync commands');
expectIncludes('CS Register (cloud cmd)', "commandType === 'FORCE_EDGE_SYNC'", 'handles force-edge-sync commands');
expectIncludes('CS Register (cloud cmd)', 'localUserUuid', 'targets linked-auth sync by local user UUID first');
expectIncludes('CS Register (cloud cmd)', 'STALE_IGNORED', 'acknowledges stale linked-auth versions without downgrading local auth');
expectIncludes('CS Register (cloud cmd)', 'ALREADY_APPLIED', 'treats duplicate linked-auth commands as idempotent');
expectIncludes('CS Register (cloud cmd)', 'server_offline_verifier_version', 'stores the linked-auth verifier version locally');
expectIncludes('CS Register (cloud cmd)', 'last_auth_sync_status', 'tracks linked-auth apply status locally');
expectIncludes('CS Register (cloud cmd)', 'forceSyncQueued', 'reports queued force-sync requests in the special-command ACK state');
expectIncludes('Build Special Command ACK', 'msg.specialAck', 'formats special command acknowledgments from structured state');
expectIncludes('Build Special Command ACK', 'authSyncOutcome', 'includes linked-auth apply outcomes in the ACK payload');
expectIncludes('Build Special Command ACK', 'forceSyncQueued', 'includes force-sync queue state in the ACK payload');
expectIncludes('Sync Init Schema + Triggers', 'AFTER INSERT ON dendrometer_daily', 'emits dendro daily outbox rows from dendrometer_daily');
expectIncludes('Sync Init Schema + Triggers', 'AFTER UPDATE ON dendrometer_daily', 'updates dendro daily outbox rows from dendrometer_daily');
expectIncludes('Sync Init Schema + Triggers', 'COALESCE(server_username, username)', 'emits linked cloud usernames in device outbox events');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN strega_model TEXT', 'adds the STREGA model metadata column');
expectIncludes('Sync Init Schema + Triggers', "'strega_model', NEW.strega_model", 'mirrors STREGA model changes into device outbox events');
expectIncludes('Sync Init Schema + Triggers', 'CREATE TABLE IF NOT EXISTS gateway_locations', 'creates the gateway GPS mirror table');
expectIncludes('Sync Init Schema + Triggers', 'trg_gateway_locations_outbox_ai', 'creates the gateway GPS insert trigger');
expectIncludes('Sync Init Schema + Triggers', 'GATEWAY_LOCATION_UPSERTED', 'emits gateway GPS sync events');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN area_m2 REAL', 'adds shared zone area config');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN irrigation_efficiency_pct REAL', 'adds shared irrigation efficiency config');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN prediction_card_enabled INTEGER DEFAULT 0', 'adds the synced prediction-card flag to zones');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN server_offline_verifier_version INTEGER DEFAULT 0', 'adds the linked-auth verifier version column to users');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN last_auth_sync_at TEXT', 'adds the linked-auth last-sync timestamp column to users');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN last_auth_sync_status TEXT', 'adds the linked-auth status column to users');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN last_auth_sync_error TEXT', 'adds the linked-auth error column to users');
expectIncludes('Sync Init Schema + Triggers', "UPDATE users SET last_auth_sync_status = 'up_to_date'", 'backfills linked server users with an up-to-date auth status');
expectIncludes('Sync Init Schema + Triggers', "UPDATE users SET last_auth_sync_status = 'repair_required'", 'marks invalid linked-auth packages for repair during sync init');
expectIncludes('Sync Init Schema + Triggers', "const gatewaySql = /^[0-9A-F]{16}$/.test(gateway)", 'uses a canonical gateway-or-NULL SQL fallback during sync init');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN rain_mm_per_10min REAL', 'adds normalized rain telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN flow_liters_per_10min REAL', 'adds normalized flow telemetry storage');
expectIncludes('Sync Init Schema + Triggers', "'area_m2', NEW.area_m2", 'mirrors zone area changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', "'irrigation_efficiency_pct', NEW.irrigation_efficiency_pct", 'mirrors irrigation efficiency changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', "'prediction_card_enabled', COALESCE(NEW.prediction_card_enabled, 0)", 'mirrors prediction-card changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', 'COALESCE(NEW.prediction_card_enabled,0) <> COALESCE(OLD.prediction_card_enabled,0)', 'queues outbox events when the prediction-card flag changes');
expectIncludes('Sync Init Schema + Triggers', "'rain_mm_per_10min', NEW.rain_mm_per_10min", 'mirrors normalized rain telemetry into device-data sync events');
expectIncludes('Sync Init Schema + Triggers', "'flow_liters_per_10min', NEW.flow_liters_per_10min", 'mirrors normalized flow telemetry into device-data sync events');
expectIncludes('Sync Init Schema + Triggers', 'SELECT name FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data names into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT type_id FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data types into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT irrigation_zone_id FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data zone bindings into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data gateway bindings into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring zone environment rows into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring zone environment gateway bindings into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring irrigation events into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring irrigation event gateway bindings into the outbox');
expectExcludes('Sync Init Schema + Triggers', '" + gateway + "', 'malformed literal gateway fallback SQL in sync triggers');
expectExcludes('Sync Init Schema + Triggers', '\'" + gatewaySql + "\'', 'double-quoted gatewaySql fallback fragments in sync init SQL');
const migrationPreflightNodes = ['Build Cloud Bootstrap', 'Build Edge Event Batch', 'Build Pending Command Pull', 'Run Force Sync'];
expectIncludesForEach(migrationPreflightNodes, 'const structuralGatewayDeviceEuis = normalizeGatewayList(', 'derives gateway migration candidates only from structural lineage');
expectIncludesForEach(migrationPreflightNodes, 'gatewayMigrationCandidateSources', 'stores gateway migration candidate source diagnostics');
expectIncludesForEach(migrationPreflightNodes, 'gatewayMigrationRejectedCandidates', 'stores rejected gateway migration candidates');
expectExcludesForEach(migrationPreflightNodes, "\"SELECT gateway_device_eui FROM sync_outbox WHERE delivered_at IS NULL AND gateway_device_eui IS NOT NULL AND gateway_device_eui <> ''\"", 'pending outbox rows as gateway migration candidates');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in bootstrap zone snapshots');
expectIncludes('Build Cloud Bootstrap', 'd.strega_model', 'includes STREGA model metadata in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.adc_ch1v,'", 'includes dendrometer reference voltage in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.dendro_ratio,'", 'includes dendrometer ratio in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.dendro_mode_used,'", 'includes the selected dendrometer path in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.dendro_stem_change_um,'", 'includes baseline-relative stem change in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', 'iz.area_m2', 'includes zone area in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'iz.irrigation_efficiency_pct', 'includes zone irrigation efficiency in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled', 'includes the prediction-card flag in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.rain_mm_per_10min,'", 'includes normalized rain telemetry in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.flow_liters_per_10min,'", 'includes normalized flow telemetry in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', 'AS event_uuid', 'synthesizes stable irrigation event UUIDs for bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'gatewayLocations,', 'includes gateway GPS state in bootstrap payloads');
expectIncludes('Build Cloud Bootstrap', 'previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis', 'includes previous gateway identities during bootstrap migration');
expectIncludes('Build Cloud Bootstrap', 'edgeBuildVersion,', 'includes the edge build version in bootstrap gateway metadata');
expectIncludes('Build Cloud Bootstrap', 'syncCapabilities', 'includes sync capabilities in bootstrap gateway metadata');
expectIncludes('Build Cloud Bootstrap', 'runGatewayMigrationPreflight', 'runs local gateway migration preflight before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'gatewayMigrationPaused: true', 'pauses normal sync while a gateway migration repair bootstrap is pending');
expectIncludes('Build Cloud Bootstrap', 'UPDATE irrigation_zones SET gateway_device_eui = ?', 'rewrites active zone gateway bindings during local migration');
expectIncludes('Build Cloud Bootstrap', 'UPDATE devices SET gateway_device_eui = ?', 'rewrites active device gateway bindings during local migration');
expectIncludes('Build Cloud Bootstrap', 'UPDATE sync_outbox SET gateway_device_eui = ?, aggregate_key = ?, payload_json = ?', 'rewrites undelivered sync outbox rows during local migration');
expectIncludes('Build Cloud Bootstrap', 'rejectedCandidates', 'surfaces rejected migration candidates in bootstrap migration state');
expectIncludes('Mark Bootstrap Synced', "gatewayMigration.migrated", 'recognizes successful cloud-side gateway migration responses');
expectIncludes('Mark Bootstrap Synced', 'gatewayMigrationPendingBootstrap = false', 'resumes normal sync after repair bootstrap succeeds');
expectIncludes('Build Edge Event Batch', 'gatewayMigrationPaused', 'suppresses event delivery while gateway migration is paused');
expectIncludes('Build Pending Command Pull', 'gatewayMigrationPaused', 'suppresses pending-command polling while gateway migration is paused');
expectIncludes('Build Sync State', 'gatewayIdentity = {', 'returns gateway identity diagnostics in sync state');
expectIncludes('Build Sync State', 'migrationPending', 'reports pending gateway migration state in sync state');
expectIncludes('Build Sync State', 'lastMigrationResult', 'reports last gateway migration result in sync state');
expectIncludes('Build Cloud Bootstrap', 'const sensorDataRows = await q([', 'loads bootstrap sensor history before reordering it');
expectIncludes('Build Cloud Bootstrap', 'const sensorData = sensorDataRows.slice().reverse();', 'replays bootstrap sensor history oldest-to-newest');
expectIncludes('Build Cloud Bootstrap', 'const dendroReadingsRows = await q([', 'loads bootstrap dendro history before reordering it');
expectIncludes('Build Cloud Bootstrap', 'const dendroReadings = dendroReadingsRows.slice().reverse();', 'replays bootstrap dendro history oldest-to-newest');
expectIncludes('Build Cloud Bootstrap', 'function normalizeIsoTimestamp(value)', 'normalizes malformed edge timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'deleted_at: normalizeIsoTimestamp(z.deleted_at)', 'normalizes zone tombstone timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'prediction_card_enabled: !!Number(z.prediction_card_enabled || 0)', 'exports the prediction-card flag in bootstrap payloads');
expectIncludes('Build Cloud Bootstrap', 'devices: devices.map(sanitizeSyncRow)', 'normalizes device tombstone timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'schedules: schedules.map(sanitizeSyncRow)', 'normalizes schedule timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'LEFT JOIN devices d ON d.deveui = dd.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting bootstrap sensor history');
expectIncludes('Build Cloud Bootstrap', 'LEFT JOIN devices d ON d.deveui = dr.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting bootstrap dendro history');
expectIncludes('Build Cloud Bootstrap', 'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL', 'ignores deleted zones when exporting bootstrap history');
expectIncludes('Mark Bootstrap Synced', "(msg.payload || {}).detail || 'Bootstrap sync failed'", 'preserves server ProblemDetail details for bootstrap errors');
expectWireById('al-link-handle-auth', 'al-link-store-mqtt', 'persists MQTT credentials after successful account linking');
expectWireById('al-link-store-mqtt', 'al-link-finalize', 'finalizes linked-account state only after MQTT config persistence');
expectWireById('al-link-finalize', 'al-link-success', 'formats a success response only after linked-account finalization');
expectWireById('al-link-finalize', 'al-link-rollback-mqtt', 'rolls back MQTT credentials when linked-account finalization fails');
expectWireById('al-link-success', 'al-link-restart-node-red', 'schedules restart only after link success is fully prepared');
expectWireById('al-link-restart-node-red', 'al-link-bootstrap-link-out', 'triggers an immediate bootstrap only after scheduling the link restart');
expectWireById('al-link-restart-node-red', 'al-link-clear-state', 'clears transient link state only after successful link restart scheduling');
expectMissingNodeById('al-link-build-claim', 'the legacy claim-bulk account-link request path');
expectMissingNodeById('al-link-server-claim', 'the legacy claim-bulk account-link HTTP request path');
expectMissingNodeById('al-link-handle-claim', 'the legacy claim-bulk response handler');
expectMissingNodeById('al-link-db-update', 'the legacy pre-MQTT link finalization query');
expectWireById('sync-bootstrap-account-link-in', 'sync-bootstrap-build', 'routes post-link bootstrap triggers into the bootstrap builder');
expectWireById('al-unlink-func', 'al-unlink-clear-mqtt', 'clears MQTT credentials only after unlink auth succeeds');
expectWireById('al-unlink-clear-mqtt', 'al-unlink-db', 'clears linked account state only after MQTT credentials are removed');
expectWireById('al-unlink-db', 'al-unlink-restore-mqtt', 'restores MQTT credentials when unlink database cleanup fails');
expectWireById('al-unlink-format', 'al-unlink-restart-node-red', 'schedules restart only after unlink state is cleared successfully');
expectWireById('al-unlink-restart-node-red', 'al-link-clear-state', 'clears transient link state only after successful unlink restart scheduling');
expectIncludes('Persist MQTT Broker Config', "set osi-server.cloud.mqtt_password=", 'writes the MQTT password into UCI after linking');
expectIncludes('Persist MQTT Broker Config', "set osi-server.cloud.link_gateway_device_eui=", 'persists the linked gateway identity into UCI after linking');
expectIncludes('Persist MQTT Broker Config', 'Linked account response is missing MQTT credentials', 'fails linking when MQTT credentials are incomplete');
expectIncludes('Persist MQTT Broker Config', 'msg._mqttConfigBackup = {', 'backs up prior MQTT config before persisting linked credentials');
expectIncludes('Persist MQTT Broker Config', "const match = text.match(new RegExp('^[a-z][a-z0-9+.-]*://([^/?#]+)', 'i'));", 'falls back to regex host extraction when URL is unavailable');
expectExcludes('Persist MQTT Broker Config', '/etc/init.d/node-red restart', 'Node-RED restart while link persistence is still in flight');
expectWireById('al-link-handle-auth', 'al-link-clear-state', 'clears transient link state when server auth fails');
expectWireById('al-link-store-mqtt', 'al-link-clear-state', 'clears transient link state when MQTT persistence fails');
expectIncludes('Clear MQTT Broker Config', "set osi-server.cloud.mqtt_password=' + shellQuote('')", 'clears the MQTT password from UCI after unlinking');
expectIncludes('Clear MQTT Broker Config', "set osi-server.cloud.link_gateway_device_eui=' + shellQuote('')", 'clears the linked gateway identity from UCI after unlinking');
expectIncludes('Clear MQTT Broker Config', 'msg._mqttConfigBackup = {', 'backs up prior MQTT config before unlink cleanup');
expectExcludes('Clear MQTT Broker Config', '/etc/init.d/node-red restart', 'Node-RED restart while unlink cleanup is still in flight');
expectIncludes('Rollback MQTT Broker Config', 'rolled back MQTT credentials', 'restores prior MQTT config when link finalization fails');
expectIncludes('Restore MQTT Broker Config', 'restored MQTT credentials', 'restores prior MQTT config when unlink finalization fails');
expectIncludes('Schedule Link Restart', '/etc/init.d/node-red restart', 'schedules a Node-RED restart only after successful link completion');
expectIncludes('Schedule Unlink Restart', '/etc/init.d/node-red restart', 'schedules a Node-RED restart only after successful unlink completion');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in force-sync device snapshots');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in force-sync zone snapshots');
expectIncludes('Run Force Sync', 'd.strega_model', 'includes STREGA model metadata in force-sync device snapshots');
expectIncludes('Run Force Sync', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.adc_ch1v,'", 'includes dendrometer reference voltage in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.dendro_ratio,'", 'includes dendrometer ratio in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.dendro_mode_used,'", 'includes the selected dendrometer path in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.dendro_stem_change_um,'", 'includes baseline-relative stem change in force-sync sensor data');
expectIncludes('Run Force Sync', 'iz.area_m2', 'includes zone area in force-sync snapshots');
expectIncludes('Run Force Sync', 'iz.irrigation_efficiency_pct', 'includes zone irrigation efficiency in force-sync snapshots');
expectIncludes('Run Force Sync', 'COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled', 'includes the prediction-card flag in force-sync snapshots');
expectIncludes('Run Force Sync', "'  dd.rain_mm_per_10min,'", 'includes normalized rain telemetry in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.flow_liters_per_10min,'", 'includes normalized flow telemetry in force-sync sensor data');
expectIncludes('Run Force Sync', 'AS event_uuid', 'synthesizes stable irrigation event UUIDs for forced bootstrap snapshots');
expectIncludes('Run Force Sync', 'gatewayLocations,', 'includes gateway GPS state in forced sync payloads');
expectIncludes('Run Force Sync', 'edgeBuildVersion,', 'includes the edge build version in forced bootstrap gateway metadata');
expectIncludes('Run Force Sync', 'syncCapabilities', 'includes sync capabilities in forced bootstrap gateway metadata');
expectIncludes('Run Force Sync', 'const sensorDataRows = await q([', 'loads force-sync sensor history before reordering it');
expectIncludes('Run Force Sync', 'const sensorData = sensorDataRows.slice().reverse();', 'replays force-sync sensor history oldest-to-newest');
expectIncludes('Run Force Sync', 'const dendroReadingsRows = await q([', 'loads force-sync dendro history before reordering it');
expectIncludes('Run Force Sync', 'const dendroReadings = dendroReadingsRows.slice().reverse();', 'replays force-sync dendro history oldest-to-newest');
expectIncludes('Run Force Sync', 'function normalizeIsoTimestamp(value)', 'normalizes malformed edge timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'deleted_at: normalizeIsoTimestamp(z.deleted_at)', 'normalizes zone tombstone timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'prediction_card_enabled: !!Number(z.prediction_card_enabled || 0)', 'exports the prediction-card flag in forced bootstrap payloads');
expectIncludes('Run Force Sync', 'devices: devices.map(sanitizeSyncRow)', 'normalizes device tombstone timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'schedules: schedules.map(sanitizeSyncRow)', 'normalizes schedule timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'LEFT JOIN devices d ON d.deveui = dd.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting force-sync sensor history');
expectIncludes('Run Force Sync', 'LEFT JOIN devices d ON d.deveui = dr.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting force-sync dendro history');
expectIncludes('Run Force Sync', 'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL', 'ignores deleted zones when exporting force-sync history');
expectIncludes('Run Force Sync', "(bootstrapRes.payload || {}).detail || 'Bootstrap sync failed'", 'preserves server ProblemDetail details in force-sync bootstrap errors');
expectIncludes('Run Force Sync', "pendingCommands: { attempted: false, succeeded: true, fetchedCount: 0, queuedCount: 0, appliesAfterResponse: false, applyPhase: 'NO_PENDING_COMMANDS'", 'initializes pending-command apply semantics in force-sync summary');
expectIncludes('Run Force Sync', 'summary.pendingCommands.appliesAfterResponse = queueablePendingCommands.length > 0;', 'marks force-sync pending commands as applying after the HTTP response');
expectIncludes('Run Force Sync', "summary.pendingCommands.applyPhase = queueablePendingCommands.length > 0 ? 'QUEUED_LOCAL_APPLY' : 'NO_PENDING_COMMANDS';", 'reports force-sync pending-command apply phase explicitly');
expectIncludes('Run Force Sync', 'msg._forceSyncInternal', 'supports internally queued force-sync sweeps from cloud commands');
expectIncludes('Run Force Sync', 'queueablePendingCommands', 'filters pending commands before queueing them locally');
expectIncludes('Run Force Sync', "commandType || '').trim().toUpperCase() !== 'FORCE_EDGE_SYNC'", 'prevents force-edge-sync commands from recursing through pending-command replay');
expectIncludes('Run Force Sync', 'rejectedCandidates', 'surfaces rejected migration candidates in force-sync migration state');
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
expectIncludes('Daily Dendrometer Analytics', "env.get('OPENAGRI_WEATHER_RADIUS_KM')", 'supports configurable OpenAgri history search radius for edge analytics');
expectIncludes('Get Zone Environment Summary', 'CREATE TABLE IF NOT EXISTS zone_weather_cache', 'creates a local weather cache table for environment summaries');
expectIncludes('Get Zone Environment Summary', "env.get('OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES')", 'supports configurable current-weather cache TTL');
expectIncludes('Get Zone Environment Summary', "env.get('OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES')", 'supports configurable forecast cache TTL');
expectIncludes('Get Zone Environment Summary', "const lib = urlString.startsWith('https:') ? httpsLib : httpLib;", 'uses imported HTTP clients inside the Node-RED function runtime');
expectIncludes('Get Zone Environment Summary', "preferredSource: usingLocal ? 'local'", 'prioritizes local sensor climate over online weather for agronomic metrics');
expectIncludes('Get Zone Environment Summary', 'LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui', 'falls back to mirrored gateway coordinates when a zone has no explicit location');
expectIncludes('Get Zone Environment Summary', 'SELECT date,rainfall_mm,flow_liters,rain_source,computed_at FROM zone_daily_environment', 'uses daily zone environment totals for water summary');
expectIncludes('Get Zone Environment Summary', 'const water = await buildWaterEnvironment', 'builds a dedicated water summary block');
expectIncludes('Get Zone Environment Summary', 'areaM2: toFiniteNumber(zone && zone.area_m2)', 'exposes zone area in water summary');
expectIncludes('Get Zone Environment Summary', 'sensorHealth: buildSensorHealth(deviceRows, local)', 'reports water sensor health and warnings');
expectIncludes('Build Telemetry', 'lsn50_mode_code: observedModeCode', 'publishes observed LSN50 mode in edge telemetry');
expectIncludes('Build Telemetry', 'convertHzToKPa(numberOrNull(obj.watermark1_frequency))', 'converts Kiwi watermark frequency telemetry to kPa for cloud mirroring');
expectIncludes('Build Telemetry', "var isLsn50 = profileKind === 'DRAGINO_LSN50';", 'gates LSN50-only telemetry fields by profile');
expectIncludes('Build Telemetry', 'var observedModeCode = isLsn50 && rawLsn50 && rawLsn50.modeCode != null ? rawLsn50.modeCode : null;', 'avoids assigning LSN50 mode codes to Kiwi telemetry');
expectIncludes('Build Telemetry', "profileKind === 'STREGA_VALVE'", 'skips valve uplinks in sensor telemetry mirroring');
expectIncludes('Build Telemetry', 'if (!profileKind && swtWm1 === null && swtWm2 === null', 'skips unknown no-data uplinks instead of defaulting them to Kiwi');
expectIncludes('Build Telemetry', 'loadLsn50Config', 'loads local dendrometer config before telemetry conversion');
expectIncludes('Build Telemetry', 'var rawLsn50 = isLsn50 && data.data ? dendro.decodeRawAdcPayload(data.data) : null;', 'reuses shared raw LSN50 ADC decoding in telemetry mirroring');
expectIncludes('Build Telemetry', 'var derived = dendro.buildDendroDerivedMetrics({', 'reuses shared dendrometer path selection in telemetry mirroring');
expectIncludes('Build Telemetry', 'dendro.computeDendroDeltaMm({', 'reuses shared dendrometer delta handling in telemetry mirroring');
expectIncludes('Build Telemetry', 'dendro_stem_change_um: stemChangeUm,', 'publishes baseline-relative stem change in live MQTT telemetry');
expectIncludesById('81c98fb07344a787', "env.get('CHIRPSTACK_PROFILE_KIWI')", 'uses env-backed Kiwi profile routing');
expectIncludesById('81c98fb07344a787', "env.get('CHIRPSTACK_PROFILE_CLOVER')", 'uses env-backed Clover profile routing');
expectIncludes('Decode LSN50', 'const rawDecoded = data.data ? dendro.decodeRawAdcPayload(data.data) : null;', 'uses the shared raw LSN50 ADC decoder');
expectIncludes('Decode LSN50', 'adcCh1V = dendro.toFiniteNumber(obj.ADC_CH1V);', 'reads ADC_CH1V from decoded MOD3 payloads');
expectIncludes('Decode LSN50', 'adcCh4V = dendro.toFiniteNumber(obj.ADC_CH4V);', 'reads ADC_CH4V when present without using it for dendrometer conversion');
expectIncludes('Decode LSN50', 'const observedModeCode = rawDecoded && rawDecoded.modeCode != null ? rawDecoded.modeCode : null;', 'decodes observed LSN50 mode from shared raw uplink parsing');
expectIncludes('Decode LSN50', "env.get('CHIRPSTACK_PROFILE_LSN50')", 'filters uplinks to the env-backed LSN50 profile');
expectIncludes('Apply Config', 'd.modeCodeToStore = d.observedModeCode != null ? d.observedModeCode : effectiveMode;', 'stores observed or configured LSN50 mode on ingest');
expectIncludes('Apply Config', 'loadPreviousMod9Sample', 'loads the last persisted MOD9 sample before computing deltas');
expectIncludes('Apply Config', 'd.counterIntervalSeconds = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : null;', 'computes elapsed seconds between MOD9 uplinks');
expectIncludes('Apply Config', "if (currentCount < previousCount) return { deltaCount: null, status: 'counter_reset' };", 'treats counter decreases as resets instead of inflating deltas');
expectIncludes('Apply Config', "const duplicateState = futureRecordedAt === d.timestamp ? 'duplicate_timestamp' : 'out_of_order';", 'guards MOD9 deltas against duplicate and out-of-order uplinks');
expectIncludes('Apply Config', 'd.rainMmPerHour = d.counterIntervalSeconds', 'derives a rain rate from the elapsed interval');
expectIncludes('Apply Config', 'd.flowLitersPerMin = d.counterIntervalSeconds', 'derives a flow rate from the elapsed interval');
expectIncludes('Apply Config', 'd.rainMmPer10Min = d.counterIntervalSeconds', 'derives normalized rain per 10 minutes');
expectIncludes('Apply Config', 'd.flowLitersPer10Min = d.counterIntervalSeconds', 'derives normalized flow per 10 minutes');
expectIncludes('Apply Config', 'loadTodayCounterTotals', 'derives running daily rain and flow totals from persisted counters');
expectIncludes('Apply Config', 'const derived = dendro.buildDendroDerivedMetrics({', 'uses the shared dual-path dendrometer conversion helper');
expectIncludes('Apply Config', 'd.dendroModeUsed = derived.dendroModeUsed;', 'stores which dendrometer conversion path was applied');
expectIncludes('Apply Config', 'd.dendroRatio = derived.dendroRatio;', 'stores the derived dendrometer ratio');
expectIncludes('Apply Config', 'd.dendroCalibrationMissing = derived.calibrationMissing;', 'tracks missing ratio calibration without emitting NaN values');
expectIncludes('Apply Config', 'const delta = dendro.computeDendroDeltaMm({', 'resets dendrometer deltas when path or calibration changes');
expectIncludes('Apply Config', 'const stemChange = dendro.computeDendroStemChangeUm({', 'derives a baseline-relative stem change signal for the basic card and monitor');
expectIncludes('Apply Config', 'd.dendroStemChangeUm = stemChange.stemChangeUm;', 'stores the baseline-relative stem change alongside mechanical position');
expectIncludes('Apply Config', 'dendro_baseline_pending = 0,', 'clears the pending-baseline flag when a new valid stem-change baseline is persisted');
expectLibById('lsn50-decode-fn', 'dendro', 'osi-dendro-helper', 'imports osi-dendro-helper in Decode LSN50');
expectLibById('lsn50-apply-config', 'dendro', 'osi-dendro-helper', 'imports osi-dendro-helper in Apply Config');
expectLibById('8809bb5239dfb3d4', 'dendro', 'osi-dendro-helper', 'imports osi-dendro-helper in Build Telemetry');
expectIncludesById('lsn50-sql-fn', 'lsn50_mode_code, lsn50_mode_label, lsn50_mode_observed_at', 'persists observed LSN50 mode into device_data');
expectIncludesById('lsn50-sql-fn', 'rain_mm_per_hour, rain_mm_per_10min, rain_mm_today, rain_delta_status', 'persists interval-aware rain metadata into device_data');
expectIncludesById('lsn50-sql-fn', 'flow_liters_per_min, flow_liters_per_10min, flow_liters_today, flow_delta_status', 'persists interval-aware flow metadata into device_data');
expectIncludesById('lsn50-sql-fn', 'rain_mm_per_10min, rain_mm_today', 'persists normalized and daily rain telemetry into device_data');
expectIncludesById('lsn50-sql-fn', 'flow_liters_per_10min, flow_liters_today', 'persists normalized and daily flow telemetry into device_data');
expectIncludesById('lsn50-sql-fn', 'counter_interval_seconds', 'persists elapsed counter interval into device_data');
expectIncludesById('lsn50-sql-fn', 'adc_ch0v, adc_ch1v,', 'persists both dendrometer ADC channels into device_data');
expectIncludesById('lsn50-sql-fn', 'dendro_ratio, dendro_mode_used, dendro_position_mm, dendro_valid, dendro_delta_mm,', 'persists dual-path dendrometer derived fields into device_data');
expectIncludesById('lsn50-sql-fn', 'dendro_stem_change_um,', 'persists baseline-relative stem change into device_data');
expectIncludesById('lsn50-zone-agg-fn', "localDateIso(d.timestamp || computedAt", 'bins MOD9 zone totals by uplink timestamp instead of processing time');
expectIncludesById('lsn50-zone-agg-fn', "d.rainDeltaStatus === 'ok'", 'only aggregates valid rain deltas into zone totals');
expectIncludesById('lsn50-zone-agg-fn', "d.flowDeltaStatus === 'ok'", 'only aggregates valid flow deltas into zone totals');
expectIncludesById('format-devices', 'dd.lsn50_mode_code', 'returns observed LSN50 mode in GET /api/devices');
expectIncludesById('format-devices', 'dd.adc_ch1v', 'returns dendrometer CH1 voltage in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_ratio', 'returns dendrometer ratio in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_mode_used', 'returns the active dendrometer conversion path in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_stem_change_um', 'returns baseline-relative stem change in GET /api/devices');
expectIncludesById('format-devices', 'dd.rain_mm_per_hour', 'returns interval-aware rain rate in GET /api/devices');
expectIncludesById('format-devices', 'dd.flow_liters_per_min', 'returns interval-aware flow rate in GET /api/devices');
expectIncludesById('format-devices', 'dd.rain_mm_per_10min', 'returns normalized rain telemetry in GET /api/devices');
expectIncludesById('format-devices', 'dd.flow_liters_per_10min', 'returns normalized flow telemetry in GET /api/devices');
expectIncludesById('format-devices', 'dd.counter_interval_seconds', 'returns elapsed counter interval in GET /api/devices');
expectIncludesById('format-devices', 'dd.barometric_pressure_hpa', 'returns S2120 pressure in GET /api/devices');
expectIncludesById('format-devices', 'dd.wind_speed_mps', 'returns S2120 wind speed in GET /api/devices');
expectIncludesById('format-devices', 'dd.wind_direction_deg', 'returns S2120 wind direction in GET /api/devices');
expectIncludesById('format-devices', 'dd.wind_gust_mps', 'returns S2120 wind gust in GET /api/devices');
expectIncludesById('format-devices', 'dd.uv_index', 'returns S2120 UV in GET /api/devices');
expectIncludesById('format-devices', 'dd.rain_gauge_cumulative_mm', 'returns S2120 cumulative rain in GET /api/devices');
expectIncludesById('format-devices', 'dd.bat_pct', 'returns S2120 battery in GET /api/devices');
expectIncludesById('merge-device-data', 'device_mode: d.device_mode ?? 1', 'returns configured LSN50 mode in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_force_legacy: d.dendro_force_legacy ?? 0', 'returns the explicit legacy dendrometer override in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_stroke_mm: d.dendro_stroke_mm ?? null', 'returns dendrometer stroke calibration in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_ratio_zero: d.dendro_ratio_zero ?? null', 'returns dendrometer ratio zero calibration in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_ratio_span: d.dendro_ratio_span ?? null', 'returns dendrometer ratio span calibration in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_invert_direction: d.dendro_invert_direction ?? 0', 'returns dendrometer inversion calibration in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_baseline_pending: d.dendro_baseline_pending ?? 0', 'returns the pending-baseline flag in GET /api/devices');
expectIncludesById('merge-device-data', 'adc_ch1v: latest.adc_ch1v', 'merges dendrometer CH1 voltage into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_ratio: latest.dendro_ratio', 'merges dendrometer ratio into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_mode_used: latest.dendro_mode_used', 'merges dendrometer path metadata into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_stem_change_um: latest.dendro_stem_change_um', 'merges baseline-relative stem change into GET /api/devices');
expectIncludesById('merge-device-data', 'strega_model: d.strega_model || null', 'returns stored STREGA model metadata in GET /api/devices');
expectIncludesById('merge-device-data', 'rain_mm_per_hour: latest.rain_mm_per_hour', 'merges interval-aware rain rate into GET /api/devices');
expectIncludesById('merge-device-data', 'flow_liters_per_min: latest.flow_liters_per_min', 'merges interval-aware flow rate into GET /api/devices');
expectIncludesById('merge-device-data', 'rain_mm_per_10min: latest.rain_mm_per_10min', 'merges normalized rain telemetry into GET /api/devices');
expectIncludesById('merge-device-data', 'flow_liters_per_10min: latest.flow_liters_per_10min', 'merges normalized flow telemetry into GET /api/devices');
expectIncludesById('merge-device-data', 'counter_interval_seconds: latest.counter_interval_seconds', 'merges elapsed counter interval into GET /api/devices');
expectIncludesById('merge-device-data', 'barometric_pressure_hpa: latest.barometric_pressure_hpa', 'merges S2120 pressure into GET /api/devices');
expectIncludesById('merge-device-data', 'wind_speed_mps: latest.wind_speed_mps', 'merges S2120 wind speed into GET /api/devices');
expectIncludesById('merge-device-data', 'wind_direction_deg: latest.wind_direction_deg', 'merges S2120 wind direction into GET /api/devices');
expectIncludesById('merge-device-data', 'wind_gust_mps: latest.wind_gust_mps', 'merges S2120 wind gust into GET /api/devices');
expectIncludesById('merge-device-data', 'uv_index: latest.uv_index', 'merges S2120 UV into GET /api/devices');
expectIncludesById('merge-device-data', 'rain_gauge_cumulative_mm: latest.rain_gauge_cumulative_mm', 'merges S2120 cumulative rain into GET /api/devices');
expectIncludesById('merge-device-data', 'bat_pct: latest.bat_pct', 'merges S2120 battery into GET /api/devices');
expectIncludesById('s2120-process-fn', 'data.object?.messages', 'accepts live decoded S2120 message shape');
expectIncludesById('s2120-process-fn', 'data.object?.data?.messages', 'accepts nested decoded S2120 message shape');
expectIncludesById('s2120-process-fn', "normalizePressureHpa(measurements['4101'])", 'uses current S2120 pressure ID');
expectIncludesById('s2120-process-fn', "measurements['4213'] ?? measurements['4113']", 'uses current and legacy S2120 cumulative rain IDs');
expectIncludesById('s2120-process-fn', "measurements['4191']", 'uses current S2120 wind gust ID');
expectIncludesById('s2120-rain-agg-fn', 'SELECT wsz.zone_id', 'prefers explicit S2120 weather station zone assignments');
expectIncludesById('s2120-rain-agg-fn', 'if (!zones.length)', 'falls back when S2120 weather station zone assignments are absent');
expectIncludesById('s2120-rain-agg-fn', 'd.irrigation_zone_id AS zone_id', 'uses legacy S2120 irrigation zone fallback');
expectIncludesById('s2120-rain-agg-fn', 'const rainToday = sn(d.rainMmToday != null ? d.rainMmToday : d.rainMmDelta)', 'seeds S2120 zone totals from device daily rain');
expectIncludesById('s2120-rain-agg-fn', 'MAX(COALESCE(rainfall_mm,0)+${rainDelta}, ${rainToday})', 'keeps S2120 zone totals caught up with device daily rain');
expectLibById('s2120-process-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectLibById('s2120-rain-agg-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectLibById('merge-device-data', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb for S2120 enrichment');
expectLibById('s2120-zones-get-fn', 'crypto', 'crypto', 'imports crypto for auth verification');
expectLibById('s2120-zones-get-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectLibById('s2120-zones-put-auth-fn', 'crypto', 'crypto', 'imports crypto for auth verification');
expectLibById('s2120-zones-put-auth-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectIncludesById('sensor-history-fn', 'rain_mm_per_hour', 'allows rate-based rain history queries');
expectIncludesById('sensor-history-fn', 'flow_liters_per_min', 'allows rate-based flow history queries');
expectIncludesById('sensor-history-fn', 'rain_mm_per_10min', 'allows normalized rain history queries');
expectIncludesById('sensor-history-fn', 'flow_liters_per_10min', 'allows normalized flow history queries');
expectIncludesById('sensor-history-fn', 'counter_interval_seconds', 'allows interval-length history queries');
expectIncludesById('dendro-history-fn', 'dd.adc_ch1v', 'returns dendrometer CH1 history points');
expectIncludesById('dendro-history-fn', 'dd.dendro_ratio', 'returns dendrometer ratio history points');
expectIncludesById('dendro-history-fn', 'dd.dendro_mode_used', 'returns dendrometer path history points');
expectIncludesById('dendro-history-fn', 'dd.dendro_stem_change_um', 'returns baseline-relative stem change history points');
expectExcludesById('dendro-history-fn', 'AND dd.dendro_position_mm IS NOT NULL', 'the calibrated-only dendrometer history filter');
expectIncludesById('dendro-history-fn', '(dd.dendro_position_mm IS NOT NULL OR dd.adc_ch0v IS NOT NULL OR dd.adc_ch1v IS NOT NULL OR dd.dendro_ratio IS NOT NULL)', 'returns raw-only dendrometer history rows from device_data');
expectIncludesById('dendro-history-format', 'adc_ch1v: r.adc_ch1v', 'formats dendrometer CH1 history for the GUI');
expectIncludesById('dendro-history-format', 'dendro_ratio: r.dendro_ratio', 'formats dendrometer ratio history for the GUI');
expectIncludesById('dendro-history-format', 'dendro_mode_used: r.dendro_mode_used', 'formats dendrometer path history for the GUI');
expectIncludesById('dendro-history-format', 'stem_change_um: r.dendro_stem_change_um', 'formats baseline-relative stem change history for the GUI');
expectIncludesById('dendro-raw-fn', 'COALESCE(dr.adc_ch0v, dr.adc_v) AS adc_ch0v', 'keeps raw dendrometer CH0 history backward compatible');
expectIncludesById('dendro-raw-fn', 'dr.adc_ch1v', 'returns raw dendrometer CH1 readings');
expectIncludesById('dendro-raw-fn', 'dr.dendro_ratio', 'returns raw dendrometer ratios');
expectIncludesById('dendro-raw-fn', 'dr.dendro_mode_used', 'returns raw dendrometer path metadata');
expectIncludesById('dendro-raw-fn', 'UNION ALL', 'merges calibrated and raw-only dendrometer readings');
expectIncludesById('dendro-raw-fn', 'FROM device_data dd', 'reads raw-only dendrometer history from device_data');
expectIncludesById('dendro-raw-fn', 'NULL AS position_um', 'keeps raw-only dendrometer readings uncalibrated');
expectIncludesById('dendro-raw-fn', 'COALESCE(dd.dendro_valid, 1) AS is_valid', 'defaults raw-only dendrometer validity when device_data omits it');
expectIncludesById('dendro-raw-fn', 'dd.dendro_position_mm IS NULL', 'limits synthetic raw dendrometer rows to uncalibrated samples');
expectIncludesById('dendro-readings-insert-fn', 'adc_v,adc_ch0v,adc_ch1v,dendro_ratio,dendro_mode_used', 'stores raw dendrometer debug fields in dendrometer_readings');
expectLibById('put-dendro-config-auth-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper for dendrometer config persistence');
expectIncludesById('put-dendro-config-auth-fn', 'deleted_at IS NULL', 'ignores deleted devices when saving dendrometer config');
expectIncludesById('put-dendro-config-auth-fn', "return respond(404, { message: 'Device not found' });", 'returns 404 for missing dendrometer-config devices');
expectIncludesById('put-dendro-config-auth-fn', 'dendro_baseline_pending = 1', 'marks the dendrometer baseline as pending when calibration changes');
expectIncludes('Format Dendro Config Response', 'dendro_force_legacy: row.dendro_force_legacy ?? null', 'returns canonical dendrometer config fields');
expectIncludes('Format Dendro Config Response', 'dendro_invert_direction: row.dendro_invert_direction ?? null', 'returns canonical dendrometer inversion config');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_position_mm = NULL', 'clears the stored dendrometer baseline position');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_mode_used = NULL', 'clears the stored dendrometer baseline mode');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_calibration_signature = NULL', 'clears the stored dendrometer baseline calibration signature');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_pending = 1', 'marks the dendrometer baseline as pending after a manual reset');
expectFileIncludes('api.ts', reactGuiApiSource, 'resetDendroBaseline: async (deveui: string): Promise<void> => {', 'adds a shared client helper for dendrometer baseline resets');
expectFileIncludes('api.ts', reactGuiApiSource, "await api.post(`/api/devices/${deveui}/dendro-baseline/reset`);", 'targets the local dendrometer baseline reset endpoint from the shared client helper');
expectFileIncludes('api.ts', reactGuiApiSource, 'position_mm: number | null;', 'types dendrometer history position as nullable');
expectFileIncludes('api.ts', reactGuiApiSource, 'stem_change_um: toNullableNumber(row?.stem_change_um ?? row?.dendro_stem_change_um)', 'normalizes baseline-relative stem change for dendrometer history');
expectFileExcludes('api.ts', reactGuiApiSource, 'Number(row?.position_mm ?? row?.dendro_position_mm ?? 0)', 'coercing missing dendrometer history position to zero');
expectFileExcludes('api.ts', reactGuiApiSource, 'Number(row?.position_um ?? 0)', 'coercing missing raw dendrometer position to zero');
expectFileIncludes('farming.ts', farmingTypesSource, 'id: number | null;', 'allows synthetic raw dendrometer rows without numeric ids');
expectFileIncludes('farming.ts', farmingTypesSource, 'position_um: number | null;', 'allows raw-only dendrometer rows to omit calibrated position');
expectFileIncludes('farming.ts', farmingTypesSource, 'dendro_stem_change_um?: number | null;', 'types the latest stem-change signal on device payloads');
expectFileIncludes('farming.ts', farmingTypesSource, 'dendro_baseline_pending?: number | null;', 'types the device-level baseline-pending flag');
expectFileIncludes('api.ts', reactGuiApiSource, 'stem_change_um: number | null;', 'types the dendrometer history stem-change signal');
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Stem change over time', 'labels the basic monitor around the comparable stem-change signal');
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Mechanical layer', 'renders mechanical engineering values beneath the stem-change graph');
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Current position', 'shows absolute mechanical position below the graph instead of as the headline graph metric');
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Awaiting baseline. Mechanical position is available in this window', 'keeps the basic monitor informative when comparable stem change is not ready yet');
expectFileIncludes('farming/dendrometer/DendrometerMonitor.tsx', dendroDrawerSource, 'Raw samples are available', 'explains raw-only dendrometer rows in the 24h drawer');
expectFileIncludes('farming/dendrometer/DendrometerMonitor.tsx', dendroDrawerSource, 'const showRatioDebug = isRatioDendroMode(point.dendro_mode_used_raw);', 'shows CH1 and ratio debug values only for ratio-mode 24h readings');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Stem change', 'shows stem change as the only primary dendrometer signal on the device card');
expectFileExcludes('DraginoTempCard.tsx', draginoTempCardSource, 'DENDROMETER POSITION', 'removes the old absolute-position headline from the device card');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'dendro_stem_change_um', 'renders the baseline-relative stem change signal on the device card');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'dendro_baseline_pending === 1', 'suppresses stale stem-change values when the device is awaiting a new baseline');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Awaiting baseline', 'keeps the dendrometer card visible while the next valid uplink establishes a new baseline');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Current ratio', 'shows ratio in the dendrometer calibration section instead of on the device card');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Dendrometer calibration', 'adds dendrometer calibration controls to the LSN50 advanced settings');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, "await lsn50API.setDendroConfig(device.deveui", 'saves dendrometer calibration through the dedicated local API');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Reset stem baseline', 'adds a manual baseline reset action for legacy dendrometers');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, "await lsn50API.resetDendroBaseline(device.deveui)", 'wires the manual baseline reset action to the local API');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Force legacy mode', 'exposes the legacy dendrometer override in the advanced settings');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Invert direction', 'exposes the ratio inversion toggle in the advanced settings');
expectExcludesById('merge-device-data', 'd.updated_at', 'updated_at fallback for last_seen in GET /api/devices');
expectIncludes('Auth + Query Gateway Location', 'gateway_locations', 'queries gateway GPS state from the local mirror table');
expectIncludes('Format Gateway Location Response', "status: row.status || 'no_fix'", 'returns a no-fix fallback for linked gateways');
expectIncludes('Route Command', "commandType === 'SET_LSN50_MODE'", 'routes SET_LSN50_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_INTERVAL'", 'routes SET_LSN50_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_INTERRUPT_MODE'", 'routes SET_LSN50_INTERRUPT_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_5V_WARMUP'", 'routes SET_LSN50_5V_WARMUP gateway commands');
expectIncludes('Route Command', "commandType === 'SET_KIWI_INTERVAL'", 'routes SET_KIWI_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'ENABLE_KIWI_TEMP_HUMIDITY'", 'routes ENABLE_KIWI_TEMP_HUMIDITY gateway commands');
expectIncludes('Route Command', "'UPSERT_DEVICE_SOIL_DEPTHS'", 'routes synced Kiwi soil depth commands through the shared update path');
expectIncludes('Route Command', "commandType === 'SET_STREGA_INTERVAL'", 'routes SET_STREGA_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_MODEL'", 'routes SET_STREGA_MODEL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_TIMED_ACTION'", 'routes SET_STREGA_TIMED_ACTION gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_MAGNET_MODE'", 'routes SET_STREGA_MAGNET_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_PARTIAL_OPENING'", 'routes SET_STREGA_PARTIAL_OPENING gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_FLUSHING'", 'routes SET_STREGA_FLUSHING gateway commands');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_MODE') {", 'updates the local configured LSN50 mode for synced commands');
expectIncludes('Build UPDATE SQL', 'area_m2=excluded.area_m2', 'upserts shared zone area from sync commands');
expectIncludes('Build UPDATE SQL', 'prediction_card_enabled=excluded.prediction_card_enabled', 'upserts the prediction-card flag from sync commands');
expectIncludes('Build UPDATE SQL', "sets.push('area_m2 = '", 'applies zone area updates from control-plane sync');
expectIncludes('Build UPDATE SQL', "sets.push('irrigation_efficiency_pct = '", 'applies irrigation efficiency updates from control-plane sync');
expectIncludes('Build UPDATE SQL', "sets.push('prediction_card_enabled = ' + b(predictionCardEnabled, false));", 'applies prediction-card updates from control-plane sync');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_INTERVAL') {", 'accepts synced LSN50 interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_INTERRUPT_MODE') {", 'accepts synced LSN50 interrupt mode commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_5V_WARMUP') {", 'accepts synced LSN50 5V warm-up commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_KIWI_INTERVAL') {", 'accepts synced Kiwi interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'ENABLE_KIWI_TEMP_HUMIDITY') {", 'accepts synced Kiwi temperature and humidity enable commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'UPSERT_DEVICE_SOIL_DEPTHS') {", 'accepts synced Kiwi soil depth updates on the gateway');
expectIncludes('Build UPDATE SQL', "soil_moisture_probe_depths_json", 'updates mirrored Kiwi soil depth metadata on the gateway');
expectIncludes('Sync Init Schema + Triggers', 'trg_sync_devices_outbox_au', 'creates the device outbox trigger for mirrored device changes');
expectIncludes('Sync Init Schema + Triggers', "COALESCE(NEW.soil_moisture_probe_depths_json,'') <> COALESCE(OLD.soil_moisture_probe_depths_json,'')", 'queues device outbox events when Kiwi soil depth JSON changes locally');
expectIncludes('Sync Init Schema + Triggers', "COALESCE(NEW.soil_moisture_probe_depths_configured,0) <> COALESCE(OLD.soil_moisture_probe_depths_configured,0)", 'queues device outbox events when Kiwi soil depth readiness changes locally');
expectIncludes('Sync Init Schema + Triggers', "'soil_moisture_probe_depths_json', json(COALESCE(NEW.soil_moisture_probe_depths_json, '{}'))", 'mirrors Kiwi soil depth JSON in device outbox payloads');
expectIncludes('Sync Init Schema + Triggers', "'soil_moisture_probe_depths_configured', COALESCE(NEW.soil_moisture_probe_depths_configured, 0)", 'mirrors Kiwi soil depth readiness in device outbox payloads');
expectIncludes('Auth + Save Soil Moisture Depths', 'soil_moisture_probe_depths_json = ', 'stores Kiwi soil depth JSON through the local edge endpoint');
expectIncludes('Auth + Save Soil Moisture Depths', 'soil_moisture_probe_depths_configured = 1', 'marks Kiwi soil depths as configured through the local edge endpoint');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_INTERVAL') {", 'accepts synced STREGA interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_MODEL') {", 'accepts synced STREGA model updates on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_TIMED_ACTION') {", 'accepts synced STREGA timed actions on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_MAGNET_MODE') {", 'accepts synced STREGA magnet mode commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_PARTIAL_OPENING') {", 'accepts synced STREGA partial opening commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_FLUSHING') {", 'accepts synced STREGA flushing commands on the gateway');
expectIncludes('Build Schedule ACK', "commandType === 'SET_LSN50_INTERRUPT_MODE'", 'skips duplicate generic ACKs for direct LSN50 interrupt-mode downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_LSN50_5V_WARMUP'", 'skips duplicate generic ACKs for direct LSN50 5V warm-up downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_TIMED_ACTION'", 'skips duplicate generic ACKs for direct STREGA timed downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_MAGNET_MODE'", 'skips duplicate generic ACKs for direct STREGA magnet downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_PARTIAL_OPENING'", 'skips duplicate generic ACKs for direct STREGA partial-opening downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_FLUSHING'", 'skips duplicate generic ACKs for direct STREGA flushing downlinks');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN lsn50_mode_code INTEGER', 'adds LSN50 mode columns to device_data');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_force_legacy INTEGER DEFAULT 0', 'adds the device-level legacy dendrometer override');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_stroke_mm REAL', 'adds the device-level dendrometer stroke calibration');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_ratio_zero REAL', 'adds the device-level dendrometer ratio zero calibration');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_ratio_span REAL', 'adds the device-level dendrometer ratio span calibration');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_position_mm REAL', 'adds a persisted edge baseline for comparable stem-change signals');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_mode_used TEXT', 'tracks which conversion path the stem-change baseline was captured with');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_calibration_signature TEXT', 'tracks calibration changes that should reset the stem-change baseline');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_pending INTEGER DEFAULT 0', 'adds a persisted pending-baseline flag on devices');
expectIncludes('Sync Init Schema + Triggers', 'COALESCE(dendro_baseline_pending,0)', 'preserves the pending-baseline flag when rebuilding the devices table');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_invert_direction INTEGER DEFAULT 0', 'adds the device-level dendrometer inversion flag');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN adc_ch1v REAL', 'adds CH1 dendrometer telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN dendro_ratio REAL', 'adds ratio dendrometer telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN dendro_mode_used TEXT', 'adds dendrometer path storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN dendro_stem_change_um REAL', 'adds baseline-relative stem-change storage to device_data');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN adc_ch0v REAL', 'adds backward-compatible CH0 storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN adc_ch1v REAL', 'adds CH1 storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN dendro_ratio REAL', 'adds ratio storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN dendro_mode_used TEXT', 'adds path metadata storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', "'lsn50_mode_code', NEW.lsn50_mode_code", 'mirrors observed LSN50 mode in device_data outbox events');
expectIncludes('Auth + Parse LSN50 Mode', "Mode must be one of MOD1..MOD9", 'validates supported LSN50 modes on the local API');
expectIncludes('Auth + Parse LSN50 Interval', "Minutes must be a whole number between 1 and ", 'validates LSN50 uplink interval minutes on the local API');
expectIncludes('Auth + Parse LSN50 Interrupt', "Interrupt mode must be between 0 and 3", 'validates LSN50 interrupt-mode values on the local API');
expectIncludes('Auth + Parse LSN50 5V Warmup', "Warm-up milliseconds must be between 0 and 65535", 'validates LSN50 5V warm-up values on the local API');
expectIncludes('Auth + Parse Kiwi Interval', "Minutes must be a whole number between 1 and 1440", 'validates Kiwi uplink interval minutes on the local API');
expectIncludes('Auth + Parse Kiwi Temp/Humidity', "A20001A30001", 'builds the Kiwi ambient temperature and humidity enable payload');
expectExcludes('Auth + Parse Kiwi Temp/Humidity', 'const intervalSeconds = 15 * 60;', 'default Kiwi temp/humidity 15-minute fallback');
expectExcludes('Auth + Parse Kiwi Temp/Humidity', 'minutes: 15,', 'implicit Kiwi temp/humidity interval default');
expectIncludes('Auth + Parse STREGA Interval', "Minutes must be a whole number between 1 and 255", 'validates STREGA uplink interval minutes on the local API');
expectIncludes('Auth + Parse STREGA Interval', "Opened minutes must be a whole number between 1 and 255", 'validates opened-box STREGA interval minutes on the local API');
expectIncludes('Auth + Parse STREGA Model', "Model must be STANDARD or MOTORIZED", 'validates STREGA model selection on the local API');
expectIncludes('Auth + Parse STREGA Timed Action', 'Timed action requires OPEN or CLOSE, seconds/minutes/hours, and an amount between 1 and 255', 'validates STREGA timed actions on the local API');
expectIncludes('Auth + Parse STREGA Magnet', 'enabled is required', 'validates STREGA magnet mode changes on the local API');
expectIncludes('Auth + Parse STREGA Partial Opening', 'Partial opening requires OPEN or CLOSE and a percentage between 1 and 100', 'validates STREGA partial opening on the local API');
expectIncludes('Auth + Parse STREGA Flushing', 'Flushing requires OPEN or CLOSE and a percentage between 1 and 100', 'validates STREGA flushing on the local API');
expectIncludes('Auth + Parse Dendro Config', 'const forceLegacy = parseNullableFlag', 'parses the explicit legacy dendrometer override');
expectIncludes('Auth + Parse Dendro Config', 'const strokeMm = parseNullableNumber', 'parses dendrometer stroke calibration');
expectIncludes('Auth + Parse Dendro Config', 'const ratioZero = parseNullableNumber', 'parses dendrometer ratio zero calibration');
expectIncludes('Auth + Parse Dendro Config', 'const ratioSpan = parseNullableNumber', 'parses dendrometer ratio span calibration');
expectIncludes('Auth + Parse Dendro Config', 'const invertDirection = parseNullableFlag', 'parses dendrometer inversion calibration');
expectIncludes('Auth + Parse Dendro Config', 'No dendrometer config fields supplied', 'rejects empty dendrometer config updates');
expectIncludes('Authorize + Fanout LSN50 Mode', "commandType: 'SET_LSN50_MODE'", 'fans out validated local LSN50 mode changes into the shared command path');
expectIncludes('Authorize + Fanout LSN50 Interval', "commandType: 'SET_LSN50_INTERVAL'", 'fans out validated local LSN50 interval changes into the shared command path');
expectIncludes('Authorize + Fanout LSN50 Advanced', "commandType: 'SET_LSN50_INTERRUPT_MODE'", 'fans out validated local LSN50 interrupt-mode changes into the shared command path');
expectIncludes('Authorize + Fanout LSN50 Advanced', "commandType: 'SET_LSN50_5V_WARMUP'", 'fans out validated local LSN50 5V warm-up changes into the shared command path');
expectIncludes('Authorize + Fanout Kiwi Interval', "commandType: 'SET_KIWI_INTERVAL'", 'fans out validated local Kiwi interval changes into the shared command path');
expectIncludes('Authorize + Fanout Kiwi Temp/Humidity', "commandType: 'ENABLE_KIWI_TEMP_HUMIDITY'", 'fans out validated local Kiwi ambient sensor enable changes into the shared command path');
expectIncludes('Authorize + Fanout STREGA Interval', "action: 'SET_INTERVAL'", 'fans out validated local STREGA interval changes into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Interval', 'tamper_disabled:', 'fans out validated STREGA tamper flags into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_TIMED_ACTION'", 'fans out validated local STREGA timed actions into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_MAGNET_MODE'", 'fans out validated local STREGA magnet commands into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_PARTIAL_OPENING'", 'fans out validated local STREGA partial opening into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_FLUSHING'", 'fans out validated local STREGA flushing into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', 'Partial opening is only supported for motorized Strega valves', 'gates motorized-only STREGA partial opening locally');
expectIncludes('Authorize + Fanout STREGA Advanced', 'Flushing is only supported for motorized Strega valves', 'gates motorized-only STREGA flushing locally');
expectExcludes('Authorize + Fanout LSN50 Mode', 'updated_at =', 'local LSN50 mode last-seen mutation');
expectExcludes('Authorize + Fanout LSN50 Interval', 'updated_at =', 'local LSN50 interval last-seen mutation');
expectExcludes('Authorize + Fanout Kiwi Interval', 'updated_at =', 'local Kiwi interval last-seen mutation');
expectExcludes('Authorize + Fanout Kiwi Temp/Humidity', 'updated_at =', 'local Kiwi temp/humidity last-seen mutation');
expectExcludes('Authorize + Fanout STREGA Interval', 'updated_at =', 'local STREGA interval last-seen mutation');
expectIncludes('Format LSN50 Mode Response', "confirmation: 'waiting_for_next_uplink'", 'returns explicit confirmation-waiting state from the local API');
expectIncludes('Format LSN50 Interval Response', "confirmation: 'downlink_queued'", 'returns queued state from the local LSN50 interval API');
expectIncludes('Format LSN50 Advanced Response', "confirmation: 'downlink_queued'", 'returns queued state from the local LSN50 advanced APIs');
expectIncludes('Format Kiwi Interval Response', "confirmation: 'downlink_queued'", 'returns queued state from the local Kiwi interval API');
expectIncludes('Format Kiwi Temp/Humidity Response', "confirmation: 'downlink_queued'", 'returns queued state from the local Kiwi ambient enable API');
expectIncludes('Format STREGA Interval Response', "confirmation: 'downlink_queued'", 'returns queued state from the local STREGA interval API');
expectIncludes('Format STREGA Interval Response', 'tamper_disabled:', 'returns tamper status from the local STREGA interval API');
expectIncludes('Format STREGA Advanced Response', "confirmation: 'stored_locally'", 'returns immediate confirmation from the local STREGA model API');
expectIncludes('Format STREGA Advanced Response', "confirmation: 'downlink_queued'", 'returns queued state from the local STREGA downlink APIs');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_LSN50_INTERVAL'", 'builds Dragino interval downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_LSN50_INTERRUPT_MODE'", 'builds Dragino interrupt-mode downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_LSN50_5V_WARMUP'", 'builds Dragino 5V warm-up downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_KIWI_INTERVAL'", 'builds Kiwi interval downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'ENABLE_KIWI_TEMP_HUMIDITY'", 'builds Kiwi ambient temperature and humidity enable downlinks');
expectIncludes('Build LSN50 mode downlink', 'rawBytes = [0x01, (intervalSeconds >> 16) & 0xFF, (intervalSeconds >> 8) & 0xFF, intervalSeconds & 0xFF];', 'encodes Dragino TDC interval bytes');
expectIncludes('Build LSN50 mode downlink', 'rawBytes = [0x06, 0x00, 0x00, interruptMode & 0xFF];', 'encodes Dragino interrupt-mode bytes');
expectIncludes('Build LSN50 mode downlink', 'rawBytes = [0x07, (milliseconds >> 8) & 0xFF, milliseconds & 0xFF];', 'encodes Dragino 5V warm-up bytes');
expectIncludes('Build LSN50 mode downlink', "rawBytes = [0xA0, (intervalSeconds >> 24) & 0xFF, (intervalSeconds >> 16) & 0xFF, (intervalSeconds >> 8) & 0xFF, intervalSeconds & 0xFF];", 'encodes Kiwi interval register writes');
expectIncludes('Build LSN50 mode downlink', "0xA2, 0x00, 0x01, 0xA3, 0x00, 0x01", 'encodes Kiwi ambient temperature and humidity enable bytes');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_INTERVAL': {", 'supports STREGA interval downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', 'rawBytes = [tamperDisabled ? 0x01 : 0x00, closedIntervalMinutes & 0xFF, 0x00, openIntervalMinutes & 0xFF];', 'encodes STREGA interval bytes with tamper control on FPort 11');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'TIMED_ACTION': {", 'supports STREGA timed-action downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_MAGNET_MODE': {", 'supports STREGA magnet-mode downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_PARTIAL_OPENING': {", 'supports STREGA partial-opening downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_FLUSHING': {", 'supports STREGA flushing downlinks');
expectFileIncludes('node-red.init', nodeRedInitScript, '. /usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper');
expectFileIncludes('node-red.init', nodeRedInitScript, 'gateway_identity_resolve', 'resolves the canonical gateway identity through the shared helper');
expectFileIncludes('node-red.init', nodeRedInitScript, 'gateway_identity_repair_concentratord_config || true', 'self-heals active concentratord gateway-id state during startup');
expectFileIncludes('node-red.init', nodeRedInitScript, 'gateway_identity_persist', 'persists canonical gateway identity metadata during startup');
expectFileIncludes('node-red.init', nodeRedInitScript, 'normalize_runtime_eui()', 'defines a startup helper to canonicalize gateway identities before exporting them');
expectFileIncludes('node-red.init', nodeRedInitScript, 'device_eui="$(normalize_runtime_eui "$device_eui")"', 'normalizes the runtime gateway identity to uppercase before using it for MQTT credentials');
expectFileIncludes('node-red.init', nodeRedInitScript, 'link_gateway_device_eui="$(normalize_runtime_eui "$link_gateway_device_eui")"', 'normalizes the linked gateway identity to uppercase before exporting it');
expectFileIncludes('node-red.init', nodeRedInitScript, 'DEVICE_EUI="$device_eui"', 'exports the derived gateway EUI into the Node-RED runtime environment');
expectFileIncludes('node-red.init', nodeRedInitScript, 'DEVICE_EUI_CONFIDENCE="$device_eui_confidence"', 'exports gateway identity confidence into the Node-RED runtime environment');
expectFileIncludes('node-red.init', nodeRedInitScript, 'LINK_GATEWAY_DEVICE_EUI="$link_gateway_device_eui"', 'exports the linked gateway identity into the Node-RED runtime environment');
expectFileIncludes('node-red.init', nodeRedInitScript, 'ALLOW_PRIVATE_SERVER_URLS="$allow_private_server_urls"', 'exports the private-target override into the Node-RED runtime environment');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, '. /usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper for first-boot seeding');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'gateway_identity_resolve', 'resolves the canonical gateway identity during UCI seeding');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'gateway_identity_persist', 'persists canonical gateway identity during UCI seeding');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.device_eui_source=$DEVICE_EUI_SOURCE', 'stores the identity source in UCI');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.device_eui_confidence=$DEVICE_EUI_CONFIDENCE', 'stores the identity confidence in UCI');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.link_gateway_device_eui=', 'initializes linked gateway identity metadata in UCI');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.allow_private_target=0', 'defaults the private-target override to disabled');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, '/usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper during one-shot bootstrap detection');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "readGatewayIdentityViaHelper", 'reads gateway identity via the shared helper during one-shot bootstrap detection');
expectFileExcludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'envVars.DEVICE_EUI = gatewayEui', 'persisting a stale gateway identity into .chirpstack.env when Node-RED already injects the canonical runtime value');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'const protectedKeys = new Set([', 'protects runtime gateway identity keys from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI'", 'protects DEVICE_EUI from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI_SOURCE'", 'protects DEVICE_EUI_SOURCE from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI_CONFIDENCE'", 'protects DEVICE_EUI_CONFIDENCE from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI_LAST_VERIFIED_AT'", 'protects DEVICE_EUI_LAST_VERIFIED_AT from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'LINK_GATEWAY_DEVICE_EUI'", 'protects LINK_GATEWAY_DEVICE_EUI from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "if (protectedKeys.has(key) && String(process.env[key] || '').trim()) return;", 'keeps init-provided identity env values when the env file is stale');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'LSN50_CODEC_PATH', 'allows overriding the LSN50 decoder path during bootstrap');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "CFG.lsn50CodecPath", 'tracks the shipped LSN50 decoder path in bootstrap config');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "readCodecScript(CFG.lsn50CodecPath, 'LSN50')", 'loads the shipped LSN50 decoder during bootstrap');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "getOrCreateProfileWithCodec(client, tenantId, CFG.profileLsn50Name", 'creates or repairs the OSI LSN50 profile with a payload codec');
expectFileIncludes('deploy.sh', deployScript, '"feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init"', 'deploys the Node-RED init script to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh"', 'deploys the shared gateway identity helper to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/package.json"', 'deploys the osi-dendro-helper package manifest to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js"', 'deploys the osi-dendro-helper runtime helper to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js"', 'deploys the shipped LSN50 ChirpStack decoder to live devices');
expectFileIncludes('deploy.sh', deployScript, 'chmod 755 /etc/init.d/node-red', 'keeps the deployed Node-RED init script executable');
expectFileIncludes('deploy.sh', deployScript, '/etc/init.d/osi-gateway-gps stop || true', 'stops the retired gateway GPS sidecar during deploy');
expectFileIncludes('deploy.sh', deployScript, '/etc/init.d/osi-gateway-gps disable || true', 'disables the retired gateway GPS sidecar during deploy');
expectFileIncludes('deploy.sh', deployScript, 'rm -f /etc/init.d/osi-gateway-gps /usr/bin/osi-gateway-gps.js', 'removes the retired gateway GPS sidecar files during deploy');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_resolve()', 'defines the shared canonical gateway resolver');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_active_chipset()', 'derives the active concentratord chipset before probing static gateway identifiers');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'uci -q get chirpstack-concentratord.@global[0].chipset', 'reads the active concentratord chipset from UCI');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_active_concentratord_uci', 'limits static UCI gateway-id probing to the active chipset');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_active_concentratord_toml', 'limits TOML gateway-id probing to the active chipset');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_repair_concentratord_config()', 'defines startup self-healing for active concentratord gateway-id state');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="authoritative"', 'marks live ChirpStack-derived gateway identities as authoritative');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="persisted"', 'marks previously verified gateway identities as persisted');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="provisional"', 'marks MAC-derived gateway identities as provisional');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, "tr 'abcdef' 'ABCDEF'", 'uses an explicit hex-only uppercase conversion that works on BusyBox');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, '/bin/sh -c', 'runs gateway detection in a non-login shell so banner output cannot poison detection');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'sh /usr/bin/gateway-id.sh', 'prefers runtime concentratord gateway identity when available');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_matches_local_mac_fallback', 'downgrades MAC-derived concentratord IDs away from authoritative confidence');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'for iface in eth0 br-lan wlan0; do', 'falls back across known interfaces for provisional MAC-derived identity');
expectFileExcludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_command "concentratord-uci-sx1302"', 'hard-coded sx1302 fallback outside active-chipset-aware resolution');
expectFileExcludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_command "concentratord-uci-sx1301"', 'hard-coded sx1301 fallback outside active-chipset-aware resolution');
expectFileExcludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_command "concentratord-toml"', 'blank-chipset TOML fallback outside active-chipset-aware resolution');
expectFileIncludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, '/usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper for first-boot concentratord seeding');
expectFileIncludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, 'gateway_identity_active_lora_section', 'seeds only the active LoRa concentratord section');
expectFileIncludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, 'resolve_fallback_gateway_id()', 'keeps a single MAC-derived fallback path for first-boot concentratord seeding');
expectFileExcludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, "SECTION='chirpstack-concentratord.@sx1302[0]'", 'hard-coded sx1302 seeding outside active-chipset-aware logic');
expectFileExcludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, "SECTION='chirpstack-concentratord.@sx1301[0]'", 'hard-coded sx1301 seeding outside active-chipset-aware logic');

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
  for (const dependency of ['@chirpstack/chirpstack-api', '@grpc/grpc-js', '@rakwireless/field-tester-server', 'bcryptjs', 'node-red-node-sqlite', 'osi-chirpstack-helper', 'osi-db-helper', 'osi-dendro-helper', 'sqlite3']) {
    if (!packageJson.dependencies || !packageJson.dependencies[dependency]) {
      fail(`package.json missing dependency ${dependency}`);
    } else {
      console.log(`OK package.json includes ${dependency}`);
    }
  }
}

const rawDbNodes = flows.filter(
  (node) => typeof node.func === 'string' && node.func.includes("new sqlite3.Database('/data/db/farming.db')")
);
for (const node of rawDbNodes) {
  const sqliteLib = (node.libs || []).find((entry) => entry && entry.var === 'sqlite3');
  if (!sqliteLib) {
    fail(`${node.name || node.id} missing sqlite3 helper import`);
  } else if (sqliteLib.module !== 'osi-db-helper') {
    fail(`${node.name || node.id} should import osi-db-helper instead of ${sqliteLib.module}`);
  } else {
    console.log(`OK ${node.name || node.id} uses osi-db-helper`);
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
    expectFileIncludes('osi-chirpstack-helper/index.js', helperSource, 'async getDeviceProfile(', 'adds profile reads so bootstrap can inspect existing ChirpStack codecs');
    expectFileIncludes('osi-chirpstack-helper/index.js', helperSource, 'async updateDeviceProfile(', 'adds profile updates so bootstrap can repair codec-less ChirpStack profiles');
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

expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'function decodeUplink(input)', 'ships the LSN50 ChirpStack decoder entry point');
expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'decode.Work_mode="3ADC+IIC";', 'ships the working MOD3 decoder path from the live LSN50 profile');
expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'decode.ADC_CH1V= (bytes[2]<<8 | bytes[3])/1000;', 'ships the working LSN50 CH1 decoder logic');

const dbHelperPath = dbHelperCandidates.find((candidate) => fs.existsSync(candidate));
if (!dbHelperPath) {
  fail(`missing DB helper module at one of: ${dbHelperCandidates.join(', ')}`);
} else {
  try {
    const helper = require(dbHelperPath);
    for (const exportName of ['Database', 'getHealth', 'quickCheck']) {
      if (typeof helper[exportName] !== 'function') {
        fail(`DB helper missing export ${exportName}`);
      } else {
        console.log(`OK DB helper exports ${exportName}`);
      }
    }
  } catch (error) {
    const helperIndexPath = path.join(dbHelperPath, 'index.js');
    const helperSource = fs.existsSync(helperIndexPath) ? fs.readFileSync(helperIndexPath, 'utf8') : '';
    if (error.code === 'MODULE_NOT_FOUND' && helperSource) {
      console.log(`OK DB helper source present despite missing local runtime deps: ${error.message}`);
      for (const exportName of ['Database', 'getHealth', 'quickCheck']) {
        if (!helperSource.includes(exportName)) {
          fail(`DB helper source missing export ${exportName}`);
        } else {
          console.log(`OK DB helper source includes ${exportName}`);
        }
      }
    } else {
      fail(`failed to load DB helper: ${error.message}`);
    }
  }
}

const dendroHelperPath = dendroHelperCandidates.find((candidate) => fs.existsSync(candidate));
if (!dendroHelperPath) {
  fail(`missing dendro helper module at one of: ${dendroHelperCandidates.join(', ')}`);
} else {
  let dendroHelper = null;
  try {
    dendroHelper = require(dendroHelperPath);
    for (const exportName of ['decodeRawAdcPayload', 'detectDendroModeUsed', 'calculateDendroRatio', 'calculateRatioDendroPositionMm', 'buildDendroDerivedMetrics', 'computeDendroDeltaMm', 'computeDendroStemChangeUm']) {
      if (typeof dendroHelper[exportName] !== 'function') {
        fail(`dendro helper missing export ${exportName}`);
      } else {
        console.log(`OK dendro helper exports ${exportName}`);
      }
    }
  } catch (error) {
    const helperIndexPath = path.join(dendroHelperPath, 'index.js');
    const helperSource = fs.existsSync(helperIndexPath) ? fs.readFileSync(helperIndexPath, 'utf8') : '';
    if (error.code === 'MODULE_NOT_FOUND' && helperSource) {
      console.log(`OK dendro helper source present despite missing local runtime deps: ${error.message}`);
      for (const exportName of ['decodeRawAdcPayload', 'detectDendroModeUsed', 'calculateDendroRatio', 'calculateRatioDendroPositionMm', 'buildDendroDerivedMetrics', 'computeDendroDeltaMm', 'computeDendroStemChangeUm']) {
        if (!helperSource.includes(exportName)) {
          fail(`dendro helper source missing export ${exportName}`);
        } else {
          console.log(`OK dendro helper source includes ${exportName}`);
        }
      }
    } else {
      fail(`failed to load dendro helper: ${error.message}`);
    }
  }

  if (dendroHelper) {
    const mod3Fixture = Buffer.from([0x0B, 0xB8, 0x00, 0xFA, 0x04, 0xB0, 0x08, 0x09, 0xC4, 0x03, 0x84]).toString('base64');
    const decoded = dendroHelper.decodeRawAdcPayload(mod3Fixture);
    expectApprox(decoded && decoded.adcCh0V, 1.2, 0.001, 'dendro helper decodes ADC_CH0V from raw MOD3 payloads');
    expectApprox(decoded && decoded.adcCh1V, 2.5, 0.001, 'dendro helper decodes ADC_CH1V from raw MOD3 payloads');
    expectApprox(decoded && decoded.adcCh4V, 0.9, 0.001, 'dendro helper decodes ADC_CH4V from raw MOD3 payloads');
    expectEqual(decoded && decoded.modeCode, 3, 'dendro helper decodes MOD3 mode from raw payloads');

    const legacyFixture = Buffer.from([0x0B, 0xB8, 0x00, 0xFA, 0x08, 0x77, 0x00, 0xFF, 0xFF, 0x03, 0x84]).toString('base64');
    const legacyDecoded = dendroHelper.decodeRawAdcPayload(legacyFixture);
    expectApprox(legacyDecoded && legacyDecoded.adcCh0V, 2.167, 0.001, 'dendro helper still decodes ADC_CH0V from legacy raw payloads');
    expectEqual(legacyDecoded && legacyDecoded.adcCh1V, null, 'dendro helper ignores raw CH1 fallback data outside MOD3');
    expectEqual(legacyDecoded && legacyDecoded.adcCh4V, null, 'dendro helper ignores raw CH4 fallback data outside MOD3');
    expectEqual(legacyDecoded && legacyDecoded.modeCode, 1, 'dendro helper preserves the observed legacy mode from raw payloads');

    const legacyMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 2,
      adcCh0V: 1.2,
      adcCh1V: null,
    });
    expectEqual(legacyMetrics.dendroModeUsed, 'legacy_single_adc', 'legacy dendrometer path remains active outside MOD3');
    expectEqual(legacyMetrics.dendroRatio, null, 'legacy dendrometer path does not expose a ratio');
    expectApprox(legacyMetrics.positionMm, 12, 0.001, 'legacy dendrometer path preserves single-ADC conversion');

    const ratioMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 1.2,
      adcCh1V: 2.4,
      strokeMm: 40,
      ratioZero: 0.2,
      ratioSpan: 0.8,
      invertDirection: 0,
    });
    expectEqual(ratioMetrics.dendroModeUsed, 'ratio_mod3', 'MOD3 dendrometer path switches to ratio mode when CH0 and CH1 are valid');
    expectApprox(ratioMetrics.dendroRatio, 0.5, 0.000001, 'ratio dendrometer path exposes the raw ratio');
    expectApprox(ratioMetrics.positionMm, 20, 0.001, 'ratio dendrometer path converts calibrated displacement');

    const invalidReferenceMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 1.2,
      adcCh1V: 0.01,
      strokeMm: 40,
      ratioZero: 0.2,
      ratioSpan: 0.8,
    });
    expectEqual(invalidReferenceMetrics.dendroModeUsed, 'legacy_single_adc', 'near-zero CH1 falls back to the legacy dendrometer path');
    expectEqual(invalidReferenceMetrics.dendroRatio, null, 'near-zero CH1 does not leak a ratio through the legacy fallback');
    expectApprox(invalidReferenceMetrics.positionMm, 12, 0.001, 'near-zero CH1 preserves legacy dendrometer comparability');

    const invertedPosition = dendroHelper.calculateRatioDendroPositionMm({
      strokeMm: 40,
      ratioZero: 0.2,
      ratioSpan: 0.8,
      ratio: 0.3,
      invertDirection: 1,
    });
    expectApprox(invertedPosition, 33.333, 0.001, 'invert_direction reverses the ratio-based displacement conversion');

    const missingCalibrationMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 1.2,
      adcCh1V: 2.4,
    });
    expectEqual(missingCalibrationMetrics.dendroModeUsed, 'ratio_mod3', 'ratio mode still activates without calibration values');
    expectApprox(missingCalibrationMetrics.dendroRatio, 0.5, 0.000001, 'ratio mode still exposes raw ratios when calibration is missing');
    expectEqual(missingCalibrationMetrics.positionMm, null, 'ratio mode does not synthesize calibrated displacement when calibration is missing');
    expectEqual(missingCalibrationMetrics.calibrationMissing, true, 'ratio mode flags missing calibration cleanly');

    const pathResetDelta = dendroHelper.computeDendroDeltaMm({
      positionMm: 20,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '40|0.2|0.8|0',
      previousState: {
        positionMm: 19,
        modeUsed: 'legacy_single_adc',
        calibrationSignature: 'null|null|null|0',
      },
    });
    expectEqual(pathResetDelta.deltaMm, null, 'dendrometer delta resets when the conversion path changes');

    const calibrationResetDelta = dendroHelper.computeDendroDeltaMm({
      positionMm: 20,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '50|0.2|0.8|0',
      previousState: {
        positionMm: 19,
        modeUsed: 'ratio_mod3',
        calibrationSignature: '40|0.2|0.8|0',
      },
    });
    expectEqual(calibrationResetDelta.deltaMm, null, 'dendrometer delta resets when calibration changes');

    const initialStemChange = dendroHelper.computeDendroStemChangeUm({
      positionMm: 20,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '40|0.2|0.8|0',
      baselineState: null,
    });
    expectEqual(initialStemChange.stemChangeUm, 0, 'the first valid calibrated dendrometer reading establishes a zero stem-change baseline');
    expectApprox(initialStemChange.nextBaseline.positionMm, 20, 0.001, 'the first valid calibrated dendrometer reading becomes the persisted baseline position');

    const laterStemChange = dendroHelper.computeDendroStemChangeUm({
      positionMm: 20.125,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '40|0.2|0.8|0',
      baselineState: initialStemChange.nextBaseline,
    });
    expectEqual(laterStemChange.stemChangeUm, 125, 'stem change is reported in micrometers relative to the device baseline');

    const resetStemChange = dendroHelper.computeDendroStemChangeUm({
      positionMm: 19.5,
      modeUsed: 'legacy_single_adc',
      calibrationSignature: 'null|null|null|0',
      baselineState: initialStemChange.nextBaseline,
    });
    expectEqual(resetStemChange.stemChangeUm, 0, 'stem change resets to zero when the conversion path changes');

    pendingChecks.push(executeFunctionNodeById('dendro-readings-insert-fn', {
      formattedData: {
        devEui: 'ABC123',
        detectedMode: 2,
        dendroValid: 1,
        positionMm: 1.234,
        deltaMm: null,
        adcV: 1.111,
        adcCh1V: null,
        dendroRatio: null,
        dendroModeUsed: 'legacy_single_adc',
        batV: 3.65,
        timestamp: '2026-04-17T12:00:00.000Z',
      },
    }).then((sqlMsg) => {
      const sql = String((sqlMsg && (sqlMsg.topic || sqlMsg.payload)) || '');
      expectCondition(
        sql.includes('adc_v,adc_ch0v,adc_ch1v,dendro_ratio,dendro_mode_used'),
        'legacy dendrometer SQL keeps adc_v while adding CH0/CH1/ratio debug columns',
        'legacy dendrometer SQL is missing backward-compatible raw debug columns'
      );
      expectCondition(
        sql.includes("1.111,1.111,NULL,NULL,'legacy_single_adc'"),
        'legacy dendrometer SQL preserves adc_v and adc_ch0v semantics for historical rows',
        'legacy dendrometer SQL no longer preserves adc_v and adc_ch0v semantics'
      );
    }).catch((error) => {
      fail(`failed to execute dendro-readings-insert-fn fixture: ${error.message}`);
    }));

    pendingChecks.push(executeFunctionNodeById('dendro-readings-insert-fn', {
      formattedData: {
        devEui: 'ABC123',
        detectedMode: 3,
        dendroValid: 1,
        positionMm: 12.5,
        deltaMm: 0.125,
        adcV: 1.2,
        adcCh1V: 2.4,
        dendroRatio: 0.5,
        dendroModeUsed: 'ratio_mod3',
        batV: 3.7,
        timestamp: '2026-04-17T12:05:00.000Z',
      },
    }).then((sqlMsg) => {
      const sql = String((sqlMsg && (sqlMsg.topic || sqlMsg.payload)) || '');
      expectCondition(
        sql.includes("1.2,1.2,2.4,0.5,'ratio_mod3'"),
        'MOD3 dendrometer SQL persists CH1, ratio, and ratio-mode metadata',
        'MOD3 dendrometer SQL is missing the ratio-mode persistence columns or values'
      );
    }).catch((error) => {
      fail(`failed to execute MOD3 dendro-readings-insert-fn fixture: ${error.message}`);
    }));
  }
}

Promise.all(pendingChecks).finally(() => {
  if (!process.exitCode) {
    console.log('Sync flow verification passed');
  }
});
