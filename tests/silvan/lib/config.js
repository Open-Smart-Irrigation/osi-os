'use strict';
// Target configuration + the hard safety guard for the Silvan test gateway.
//
// SAFETY CONTRACT (do not weaken):
//   * Exactly one gateway is ever addressed: the one whose DEVICE_EUI matches
//     EXPECTED_GATEWAY_EUI. assertSilvan() reads that EUI back from the live
//     gateway and refuses to run against anything else.
//   * FORBIDDEN_HOSTS is an explicit deny-list of production/other-customer
//     gateways that must never be touched by this harness.
//   * Every device this harness actuates must be a SIMULATED device it created
//     itself (assertSimulatedDevice). Real hardware is never commanded.

const DEFAULTS = {
  sshHost: process.env.SILVAN_SSH_HOST || '100.81.220.8',
  sshUser: process.env.SILVAN_SSH_USER || 'root',
  sshKey: process.env.SILVAN_SSH_KEY || (process.env.HOME + '/.ssh/id_ed25519'),
  apiBase: process.env.SILVAN_API_BASE || 'http://127.0.0.1:18800',
  guiBase: process.env.SILVAN_GUI_BASE || 'http://127.0.0.1:18800/gui/',
  mqttHost: process.env.SILVAN_MQTT_HOST || '127.0.0.1',
  mqttPort: Number(process.env.SILVAN_MQTT_PORT || 18830),
  dbPath: '/data/db/farming.db',
  secretPath: '/data/db/osi_auth_token_secret',
};

const EXPECTED_GATEWAY_EUI = '0016C001F11715E2';

// Hosts this harness must never address, whatever the environment says.
const FORBIDDEN_HOSTS = [
  '100.99.212.115',
  'osi-uganda-01.tail77bd41.ts.net',
  '100.69.51.98',
  'osicloud.ch',
  'server.opensmartirrigation.org',
  '57.129.7.196',
];

// Simulated DevEUIs only. Anything this harness commands must be in this range.
// 70B3D57ED00... is the harness's own reserved prefix; no real OSI device uses it.
const SIM_DEVEUI_PREFIX = '70B3D57ED00';

function config(overrides = {}) {
  const cfg = Object.assign({}, DEFAULTS, overrides);
  if (FORBIDDEN_HOSTS.includes(cfg.sshHost)) {
    throw new Error('REFUSING to run: ' + cfg.sshHost + ' is on the forbidden-host list.');
  }
  if (cfg.sshHost !== DEFAULTS.sshHost && !process.env.SILVAN_ALLOW_ALT_HOST) {
    throw new Error(
      'REFUSING to run against ' + cfg.sshHost + '. This harness targets the Silvan test ' +
      'gateway only. The EUI guard still applies even if you set SILVAN_ALLOW_ALT_HOST=1.'
    );
  }
  return cfg;
}

// PRE-FLIGHT GUARD (runs before anything else, over SSH, read-only):
// reads the gateway's own configured EUI and refuses to continue unless it is
// Silvan. This runs before any HTTP request, so a misconfigured tunnel pointing
// at another gateway is caught before a single mutation.
async function assertSilvanViaSsh(ssh) {
  const eui = String(await ssh.exec('uci get osi-server.cloud.device_eui')).trim().toUpperCase();
  if (eui !== EXPECTED_GATEWAY_EUI) {
    throw new Error(
      'EUI GUARD TRIPPED (ssh): ' + (ssh.host) + ' reports gateway EUI ' + (eui || '<empty>') +
      ' but this harness only runs against ' + EXPECTED_GATEWAY_EUI + ' (Silvan). Aborting.'
    );
  }
  return eui;
}

// SECOND GUARD, over the API: proves the HTTP tunnel terminates on the same
// gateway the SSH guard checked. A tunnel pointed at a different Node-RED than
// the SSH session would otherwise go unnoticed.
async function assertSilvanViaApi(rest) {
  const res = await rest.get('/api/sync/state');
  if (res.status !== 200) {
    throw new Error('EUI GUARD: GET /api/sync/state returned ' + res.status + '; refusing to run.');
  }
  const eui = String(
    (res.body && res.body.gatewayIdentity && res.body.gatewayIdentity.currentEui) || ''
  ).trim().toUpperCase();
  if (eui !== EXPECTED_GATEWAY_EUI) {
    throw new Error(
      'EUI GUARD TRIPPED (api): tunnel reports gateway EUI ' + (eui || '<empty>') +
      ' but this harness only runs against ' + EXPECTED_GATEWAY_EUI + ' (Silvan). Aborting.'
    );
  }
  return eui;
}

// A DevEUI this harness is allowed to actuate. Anything else is real hardware.
function assertSimulatedDevice(deveui) {
  const norm = String(deveui || '').trim().toUpperCase();
  if (!norm.startsWith(SIM_DEVEUI_PREFIX)) {
    throw new Error(
      'SAFETY: refusing to command ' + norm + ' -- only simulated devices with the ' +
      SIM_DEVEUI_PREFIX + ' prefix may be actuated by this harness.'
    );
  }
  return norm;
}

// Deterministic-per-run simulated DevEUI, e.g. simDeveui('V1', 1).
// Must be valid 16-char hex: ChirpStack provisioning rejects anything else.
function simDeveui(caseId, index = 1) {
  const digest = require('node:crypto').createHash('sha256').update(String(caseId)).digest('hex');
  const eui = (SIM_DEVEUI_PREFIX + digest.slice(0, 3) + index.toString(16).padStart(2, '0'))
    .slice(0, 16)
    .toUpperCase();
  return assertSimulatedDevice(eui);
}

module.exports = {
  config,
  assertSilvanViaSsh,
  assertSilvanViaApi,
  assertSimulatedDevice,
  simDeveui,
  EXPECTED_GATEWAY_EUI,
  FORBIDDEN_HOSTS,
  SIM_DEVEUI_PREFIX,
  DEFAULTS,
};
