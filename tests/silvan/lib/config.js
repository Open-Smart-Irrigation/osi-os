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
//   * Every network endpoint -- SSH host, HTTP API, GUI, MQTT broker -- is
//     cross-validated against each other and against FORBIDDEN_HOSTS before any
//     client is built. SILVAN_ALLOW_ALT_HOST relaxes WHICH gateway may be
//     targeted; it never relaxes the deny-list or the endpoint-consistency rule.

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

// The only non-gateway hosts an endpoint may name: the local end of the SSH
// tunnel. Anything else must be the SSH-verified gateway itself.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

// Simulated DevEUIs only. Anything this harness commands must be in this range.
// 70B3D57ED00... is the harness's own reserved prefix; no real OSI device uses it.
const SIM_DEVEUI_PREFIX = '70B3D57ED00';

// Extracts a comparable hostname from either a URL ("http://127.0.0.1:18800/gui/")
// or a bare host ("100.81.220.8"). IPv6 brackets are stripped so "[::1]" and
// "::1" compare equal.
function hostOf(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch (_) {
      throw new Error('REFUSING to run: "' + raw + '" is not a parseable URL.');
    }
  }
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function isLoopback(host) {
  return LOOPBACK_HOSTS.has(String(host || '').toLowerCase());
}

// Set on a cfg that cleared assertEndpointsAllowed(). A Symbol, so it cannot be
// produced by a hand-written object literal and never leaks into JSON evidence.
const ENDPOINT_GUARD_PASSED = Symbol('osi.silvan.endpointGuardPassed');

// THE ENDPOINT GUARD. Every host this harness will ever open a socket to is
// checked here, before any client exists.
//
// Order matters and is part of the contract:
//   1. The deny-list is applied to EVERY endpoint, unconditionally. It is
//      consulted before SILVAN_ALLOW_ALT_HOST is even read, so that escape
//      hatch can never be used to reach a production gateway or the cloud.
//   2. Every non-SSH endpoint must be either a loopback tunnel address or
//      exactly the SSH host the EUI guard will verify. This closes the gap
//      where SSH points at Silvan (so both EUI guards pass) while the HTTP or
//      MQTT client is quietly aimed somewhere else.
//   3. Only then is SILVAN_ALLOW_ALT_HOST consulted, and only for which
//      gateway may be named.
function assertEndpointsAllowed(cfg) {
  const forbidden = new Set(FORBIDDEN_HOSTS.map((h) => h.toLowerCase()));
  const sshHost = hostOf(cfg.sshHost);
  if (!sshHost) throw new Error('REFUSING to run: no SSH host configured.');

  const endpoints = [
    { label: 'SSH host (SILVAN_SSH_HOST)', value: cfg.sshHost, host: sshHost },
    { label: 'HTTP API (SILVAN_API_BASE)', value: cfg.apiBase, host: hostOf(cfg.apiBase) },
    { label: 'GUI (SILVAN_GUI_BASE)', value: cfg.guiBase, host: hostOf(cfg.guiBase) },
    { label: 'MQTT broker (SILVAN_MQTT_HOST)', value: cfg.mqttHost, host: hostOf(cfg.mqttHost) },
  ];

  // 1. Deny-list, unconditional, every endpoint, by IP and by name.
  for (const ep of endpoints) {
    if (!ep.host) {
      throw new Error('REFUSING to run: ' + ep.label + ' is empty; every endpoint must be explicit.');
    }
    if (forbidden.has(ep.host)) {
      throw new Error(
        'REFUSING to run: ' + ep.label + ' resolves to "' + ep.host + '", which is on the ' +
        'forbidden-host list. SILVAN_ALLOW_ALT_HOST does not override this.'
      );
    }
  }

  // 2. Endpoint consistency: loopback tunnel, or the very host SSH will verify.
  for (const ep of endpoints) {
    if (ep.label.startsWith('SSH host')) continue;
    if (isLoopback(ep.host) || ep.host === sshHost) continue;
    throw new Error(
      'REFUSING to run: ' + ep.label + ' points at "' + ep.host + '", which is neither a loopback ' +
      'tunnel endpoint (' + [...LOOPBACK_HOSTS].join(', ') + ') nor the SSH host "' + sshHost + '" ' +
      'that the EUI guards verify. Every endpoint must terminate on the same gateway.'
    );
  }

  // MQTT port: a real port, or the observer would connect somewhere unintended.
  const port = Number(cfg.mqttPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('REFUSING to run: SILVAN_MQTT_PORT "' + cfg.mqttPort + '" is not a valid TCP port.');
  }

  // 3. Only now: which gateway may be named at all.
  if (sshHost !== hostOf(DEFAULTS.sshHost) && !process.env.SILVAN_ALLOW_ALT_HOST) {
    throw new Error(
      'REFUSING to run against ' + cfg.sshHost + '. This harness targets the Silvan test ' +
      'gateway only. The EUI guard still applies even if you set SILVAN_ALLOW_ALT_HOST=1.'
    );
  }

  cfg[ENDPOINT_GUARD_PASSED] = true;
  return cfg;
}

// Throws unless `cfg` came from config() and cleared the endpoint guard. Any
// client that opens a socket calls this first, so a hand-rolled config object
// cannot be used to slip past the checks above.
function assertEndpointGuardPassed(cfg, who) {
  if (!cfg || cfg[ENDPOINT_GUARD_PASSED] !== true) {
    throw new Error(
      'REFUSING to start ' + (who || 'a network client') + ': its configuration did not pass ' +
      'assertEndpointsAllowed(). Build it from config() rather than a plain object.'
    );
  }
  return cfg;
}

function config(overrides = {}) {
  const cfg = Object.assign({}, DEFAULTS, overrides);
  return assertEndpointsAllowed(cfg);
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
  assertEndpointsAllowed,
  assertEndpointGuardPassed,
  hostOf,
  isLoopback,
  ENDPOINT_GUARD_PASSED,
  LOOPBACK_HOSTS,
  assertSilvanViaSsh,
  assertSilvanViaApi,
  assertSimulatedDevice,
  simDeveui,
  EXPECTED_GATEWAY_EUI,
  FORBIDDEN_HOSTS,
  SIM_DEVEUI_PREFIX,
  DEFAULTS,
};
