#!/usr/bin/env node
/**
 * chirpstack-bootstrap.js  —  OSI OS one-time ChirpStack setup
 *
 * Creates (or reuses if already present):
 *   • 3 ChirpStack applications:  OSI Sensors, OSI Actuators, OSI Field Tester
 *   • 4 device profiles:          KIWI Sensor, STREGA Valve, Dragino LSN50, RAK Field Tester
 *   • 1 API key:                  osi-nodered  (used by Node-RED function nodes)
 *
 * Writes results to:
 *   • /srv/node-red/.chirpstack.env      — env vars loaded by Node-RED on startup
 *   • /srv/node-red/settings.js          — patched to auto-load the env file
 *   • /srv/node-red/flows.json           — MQTT topics updated to new app IDs
 *
 * Run ONCE on the Pi after first boot:
 *   node /tmp/chirpstack-bootstrap.js
 *
 * Overridable via environment variables:
 *   CHIRPSTACK_API_URL       ChirpStack gRPC API URL       (default: http://localhost:8080)
 *   CHIRPSTACK_API_KEY       Pre-created API key token     (skips CLI creation)
 *   CS_TENANT_NAME           Tenant name to reuse/create   (default: Open Smart Irrigation)
 *   CS_REGION                LoRaWAN region                (default: EU868)
 *   ENV_FILE                 Env file path                 (default: /srv/node-red/.chirpstack.env)
 *   SETTINGS_JS              Node-RED settings.js path     (default: /srv/node-red/settings.js)
 *   FLOWS_JSON               Node-RED flows.json path      (default: /srv/node-red/flows.json)
 *
 * App name overrides (use to reuse existing apps instead of creating OSI-prefixed ones):
 *   CS_APP_SENSORS_NAME      (default: "OSI Sensors")
 *   CS_APP_ACTUATORS_NAME    (default: "OSI Actuators")
 *   CS_APP_FIELD_TESTER_NAME (default: "OSI Field Tester")
 *
 * Profile name overrides (use to reuse an existing device profile):
 *   CS_PROFILE_KIWI_NAME     (default: "OSI KIWI Sensor")
 *   CS_PROFILE_STREGA_NAME   (default: "OSI STREGA Valve")
 *   CS_PROFILE_LSN50_NAME    (default: "OSI Dragino LSN50")
 *   CS_PROFILE_RAK_NAME      (default: "OSI RAK Field Tester")
 *   CS_PROFILE_S2120_NAME    (default: "OSI SenseCAP S2120")
 *   S2120_CODEC_PATH         (default: "/srv/node-red/codecs/sensecap_s2120_decoder.js")
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadChirpStackHelper() {
  const candidates = [
    '/srv/node-red/node_modules/osi-chirpstack-helper',
    '/srv/node-red/osi-chirpstack-helper',
    '/usr/share/node-red/node_modules/osi-chirpstack-helper',
    path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'node_modules', 'osi-chirpstack-helper'),
    path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'osi-chirpstack-helper')
  ];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Unable to load osi-chirpstack-helper.\n${failures.join('\n')}`);
}

const chirpstack = loadChirpStackHelper();

const CFG = {
  url: process.env.CHIRPSTACK_API_URL || process.env.CS_URL || 'http://localhost:8080',
  apiKey: process.env.CHIRPSTACK_API_KEY || process.env.CS_API_KEY || '',
  tenantName: process.env.CS_TENANT_NAME || 'Open Smart Irrigation',
  region: process.env.CS_REGION || 'EU868',
  envFile: process.env.ENV_FILE || '/srv/node-red/.chirpstack.env',
  settingsJs: process.env.SETTINGS_JS || '/srv/node-red/settings.js',
  flowsJson: process.env.FLOWS_JSON || '/srv/node-red/flows.json',
  appSensorsName: process.env.CS_APP_SENSORS_NAME || 'OSI Sensors',
  appActuatorsName: process.env.CS_APP_ACTUATORS_NAME || 'OSI Actuators',
  appFieldTesterName: process.env.CS_APP_FIELD_TESTER_NAME || 'OSI Field Tester',
  profileKiwiName: process.env.CS_PROFILE_KIWI_NAME || 'OSI KIWI Sensor',
  profileStregaName: process.env.CS_PROFILE_STREGA_NAME || 'OSI STREGA Valve',
  profileLsn50Name: process.env.CS_PROFILE_LSN50_NAME || 'OSI Dragino LSN50',
  profileRakName: process.env.CS_PROFILE_RAK_NAME || 'OSI RAK Field Tester',
  profileS2120Name: process.env.CS_PROFILE_S2120_NAME || 'OSI SenseCAP S2120',
  s2120CodecPath: process.env.S2120_CODEC_PATH || '/srv/node-red/codecs/sensecap_s2120_decoder.js'
};

const ENV_LOADER_MARKER = '// [OSI] chirpstack env loader';

function listItemsToObjects(items) {
  return items.map((item) => chirpstack.listItemToObject(item));
}

async function getOrCreateTenant(client) {
  const tenants = listItemsToObjects(await client.listTenants());
  const named = tenants.find((tenant) => tenant.name === CFG.tenantName);
  if (named) {
    console.log(`  ✓ Tenant exists: "${named.name}" (${named.id})`);
    return named.id;
  }
  if (tenants.length > 0) {
    console.log(`  ✓ Reusing first tenant: "${tenants[0].name}" (${tenants[0].id})`);
    return tenants[0].id;
  }
  const created = await client.createTenant({
    name: CFG.tenantName,
    description: 'OSI bootstrap tenant',
    canHaveGateways: true,
    maxGatewayCount: 0,
    maxDeviceCount: 0,
    privateGatewaysUp: false,
    privateGatewaysDown: false
  });
  console.log(`  + Tenant created: "${CFG.tenantName}" (${created.getId()})`);
  return created.getId();
}

async function getOrCreateApp(client, tenantId, name, description) {
  const apps = listItemsToObjects(await client.listApplications(tenantId));
  const existing = apps.find((app) => app.name === name);
  if (existing) {
    console.log(`  ✓ App exists: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await client.createApplication({ tenantId, name, description });
  console.log(`  + App created: "${name}" (${created.getId()})`);
  return created.getId();
}

async function getOrCreateProfileWithCodec(client, tenantId, name, description, payloadCodecScript) {
  const profiles = listItemsToObjects(await client.listDeviceProfiles(tenantId));
  const existing = profiles.find((profile) => profile.name === name);
  if (existing) {
    console.log(`  ✓ Profile exists: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await client.createDeviceProfile({
    tenantId,
    name,
    description,
    region: CFG.region,
    uplinkInterval: 3600,
    deviceStatusReqInterval: 1,
    payloadCodecScript: payloadCodecScript || undefined
  });
  console.log(`  + Profile created: "${name}" (${created.getId()})`);
  return created.getId();
}

async function getOrCreateProfile(client, tenantId, name, description) {
  const profiles = listItemsToObjects(await client.listDeviceProfiles(tenantId));
  const existing = profiles.find((profile) => profile.name === name);
  if (existing) {
    console.log(`  ✓ Profile exists: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await client.createDeviceProfile({
    tenantId,
    name,
    description,
    region: CFG.region,
    uplinkInterval: 3600,
    deviceStatusReqInterval: 1
  });
  console.log(`  + Profile created: "${name}" (${created.getId()})`);
  return created.getId();
}

async function createApiKeyViaCLI() {
  console.log('  + Creating API key via CLI (chirpstack create-api-key) ...');
  try {
    const out = execSync('chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered 2>&1').toString();
    const match = out.match(/^token:\s*(.+)$/m);
    if (!match) {
      throw new Error('No token in CLI output: ' + out);
    }
    console.log('  ✓ API key created via CLI');
    return match[1].trim();
  } catch (error) {
    throw new Error('CLI create-api-key failed: ' + error.message);
  }
}

function normalizeGatewayEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return null;
  if (raw.length === 16) return raw === '0101010101010101' ? null : raw;
  if (raw.length === 12) return `${raw.slice(0, 6)}FFFE${raw.slice(6)}`;
  return null;
}

function readGatewayEuiFromTOML() {
  const confDirs = [
    '/var/etc/chirpstack-concentratord',
    '/var/etc',
    '/etc/chirpstack-concentratord/sx1302',
    '/etc/chirpstack-concentratord/sx1301',
  ];
  for (const dir of confDirs) {
    try {
      const files = fs.readdirSync(dir).filter((file) => file.endsWith('.toml'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const match = content.match(/gateway_id\s*=\s*"([0-9a-fA-F]{16})"/);
        const resolved = normalizeGatewayEui(match && match[1]);
        if (resolved) return resolved;
      }
    } catch (_) {}
  }
  return null;
}

function readGatewayEuiViaCommand(command) {
  try {
    return normalizeGatewayEui(execSync(command, { timeout: 5000 }).toString('utf8'));
  } catch (_) {
    return null;
  }
}

function detectGatewayEui() {
  try {
    const log = execSync('logread 2>/dev/null || true', { timeout: 5000 }).toString();
    const topicMatch = log.match(/gateway\/([0-9a-fA-F]{16})\/event\//);
    if (topicMatch) return normalizeGatewayEui(topicMatch[1]);
    const match = log.match(/gateway_id[:\s"]+([0-9a-fA-F]{16})/);
    if (match) return normalizeGatewayEui(match[1]);
  } catch (_) {}

  for (const candidate of [
    readGatewayEuiFromTOML(),
    readGatewayEuiViaCommand('uci -q get chirpstack-concentratord.@sx1302[0].gateway_id 2>/dev/null || true'),
    readGatewayEuiViaCommand('uci -q get chirpstack-concentratord.@sx1301[0].gateway_id 2>/dev/null || true'),
    readGatewayEuiViaCommand('uci -q get osi-server.cloud.device_eui 2>/dev/null || true')
  ]) {
    if (candidate) return candidate;
  }

  for (const iface of ['eth0', 'br-lan', 'wlan0']) {
    try {
      const mac = fs.readFileSync(`/sys/class/net/${iface}/address`, 'utf8');
      const resolved = normalizeGatewayEui(mac);
      if (resolved) return resolved;
    } catch (_) {}
  }

  return null;
}

function writeEnvFile(vars) {
  const lines = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.writeFileSync(CFG.envFile, lines + '\n', 'utf8');
  console.log(`\n  ✓ Env file written: ${CFG.envFile}`);
}

function patchSettingsJs() {
  if (!fs.existsSync(CFG.settingsJs)) {
    console.log(`  ⚠ settings.js not found at ${CFG.settingsJs} — skipping patch`);
    return;
  }
  let src = fs.readFileSync(CFG.settingsJs, 'utf8');
  if (src.includes(ENV_LOADER_MARKER)) {
    console.log('  ✓ settings.js already patched');
    return;
  }
  const loader = `
${ENV_LOADER_MARKER}
try {
  require('fs').readFileSync(${JSON.stringify(CFG.envFile)}, 'utf8')
    .split('\\n').filter(l => l.includes('=')).forEach(l => {
      const eq = l.indexOf('=');
      if (eq > 0) process.env[l.slice(0, eq).trim()] = l.slice(eq + 1).trim();
    });
} catch (e) {}
// [/OSI]
`;
  if (src.includes("'use strict'") || src.includes('"use strict"')) {
    src = src.replace(/(['"])use strict\1;?\s*\n/, (match) => match + loader);
  } else {
    src = loader + src;
  }
  fs.writeFileSync(CFG.settingsJs, src, 'utf8');
  console.log('  ✓ settings.js patched to load env file on startup');
}

function updateFlowsJson(sensorsAppId, actuatorsAppId, fieldTesterAppId) {
  if (!fs.existsSync(CFG.flowsJson)) {
    console.log(`  ⚠ flows.json not found at ${CFG.flowsJson} — skipping MQTT topic update`);
    return;
  }

  const flows = JSON.parse(fs.readFileSync(CFG.flowsJson, 'utf8'));
  let changes = 0;

  const kiwiMqtt = flows.find((node) => node.id === 'e73a11a2a36aab22');
  if (kiwiMqtt && !kiwiMqtt.topic.includes(sensorsAppId)) {
    kiwiMqtt.topic = `application/${sensorsAppId}/device/#`;
    console.log(`  ✓ Sensor_KIWI MQTT topic -> application/${sensorsAppId}/device/#`);
    changes++;
  }

  const lsn50Mqtt = flows.find((node) => node.id === 'lsn50-mqtt-in');
  if (lsn50Mqtt && !lsn50Mqtt.topic.includes(sensorsAppId)) {
    lsn50Mqtt.topic = `application/${sensorsAppId}/device/#`;
    console.log(`  ✓ Sensor_LSN50 MQTT topic -> application/${sensorsAppId}/device/#`);
    changes++;
  }

  const fieldMqtt = flows.find((node) => node.id === 'e382bbf0dde572b1');
  if (fieldMqtt && !fieldMqtt.topic.includes(fieldTesterAppId)) {
    fieldMqtt.topic = `application/${fieldTesterAppId}/#`;
    console.log(`  ✓ Field Tester MQTT topic -> application/${fieldTesterAppId}/#`);
    changes++;
  }

  const stregaFn = flows.find((node) => node.id === 'cdbaa3891d40d7a1');
  if (stregaFn && stregaFn.func && stregaFn.func.includes('FIXED_APP_ID')) {
    const oldLine = /const FIXED_APP_ID\s*=\s*"[^"]+";[^\n]*/;
    const newLine = `const FIXED_APP_ID = env.get('CHIRPSTACK_APP_ACTUATORS') || "${actuatorsAppId}"; // updated by chirpstack-bootstrap.js`;
    if (oldLine.test(stregaFn.func)) {
      stregaFn.func = stregaFn.func.replace(oldLine, newLine);
      console.log('  ✓ STREGA downlink FIXED_APP_ID -> env.get(CHIRPSTACK_APP_ACTUATORS)');
      changes++;
    }
  }

  if (changes > 0) {
    fs.writeFileSync(CFG.flowsJson, JSON.stringify(flows, null, 2), 'utf8');
    console.log(`  ✓ flows.json updated (${changes} change(s)) — restart Node-RED to apply`);
  } else {
    console.log('  ✓ flows.json already up to date');
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   OSI OS  —  ChirpStack Bootstrap            ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  ChirpStack gRPC URL : ${CFG.url}`);
  console.log(`  LoRaWAN region      : ${CFG.region}`);
  console.log(`  API key mode        : ${CFG.apiKey ? 'pre-created' : 'CLI create-api-key'}`);
  console.log(`  Env file            : ${CFG.envFile}\n`);

  console.log('[ 1/5 ] API key');
  let apiKey = CFG.apiKey;
  if (!apiKey) {
    apiKey = await createApiKeyViaCLI();
  } else {
    console.log('  ✓ Using pre-created API key');
  }

  const client = chirpstack.createClient({ apiUrl: CFG.url, apiKey });

  console.log('\n[ 2/5 ] Tenant');
  const tenantId = await getOrCreateTenant(client);

  console.log('\n[ 3/5 ] Applications');
  const sensorsAppId = await getOrCreateApp(client, tenantId, CFG.appSensorsName, 'KIWI soil sensors and Dragino LSN50 dendrometers');
  const actuatorsAppId = await getOrCreateApp(client, tenantId, CFG.appActuatorsName, 'STREGA smart irrigation valves');
  const fieldTesterAppId = await getOrCreateApp(client, tenantId, CFG.appFieldTesterName, 'RAK10701 field coverage testing');

  console.log('\n[ 4/5 ] Device profiles');
  const kiwiProfileId = await getOrCreateProfile(client, tenantId, CFG.profileKiwiName, 'Kiwi soil moisture & temperature (LoRaWAN 1.0.3 OTAA)');
  const stregaProfileId = await getOrCreateProfile(client, tenantId, CFG.profileStregaName, 'Strega smart irrigation valve (LoRaWAN 1.0.3 OTAA)');
  const lsn50ProfileId = await getOrCreateProfile(client, tenantId, CFG.profileLsn50Name, 'Dragino LSN50 temperature & dendrometer ADC (LoRaWAN 1.0.3 OTAA)');
  const rak10701ProfileId = await getOrCreateProfile(client, tenantId, CFG.profileRakName, 'RAK10701 LoRaWAN coverage field tester');

  let s2120CodecScript = '';
  try {
    s2120CodecScript = fs.readFileSync(CFG.s2120CodecPath, 'utf8');
    console.log(`  ✓ S2120 codec loaded from ${CFG.s2120CodecPath} (${s2120CodecScript.length} bytes)`);
  } catch (e) {
    console.log(`  ⚠ S2120 codec not found at ${CFG.s2120CodecPath} — creating profile without codec`);
  }
  const s2120ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileS2120Name, 'SenseCAP S2120 8-in-1 weather station (LoRaWAN 1.0.3 OTAA)', s2120CodecScript);

  console.log('\n[ 5/5 ] Writing configuration');
  const gatewayEui = detectGatewayEui();
  if (gatewayEui) {
    console.log(`  ✓ Gateway EUI detected: ${gatewayEui}`);
  } else {
    console.log('  ⚠ Gateway EUI not detected — set DEVICE_EUI manually in .chirpstack.env');
  }
  const envVars = {
    CHIRPSTACK_API_URL: CFG.url,
    CHIRPSTACK_API_KEY: apiKey,
    CHIRPSTACK_APP_SENSORS: sensorsAppId,
    CHIRPSTACK_APP_ACTUATORS: actuatorsAppId,
    CHIRPSTACK_APP_FIELD_TESTER: fieldTesterAppId,
    CHIRPSTACK_PROFILE_KIWI: kiwiProfileId,
    CHIRPSTACK_PROFILE_STREGA: stregaProfileId,
    CHIRPSTACK_PROFILE_LSN50: lsn50ProfileId,
    CHIRPSTACK_PROFILE_RAK10701: rak10701ProfileId,
    CHIRPSTACK_PROFILE_S2120: s2120ProfileId
  };
  if (gatewayEui) envVars.DEVICE_EUI = gatewayEui;
  writeEnvFile(envVars);

  patchSettingsJs();
  updateFlowsJson(sensorsAppId, actuatorsAppId, fieldTesterAppId);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Bootstrap complete                         ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('  Applications found / created:');
  console.log(`    ${CFG.appSensorsName.padEnd(20)} ${sensorsAppId}`);
  console.log(`    ${CFG.appActuatorsName.padEnd(20)} ${actuatorsAppId}`);
  console.log(`    ${CFG.appFieldTesterName.padEnd(20)} ${fieldTesterAppId}\n`);
  console.log('  Device profiles:');
  console.log(`    ${CFG.profileKiwiName.padEnd(24)} ${kiwiProfileId}`);
  console.log(`    ${CFG.profileStregaName.padEnd(24)} ${stregaProfileId}`);
  console.log(`    ${CFG.profileLsn50Name.padEnd(24)} ${lsn50ProfileId}`);
  console.log(`    ${CFG.profileRakName.padEnd(24)} ${rak10701ProfileId}`);
  console.log(`    ${CFG.profileS2120Name.padEnd(24)} ${s2120ProfileId}\n`);
  if (gatewayEui) {
    console.log(`  Gateway EUI (DEVICE_EUI): ${gatewayEui}\n`);
  } else {
    console.log('  ⚠ Gateway EUI: NOT DETECTED — add DEVICE_EUI=<eui> to .chirpstack.env manually\n');
  }
  console.log('  Next step:');
  console.log('  1. Restart Node-RED:  /etc/init.d/node-red restart');
  console.log('  2. Register devices via the OSI OS UI or OSI Server UI (type + DevEUI + AppKey from device label)\n');
}

main().catch((error) => {
  console.error('\nBootstrap failed:', error.message);
  process.exit(1);
});
