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
//     client is built. SSH and MQTT destinations must be BARE hosts: ssh(1)
//     splits user@host on the LAST '@', so a URL-shaped value such as
//     "https://100.81.220.8/@100.99.212.115" would be validated as one host and
//     connected to as another (V-297). The deny-list is matched against every
//     host-shaped token of the raw value, canonicalised (lowercase, no trailing
//     root dot), so it cannot be dodged by spelling.
//   * The clients re-check: lib/ssh.js, lib/rest.js and lib/observer.js each
//     validate their own destination against the allow-list, so a cfg mutated
//     after the guard -- or a caller that never used config() -- is caught at
//     the point a socket would open.

const net = require('node:net');

// THE GATEWAY ALLOW-LIST. Adding a gateway is a deliberate, reviewed code
// change: a name, the host, the DEVICE_EUI both guards will demand, and the
// credentials file that belongs to it. Nothing at runtime can add an entry.
const GATEWAYS = Object.freeze([
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
]);

const DEFAULT_GATEWAY = 'silvan';

// Hosts this harness must never address, whatever the environment says.
const FORBIDDEN_HOSTS = Object.freeze([
  '100.99.212.115',
  'osi-uganda-01.tail77bd41.ts.net',
  '100.69.51.98',
  'osicloud.ch',
  'server.opensmartirrigation.org',
  '57.129.7.196',
]);

// The only non-gateway hosts an endpoint may name: the local end of the SSH
// tunnel. Anything else must be the SSH-verified gateway itself.
// A frozen array rather than a Set: an exported Set can be widened at runtime
// (Object.freeze does not stop Set.add), and "which hosts count as loopback" is
// exactly the kind of list that must not be widenable.
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

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

// Expands an IPv6 literal to its eight 16-bit groups, or null if it is not one.
// Handles "::" compression and a trailing dotted quad.
function expandIpv6(addr) {
  let text = String(addr);
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (dotted) {
    const bytes = dotted[2].split('.').map(Number);
    if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
    text = dotted[1] + (((bytes[0] << 8) | bytes[1]).toString(16)) + ':' + (((bytes[2] << 8) | bytes[3]).toString(16));
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const parts = head.concat(halves.length === 2 ? new Array(fill).fill('0') : [], tail);
  if (parts.length !== 8) return null;
  const groups = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

// "::ffff:100.99.212.115" and "::ffff:6463:d473" ARE 100.99.212.115: a socket
// opened on either reaches the same machine. The deny-list therefore has to see
// the dotted form, or those spellings would only be stopped further down by the
// endpoint-consistency backstop -- and never named as forbidden.
function ipv4MappedToDotted(host) {
  if (!net.isIPv6(host)) return null;
  const groups = expandIpv6(host);
  if (!groups || !groups.slice(0, 5).every((g) => g === 0)) return null;
  const isMapped = groups[5] === 0xffff;
  // The deprecated IPv4-compatible form, and only when actually written as one:
  // this must never turn "::1" into 0.0.0.1.
  const isCompat = groups[5] === 0 && /:(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  if (!isMapped && !isCompat) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
}

// Canonical comparable form of a host: lowercased, IPv6 brackets removed, the
// trailing root dot stripped, and IPv4-mapped IPv6 literals reduced to their
// dotted form -- so "OSICLOUD.CH", "osicloud.ch.", "::ffff:100.99.212.115" and
// "::ffff:6463:d473" are each one host, and the deny-list cannot be dodged by
// spelling.
function canonicalHost(value) {
  let host = String(value == null ? '' : value).trim().toLowerCase();
  host = host.replace(/^\[/, '').replace(/\]$/, '');
  while (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1);
  return ipv4MappedToDotted(host) || host;
}

// Every host-shaped token in a RAW endpoint value, canonicalised. The deny-list
// is applied to all of them, so a forbidden host is caught even where a URL
// parser would ignore it -- "https://100.81.220.8/@100.99.212.115" yields
// ["https", "100.81.220.8", "100.99.212.115"], and ssh(1) would have connected
// to the last one.
function hostTokens(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  const out = [];
  for (const piece of raw.split(/[^a-z0-9._:\[\]-]+/)) {
    if (!piece) continue;
    let token = canonicalHost(piece);
    const withPort = /^([a-z0-9._-]+):\d{1,5}$/.exec(token);
    if (withPort) token = withPort[1];
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

const FORBIDDEN_CANON = Object.freeze(FORBIDDEN_HOSTS.map(canonicalHost));

// A deny-listed host, or anything under a deny-listed NAME (api.osicloud.ch).
function isForbiddenHost(host) {
  const h = canonicalHost(host);
  if (!h) return false;
  return FORBIDDEN_CANON.some((bad) => h === bad || (!net.isIP(bad) && h.endsWith('.' + bad)));
}

// Extracts a comparable hostname from either a URL ("http://127.0.0.1:18800/gui/")
// or a bare host ("100.81.220.8"). IPv6 brackets are stripped so "[::1]" and
// "::1" compare equal. What it returns is the host a CLIENT would address; it
// is never the whole safety story for a value that ssh(1) or mosquitto parses
// differently -- see assertBareHost.
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
  return canonicalHost(host);
}

function isLoopback(host) {
  return LOOPBACK_HOSTS.includes(canonicalHost(host));
}

// Refuses a value whose RAW text contains a deny-listed host anywhere, in any
// position, before anything tries to parse it.
function assertNoForbiddenToken(value, label) {
  for (const token of hostTokens(value)) {
    if (isForbiddenHost(token)) {
      throw new Error(
        'REFUSING to run: ' + label + ' contains "' + token + '", which is on the forbidden-host list. ' +
        'No gateway selection and no SILVAN_ALLOW_ALT_HOST overrides this.'
      );
    }
  }
}

// A BARE hostname or IP literal, and nothing else. SSH and MQTT destinations
// are hosts, not URLs: `ssh user@X` splits on the LAST '@' and mosquitto takes
// a plain host, so a scheme, userinfo, path, query, fragment or :port here
// means the value validated is not the value connected to. A leading '-' is
// refused too, so a host can never be read as a command-line option.
function assertBareHost(value, label) {
  const raw = String(value == null ? '' : value);
  if (!raw.trim()) {
    throw new Error('REFUSING to run: ' + label + ' is empty; every endpoint must be explicit.');
  }
  if (raw !== raw.trim() || /[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('REFUSING to run: ' + label + ' "' + raw + '" contains whitespace or control characters; ' +
      'it must be a bare hostname or IP address.');
  }
  const unbracketed = raw.replace(/^\[/, '').replace(/\]$/, '');
  if (!net.isIP(unbracketed)) {
    if (/[@/\\?#:]/.test(raw)) {
      throw new Error(
        'REFUSING to run: ' + label + ' "' + raw + '" is not a bare host. SSH and MQTT destinations are ' +
        'hostnames or IP addresses, never URLs: ssh(1) splits user@host on the LAST "@", so a URL-shaped ' +
        'value is checked as one host and connected to as another.'
      );
    }
    if (!/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*\.?$/i.test(raw)) {
      throw new Error('REFUSING to run: ' + label + ' "' + raw + '" is not a valid hostname or IP address.');
    }
  }
  return canonicalHost(unbracketed);
}

// An http(s) base URL with no credentials in it. Userinfo is refused outright:
// it hides which host is really addressed and would be a secret in a config
// value that ends up in evidence.
function assertHttpBase(value, label) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) {
    throw new Error('REFUSING to run: ' + label + ' is empty; every endpoint must be explicit.');
  }
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('REFUSING to run: "' + raw + '" is not a parseable URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('REFUSING to run: ' + label + ' "' + raw + '" is not an http(s) URL.');
  }
  if (url.username || url.password) {
    throw new Error(
      'REFUSING to run: ' + label + ' "' + raw + '" carries userinfo (user:pass@host). Give the endpoint as a ' +
      'plain URL: credentials in a URL hide which host is really addressed.'
    );
  }
  const host = canonicalHost(url.hostname);
  if (!host) {
    throw new Error('REFUSING to run: ' + label + ' "' + raw + '" names no host.');
  }
  return host;
}

// The login name for ssh. A bare user name, so it can never carry an option or
// a second '@' segment into the destination argument.
function assertSshUser(value, who) {
  const raw = String(value == null ? '' : value);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) {
    throw new Error('REFUSING to start ' + (who || 'an SSH session') + ': "' + raw + '" is not a bare SSH user name.');
  }
  return raw;
}

// The canonical hosts of the allow-list. Used by the clients for their own,
// independent second check.
function allowListedHosts() {
  return GATEWAYS.map((g) => canonicalHost(g.sshHost));
}

// SECOND CHECK, at the SSH client: the destination must still be an
// allow-listed gateway's own host -- bare, deny-list-clean, and known. With a
// gateway name it must be THAT gateway, so a cfg mutated from one allow-listed
// gateway to the other is caught here rather than by the EUI guard afterwards.
function assertAllowListedSshHost(value, who, gatewayName) {
  assertNoForbiddenToken(value, (who || 'the SSH destination'));
  const host = assertBareHost(value, (who || 'the SSH destination'));
  if (gatewayName !== undefined && gatewayName !== null && gatewayName !== '') {
    const entry = resolveGateway(gatewayName);
    if (host !== canonicalHost(entry.sshHost)) {
      throw new Error(
        'REFUSING to start ' + (who || 'an SSH session') + ': "' + host + '" is not the selected gateway "' +
        entry.name + '" (' + entry.sshHost + ').'
      );
    }
    return host;
  }
  if (!allowListedHosts().includes(host)) {
    throw new Error(
      'REFUSING to start ' + (who || 'an SSH session') + ': "' + host + '" is not an allow-listed test gateway ' +
      '(' + GATEWAYS.map((g) => g.name + ' = ' + g.sshHost).join(', ') + ').'
    );
  }
  return host;
}

// SECOND CHECK, at a socket client: a broker/host endpoint must be the local
// end of the tunnel or, with a gateway name, that gateway itself.
function assertConnectableHost(value, who, gatewayName) {
  assertNoForbiddenToken(value, (who || 'a network client'));
  const host = assertBareHost(value, (who || 'a network client'));
  if (isLoopback(host)) return host;
  const allowed = (gatewayName === undefined || gatewayName === null || gatewayName === '')
    ? allowListedHosts()
    : [canonicalHost(resolveGateway(gatewayName).sshHost)];
  if (!allowed.includes(host)) {
    throw new Error(
      'REFUSING to start ' + (who || 'a network client') + ': "' + host + '" is neither a loopback tunnel ' +
      'endpoint nor the gateway this run targets (' + allowed.join(', ') + ').'
    );
  }
  return host;
}

// SECOND CHECK, at the HTTP client: same rule, for a base URL. With a gateway
// name the base must be the loopback tunnel or THAT gateway, so a client cannot
// be pointed at the other allow-listed gateway mid-run.
function assertConnectableBase(value, who, gatewayName) {
  assertNoForbiddenToken(value, (who || 'the HTTP client'));
  const host = assertHttpBase(value, (who || 'the HTTP client'));
  if (isLoopback(host)) return host;
  const allowed = (gatewayName === undefined || gatewayName === null || gatewayName === '')
    ? allowListedHosts()
    : [canonicalHost(resolveGateway(gatewayName).sshHost)];
  if (!allowed.includes(host)) {
    throw new Error(
      'REFUSING to start ' + (who || 'the HTTP client') + ': base URL "' + value + '" resolves to "' + host +
      '", which is neither a loopback tunnel endpoint nor the gateway this run targets (' + allowed.join(', ') + ').'
    );
  }
  return host;
}

// R1(b) blackholes a route ON the gateway. The target must be a genuine third
// party: never a deny-listed host, never ANY allow-listed test gateway (not
// only the one this run selected -- another run may be talking to the other
// one), and never a loopback or an endpoint this run is itself using.
function blackholeTargetRefusal(target, cfg) {
  const host = canonicalHost(target);
  if (!host) return 'it did not yield a parseable host';
  if (isForbiddenHost(host)) return 'it is on this harness\'s FORBIDDEN_HOSTS list';
  if (allowListedHosts().includes(host)) {
    return 'it is an allow-listed test gateway (' + GATEWAYS.map((g) => g.name + ' = ' + g.sshHost).join(', ') + ')';
  }
  if (isLoopback(host)) return 'it is a loopback address, i.e. this run\'s own tunnel endpoint';
  const own = [
    canonicalHost(cfg && cfg.sshHost),
    hostOf(cfg && cfg.apiBase),
    hostOf(cfg && cfg.guiBase),
    canonicalHost(cfg && cfg.mqttHost),
  ].filter(Boolean);
  if (own.includes(host)) return 'it is one of this run\'s own SSH/API/GUI/MQTT endpoints';
  return null;
}

// Set on a cfg that cleared assertEndpointsAllowed(). A Symbol, so it cannot be
// produced by a hand-written object literal and never leaks into JSON evidence.
const ENDPOINT_GUARD_PASSED = Symbol('osi.silvan.endpointGuardPassed');

// THE ENDPOINT GUARD. Every host this harness will ever open a socket to is
// checked here, before any client exists.
//
// Order matters and is part of the contract:
//   1. The deny-list is applied to EVERY endpoint, unconditionally, over every
//      host-shaped token of the RAW value -- before anything is parsed and
//      before the gateway selection or SILVAN_ALLOW_ALT_HOST are read. A
//      forbidden host is refused wherever it hides in the string.
//   2. Shape. SSH and MQTT endpoints must be bare hosts (a URL there is checked
//      as one host and connected to as another); API and GUI bases must be
//      http(s) URLs with no userinfo.
//   3. Endpoint consistency: every non-SSH endpoint must be either a loopback
//      tunnel address or exactly the SSH host the EUI guard will verify. This
//      closes the gap where SSH points at the selected gateway (so both EUI
//      guards pass) while the HTTP or MQTT client is quietly aimed elsewhere.
//   4. Only then is the gateway selection consulted, and the SSH host must be
//      exactly the selected allow-list entry's host. SILVAN_ALLOW_ALT_HOST
//      grants nothing here: it cannot add a host to the allow-list.
//   5. The cfg the clients receive carries canonical values -- the allow-list
//      entry's own host string, never the raw environment value.
function assertEndpointsAllowed(cfg) {
  const endpoints = [
    { label: 'SSH host (SILVAN_SSH_HOST)', value: cfg.sshHost, kind: 'host' },
    { label: 'HTTP API (SILVAN_API_BASE)', value: cfg.apiBase, kind: 'url' },
    { label: 'GUI (SILVAN_GUI_BASE)', value: cfg.guiBase, kind: 'url' },
    { label: 'MQTT broker (SILVAN_MQTT_HOST)', value: cfg.mqttHost, kind: 'host' },
  ];

  // 1. Deny-list, unconditional, every endpoint, every token of the raw value.
  for (const ep of endpoints) assertNoForbiddenToken(ep.value, ep.label);

  // 2. Shape, and the deny-list again on what the client would actually address.
  for (const ep of endpoints) {
    ep.host = ep.kind === 'host'
      ? assertBareHost(ep.value, ep.label)
      : assertHttpBase(ep.value, ep.label);
    if (isForbiddenHost(ep.host)) {
      throw new Error(
        'REFUSING to run: ' + ep.label + ' resolves to "' + ep.host + '", which is on the ' +
        'forbidden-host list. No gateway selection and no SILVAN_ALLOW_ALT_HOST overrides this.'
      );
    }
  }
  const sshHost = endpoints[0].host;
  const sshUser = assertSshUser(cfg.sshUser, 'the SSH client');
  const sshKey = String(cfg.sshKey == null ? '' : cfg.sshKey);
  if (!sshKey || sshKey.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(sshKey)) {
    throw new Error('REFUSING to run: SILVAN_SSH_KEY "' + sshKey + '" is not a plain key path.');
  }

  // 3. Endpoint consistency: loopback tunnel, or the very host SSH will verify.
  for (const ep of endpoints) {
    if (ep.label.startsWith('SSH host')) continue;
    if (isLoopback(ep.host) || ep.host === sshHost) continue;
    throw new Error(
      'REFUSING to run: ' + ep.label + ' points at "' + ep.host + '", which is neither a loopback ' +
      'tunnel endpoint (' + LOOPBACK_HOSTS.join(', ') + ') nor the SSH host "' + sshHost + '" ' +
      'that the EUI guards verify. Every endpoint must terminate on the same gateway.'
    );
  }

  // MQTT port: a real port, or the observer would connect somewhere unintended.
  const port = Number(cfg.mqttPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('REFUSING to run: SILVAN_MQTT_PORT "' + cfg.mqttPort + '" is not a valid TCP port.');
  }

  // 4. Only now: which gateway may be named at all -- and only one the
  //    allow-list already knows, addressed at exactly its own host.
  const entry = resolveGateway(cfg.gateway);
  if (sshHost !== canonicalHost(entry.sshHost)) {
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

  // 5. Normalised from the allow-list and from the checks above, never from the
  //    caller: the clients receive the validated host, not the raw env value.
  cfg.gateway = entry.name;
  cfg.expectedEui = entry.expectedEui;
  cfg.credsFile = entry.credsFile;
  cfg.sshHost = entry.sshHost;
  cfg.sshUser = sshUser;
  cfg.mqttHost = endpoints[3].host;
  cfg.mqttPort = port;
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
  canonicalHost,
  hostTokens,
  isForbiddenHost,
  isLoopback,
  assertBareHost,
  assertHttpBase,
  assertSshUser,
  assertAllowListedSshHost,
  assertConnectableHost,
  assertConnectableBase,
  allowListedHosts,
  blackholeTargetRefusal,
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
