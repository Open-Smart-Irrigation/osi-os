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
 *   CS_URL             ChirpStack API base URL      (default: http://localhost:8080)
 *   CS_ADMIN_EMAIL     Admin login email             (default: admin@chirpstack.io)
 *   CS_ADMIN_PASSWORD  Admin login password          (default: admin)
 *   CS_REGION          LoRaWAN region                (default: EU868)
 *                        EU868 | US915 | AU915 | AS923 | IN865 | KR920 | RU864
 *   ENV_FILE           Env file path                 (default: /srv/node-red/.chirpstack.env)
 *   SETTINGS_JS        Node-RED settings.js path     (default: /srv/node-red/settings.js)
 *   FLOWS_JSON         Node-RED flows.json path      (default: /srv/node-red/flows.json)
 */

'use strict';
const fs   = require('fs');
const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────

const CFG = {
  url:           process.env.CS_URL             || 'http://localhost:8080',
  adminEmail:    process.env.CS_ADMIN_EMAIL     || 'admin@chirpstack.io',
  adminPassword: process.env.CS_ADMIN_PASSWORD  || 'admin',
  region:        process.env.CS_REGION          || 'EU868',
  envFile:       process.env.ENV_FILE           || '/srv/node-red/.chirpstack.env',
  settingsJs:    process.env.SETTINGS_JS        || '/srv/node-red/settings.js',
  flowsJson:     process.env.FLOWS_JSON         || '/srv/node-red/flows.json',
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u    = new URL(path, CFG.url);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port:     u.port || 8080,
      path:     u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Grpc-Metadata-Authorization': `Bearer ${token}` } : {}),
        ...(data  ? { 'Content-Length': Buffer.byteLength(data) }         : {}),
      },
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = raw ? JSON.parse(raw) : {};
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} ${method} ${path}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`JSON parse error on ${method} ${path}: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const get  = (path, token)       => request('GET',  path, null,  token);
const post = (path, body, token) => request('POST', path, body,  token);

// ─── ChirpStack API functions ─────────────────────────────────────────────────

async function login() {
  console.log(`  Logging in as ${CFG.adminEmail} …`);
  const res = await post('/api/internal/login', {
    email:    CFG.adminEmail,
    password: CFG.adminPassword,
  });
  if (!res.jwt) throw new Error('Login failed — no JWT in response. Check admin credentials.');
  console.log('  ✓ Authenticated');
  return res.jwt;
}

async function getTenantId(jwt) {
  const res = await get('/api/tenants?limit=10', jwt);
  const tenants = res.result || [];
  if (!tenants.length) throw new Error('No tenants found in ChirpStack');
  console.log(`  ✓ Tenant: "${tenants[0].name}" (${tenants[0].id})`);
  return tenants[0].id;
}

async function getOrCreateApp(jwt, tenantId, name, description) {
  const list = await get(`/api/applications?tenantId=${tenantId}&limit=100`, jwt);
  const existing = (list.result || []).find(a => a.name === name);
  if (existing) {
    console.log(`  ✓ App exists:  "${name}" (${existing.id})`);
    return existing.id;
  }
  const res = await post('/api/applications', {
    application: { name, description, tenantId },
  }, jwt);
  console.log(`  + App created: "${name}" (${res.id})`);
  return res.id;
}

async function getOrCreateProfile(jwt, tenantId, name, description) {
  const list = await get(`/api/device-profiles?tenantId=${tenantId}&limit=100`, jwt);
  const existing = (list.result || []).find(p => p.name === name);
  if (existing) {
    console.log(`  ✓ Profile exists:  "${name}" (${existing.id})`);
    return existing.id;
  }
  const res = await post('/api/device-profiles', {
    deviceProfile: {
      tenantId,
      name,
      description,
      region:              CFG.region,
      macVersion:          'LORAWAN_1_0_3',
      regParamsRevision:   'RP002_1_0_3',
      adrAlgorithmId:      'default',
      supportsOtaa:        true,
      uplinkInterval:      3600,          // expected uplink interval (informational)
      deviceStatusReqInterval: 1,
      flushQueueOnActivate: true,
      abpRx1Delay:          0,
      abpRx1DrOffset:       0,
      abpRx2Dr:             0,
      abpRx2Freq:           0,
    },
  }, jwt);
  console.log(`  + Profile created: "${name}" (${res.id})`);
  return res.id;
}

async function createApiKey(jwt, tenantId) {
  // Always create a fresh key — idempotency handled by unique name timestamp
  const name = 'osi-nodered';
  console.log(`  + Creating API key "${name}" …`);
  const res = await post('/api/keys', {
    apiKey: { name, tenantId },
  }, jwt);
  if (!res.token) throw new Error('API key creation returned no token');
  console.log(`  ✓ API key created (id: ${res.id})`);
  return res.token;
}

// ─── File patching functions ──────────────────────────────────────────────────

const ENV_LOADER_MARKER = '// [OSI] chirpstack env loader';

function writeEnvFile(vars) {
  const lines = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
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
  // Insert after the first 'use strict' or at the very top
  if (src.includes("'use strict'") || src.includes('"use strict"')) {
    src = src.replace(/(['"])use strict\1;?\s*\n/, match => match + loader);
  } else {
    src = loader + src;
  }
  fs.writeFileSync(CFG.settingsJs, src, 'utf8');
  console.log(`  ✓ settings.js patched to load env file on startup`);
}

function updateFlowsJson(sensorsAppId, actuatorsAppId, fieldTesterAppId) {
  if (!fs.existsSync(CFG.flowsJson)) {
    console.log(`  ⚠ flows.json not found at ${CFG.flowsJson} — skipping MQTT topic update`);
    return;
  }

  const flows = JSON.parse(fs.readFileSync(CFG.flowsJson, 'utf8'));
  let changes = 0;

  // Update MQTT in node: Sensor_KIWI tab → new sensors app
  const kiwiMqtt = flows.find(n => n.id === 'e73a11a2a36aab22');
  if (kiwiMqtt && !kiwiMqtt.topic.includes(sensorsAppId)) {
    kiwiMqtt.topic = `application/${sensorsAppId}/device/#`;
    console.log(`  ✓ Sensor_KIWI MQTT topic → application/${sensorsAppId}/device/#`);
    changes++;
  }

  // Update MQTT in node: Sensor_LSN50 tab → same sensors app
  const lsn50Mqtt = flows.find(n => n.id === 'lsn50-mqtt-in');
  if (lsn50Mqtt && !lsn50Mqtt.topic.includes(sensorsAppId)) {
    lsn50Mqtt.topic = `application/${sensorsAppId}/device/#`;
    console.log(`  ✓ Sensor_LSN50 MQTT topic → application/${sensorsAppId}/device/#`);
    changes++;
  }

  // Update MQTT in node: Field testing tab → new field tester app
  const fieldMqtt = flows.find(n => n.id === 'e382bbf0dde572b1');
  if (fieldMqtt && !fieldMqtt.topic.includes(fieldTesterAppId)) {
    fieldMqtt.topic = `application/${fieldTesterAppId}/#`;
    console.log(`  ✓ Field Tester MQTT topic → application/${fieldTesterAppId}/#`);
    changes++;
  }

  // Update Actuator_STREGA downlink: replace hardcoded FIXED_APP_ID with env.get()
  const stregaFn = flows.find(n => n.id === 'cdbaa3891d40d7a1');
  if (stregaFn && stregaFn.func && stregaFn.func.includes('FIXED_APP_ID')) {
    const oldLine = /const FIXED_APP_ID\s*=\s*"[^"]+";[^\n]*/;
    const newLine = `const FIXED_APP_ID = env.get('CHIRPSTACK_APP_ACTUATORS') || "${actuatorsAppId}"; // updated by chirpstack-bootstrap.js`;
    if (oldLine.test(stregaFn.func)) {
      stregaFn.func = stregaFn.func.replace(oldLine, newLine);
      console.log('  ✓ STREGA downlink FIXED_APP_ID → env.get(CHIRPSTACK_APP_ACTUATORS)');
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   OSI OS  —  ChirpStack Bootstrap            ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  ChirpStack URL : ${CFG.url}`);
  console.log(`  LoRaWAN region : ${CFG.region}`);
  console.log(`  Admin email    : ${CFG.adminEmail}`);
  console.log(`  Env file       : ${CFG.envFile}\n`);

  // ── Step 1: Authenticate ──────────────────────────────────────────────────
  console.log('[ 1/5 ] Authentication');
  const jwt = await login();
  const tenantId = await getTenantId(jwt);

  // ── Step 2: Applications ──────────────────────────────────────────────────
  console.log('\n[ 2/5 ] Applications');
  const sensorsAppId     = await getOrCreateApp(jwt, tenantId, 'OSI Sensors',      'KIWI soil sensors and Dragino LSN50 dendrometers');
  const actuatorsAppId   = await getOrCreateApp(jwt, tenantId, 'OSI Actuators',    'STREGA smart irrigation valves');
  const fieldTesterAppId = await getOrCreateApp(jwt, tenantId, 'OSI Field Tester', 'RAK10701 field coverage testing');

  // ── Step 3: Device profiles ───────────────────────────────────────────────
  console.log('\n[ 3/5 ] Device profiles');
  const kiwiProfileId      = await getOrCreateProfile(jwt, tenantId, 'OSI KIWI Sensor',      'Kiwi soil moisture & temperature (LoRaWAN 1.0.3 OTAA)');
  const stregaProfileId    = await getOrCreateProfile(jwt, tenantId, 'OSI STREGA Valve',      'Strega smart irrigation valve (LoRaWAN 1.0.3 OTAA)');
  const lsn50ProfileId     = await getOrCreateProfile(jwt, tenantId, 'OSI Dragino LSN50',     'Dragino LSN50 temperature & dendrometer ADC (LoRaWAN 1.0.3 OTAA)');
  const rak10701ProfileId  = await getOrCreateProfile(jwt, tenantId, 'OSI RAK Field Tester',  'RAK10701 LoRaWAN coverage field tester');

  // ── Step 4: API key ───────────────────────────────────────────────────────
  console.log('\n[ 4/5 ] API key');
  const apiKey = await createApiKey(jwt, tenantId);

  // ── Step 5: Write outputs ─────────────────────────────────────────────────
  console.log('\n[ 5/5 ] Writing configuration');

  writeEnvFile({
    CHIRPSTACK_API_URL:          CFG.url,
    CHIRPSTACK_API_KEY:          apiKey,
    CHIRPSTACK_APP_SENSORS:      sensorsAppId,
    CHIRPSTACK_APP_ACTUATORS:    actuatorsAppId,
    CHIRPSTACK_APP_FIELD_TESTER: fieldTesterAppId,
    CHIRPSTACK_PROFILE_KIWI:     kiwiProfileId,
    CHIRPSTACK_PROFILE_STREGA:   stregaProfileId,
    CHIRPSTACK_PROFILE_LSN50:    lsn50ProfileId,
    CHIRPSTACK_PROFILE_RAK10701: rak10701ProfileId,
    // AppKeys (fixed per device type — printed on device label)
    // Set these BEFORE registering devices, or re-run with correct values:
    // CHIRPSTACK_APPKEY_KIWI=<32-hex-chars>
    // CHIRPSTACK_APPKEY_STREGA=<32-hex-chars>
    // CHIRPSTACK_APPKEY_LSN50=<32-hex-chars>
  });

  patchSettingsJs();
  updateFlowsJson(sensorsAppId, actuatorsAppId, fieldTesterAppId);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Bootstrap complete                         ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('  Applications created / found:');
  console.log(`    OSI Sensors      ${sensorsAppId}`);
  console.log(`    OSI Actuators    ${actuatorsAppId}`);
  console.log(`    OSI Field Tester ${fieldTesterAppId}\n`);
  console.log('  Device profiles:');
  console.log(`    KIWI_SENSOR      ${kiwiProfileId}`);
  console.log(`    STREGA_VALVE     ${stregaProfileId}`);
  console.log(`    DRAGINO_LSN50    ${lsn50ProfileId}`);
  console.log(`    RAK10701         ${rak10701ProfileId}\n`);
  console.log('  Next steps:');
  console.log(`  1. Add AppKeys to ${CFG.envFile}:`);
  console.log('       CHIRPSTACK_APPKEY_KIWI=<32-hex>    (from device label)');
  console.log('       CHIRPSTACK_APPKEY_STREGA=<32-hex>  (from device label)');
  console.log('       CHIRPSTACK_APPKEY_LSN50=<32-hex>   (from device label)');
  console.log('  2. Restart Node-RED:  /etc/init.d/node-red restart\n');
}

main().catch(err => {
  console.error('\n✗ Bootstrap failed:', err.message);
  process.exit(1);
});
