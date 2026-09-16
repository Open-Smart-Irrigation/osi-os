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

const {
  config, assertEndpointsAllowed, assertEndpointGuardPassed, hostOf, isLoopback,
  assertSimulatedDevice, simDeveui, ENDPOINT_GUARD_PASSED, DEFAULTS,
} = require('./lib/config');
const { Rest, redact, redactHeaders, isSecretKey, REDACTED } = require('./lib/rest');
const { Ssh } = require('./lib/ssh');
const { DownlinkObserver } = require('./lib/observer');

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
  refuses('a non-Silvan SSH host is refused without SILVAN_ALLOW_ALT_HOST',
    { sshHost: '10.0.0.9', apiBase: 'http://10.0.0.9:1880', guiBase: 'http://10.0.0.9:1880/gui/', mqttHost: '10.0.0.9' },
    { SILVAN_ALLOW_ALT_HOST: undefined });
  await check('a non-Silvan SSH host is allowed only with SILVAN_ALLOW_ALT_HOST, and only when every endpoint follows it', () => {
    withEnv(ALT, () => {
      assertEndpointsAllowed(Object.assign({}, DEFAULTS, {
        sshHost: '10.0.0.9', apiBase: 'http://10.0.0.9:1880',
        guiBase: 'http://10.0.0.9:1880/gui/', mqttHost: '10.0.0.9',
      }));
    });
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
