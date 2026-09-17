'use strict';
// Target configuration + the hard safety guard for the OSI test gateways.
//
// SAFETY CONTRACT (do not weaken):
//   * Only a gateway that appears in GATEWAYS -- the explicit allow-list below
//     -- is ever addressed. It is chosen BY NAME (`--gateway <name>` /
//     SILVAN_GATEWAY, default 'silvan'); there is no free-form host override.
//     An SSH host that is not the selected entry's host is refused, with or
//     without SILVAN_ALLOW_ALT_HOST.
//   * Exactly one gateway is ever addressed: the one whose DEVICE_EUI matches
//     the SELECTED entry's expectedEui. assertGatewayViaSsh/ViaApi read that
//     EUI back from the live gateway and refuse to run against anything else.
//     Both resolve the expected EUI from the allow-list, so a tampered
//     cfg.expectedEui cannot lower the bar.
//   * FORBIDDEN_HOSTS is an explicit deny-list of production/other-customer
//     gateways that must never be touched by this harness.
//   * Every device this harness actuates must be a SIMULATED device it created
//     itself (assertSimulatedDevice). Real hardware is never commanded.
//   * Every network endpoint -- SSH host, HTTP API, GUI, MQTT broker -- is
//     cross-validated against each other and against FORBIDDEN_HOSTS before any
//     client is built.

// THE GATEWAY ALLOW-LIST. Adding a gateway is a deliberate, reviewed code
// change: a name, the host, the DEVICE_EUI both guards will demand, and the
// credentials file that belongs to it. Nothing at runtime can add an entry.
const GATEWAYS = [
  Object.freeze({
    name: 'silvan',
    description: 'Silvan test gateway (Pi 5, demo hardware, no valves)',
    sshHost: '100.81.220.8',
    expectedEui: '0016C001F11715E2',
    credsFile: '~/osi-tools/.silvan-test-creds',
  }),
  Object.freeze({
    name: 'rpi4-test',
    description: 'Raspberry Pi 4B test gateway (bcm2709 profile)',
    sshHost: '100.85.226.64',
    expectedEui: '0016C001F11369DE',
    credsFile: '~/osi-tools/.rpi4-test-creds',
  }),
];

const DEFAULT_GATEWAY = 'silvan';

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

// The allow-list and the deny-list must never overlap, and two entries must
// never share a name, a host or an EUI (a duplicate would make `--gateway`
// ambiguous, and a shared EUI would let one gateway's guard pass for another).
// Checked at load, so a bad edit to GATEWAYS fails immediately and loudly.
(function assertAllowListIsSane() {
  const forbidden = new Set(FORBIDDEN_HOSTS.map((h) => h.toLowerCase()));
  const names = new Set(); const hosts = new Set(); const euis = new Set();
  for (const g of GATEWAYS) {
    const host = String(g.sshHost || '').toLowerCase();
    if (!g.name || !host || !g.credsFile) {
      throw new Error('REFUSING to load: allow-list entry "' + g.name + '" needs a name, an sshHost and a credsFile.');
    }
    if (!/^[0-9A-F]{16}$/.test(String(g.expectedEui || ''))) {
      throw new Error('REFUSING to load: allow-listed gateway "' + g.name + '" has no 16-hex uppercase EUI.');
    }
    if (forbidden.has(host)) {
      throw new Error('REFUSING to load: allow-listed gateway "' + g.name + '" points at ' + g.sshHost +
        ', which is on FORBIDDEN_HOSTS. The deny-list wins; remove the allow-list entry.');
    }
    if (names.has(g.name) || hosts.has(host) || euis.has(g.expectedEui)) {
      throw new Error('REFUSING to load: duplicate allow-list entry around "' + g.name + '".');
    }
    names.add(g.name); hosts.add(host); euis.add(g.expectedEui);
  }
})();

// Resolves a gateway NAME (never a host) to its allow-list entry. An unknown
// name is refused: that is the only way to point this harness somewhere new.
function resolveGateway(name) {
  const raw = (name === undefined || name === null || name === '') ? DEFAULT_GATEWAY : String(name);
  const wanted = raw.trim().toLowerCase();
  const entry = GATEWAYS.find((g) => g.name === wanted);
  if (!entry) {
    throw new Error(
      'REFUSING to run: "' + raw + '" is not an allow-listed test gateway. Known gateways: ' +
      GATEWAYS.map((g) => g.name).join(', ') + '. --gateway/SILVAN_GATEWAY takes a NAME, not a host; ' +
      'to target a new gateway, add it to GATEWAYS in tests/silvan/lib/config.js with its DEVICE_EUI.'
    );
  }
  return entry;
}

// The default configuration for one allow-listed gateway. The tunnel-side
// defaults (loopback ports 18800/18830) are the same for every gateway; only
// the host, the expected EUI and the credentials file follow the selection.
function defaultsFor(entry) {
  return {
    gateway: entry.name,
    expectedEui: entry.expectedEui,
    credsFile: entry.credsFile,
    sshHost: process.env.SILVAN_SSH_HOST || entry.sshHost,
    sshUser: process.env.SILVAN_SSH_USER || 'root',
    sshKey: process.env.SILVAN_SSH_KEY || (process.env.HOME + '/.ssh/id_ed25519'),
    apiBase: process.env.SILVAN_API_BASE || 'http://127.0.0.1:18800',
    guiBase: process.env.SILVAN_GUI_BASE || 'http://127.0.0.1:18800/gui/',
    mqttHost: process.env.SILVAN_MQTT_HOST || '127.0.0.1',
    mqttPort: Number(process.env.SILVAN_MQTT_PORT || 18830),
    dbPath: '/data/db/farming.db',
    secretPath: '/data/db/osi_auth_token_secret',
  };
}

const DEFAULTS = defaultsFor(resolveGateway(DEFAULT_GATEWAY));

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
//      consulted before the gateway selection or SILVAN_ALLOW_ALT_HOST are even
//      read, so nothing can be used to reach a production gateway or the cloud.
//   2. Every non-SSH endpoint must be either a loopback tunnel address or
//      exactly the SSH host the EUI guard will verify. This closes the gap
//      where SSH points at the test gateway (so both EUI guards pass) while the
//      HTTP or MQTT client is quietly aimed somewhere else.
//   3. Only then is the gateway selection consulted, and the SSH host must be
//      exactly the selected allow-list entry's host. SILVAN_ALLOW_ALT_HOST
//      grants nothing here: it cannot add a host to the allow-list.
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
        'forbidden-host list. No gateway selection and no SILVAN_ALLOW_ALT_HOST overrides this.'
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

  // 3. Only now: which gateway may be named at all -- and only one the
  //    allow-list already knows, addressed at exactly its own host.
  const entry = resolveGateway(cfg.gateway);
  if (sshHost !== hostOf(entry.sshHost)) {
    throw new Error(
      'REFUSING to run against ' + cfg.sshHost + '. The selected gateway "' + entry.name + '" is ' +
      entry.sshHost + ', and this harness only ever addresses an allow-listed test gateway at its own ' +
      'address. Pick another with --gateway <name> (known: ' + GATEWAYS.map((g) => g.name).join(', ') + ').' +
      (process.env.SILVAN_ALLOW_ALT_HOST
        ? ' SILVAN_ALLOW_ALT_HOST does not add hosts to the allow-list.' : '')
    );
  }
  if (cfg.expectedEui !== undefined && cfg.expectedEui !== null &&
      String(cfg.expectedEui).trim().toUpperCase() !== entry.expectedEui) {
    throw new Error(
      'REFUSING to run: this configuration carries expectedEui "' + cfg.expectedEui + '" while the ' +
      'selected gateway "' + entry.name + '" is ' + entry.expectedEui + '. The allow-list decides.'
    );
  }

  // Normalised from the allow-list, never from the caller.
  cfg.gateway = entry.name;
  cfg.expectedEui = entry.expectedEui;
  cfg.credsFile = entry.credsFile;
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

// Builds the configuration for one allow-listed gateway. Selection order:
// an explicit `overrides.gateway` (the --gateway flag), then SILVAN_GATEWAY,
// then the default ('silvan').
function config(overrides = {}) {
  const requested = (overrides.gateway === undefined || overrides.gateway === null || overrides.gateway === '')
    ? (process.env.SILVAN_GATEWAY || DEFAULT_GATEWAY)
    : overrides.gateway;
  const entry = resolveGateway(requested);
  const cfg = Object.assign({}, defaultsFor(entry), overrides, { gateway: entry.name });
  return assertEndpointsAllowed(cfg);
}

// The EUI the guards demand, taken from the ALLOW-LIST entry the guarded config
// names -- not from cfg.expectedEui, which a case could have overwritten.
function expectedGatewayFor(cfg, who) {
  assertEndpointGuardPassed(cfg, who);
  return resolveGateway(cfg.gateway);
}

// PRE-FLIGHT GUARD (runs before anything else, over SSH, read-only):
// reads the gateway's own configured EUI and refuses to continue unless it is
// the selected gateway's. This runs before any HTTP request, so a misconfigured
// tunnel pointing at another gateway is caught before a single mutation.
async function assertGatewayViaSsh(ssh, cfg) {
  const entry = expectedGatewayFor(cfg, 'the SSH EUI guard');
  const eui = String(await ssh.exec('uci get osi-server.cloud.device_eui')).trim().toUpperCase();
  if (eui !== entry.expectedEui) {
    throw new Error(
      'EUI GUARD TRIPPED (ssh): ' + (ssh.host) + ' reports gateway EUI ' + (eui || '<empty>') +
      ' but this run targets ' + entry.expectedEui + ' (' + entry.name + '). Aborting.'
    );
  }
  return eui;
}

// SECOND GUARD, over the API: proves the HTTP tunnel terminates on the same
// gateway the SSH guard checked. A tunnel pointed at a different Node-RED than
// the SSH session would otherwise go unnoticed.
async function assertGatewayViaApi(rest, cfg) {
  const entry = expectedGatewayFor(cfg, 'the API EUI guard');
  const res = await rest.get('/api/sync/state');
  if (res.status !== 200) {
    throw new Error('EUI GUARD: GET /api/sync/state returned ' + res.status + '; refusing to run.');
  }
  const eui = String(
    (res.body && res.body.gatewayIdentity && res.body.gatewayIdentity.currentEui) || ''
  ).trim().toUpperCase();
  if (eui !== entry.expectedEui) {
    throw new Error(
      'EUI GUARD TRIPPED (api): tunnel reports gateway EUI ' + (eui || '<empty>') +
      ' but this run targets ' + entry.expectedEui + ' (' + entry.name + '). Aborting.'
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
  resolveGateway,
  assertGatewayViaSsh,
  assertGatewayViaApi,
  assertSimulatedDevice,
  simDeveui,
  GATEWAYS,
  DEFAULT_GATEWAY,
  FORBIDDEN_HOSTS,
  SIM_DEVEUI_PREFIX,
  DEFAULTS,
};
