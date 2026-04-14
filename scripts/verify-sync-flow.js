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
const dbHelperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-db-helper'),
  path.join(nodeRedRoot, 'osi-db-helper')
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
  '/api/devices/:deveui/zone-assignments',
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
expectIncludes('Build server auth request', 'deviceEuis: deviceEuis', 'sends local device claims in the authenticated local-sync request');
expectIncludes('Build server auth request', "new osiDb.Database('/data/db/farming.db')", 'loads local device claims before cloud linking');
expectIncludes('Handle server auth response', "const claimed = Array.isArray(data.claimed)", 'accepts claimed device results directly from local-sync');
expectIncludes('Build Sync State', 'lastMirroredEventAt', 'returns the last mirrored sync event timestamp');
expectIncludes('Build Sync State', 'dbHealth: {', 'returns a DB health block in sync state');
expectIncludes('Build Sync State', "journalMode: helperHealth.journalMode || null", 'returns SQLite journal mode in sync state');
expectIncludes('Build Sync State', "quickCheck: quickCheck.status", 'returns quick-check status in sync state');
expectIncludes('Build Sync State', "lastError: helperHealth.lastError || null", 'returns helper DB errors in sync state');
expectIncludesById('al-link-build-claim', 'if (deviceEuis.length === 0)', 'skips remote bulk claim when there are no local devices');
expectIncludesById('al-link-build-claim', 'return [msg, null];', 'only calls remote bulk claim when device claims are needed');
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
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN area_m2 REAL', 'adds shared zone area config');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN irrigation_efficiency_pct REAL', 'adds shared irrigation efficiency config');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN rain_mm_per_10min REAL', 'adds normalized rain telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN flow_liters_per_10min REAL', 'adds normalized flow telemetry storage');
expectIncludes('Sync Init Schema + Triggers', "'area_m2', NEW.area_m2", 'mirrors zone area changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', "'irrigation_efficiency_pct', NEW.irrigation_efficiency_pct", 'mirrors irrigation efficiency changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', "'rain_mm_per_10min', NEW.rain_mm_per_10min", 'mirrors normalized rain telemetry into device-data sync events');
expectIncludes('Sync Init Schema + Triggers', "'flow_liters_per_10min', NEW.flow_liters_per_10min", 'mirrors normalized flow telemetry into device-data sync events');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in bootstrap zone snapshots');
expectIncludes('Build Cloud Bootstrap', 'd.strega_model', 'includes STREGA model metadata in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', 'iz.area_m2', 'includes zone area in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'iz.irrigation_efficiency_pct', 'includes zone irrigation efficiency in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.rain_mm_per_10min,'", 'includes normalized rain telemetry in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.flow_liters_per_10min,'", 'includes normalized flow telemetry in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', 'AS event_uuid', 'synthesizes stable irrigation event UUIDs for bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'gatewayLocations: gatewayLocations', 'includes gateway GPS state in bootstrap payloads');
expectIncludes('Build Cloud Bootstrap', 'const sensorDataRows = await q([', 'loads bootstrap sensor history before reordering it');
expectIncludes('Build Cloud Bootstrap', 'const sensorData = sensorDataRows.slice().reverse();', 'replays bootstrap sensor history oldest-to-newest');
expectIncludes('Build Cloud Bootstrap', 'const dendroReadingsRows = await q([', 'loads bootstrap dendro history before reordering it');
expectIncludes('Build Cloud Bootstrap', 'const dendroReadings = dendroReadingsRows.slice().reverse();', 'replays bootstrap dendro history oldest-to-newest');
expectIncludes('Build Cloud Bootstrap', 'function normalizeIsoTimestamp(value)', 'normalizes malformed edge timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'deleted_at: normalizeIsoTimestamp(z.deleted_at)', 'normalizes zone tombstone timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'devices: devices.map(sanitizeSyncRow)', 'normalizes device tombstone timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'schedules: schedules.map(sanitizeSyncRow)', 'normalizes schedule timestamps before bootstrap sync');
expectIncludes('Mark Bootstrap Synced', "(msg.payload || {}).detail || 'Bootstrap sync failed'", 'preserves server ProblemDetail details for bootstrap errors');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in force-sync device snapshots');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in force-sync zone snapshots');
expectIncludes('Run Force Sync', 'd.strega_model', 'includes STREGA model metadata in force-sync device snapshots');
expectIncludes('Run Force Sync', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in force-sync sensor data');
expectIncludes('Run Force Sync', 'iz.area_m2', 'includes zone area in force-sync snapshots');
expectIncludes('Run Force Sync', 'iz.irrigation_efficiency_pct', 'includes zone irrigation efficiency in force-sync snapshots');
expectIncludes('Run Force Sync', "'  dd.rain_mm_per_10min,'", 'includes normalized rain telemetry in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.flow_liters_per_10min,'", 'includes normalized flow telemetry in force-sync sensor data');
expectIncludes('Run Force Sync', 'AS event_uuid', 'synthesizes stable irrigation event UUIDs for forced bootstrap snapshots');
expectIncludes('Run Force Sync', 'gatewayLocations,', 'includes gateway GPS state in forced sync payloads');
expectIncludes('Run Force Sync', 'const sensorDataRows = await q([', 'loads force-sync sensor history before reordering it');
expectIncludes('Run Force Sync', 'const sensorData = sensorDataRows.slice().reverse();', 'replays force-sync sensor history oldest-to-newest');
expectIncludes('Run Force Sync', 'const dendroReadingsRows = await q([', 'loads force-sync dendro history before reordering it');
expectIncludes('Run Force Sync', 'const dendroReadings = dendroReadingsRows.slice().reverse();', 'replays force-sync dendro history oldest-to-newest');
expectIncludes('Run Force Sync', 'function normalizeIsoTimestamp(value)', 'normalizes malformed edge timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'deleted_at: normalizeIsoTimestamp(z.deleted_at)', 'normalizes zone tombstone timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'devices: devices.map(sanitizeSyncRow)', 'normalizes device tombstone timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'schedules: schedules.map(sanitizeSyncRow)', 'normalizes schedule timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', "(bootstrapRes.payload || {}).detail || 'Bootstrap sync failed'", 'preserves server ProblemDetail details in force-sync bootstrap errors');
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
expectIncludes('Build Telemetry', 'var observedModeCode = isLsn50 && data.data ?', 'avoids assigning LSN50 mode codes to Kiwi telemetry');
expectIncludes('Build Telemetry', "profileKind === 'STREGA_VALVE'", 'skips valve uplinks in sensor telemetry mirroring');
expectIncludes('Build Telemetry', 'if (!profileKind && swtWm1 === null && swtWm2 === null', 'skips unknown no-data uplinks instead of defaulting them to Kiwi');
expectIncludesById('81c98fb07344a787', "env.get('CHIRPSTACK_PROFILE_KIWI')", 'uses env-backed Kiwi profile routing');
expectIncludesById('81c98fb07344a787', "env.get('CHIRPSTACK_PROFILE_CLOVER')", 'uses env-backed Clover profile routing');
expectIncludes('Decode LSN50', 'function detectLsn50ModeCode', 'decodes observed LSN50 mode from raw uplinks');
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
expectIncludesById('lsn50-sql-fn', 'lsn50_mode_code, lsn50_mode_label, lsn50_mode_observed_at', 'persists observed LSN50 mode into device_data');
expectIncludesById('lsn50-sql-fn', 'rain_mm_per_hour, rain_mm_per_10min, rain_mm_today, rain_delta_status', 'persists interval-aware rain metadata into device_data');
expectIncludesById('lsn50-sql-fn', 'flow_liters_per_min, flow_liters_per_10min, flow_liters_today, flow_delta_status', 'persists interval-aware flow metadata into device_data');
expectIncludesById('lsn50-sql-fn', 'rain_mm_per_10min, rain_mm_today', 'persists normalized and daily rain telemetry into device_data');
expectIncludesById('lsn50-sql-fn', 'flow_liters_per_10min, flow_liters_today', 'persists normalized and daily flow telemetry into device_data');
expectIncludesById('lsn50-sql-fn', 'counter_interval_seconds', 'persists elapsed counter interval into device_data');
expectIncludesById('lsn50-zone-agg-fn', "localDateIso(d.timestamp || computedAt", 'bins MOD9 zone totals by uplink timestamp instead of processing time');
expectIncludesById('lsn50-zone-agg-fn', "d.rainDeltaStatus === 'ok'", 'only aggregates valid rain deltas into zone totals');
expectIncludesById('lsn50-zone-agg-fn', "d.flowDeltaStatus === 'ok'", 'only aggregates valid flow deltas into zone totals');
expectIncludesById('format-devices', 'dd.lsn50_mode_code', 'returns observed LSN50 mode in GET /api/devices');
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
expectIncludes('Build UPDATE SQL', 'area_m2=excluded.area_m2', 'upserts shared zone area from sync commands');
expectIncludes('Build UPDATE SQL', "sets.push('area_m2 = '", 'applies zone area updates from control-plane sync');
expectIncludes('Build UPDATE SQL', "sets.push('irrigation_efficiency_pct = '", 'applies irrigation efficiency updates from control-plane sync');
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
  for (const dependency of ['@chirpstack/chirpstack-api', '@grpc/grpc-js', '@rakwireless/field-tester-server', 'bcryptjs', 'node-red-node-sqlite', 'osi-chirpstack-helper', 'osi-db-helper', 'sqlite3']) {
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

if (!process.exitCode) {
  console.log('Sync flow verification passed');
}
