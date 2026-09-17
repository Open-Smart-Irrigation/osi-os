#!/usr/bin/env node
'use strict';
// Self-test for the harness's own safety machinery. Runs OFFLINE: no gateway,
// no SSH, no tunnel. The only socket it opens is a throwaway loopback HTTP
// server it starts itself.
//
//   node tests/silvan/selftest.js
//
// These assertions guard the guards. If one fails, the harness can no longer be
// trusted to refuse a wrong target or to keep a secret out of evidence, so this
// must be green before any run against real hardware.

const http = require('node:http');
const assert = require('node:assert');

const configLib = require('./lib/config');
const {
  config, assertEndpointsAllowed, assertEndpointGuardPassed, hostOf, isLoopback,
  assertSimulatedDevice, simDeveui, ENDPOINT_GUARD_PASSED, DEFAULTS,
} = require('./lib/config');
const { Rest, redact, redactHeaders, isSecretKey, REDACTED } = require('./lib/rest');
const { Ssh } = require('./lib/ssh');
const { DownlinkObserver } = require('./lib/observer');
const { hasRejectedOutboxShape, isKnownTerminalReason } = require('./lib/rejections');
const { classifyOnceOutcome, ONCE_GRACE_MS } = require('./lib/onceGrace');
const { hasAdminRouterScopedGate, hasScopedOnlyRoleAssert } = require('./lib/roleGates');
const { hasBlackholeRoute, firstIpv4, parsePingResolvedIp } = require('./lib/routeParse');
const planRef = require('./lib/planRef');

const failures = [];
let passed = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { passed += 1; console.log('  ok   ' + name); },
        (e) => { failures.push({ name, error: e.message }); console.log('  FAIL ' + name + ' -- ' + e.message); }
      );
    }
    passed += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log('  FAIL ' + name + ' -- ' + e.message);
  }
  return Promise.resolve();
}

// Runs `fn` with env vars temporarily set, then restores them.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function refuses(name, cfgOverrides, envVars = {}) {
  return check(name, () => {
    withEnv(envVars, () => {
      assert.throws(
        () => assertEndpointsAllowed(Object.assign({}, DEFAULTS, cfgOverrides)),
        /REFUSING/,
        'expected the endpoint guard to refuse this configuration'
      );
    });
  });
}

async function main() {
  console.log('\n-- endpoint guard: accepts the intended setup');
  await check('the default configuration passes and is marked as guarded', () => {
    const cfg = config();
    assert.strictEqual(cfg[ENDPOINT_GUARD_PASSED], true);
  });
  await check('endpoints naming the SSH host directly are accepted', () => {
    assertEndpointsAllowed(Object.assign({}, DEFAULTS, {
      apiBase: 'http://100.81.220.8:1880',
      guiBase: 'http://100.81.220.8:1880/gui/',
      mqttHost: '100.81.220.8',
      mqttPort: 1883,
    }));
  });
  await check('localhost and ::1 count as loopback tunnel endpoints', () => {
    assertEndpointsAllowed(Object.assign({}, DEFAULTS, {
      apiBase: 'http://localhost:18800',
      guiBase: 'http://[::1]:18800/gui/',
      mqttHost: 'localhost',
    }));
    assert.ok(isLoopback('::1') && isLoopback('LOCALHOST'));
  });

  console.log('\n-- endpoint guard: the deny-list applies to every endpoint, unconditionally');
  // The escape hatch is set in every one of these: it must not help.
  const ALT = { SILVAN_ALLOW_ALT_HOST: '1' };
  refuses('an SSH host on the deny-list is refused even with SILVAN_ALLOW_ALT_HOST',
    { sshHost: 'osi-uganda-01.tail77bd41.ts.net' }, ALT);
  refuses('a deny-listed IP as the SSH host is refused even with SILVAN_ALLOW_ALT_HOST',
    { sshHost: '100.69.51.98' }, ALT);
  refuses('a deny-listed host in SILVAN_API_BASE is refused even with SILVAN_ALLOW_ALT_HOST',
    { sshHost: '100.69.51.98', apiBase: 'https://osicloud.ch' }, ALT);
  refuses('the production cloud in SILVAN_API_BASE is refused',
    { apiBase: 'https://osicloud.ch/api' }, ALT);
  refuses('the OSI test server in SILVAN_GUI_BASE is refused',
    { guiBase: 'https://server.opensmartirrigation.org/gui/' }, ALT);
  refuses('a deny-listed MQTT host is refused',
    { mqttHost: 'server.opensmartirrigation.org' }, ALT);
  refuses('a deny-listed MQTT host by IP is refused',
    { mqttHost: '57.129.7.196' }, ALT);
  refuses('the forbidden host 100.99.212.115 is refused in any endpoint',
    { apiBase: 'http://100.99.212.115:1880' }, ALT);

  console.log('\n-- endpoint guard: endpoints must terminate on the verified gateway');
  refuses('an API base on a third host is refused even when SSH points at Silvan',
    { apiBase: 'http://10.1.2.3:1880' });
  refuses('an MQTT host on a third host is refused even when SSH points at Silvan',
    { mqttHost: '10.1.2.3' });
  refuses('a GUI base on a third host is refused even when SSH points at Silvan',
    { guiBase: 'http://10.1.2.3:1880/gui/' });
  refuses('a third-host API base is still refused with SILVAN_ALLOW_ALT_HOST set',
    { sshHost: '10.0.0.9', apiBase: 'http://10.1.2.3:1880' }, ALT);
  refuses('an empty endpoint is refused rather than defaulted', { mqttHost: '' });
  refuses('an unparseable API base is refused', { apiBase: 'http://' });

  console.log('\n-- endpoint guard: port and alt-host gate');
  refuses('a non-numeric MQTT port is refused', { mqttPort: 'eighteen-thirty' });
  refuses('an out-of-range MQTT port is refused', { mqttPort: 70000 });
  refuses('a host that is on no allow-list entry is refused without SILVAN_ALLOW_ALT_HOST',
    { sshHost: '10.0.0.9', apiBase: 'http://10.0.0.9:1880', guiBase: 'http://10.0.0.9:1880/gui/', mqttHost: '10.0.0.9' },
    { SILVAN_ALLOW_ALT_HOST: undefined });
  refuses('a host that is on no allow-list entry is refused WITH SILVAN_ALLOW_ALT_HOST too -- the hatch no longer ' +
    'admits hosts, the allow-list is the only way to name a gateway',
    { sshHost: '10.0.0.9', apiBase: 'http://10.0.0.9:1880', guiBase: 'http://10.0.0.9:1880/gui/', mqttHost: '10.0.0.9' },
    ALT);

  console.log('\n-- gateway allow-list: only the known test gateways, selected by name');
  await check('the default selection is the Silvan gateway, with its own host, EUI and credentials path', () => {
    const cfg = config();
    assert.strictEqual(cfg.gateway, 'silvan');
    assert.strictEqual(cfg.sshHost, '100.81.220.8');
    assert.strictEqual(cfg.expectedEui, '0016C001F11715E2');
    assert.strictEqual(cfg.credsFile, '~/osi-tools/.silvan-test-creds');
  });
  await check('selecting rpi4-test passes the endpoint checks and switches host, EUI and credentials together', () => {
    const cfg = config({ gateway: 'rpi4-test' });
    assert.strictEqual(cfg[ENDPOINT_GUARD_PASSED], true);
    assert.strictEqual(cfg.sshHost, '100.85.226.64');
    assert.strictEqual(cfg.expectedEui, '0016C001F11369DE');
    assert.strictEqual(cfg.credsFile, '~/osi-tools/.rpi4-test-creds');
  });
  await check('SILVAN_GATEWAY selects the same entry as the --gateway flag', () => {
    withEnv({ SILVAN_GATEWAY: 'rpi4-test' }, () => {
      const cfg = config();
      assert.strictEqual(cfg.gateway, 'rpi4-test');
      assert.strictEqual(cfg.expectedEui, '0016C001F11369DE');
    });
  });
  await check('endpoints naming the selected gateway host directly are accepted for rpi4-test as well', () => {
    configLib.assertEndpointsAllowed(Object.assign({}, DEFAULTS, {
      gateway: 'rpi4-test', sshHost: '100.85.226.64',
      apiBase: 'http://100.85.226.64:1880', guiBase: 'http://100.85.226.64:1880/gui/',
      mqttHost: '100.85.226.64', mqttPort: 1883, expectedEui: undefined,
    }));
  });
  await check('an unknown gateway name is refused, from the flag and from the environment', () => {
    assert.throws(() => config({ gateway: 'bovey' }), /REFUSING/);
    withEnv({ SILVAN_GATEWAY: 'kaba100' }, () => { assert.throws(() => config(), /REFUSING/); });
  });
  await check('a gateway NAME is not a host: SILVAN_GATEWAY cannot introduce an address', () => {
    for (const value of ['100.85.226.64', '100.99.212.115', 'osicloud.ch']) {
      withEnv({ SILVAN_GATEWAY: value }, () => {
        assert.throws(() => config(), /REFUSING/, 'SILVAN_GATEWAY=' + value + ' must not be read as a host');
      });
    }
  });
  refuses('an API base pointed at the OTHER allow-listed gateway is refused: endpoints still have to ' +
    'terminate on the one gateway the EUI guards verify',
    { gateway: 'silvan', apiBase: 'http://100.85.226.64:1880' }, ALT);
  refuses('an SSH host belonging to a DIFFERENT allow-list entry than the selected one is refused',
    { gateway: 'silvan', sshHost: '100.85.226.64', apiBase: 'http://100.85.226.64:1880',
      guiBase: 'http://100.85.226.64:1880/gui/', mqttHost: '100.85.226.64', expectedEui: undefined });
  refuses('...and is still refused with SILVAN_ALLOW_ALT_HOST set',
    { gateway: 'silvan', sshHost: '100.85.226.64', apiBase: 'http://100.85.226.64:1880',
      guiBase: 'http://100.85.226.64:1880/gui/', mqttHost: '100.85.226.64', expectedEui: undefined }, ALT);
  await check('a configuration whose expectedEui contradicts the selected gateway is refused', () => {
    assert.throws(() => configLib.assertEndpointsAllowed(Object.assign({}, DEFAULTS, {
      gateway: 'rpi4-test', sshHost: '100.85.226.64', expectedEui: '0016C001F11715E2',
    })), /REFUSING/);
  });
  await check('every allow-list entry is off the deny-list, uniquely named and addressed, and has a 16-hex EUI', () => {
    const forbidden = new Set(configLib.FORBIDDEN_HOSTS.map((h) => h.toLowerCase()));
    const names = new Set(); const hosts = new Set(); const euis = new Set();
    for (const g of configLib.GATEWAYS) {
      assert.match(g.expectedEui, /^[0-9A-F]{16}$/, g.name + ' needs a 16-hex uppercase EUI');
      assert.ok(!forbidden.has(String(g.sshHost).toLowerCase()), g.name + ' must not be a forbidden host');
      assert.ok(!names.has(g.name), 'duplicate gateway name ' + g.name);
      assert.ok(!hosts.has(g.sshHost), 'duplicate gateway host ' + g.sshHost);
      assert.ok(!euis.has(g.expectedEui), 'duplicate gateway EUI ' + g.expectedEui);
      assert.ok(String(g.credsFile || '').length > 0, g.name + ' needs a credentials file path');
      names.add(g.name); hosts.add(g.sshHost); euis.add(g.expectedEui);
    }
    assert.ok(names.has('silvan') && names.has('rpi4-test'), 'both known test gateways are allow-listed');
  });

  console.log('\n-- the Bovey demo Pi is refused under every flag/environment combination');
  await check('no combination of gateway selection, SILVAN_SSH_HOST and SILVAN_ALLOW_ALT_HOST reaches 100.99.212.115', () => {
    const DEMO = '100.99.212.115';
    let combos = 0;
    for (const name of [undefined, 'silvan', 'rpi4-test', 'bovey', 'demo']) {
      for (const alt of [undefined, '1']) {
        const where = ' (SILVAN_GATEWAY=' + name + ', SILVAN_ALLOW_ALT_HOST=' + alt + ')';
        for (const vars of [
          { SILVAN_SSH_HOST: DEMO },
          { SILVAN_API_BASE: 'http://' + DEMO + ':1880' },
          { SILVAN_GUI_BASE: 'http://' + DEMO + ':1880/gui/' },
          { SILVAN_MQTT_HOST: DEMO },
        ]) {
          withEnv(Object.assign({ SILVAN_GATEWAY: name, SILVAN_ALLOW_ALT_HOST: alt }, vars), () => {
            assert.throws(() => config(), /REFUSING/, Object.keys(vars)[0] + '=' + DEMO + where);
          });
          combos += 1;
        }
      }
    }
    assert.strictEqual(combos, 40, 'every flag/env combination was actually exercised');
    for (const name of ['silvan', 'rpi4-test']) {
      assert.throws(() => config({ gateway: name, sshHost: DEMO }), /REFUSING/,
        'an explicit sshHost override to the demo Pi must be refused for ' + name);
    }
  });

  console.log('\n-- EUI guards compare against the SELECTED gateway, never a hardcoded one');
  const stubSsh = (eui) => ({ host: 'stub-host', exec: async () => String(eui) + '\n' });
  const stubRest = (eui, status = 200) => ({
    get: async () => ({ status, body: { gatewayIdentity: { currentEui: eui } } }),
  });
  await check('the SSH EUI guard accepts the selected gateway\'s own EUI (rpi4-test)', async () => {
    const eui = await configLib.assertGatewayViaSsh(stubSsh('0016c001f11369de'), config({ gateway: 'rpi4-test' }));
    assert.strictEqual(eui, '0016C001F11369DE');
  });
  await check('the SSH EUI guard aborts when rpi4-test is selected but the gateway reports Silvan\'s EUI', async () => {
    await assert.rejects(
      () => configLib.assertGatewayViaSsh(stubSsh('0016C001F11715E2'), config({ gateway: 'rpi4-test' })),
      /EUI GUARD TRIPPED \(ssh\)/);
  });
  await check('the SSH EUI guard aborts when silvan is selected but the gateway reports the rpi4 EUI', async () => {
    await assert.rejects(
      () => configLib.assertGatewayViaSsh(stubSsh('0016C001F11369DE'), config()),
      /EUI GUARD TRIPPED \(ssh\)/);
  });
  await check('an empty EUI read back from the gateway aborts rather than passing', async () => {
    await assert.rejects(() => configLib.assertGatewayViaSsh(stubSsh(''), config()), /EUI GUARD TRIPPED/);
  });
  await check('the API EUI guard accepts the selected gateway and aborts on the other one', async () => {
    assert.strictEqual(
      await configLib.assertGatewayViaApi(stubRest('0016C001F11369DE'), config({ gateway: 'rpi4-test' })),
      '0016C001F11369DE');
    await assert.rejects(
      () => configLib.assertGatewayViaApi(stubRest('0016C001F11715E2'), config({ gateway: 'rpi4-test' })),
      /EUI GUARD TRIPPED \(api\)/);
  });
  await check('the API EUI guard refuses a non-200 /api/sync/state rather than reading an absent EUI', async () => {
    await assert.rejects(() => configLib.assertGatewayViaApi(stubRest('0016C001F11715E2', 503), config()), /EUI GUARD/);
  });
  await check('the EUI guards refuse a hand-built config, so a forged expectedEui cannot lower the bar', async () => {
    await assert.rejects(
      () => configLib.assertGatewayViaSsh(stubSsh('DEADBEEFDEADBEEF'),
        { gateway: 'silvan', expectedEui: 'DEADBEEFDEADBEEF', sshHost: '100.81.220.8' }),
      /REFUSING to start/);
  });
  await check('tampering with expectedEui on a guarded config does not move the guard: the allow-list is the source ' +
    'of truth', async () => {
    const cfg = config({ gateway: 'rpi4-test' });
    cfg.expectedEui = '0016C001F11715E2';
    await assert.rejects(() => configLib.assertGatewayViaSsh(stubSsh('0016C001F11715E2'), cfg), /EUI GUARD TRIPPED/);
  });

  console.log('\n-- endpoint guard: an SSH/MQTT host is a bare host, never a URL (V-297)');
  // The payloads below defeated the guard as first written: hostOf() reads the
  // WHATWG URL hostname ("100.81.220.8", allowed) while ssh(1) splits user@host
  // on the LAST '@' and connects to what follows it. Verified by hand with
  // `ssh -G root@https://100.81.220.8/@100.99.212.115`, which prints
  // `hostname 100.99.212.115` -- the Bovey demo Pi.
  const SSH_URL_PAYLOADS = [
    { value: 'https://100.81.220.8/@100.99.212.115', gateway: 'silvan', tail: '100.99.212.115' },
    { value: 'https://100.81.220.8/@osicloud.ch', gateway: 'silvan', tail: 'osicloud.ch' },
    { value: 'http://100.85.226.64/@100.99.212.115', gateway: 'rpi4-test', tail: '100.99.212.115' },
  ];
  for (const p of SSH_URL_PAYLOADS) {
    await check('SILVAN_SSH_HOST="' + p.value + '" is refused (--gateway ' + p.gateway + ')', () => {
      withEnv({ SILVAN_SSH_HOST: p.value, SILVAN_ALLOW_ALT_HOST: '1' }, () => {
        assert.throws(() => config({ gateway: p.gateway }), /REFUSING/);
      });
    });
    await check('the deny-list sees "' + p.tail + '" inside "' + p.value + '", not only the URL hostname', () => {
      assert.ok(configLib.hostTokens(p.value).includes(p.tail),
        'hostTokens must expose every host-shaped token of the raw value');
      assert.strictEqual(configLib.isForbiddenHost(p.tail), true);
    });
  }
  refuses('a URL-shaped SSH host whose tail is NOT deny-listed is still refused, because it is not a bare host',
    { sshHost: 'https://100.81.220.8/@10.1.2.3' }, ALT);
  refuses('an SSH host with a :port suffix is refused (the port is SILVAN_MQTT_PORT/the tunnel, not the host)',
    { sshHost: '100.81.220.8:22' });
  refuses('an SSH host with whitespace is refused', { sshHost: '100.81.220.8 ' });
  refuses('an SSH host starting with "-" cannot inject an ssh option',
    { sshHost: '-oProxyCommand=curl http://example.invalid' }, ALT);
  refuses('an MQTT host given as a URL is refused', { mqttHost: 'tcp://127.0.0.1/@100.99.212.115' });
  refuses('an MQTT host with a :port suffix is refused', { mqttHost: '127.0.0.1:1883' });
  refuses('an MQTT host starting with "-" is refused', { mqttHost: '-oProxyCommand=x' }, ALT);
  refuses('an SSH user that smuggles an ssh option is refused', { sshUser: 'root -oProxyCommand=x' });

  console.log('\n-- endpoint guard: deny-list matching is normalised (trailing dot, case, subdomain, userinfo)');
  await check('a trailing-dot forbidden host is refused AS forbidden, not incidentally', () => {
    assert.throws(() => config({ sshHost: '100.99.212.115.' }), /forbidden-host list/);
    assert.throws(() => config({ apiBase: 'http://osicloud.ch./' }), /forbidden-host list/);
  });
  await check('a forbidden host in a different case is refused as forbidden', () => {
    assert.throws(() => config({ guiBase: 'https://OSICLOUD.CH/gui/' }), /forbidden-host list/);
  });
  await check('a subdomain of a deny-listed name is refused as forbidden', () => {
    assert.throws(() => config({ apiBase: 'https://api.osicloud.ch/' }), /forbidden-host list/);
  });
  await check('a URL that hides a forbidden host in its userinfo position is refused', () => {
    assert.throws(() => config({ apiBase: 'http://100.81.220.8@100.99.212.115/' }), /REFUSING/);
  });
  refuses('an API base carrying userinfo is refused even when the host itself is the tunnel',
    { apiBase: 'http://user:pass@127.0.0.1:18800' });
  refuses('a GUI base carrying userinfo is refused', { guiBase: 'http://user:pass@127.0.0.1:18800/gui/' });
  refuses('an API base on a non-HTTP scheme is refused', { apiBase: 'ftp://100.81.220.8/' });

  console.log('\n-- the allow-list and the deny-list cannot be mutated at runtime');
  await check('GATEWAYS, its entries, FORBIDDEN_HOSTS and LOOPBACK_HOSTS are all frozen', () => {
    assert.throws(() => configLib.GATEWAYS.push({ name: 'demo', sshHost: '100.99.212.115' }), TypeError);
    assert.throws(() => { configLib.GATEWAYS[0] = { name: 'silvan', sshHost: '100.99.212.115' }; }, TypeError);
    assert.throws(() => { configLib.GATEWAYS[0].sshHost = '100.99.212.115'; }, TypeError);
    assert.throws(() => configLib.FORBIDDEN_HOSTS.pop(), TypeError);
    assert.throws(() => configLib.LOOPBACK_HOSTS.push('100.99.212.115'), TypeError);
    assert.strictEqual(config().sshHost, '100.81.220.8');
    assert.strictEqual(configLib.isForbiddenHost('100.99.212.115'), true);
    assert.strictEqual(isLoopback('100.99.212.115'), false);
  });

  console.log('\n-- clients re-check their destination, so a config mutated after the guard is caught');
  await check('the SSH client refuses a config whose host was changed to the demo Pi after config()', () => {
    const cfg = config();
    cfg.sshHost = '100.99.212.115';
    assert.throws(() => new Ssh(cfg), /REFUSING/);
  });
  await check('the SSH client refuses a host mutated to the OTHER allow-listed gateway after config()', () => {
    const cfg = config();
    cfg.sshHost = '100.85.226.64';
    assert.throws(() => new Ssh(cfg), /REFUSING to start/);
  });
  await check('the SSH client refuses a user mutated into an option after config()', () => {
    const cfg = config();
    cfg.sshUser = 'root -oProxyCommand=x';
    assert.throws(() => new Ssh(cfg), /REFUSING to start/);
  });
  await check('the MQTT observer refuses a broker on the OTHER allow-listed gateway after config()', async () => {
    const cfg = config();
    cfg.mqttHost = '100.85.226.64';
    const observer = new DownlinkObserver({ cfg, profiles: {}, actuatorsAppId: 'x' });
    await assert.rejects(() => observer.start(), /REFUSING to start/);
  });
  await check('the SSH client refuses a URL-shaped host that was set after config()', () => {
    const cfg = config();
    cfg.sshHost = 'https://100.81.220.8/@100.99.212.115';
    assert.throws(() => new Ssh(cfg), /REFUSING/);
  });
  await check('the SSH destination is the allow-list host, option-terminated, and pinned with HostName', () => {
    const args = new Ssh(config())._args('true');
    assert.ok(args.includes('-o') && args.includes('HostName=100.81.220.8'), 'HostName must pin the destination');
    const sep = args.indexOf('--');
    assert.ok(sep > 0, 'the option list must be terminated with --');
    assert.strictEqual(args[sep + 1], 'root@100.81.220.8');
    assert.strictEqual(args[sep + 2], 'true');
  });
  await check('the MQTT observer refuses a config whose broker host was changed after config()', async () => {
    const cfg = config();
    cfg.mqttHost = '100.99.212.115';
    const observer = new DownlinkObserver({ cfg, profiles: {}, actuatorsAppId: 'x' });
    await assert.rejects(() => observer.start(), /REFUSING/);
  });
  await check('the REST client refuses a base URL that is not the tunnel or an allow-listed gateway', () => {
    assert.throws(() => new Rest('http://100.99.212.115:1880'), /REFUSING/);
    assert.throws(() => new Rest('http://10.1.2.3:1880'), /REFUSING/);
    assert.throws(() => new Rest('http://user:pass@127.0.0.1:18800'), /REFUSING/);
  });
  await check('the REST client accepts the tunnel and an allow-listed gateway', () => {
    new Rest('http://127.0.0.1:18800');
    new Rest('http://100.85.226.64:1880');
  });

  console.log('\n-- clients refuse an unguarded configuration');
  await check('the SSH client refuses a hand-built config object', () => {
    assert.throws(() => new Ssh({ sshHost: '100.81.220.8', sshKey: 'k', sshUser: 'root' }), /REFUSING to start/);
  });
  await check('the MQTT observer refuses to start on a hand-built config object', async () => {
    const observer = new DownlinkObserver({
      cfg: { mqttHost: '127.0.0.1', mqttPort: 18830 }, profiles: {}, actuatorsAppId: 'x',
    });
    await assert.rejects(() => observer.start(), /REFUSING to start/);
  });
  await check('assertEndpointGuardPassed accepts a config() result', () => {
    assertEndpointGuardPassed(config(), 'a test');
  });
  await check('the SSH client accepts a guarded rpi4-test config and addresses that gateway, not Silvan', () => {
    const ssh = new Ssh(config({ gateway: 'rpi4-test' }));
    assert.strictEqual(ssh.host, '100.85.226.64');
  });

  console.log('\n-- simulated devices only');
  await check('a simulated DevEUI is accepted and is valid 16-char hex', () => {
    const eui = simDeveui('selftest', 1);
    assert.match(eui, /^[0-9A-F]{16}$/);
    assert.ok(eui.startsWith('70B3D57ED00'));
  });
  await check('a real STREGA DevEUI is refused', () => {
    assert.throws(() => assertSimulatedDevice('70B3D57708000334'), /SAFETY/);
  });
  await check('the Silvan gateway EUI itself is refused as a device', () => {
    assert.throws(() => assertSimulatedDevice('0016C001F11715E2'), /SAFETY/);
  });

  console.log('\n-- evidence redaction');
  await check('secret-looking keys are recognised in every spelling', () => {
    for (const k of ['password', 'Password', 'token', 'sync_token', 'syncToken', 'mqtt_password', 'Authorization', 'appkey']) {
      assert.ok(isSecretKey(k), k + ' should be treated as secret');
    }
    for (const k of ['username', 'deveui', 'zone_uuid', 'status']) {
      assert.ok(!isSecretKey(k), k + ' should NOT be redacted');
    }
  });
  await check('nested secrets are redacted and non-secrets survive', () => {
    const out = redact({ username: 'u', password: 'hunter2', nested: { sync_token: 'abc', keep: 'me' } });
    assert.strictEqual(out.password, REDACTED);
    assert.strictEqual(out.nested.sync_token, REDACTED);
    assert.strictEqual(out.username, 'u');
    assert.strictEqual(out.nested.keep, 'me');
  });
  await check('an Authorization header is redacted', () => {
    assert.strictEqual(redactHeaders({ Authorization: 'Bearer a.b' }).Authorization, REDACTED);
  });
  await check('redaction copies rather than mutating the caller\'s object', () => {
    const original = { password: 'hunter2' };
    redact(original);
    assert.strictEqual(original.password, 'hunter2');
  });

  console.log('\n-- rejected-outbox shape (F30 / osi-os#262), against fixture JSON');
  // These fixtures stand in for GET /api/sync/state bodies so this logic is
  // checked offline, without a gateway, both before and after #262 lands.
  const FIXTURE_WITH_262 = {
    pendingOutboxCount: 3,
    gatewayIdentity: { currentEui: '0016C001F11715E2' },
    rejectedOutboxCount: 205,
    rejectedLast24h: 205,
    lastRejection: { at: '2026-09-17T00:43:00.350Z', op: 'DEVICE_DATA_APPENDED', reason: 'ownership_denied' },
  };
  const FIXTURE_WITH_262_NO_REJECTIONS = {
    pendingOutboxCount: 0,
    rejectedOutboxCount: 0,
    rejectedLast24h: 0,
    lastRejection: null,
  };
  // The actual pre-#262 shape observed on Silvan (TRIAGE.md F30 detail):
  // `rejectedMigrationCandidates` is an unrelated gateway-recovery/migration
  // field that a /reject/i name-regex would have matched, producing the old
  // harness's false PASS.
  const FIXTURE_WITHOUT_262 = {
    pendingOutboxCount: 3,
    lastError: null,
    lastBootstrapSuccessAt: '2026-09-17T00:37:23.187Z',
    gatewayIdentity: { currentEui: '0016C001F11715E2' },
    rejectedMigrationCandidates: 2,
  };

  await check('a post-#262 /api/sync/state body with an active rejection has the #262 shape', () => {
    assert.strictEqual(hasRejectedOutboxShape(FIXTURE_WITH_262), true);
  });
  await check('a post-#262 body with no rejections yet (lastRejection: null) still has the #262 shape', () => {
    assert.strictEqual(hasRejectedOutboxShape(FIXTURE_WITH_262_NO_REJECTIONS), true);
  });
  await check('a pre-#262 body does NOT have the #262 shape, even though it name-regex-matches /reject/i', () => {
    assert.strictEqual(hasRejectedOutboxShape(FIXTURE_WITHOUT_262), false);
    assert.ok(Object.keys(FIXTURE_WITHOUT_262).some((k) => /reject/i.test(k)),
      'fixture should still contain a /reject/i-matching key, or this is not testing the false-positive it claims to');
  });
  await check('an empty body does not have the #262 shape', () => {
    assert.strictEqual(hasRejectedOutboxShape({}), false);
    assert.strictEqual(hasRejectedOutboxShape(null), false);
  });
  await check('a body with rejectedOutboxCount but no lastRejection key does not have the #262 shape', () => {
    assert.strictEqual(hasRejectedOutboxShape({ rejectedOutboxCount: 1, rejectedLast24h: 1 }), false);
  });
  await check('ownership_denied and its sub-reasons are a known terminal reason', () => {
    assert.strictEqual(isKnownTerminalReason('ownership_denied'), true);
    assert.strictEqual(isKnownTerminalReason('ownership_denied: zone never seen'), true);
  });
  await check('an unrelated rejection reason is NOT a known terminal reason', () => {
    assert.strictEqual(isKnownTerminalReason('version_conflict'), false);
    assert.strictEqual(isKnownTerminalReason(''), false);
    assert.strictEqual(isKnownTerminalReason(null), false);
    assert.strictEqual(isKnownTerminalReason(undefined), false);
  });

  console.log('\n-- once-schedule grace window (P1/C1 additions), against fixture timestamps');
  await check('a fire_at 2 minutes in the past is within the grace window (fires)', () => {
    const now = Date.parse('2026-09-17T12:00:00.000Z');
    assert.strictEqual(classifyOnceOutcome('2026-09-17T11:58:00.000Z', now), 'FIRE');
  });
  await check('a fire_at exactly at the grace boundary still fires (strictly-greater-than in the real code)', () => {
    const now = Date.parse('2026-09-17T12:00:00.000Z');
    const atBoundary = new Date(now - ONCE_GRACE_MS).toISOString();
    assert.strictEqual(classifyOnceOutcome(atBoundary, now), 'FIRE');
  });
  await check('a fire_at one second past the grace window is SKIPped', () => {
    const now = Date.parse('2026-09-17T12:00:00.000Z');
    const pastBoundary = new Date(now - ONCE_GRACE_MS - 1000).toISOString();
    assert.strictEqual(classifyOnceOutcome(pastBoundary, now), 'SKIP');
  });
  await check('a fire_at in the future is treated as FIRE-eligible (not due yet, but not skipped)', () => {
    const now = Date.parse('2026-09-17T12:00:00.000Z');
    assert.strictEqual(classifyOnceOutcome('2026-09-17T12:05:00.000Z', now), 'FIRE');
  });
  await check('an unparseable fire_at throws rather than silently misclassifying', () => {
    assert.throws(() => classifyOnceOutcome('not-a-date', Date.now()), /not parseable/);
  });

  console.log('\n-- role-gate shape classifiers (A2), against literal extracts of the real deployed source');
  // These snippets are trimmed, literal excerpts of the ACTUAL flows.json node
  // source (verified 2026-09-17, this repo) -- not hand-invented shapes -- so
  // this selftest catches drift if a future refactor changes the pattern this
  // classifier depends on.
  const REAL_ADMIN_ROUTER_SNIPPET =
    "return (async () => {\nconst respond = function(statusCode, payload) {\nmsg.statusCode = statusCode;\n" +
    "return msg;\n};\nif (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {\n" +
    "  return respond(404, { message: 'Not found' });\n}\nlet db;\n";
  const REAL_ROLE_ASSERT_SNIPPET =
    "const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';\nif (scopedOn) {\n" +
    "  const scopeLoad = osiLib.require('scope');\n  if (!scopeLoad.ok) { }\n" +
    "  const roleDb = new osiDb.Database('/data/db/farming.db');\n  try {\n" +
    "    await scopeLoad.value.assertAuthenticatedRole(roleDb, auth, 'admin', { scopedMode: true });\n  } catch (e) {}\n}\n";
  await check('the admin-router classifier matches the real scoped-admin-account-router shape', () => {
    assert.strictEqual(hasAdminRouterScopedGate(REAL_ADMIN_ROUTER_SNIPPET), true);
  });
  await check('the admin-router classifier does NOT match the reboot/fan shape', () => {
    assert.strictEqual(hasAdminRouterScopedGate(REAL_ROLE_ASSERT_SNIPPET), false);
  });
  await check('the scoped-only-role-assert classifier matches the real reboot/fan shape', () => {
    assert.strictEqual(hasScopedOnlyRoleAssert(REAL_ROLE_ASSERT_SNIPPET), true);
  });
  await check('the scoped-only-role-assert classifier does NOT match the admin-router shape', () => {
    assert.strictEqual(hasScopedOnlyRoleAssert(REAL_ADMIN_ROUTER_SNIPPET), false);
  });
  await check('both classifiers return false on empty/undefined source rather than throwing', () => {
    assert.strictEqual(hasAdminRouterScopedGate(undefined), false);
    assert.strictEqual(hasScopedOnlyRoleAssert(null), false);
  });

  console.log('\n-- route-table parsing (R1b), against fixture `ip route show` text');
  const ROUTE_SHOW_WITH_BLACKHOLE = 'default via 10.0.0.1 dev eth0\nblackhole 203.0.113.9\n10.0.0.0/24 dev eth0 scope link';
  const ROUTE_SHOW_WITHOUT = 'default via 10.0.0.1 dev eth0\n10.0.0.0/24 dev eth0 scope link';
  await check('hasBlackholeRoute finds an exact-match blackhole entry', () => {
    assert.strictEqual(hasBlackholeRoute(ROUTE_SHOW_WITH_BLACKHOLE, '203.0.113.9'), true);
  });
  await check('hasBlackholeRoute finds a /32-suffixed blackhole entry', () => {
    assert.strictEqual(hasBlackholeRoute('blackhole 203.0.113.9/32\n', '203.0.113.9'), true);
  });
  await check('hasBlackholeRoute is false when no blackhole route exists', () => {
    assert.strictEqual(hasBlackholeRoute(ROUTE_SHOW_WITHOUT, '203.0.113.9'), false);
  });
  await check('hasBlackholeRoute does not false-positive on a DIFFERENT blackholed IP', () => {
    assert.strictEqual(hasBlackholeRoute(ROUTE_SHOW_WITH_BLACKHOLE, '203.0.113.99'), false);
  });
  await check('hasBlackholeRoute is false on an empty ip', () => {
    assert.strictEqual(hasBlackholeRoute(ROUTE_SHOW_WITH_BLACKHOLE, ''), false);
  });
  await check('firstIpv4 extracts an address from getent-style output', () => {
    assert.strictEqual(firstIpv4('bovey.cloud has address 203.0.113.9\n'), '203.0.113.9');
  });
  await check('firstIpv4 returns null when nothing IPv4-shaped is present', () => {
    assert.strictEqual(firstIpv4('no addresses found'), null);
  });
  await check('parsePingResolvedIp ties the address to the pinged host (BusyBox format), not a DNS resolver ' +
    'line that might precede it', () => {
    assert.strictEqual(parsePingResolvedIp('PING bovey.cloud (83.228.220.63): 56 data bytes\n64 bytes from ...'), '83.228.220.63');
  });
  await check('parsePingResolvedIp handles the iputils spelling too', () => {
    assert.strictEqual(parsePingResolvedIp('PING bovey.cloud (203.0.113.9) 56(84) bytes of data.'), '203.0.113.9');
  });
  await check('parsePingResolvedIp does NOT pick up a resolver address from an unrelated preceding line ' +
    '(the exact bug this function exists to avoid)', () => {
    const nslookupLikeNoise = 'Server:\t\t100.100.100.100\nAddress:\t100.100.100.100:53\n\n' +
      'PING bovey.cloud (83.228.220.63): 56 data bytes';
    assert.strictEqual(parsePingResolvedIp(nslookupLikeNoise), '83.228.220.63');
  });
  await check('parsePingResolvedIp returns null on a resolution failure line', () => {
    assert.strictEqual(parsePingResolvedIp("ping: bad address 'no-such-host.invalid'"), null);
  });

  console.log('\n-- next_run / DST reference (S2), against the REAL osi-valve-control/plan.js, required directly');
  await check('plan.js loads standalone from this repo checkout (no gateway globals needed)', () => {
    assert.strictEqual(typeof planRef.nextRun, 'function');
    assert.strictEqual(typeof planRef.nextLocalOccurrence, 'function');
  });
  await check('nextRun honours the weekday mask and lands on the correct calendar day at a +14h offset ' +
    '(Pacific/Kiritimati)', () => {
    const result = planRef.nextRun(
      [{ enabled: 1, kind: 'WEEKLY', weekdays_mask: 1, start_time: '23:59', timezone: 'Pacific/Kiritimati',
        duration_minutes: 10, schedule_uuid: 'fixture' }],
      new Date('2026-09-17T00:00:00Z'), // a Thursday
      'UTC'
    );
    assert.ok(result, 'nextRun returned null');
    const parts = planRef.localParts(new Date(result.at), 'Pacific/Kiritimati');
    assert.strictEqual(parts.weekday, 0, 'expected the next Sunday');
    assert.strictEqual(parts.hour, 23);
    assert.strictEqual(parts.minute, 59);
  });
  await check('nextRun lands on the correct calendar day at a -11h offset (Pacific/Pago_Pago)', () => {
    const result = planRef.nextRun(
      [{ enabled: 1, kind: 'WEEKLY', weekdays_mask: 1, start_time: '00:00', timezone: 'Pacific/Pago_Pago',
        duration_minutes: 5, schedule_uuid: 'fixture' }],
      new Date('2026-09-17T00:00:00Z'),
      'UTC'
    );
    assert.ok(result);
    const parts = planRef.localParts(new Date(result.at), 'Pacific/Pago_Pago');
    assert.strictEqual(parts.weekday, 0);
    assert.strictEqual(parts.hour, 0);
    assert.strictEqual(parts.minute, 0);
  });
  await check('offsetMinutes reports the expected fixed (no-DST) offsets', () => {
    assert.strictEqual(planRef.offsetMinutes(new Date('2026-09-17T00:00:00Z'), 'Pacific/Kiritimati'), 840);
    assert.strictEqual(planRef.offsetMinutes(new Date('2026-09-17T00:00:00Z'), 'Pacific/Pago_Pago'), -660);
  });
  await check('nextLocalOccurrence resolves a nonexistent time in the 2026 Europe/Zurich spring-forward gap ' +
    'to a real instant on the correct calendar day', () => {
    const occ = planRef.nextLocalOccurrence(new Date('2026-03-27T00:00:00Z'), 'Europe/Zurich', 0, 2, 30);
    assert.ok(occ, 'expected a resolved instant, not null');
    const parts = planRef.localParts(occ, 'Europe/Zurich');
    assert.strictEqual(parts.year, 2026); assert.strictEqual(parts.month, 3); assert.strictEqual(parts.day, 29);
  });
  await check('nextLocalOccurrence resolves an ambiguous time in the 2026 Europe/Zurich fall-back repeat ' +
    'deterministically to the correct calendar day', () => {
    const occ = planRef.nextLocalOccurrence(new Date('2026-10-23T00:00:00Z'), 'Europe/Zurich', 0, 2, 30);
    assert.ok(occ);
    const parts = planRef.localParts(occ, 'Europe/Zurich');
    assert.strictEqual(parts.year, 2026); assert.strictEqual(parts.month, 10); assert.strictEqual(parts.day, 25);
  });
  await check('isDstTransitionWithin detects the spring-forward transition and reports none on an ordinary day', () => {
    assert.strictEqual(planRef.isDstTransitionWithin('Europe/Zurich', Date.UTC(2026, 2, 29, 0), Date.UTC(2026, 2, 29, 23)), true);
    assert.strictEqual(planRef.isDstTransitionWithin('Europe/Zurich', Date.UTC(2026, 5, 15, 0), Date.UTC(2026, 5, 15, 23)), false);
  });

  // End to end through the real Rest client against a loopback stub, which is
  // what the transcript actually records during a run.
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token: 'header.signature', message: 'ok' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const transcript = [];
    const rest = new Rest('http://127.0.0.1:' + port, { transcript });
    await rest.post('/auth/register', { username: 'osi_selftest', password: 'sup3r-s3cret-value' });
    await rest.get('/api/me', { token: 'tok3n.s1gnature' });

    await check('a recorded register call shows [redacted] instead of the password', () => {
      const rec = transcript.find((r) => r.path === '/auth/register');
      assert.ok(rec, 'the register call was recorded');
      assert.strictEqual(rec.requestBody.password, REDACTED);
      assert.strictEqual(rec.requestBody.username, 'osi_selftest');
    });
    await check('the password never appears anywhere in the serialized transcript', () => {
      const serialized = JSON.stringify(transcript);
      assert.ok(!serialized.includes('sup3r-s3cret-value'), 'the password leaked into the transcript');
      assert.ok(!serialized.includes('tok3n.s1gnature'), 'the bearer token leaked into the transcript');
      assert.ok(!serialized.includes('header.signature'), 'the issued token leaked into the transcript');
      assert.ok(serialized.includes(REDACTED), 'nothing was redacted at all');
    });
    await check('a token in a response body is redacted', () => {
      const rec = transcript.find((r) => r.path === '/auth/register');
      assert.strictEqual(rec.responseBody.token, REDACTED);
      assert.strictEqual(rec.responseBody.message, 'ok');
    });
    await check('the Authorization header is redacted in the recorded request', () => {
      const rec = transcript.find((r) => r.path === '/api/me');
      assert.strictEqual(rec.requestHeaders.Authorization, REDACTED);
      assert.strictEqual(rec.authenticated, true);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('');
  if (failures.length) {
    console.log('FAIL: ' + failures.length + ' self-test assertion(s) failed, ' + passed + ' passed');
    for (const f of failures) console.log('  - ' + f.name + ': ' + f.error);
    return 1;
  }
  console.log('PASS: ' + passed + ' self-test assertions passed (offline; no gateway contacted)');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('SELFTEST ERROR: ' + e.stack);
  process.exit(2);
});
