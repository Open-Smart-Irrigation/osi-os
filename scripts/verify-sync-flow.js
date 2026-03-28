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
  '/api/gateway/location',
  '/api/gateways/:gatewayEui/location',
  '/api/irrigation-zones/:zone_id/environment-summary'
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
  'Build LSN50 mode downlink',
  'Auth + Query Gateway Location',
  'Format Gateway Location Response',
  'Get Zone Environment Summary'
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
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN strega_model TEXT', 'adds the STREGA model metadata column');
expectIncludes('Sync Init Schema + Triggers', "'strega_model', NEW.strega_model", 'mirrors STREGA model changes into device outbox events');
expectIncludes('Sync Init Schema + Triggers', 'CREATE TABLE IF NOT EXISTS gateway_locations', 'creates the gateway GPS mirror table');
expectIncludes('Sync Init Schema + Triggers', 'trg_gateway_locations_outbox_ai', 'creates the gateway GPS insert trigger');
expectIncludes('Sync Init Schema + Triggers', 'GATEWAY_LOCATION_UPSERTED', 'emits gateway GPS sync events');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in bootstrap zone snapshots');
expectIncludes('Build Cloud Bootstrap', 'd.strega_model', 'includes STREGA model metadata in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', 'gatewayLocations: gatewayLocations', 'includes gateway GPS state in bootstrap payloads');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in force-sync device snapshots');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in force-sync zone snapshots');
expectIncludes('Run Force Sync', 'd.strega_model', 'includes STREGA model metadata in force-sync device snapshots');
expectIncludes('Run Force Sync', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in force-sync sensor data');
expectIncludes('Run Force Sync', 'gatewayLocations,', 'includes gateway GPS state in forced sync payloads');
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
expectIncludes('Get Zone Environment Summary', "preferredSource: usingLocal ? 'local'", 'prioritizes local sensor climate over online weather for agronomic metrics');
expectIncludes('Get Zone Environment Summary', 'LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui', 'falls back to mirrored gateway coordinates when a zone has no explicit location');
expectIncludes('Build Telemetry', 'lsn50_mode_code: observedModeCode', 'publishes observed LSN50 mode in edge telemetry');
expectIncludes('Decode LSN50', 'function detectLsn50ModeCode', 'decodes observed LSN50 mode from raw uplinks');
expectIncludes('Apply Config', 'd.modeCodeToStore = d.observedModeCode != null ? d.observedModeCode : deviceMode;', 'stores observed or configured LSN50 mode on ingest');
expectIncludesById('lsn50-sql-fn', 'lsn50_mode_code, lsn50_mode_label, lsn50_mode_observed_at', 'persists observed LSN50 mode into device_data');
expectIncludesById('format-devices', 'dd.lsn50_mode_code', 'returns observed LSN50 mode in GET /api/devices');
expectIncludesById('merge-device-data', 'device_mode: d.device_mode ?? 1', 'returns configured LSN50 mode in GET /api/devices');
expectIncludesById('merge-device-data', 'strega_model: d.strega_model || null', 'returns stored STREGA model metadata in GET /api/devices');
expectExcludesById('merge-device-data', 'd.updated_at', 'updated_at fallback for last_seen in GET /api/devices');
expectIncludes('Auth + Query Gateway Location', 'gateway_locations', 'queries gateway GPS state from the local mirror table');
expectIncludes('Format Gateway Location Response', "status: row.status || 'no_fix'", 'returns a no-fix fallback for linked gateways');
expectIncludes('Route Command', "commandType === 'SET_LSN50_MODE'", 'routes SET_LSN50_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_INTERVAL'", 'routes SET_LSN50_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_INTERRUPT_MODE'", 'routes SET_LSN50_INTERRUPT_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_5V_WARMUP'", 'routes SET_LSN50_5V_WARMUP gateway commands');
expectIncludes('Route Command', "commandType === 'SET_KIWI_INTERVAL'", 'routes SET_KIWI_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'ENABLE_KIWI_TEMP_HUMIDITY'", 'routes ENABLE_KIWI_TEMP_HUMIDITY gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_INTERVAL'", 'routes SET_STREGA_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_MODEL'", 'routes SET_STREGA_MODEL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_TIMED_ACTION'", 'routes SET_STREGA_TIMED_ACTION gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_MAGNET_MODE'", 'routes SET_STREGA_MAGNET_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_PARTIAL_OPENING'", 'routes SET_STREGA_PARTIAL_OPENING gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_FLUSHING'", 'routes SET_STREGA_FLUSHING gateway commands');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_MODE') {", 'updates the local configured LSN50 mode for synced commands');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_INTERVAL') {", 'accepts synced LSN50 interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_INTERRUPT_MODE') {", 'accepts synced LSN50 interrupt mode commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_5V_WARMUP') {", 'accepts synced LSN50 5V warm-up commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_KIWI_INTERVAL') {", 'accepts synced Kiwi interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'ENABLE_KIWI_TEMP_HUMIDITY') {", 'accepts synced Kiwi temperature and humidity enable commands on the gateway');
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
