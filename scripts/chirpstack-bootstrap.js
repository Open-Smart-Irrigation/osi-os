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
 *   • UCI osi-server.cloud.*             — canonical runtime ChirpStack config
 *   • /srv/node-red/.chirpstack.env      — compatibility fallback for older installs
 *
 * Bootstrap validates flows.json portability but does not mutate flow behavior.
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
 *   STREGA_CODEC_PATH        (default: "/srv/node-red/codecs/strega_gen1_decoder.js")
 *   LSN50_CODEC_PATH         (default: "/srv/node-red/codecs/dragino_lsn50_decoder.js")
 *   S2120_CODEC_PATH         (default: "/srv/node-red/codecs/sensecap_s2120_decoder.js")
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

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
  stregaCodecPath: process.env.STREGA_CODEC_PATH || '/srv/node-red/codecs/strega_gen1_decoder.js',
  lsn50CodecPath: process.env.LSN50_CODEC_PATH || '/srv/node-red/codecs/dragino_lsn50_decoder.js',
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

function normalizeCodecScript(payloadCodecScript) {
  return String(payloadCodecScript || '').replace(/\r\n/g, '\n').trim();
}

function readCodecScript(codecPath, label) {
  try {
    const payloadCodecScript = fs.readFileSync(codecPath, 'utf8');
    console.log(`  ✓ ${label} codec loaded from ${codecPath} (${payloadCodecScript.length} bytes)`);
    return payloadCodecScript;
  } catch (e) {
    console.log(`  ⚠ ${label} codec not found at ${codecPath} — creating profile without codec`);
    return '';
  }
}

async function getOrCreateProfileWithCodec(client, tenantId, name, description, payloadCodecScript, options = {}) {
  const desiredCodecScript = normalizeCodecScript(payloadCodecScript);
  const autoDetectMeasurements = options.autoDetectMeasurements !== undefined
    ? Boolean(options.autoDetectMeasurements)
    : desiredCodecScript.length > 0;
  const profiles = listItemsToObjects(await client.listDeviceProfiles(tenantId));
  const existing = profiles.find((profile) => profile.name === name);
  if (existing) {
    if (desiredCodecScript) {
      const existingProfile = await client.getDeviceProfile(existing.id);
      const existingCodecRuntime = existingProfile && typeof existingProfile.getPayloadCodecRuntime === 'function'
        ? Number(existingProfile.getPayloadCodecRuntime())
        : null;
      const existingCodecScript = existingProfile && typeof existingProfile.getPayloadCodecScript === 'function'
        ? normalizeCodecScript(existingProfile.getPayloadCodecScript())
        : '';
      const existingAutoDetect = existingProfile && typeof existingProfile.getAutoDetectMeasurements === 'function'
        ? Boolean(existingProfile.getAutoDetectMeasurements())
        : false;
      const needsCodecRepair = existingCodecRuntime !== 2
        || existingCodecScript !== desiredCodecScript
        || existingAutoDetect !== autoDetectMeasurements;

      if (needsCodecRepair) {
        await client.updateDeviceProfile({
          id: existing.id,
          tenantId,
          name,
          description,
          region: CFG.region,
          uplinkInterval: 3600,
          deviceStatusReqInterval: 1,
          autoDetectMeasurements,
          payloadCodecScript: desiredCodecScript
        });
        console.log(`  ~ Profile updated: "${name}" (${existing.id})`);
        return existing.id;
      }
    }
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
    autoDetectMeasurements,
    payloadCodecScript: desiredCodecScript || undefined
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

function readGatewayIdentityViaHelper() {
  try {
    const helper = '/usr/libexec/osi-gateway-identity.sh';
    if (!fs.existsSync(helper)) return null;
    const output = execSync(`${helper} resolve`, { timeout: 5000 }).toString('utf8');
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const values = Object.fromEntries(lines.map((line) => {
      const idx = line.indexOf('=');
      return idx > 0 ? [line.slice(0, idx), line.slice(idx + 1)] : [line, ''];
    }));
    const deviceEui = normalizeGatewayEui(values.DEVICE_EUI);
    if (!deviceEui) return null;
    return {
      deviceEui,
      source: String(values.DEVICE_EUI_SOURCE || '').trim() || 'persisted',
      confidence: String(values.DEVICE_EUI_CONFIDENCE || '').trim() || 'provisional',
      lastVerifiedAt: String(values.DEVICE_EUI_LAST_VERIFIED_AT || '').trim() || null,
    };
  } catch (_) {
    return null;
  }
}

function detectGatewayEui() {
  const identity = readGatewayIdentityViaHelper();
  return identity ? identity.deviceEui : null;
}

function writeEnvFile(vars) {
  const lines = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.writeFileSync(CFG.envFile, lines + '\n', 'utf8');
  console.log(`\n  ✓ Env file written: ${CFG.envFile}`);
}

function toUciCloudKey(envKey) {
  const mapping = {
    CHIRPSTACK_APP_SENSORS: 'chirpstack_app_sensors',
    CHIRPSTACK_APP_ACTUATORS: 'chirpstack_app_actuators',
    CHIRPSTACK_APP_FIELD_TESTER: 'chirpstack_app_field_tester',
    CHIRPSTACK_PROFILE_KIWI: 'chirpstack_profile_kiwi',
    CHIRPSTACK_PROFILE_STREGA: 'chirpstack_profile_strega',
    CHIRPSTACK_PROFILE_LSN50: 'chirpstack_profile_lsn50',
    CHIRPSTACK_PROFILE_CLOVER: 'chirpstack_profile_clover',
    CHIRPSTACK_PROFILE_RAK10701: 'chirpstack_profile_rak10701',
    CHIRPSTACK_PROFILE_S2120: 'chirpstack_profile_s2120'
  };
  return mapping[envKey] || null;
}

function assertValidUciValue(envKey, value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (envKey.startsWith('CHIRPSTACK_APP_') || envKey.startsWith('CHIRPSTACK_PROFILE_')) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
      throw new Error(`${envKey} is not a valid ChirpStack UUID: ${text}`);
    }
  }
  return true;
}

function writeUciConfig(envVars) {
  const commands = [];
  for (const [envKey, value] of Object.entries(envVars)) {
    const uciKey = toUciCloudKey(envKey);
    if (!uciKey || !assertValidUciValue(envKey, value)) continue;
    commands.push(['set', `osi-server.cloud.${uciKey}=${String(value).trim()}`]);
  }
  if (!commands.length) return;
  try {
    for (const args of commands) {
      execFileSync('uci', args, { stdio: 'inherit' });
    }
    execFileSync('uci', ['commit', 'osi-server'], { stdio: 'inherit' });
    for (const [envKey, value] of Object.entries(envVars)) {
      const uciKey = toUciCloudKey(envKey);
      if (!uciKey || !String(value || '').trim()) continue;
      const actual = execFileSync('uci', ['-q', 'get', `osi-server.cloud.${uciKey}`], { encoding: 'utf8' }).trim();
      if (actual !== String(value).trim()) {
        throw new Error(`UCI readback mismatch for ${uciKey}`);
      }
    }
    console.log('  ✓ UCI ChirpStack config committed: osi-server.cloud');
  } catch (error) {
    throw new Error(`Unable to persist ChirpStack UCI config: ${error.message}`);
  }
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
  const protectedKeys = new Set([
    'DEVICE_EUI',
    'DEVICE_EUI_SOURCE',
    'DEVICE_EUI_CONFIDENCE',
    'DEVICE_EUI_LAST_VERIFIED_AT',
    'LINK_GATEWAY_DEVICE_EUI'
  ]);
  require('fs').readFileSync(${JSON.stringify(CFG.envFile)}, 'utf8')
    .split('\\n').filter(l => l.includes('=')).forEach(l => {
      const eq = l.indexOf('=');
      if (eq <= 0) return;
      const key = l.slice(0, eq).trim();
      if (!key) return;
      if (protectedKeys.has(key) && String(process.env[key] || '').trim()) return;
      process.env[key] = l.slice(eq + 1).trim();
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

function validatePortableFlows() {
  if (!fs.existsSync(CFG.flowsJson)) {
    console.log('  ✓ flows.json not present; skipping portable flow validation');
    return;
  }

  const flows = JSON.parse(fs.readFileSync(CFG.flowsJson, 'utf8'));
  const badTopics = flows
    .filter((node) => node.type === 'mqtt in' && node.topic !== 'application/+/device/+/event/up')
    .map((node) => `${node.name || node.id}: ${node.topic}`);
  const hardcodedDownlinks = flows
    .filter((node) => typeof node.func === 'string' && node.func.includes('FIXED_APP_ID'))
    .map((node) => node.name || node.id);
  if (badTopics.length || hardcodedDownlinks.length) {
    console.log([
      '  ⚠ flows.json uses the legacy mutation pattern and is not portable.',
      ...badTopics.map((entry) => `bad mqtt topic: ${entry}`),
      ...hardcodedDownlinks.map((entry) => `hardcoded downlink app id: ${entry}`),
      '  ⚠ Bootstrap will not repair or mutate flows.json. Deploy the portable repo flow before relying on runtime env configuration.'
    ].join('\n'));
    if (process.env.OSI_BOOTSTRAP_REQUIRE_PORTABLE_FLOW === '1') {
      throw new Error('flows.json is not portable');
    }
    return;
  }
  console.log('  ✓ flows.json portable communication contract verified');
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
  const stregaCodecScript = readCodecScript(CFG.stregaCodecPath, 'STREGA');
  const stregaProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileStregaName, 'Strega smart irrigation valve (LoRaWAN 1.0.3 OTAA)', stregaCodecScript);
  const lsn50CodecScript = readCodecScript(CFG.lsn50CodecPath, 'LSN50');
  const lsn50ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileLsn50Name, 'Dragino LSN50 temperature & dendrometer ADC (LoRaWAN 1.0.3 OTAA)', lsn50CodecScript);
  const rak10701ProfileId = await getOrCreateProfile(client, tenantId, CFG.profileRakName, 'RAK10701 LoRaWAN coverage field tester');
  const s2120CodecScript = readCodecScript(CFG.s2120CodecPath, 'S2120');
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
    // CLOVER is a compatibility alias for the RAK10701 field tester profile.
    // Both keys intentionally point to the same ChirpStack device profile ID.
    CHIRPSTACK_PROFILE_CLOVER: rak10701ProfileId,
    CHIRPSTACK_PROFILE_RAK10701: rak10701ProfileId,
    CHIRPSTACK_PROFILE_S2120: s2120ProfileId
  };
  writeEnvFile(envVars);
  writeUciConfig(envVars);

  if (process.env.OSI_BOOTSTRAP_PATCH_SETTINGS === '1') {
    patchSettingsJs();
  }
  validatePortableFlows();

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
