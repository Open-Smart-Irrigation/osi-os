#!/usr/bin/env node
'use strict';
// Cloud broker certificate verification on the shipped Node-RED runtime
// (3.1.15, the release-smoke fixture), reusing the #766 harness pattern:
// each case runs the shipped "OSI Cloud Broker" config node of both profiles
// in a child process against a local wss broker (aedes over ws), with only
// test-local overrides (broker URL, MQTT 3.1.1, client id, auto-connect).
// verifyservercert is never overridden: it must come from the shipped node.
//
// Cases:
//   self-signed   a self-signed server certificate is refused: the server
//                 sees repeated TLS attempts, an in-process TLS probe with
//                 verification on reports the trust failure for the same
//                 port and trust store, no MQTT CONNECT, no credentials
//                 leave the client, no publish reaches the broker.
//   untrusted-ca  a certificate from a CA the process does not trust is
//                 refused the same way.
//   trusted-ca    a certificate from a CA injected through
//                 NODE_EXTRA_CA_CERTS (child process only) connects and
//                 every publish arrives: the refusals above are about
//                 trust, not about the transport.
//   recover       the server swaps its certificate for one from the trusted
//                 CA while running; the client recovers on its next retry
//                 without a restart.
//   placeholder   a "${...}" value in place of the literal boolean does not
//                 turn verification on (the in-process probe still refuses
//                 the certificate, but the client connects to it), which is
//                 why the shipped property must stay the literal boolean
//                 true.
//
// Throwaway certificates are generated with openssl at run time in a
// per-run scratch directory; nothing here is a real credential.
//
// Run: node scripts/test-cloud-broker-certificate-node-red.js
// (needs npm ci --prefix scripts/fixtures/release-smoke and openssl)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = process.env.OSI_RELEASE_SMOKE_FIXTURE || path.join(ROOT, 'scripts/fixtures/release-smoke');
const fixtureRequire = Module.createRequire(path.join(FIXTURE, 'package.json'));
const BROKER_ID = 'ec43625ea99685a6';
const EUI = '0016C001F1000001';
const MESSAGES = 5;
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
// Test-only settings: retry every 2 s so the recover case is quick (the
// shipped settings retry every 15 s).
const RECONNECT_MS = 2000;

function makeCertificates(dir) {
  const run = (args) => {
    const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `openssl ${args.join(' ')} failed:\n${result.stderr}`);
  };
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
  run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-nodes',
    '-subj', '/CN=OSI loopback test CA']);
  run(['req', '-newkey', 'rsa:2048', '-keyout', 'srv.key', '-out', 'srv.csr', '-nodes', '-subj', '/CN=localhost']);
  run(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf']);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'self.key', '-out', 'self.pem', '-days', '2', '-nodes',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost']);
}

async function child(profile, kase) {
  const share = path.join(ROOT, 'conf', profile, 'files/usr/share');
  const shipped = JSON.parse(fs.readFileSync(path.join(share, 'flows.json'), 'utf8'));
  const broker = structuredClone(shipped.find((n) => n.id === BROKER_ID));
  assert.ok(broker, 'missing shipped node ' + BROKER_ID);
  // Only test-local overrides; verifyservercert stays whatever the shipped
  // node carries, and the placeholder case below is the documented exception.
  Object.assign(broker, { broker: '', port: '', protocolVersion: '4', clientid: 'device_' + EUI, autoConnect: true });
  delete broker.credentials;
  if (kase === 'placeholder') broker.verifyservercert = '${OSI_UNSET_VERIFY}';

  // Per-run scratch directory created by the parent (mkdtemp) and passed
  // through the environment, so concurrent runs never share certificates.
  const certDir = process.env.OSI_BROKER_TLS_CERTDIR;
  assert.ok(certDir, 'OSI_BROKER_TLS_CERTDIR must point at the per-run certificate directory');
  const aedes = fixtureRequire('aedes')();
  // Client-side connection errors, from the mqtt client the broker node
  // owns (its own error handler is empty), so a refusal can be told apart
  // from a harness that never dials.
  const seen = { authenticates: [], publishes: [], tlsClientErrors: [], clientErrors: [], connectsBeforeSwap: 0, swapped: false };
  aedes.on('client', (client) => { if (!seen.swapped) seen.connectsBeforeSwap += 1; });
  aedes.authenticate = (client, username, password, done) => {
    seen.authenticates.push(username || '<none>');
    done(null, true);
  };
  aedes.on('publish', (packet, client) => { if (client) seen.publishes.push(packet.topic); });

  const https = require('node:https');
  // untrusted-ca and trusted-ca serve the CA-signed certificate (the child
  // differs only in whether it trusts the CA); every other case starts on
  // the self-signed one. recover starts self-signed (refused even with the
  // CA injected: it is not signed by it) and swaps to the CA-signed pair.
  const serverCert = kase === 'untrusted-ca' || kase === 'trusted-ca' ? 'srv' : 'self';
  const server = https.createServer({
    key: fs.readFileSync(path.join(certDir, serverCert + '.key')),
    cert: fs.readFileSync(path.join(certDir, serverCert + '.pem')),
  });
  server.on('tlsClientError', (error) => seen.tlsClientErrors.push(error.code || error.message));
  const WS = fixtureRequire('ws');
  const wss = new WS.Server({ server, path: '/mqtt' });
  wss.on('connection', (ws) => aedes.handle(WS.createWebSocketStream(ws)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  broker.broker = 'wss://127.0.0.1:' + server.address().port + '/mqtt';
  const swapCertificate = () => {
    seen.swapped = true;
    server.setSecureContext({
      key: fs.readFileSync(path.join(certDir, 'srv.key')),
      cert: fs.readFileSync(path.join(certDir, 'srv.pem')),
    });
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-broker-tls-runtime-'));
  const tab = { id: 't1', type: 'tab', label: 't', disabled: false, info: '' };
  const out = { id: 'o1', type: 'mqtt out', z: 't1', name: '', topic: '', qos: '1', retain: '', respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker: BROKER_ID, wires: [] };
  const inject = { id: 'test-inject', type: 'inject', z: 't1', name: 'test', props: [{ p: 'payload' }], repeat: '', once: false, topic: '', payload: '', payloadType: 'date', wires: [['o1']] };
  fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([tab, broker, out, inject]));
  fs.writeFileSync(path.join(dir, 'flows_cred.json'), JSON.stringify({ [BROKER_ID]: { user: EUI, password: 'fixture-mqtt' } }));

  const RED = fixtureRequire('node-red');
  const express = fixtureRequire('express');
  const app = express();
  const http = require('node:http');
  const httpServer = http.createServer(app);
  RED.init(httpServer, {
    userDir: dir, flowFile: path.join(dir, 'flows.json'), credentialSecret: false,
    httpAdminRoot: false, mqttReconnectTime: RECONNECT_MS,
    logging: { console: { level: 'off', metrics: false, audit: false } },
  });
  app.use('/', RED.httpNode);
  await RED.start();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(250);
    }
    return predicate();
  };
  // The broker node's mqtt client appears once the flow (and its config
  // node with credentials) finishes loading; attach the error hook by
  // polling for it rather than assuming it exists the moment start()
  // resolves. mqtt.js only re-emits socket-class stream errors on its
  // client and suppresses certificate errors, so whatever arrives here is
  // diagnostics; the asserted client-side reason comes from the direct TLS
  // probe below.
  const hooked = await waitFor(() => {
    const n = RED.nodes.getNode(BROKER_ID);
    return !!(n && n.client);
  }, 5000);
  assert.ok(hooked, 'the broker node exposes its mqtt client');
  RED.nodes.getNode(BROKER_ID).client.on('error', (error) => {
    seen.clientErrors.push(String((error && (error.code || error.message)) || error));
  });
  // Client-side reason, from the same process and trust store the mqtt
  // client uses: a direct TLS connection to the same broker port with
  // verification on. Refusal cases must fail here with a trust failure;
  // the trusted case must complete the handshake.
  const probeTls = () => new Promise((resolve) => {
    const socket = require('node:tls').connect(
      { host: '127.0.0.1', port: server.address().port, rejectUnauthorized: true },
      () => { socket.destroy(); resolve({ ok: true }); },
    );
    socket.on('error', (error) => resolve({ ok: false, error: String((error && (error.code || error.message)) || error) }));
  });
  const probe = await probeTls();
  const publishAll = async () => {
    for (let i = 0; i < MESSAGES; i++) {
      RED.nodes.getNode('test-inject').receive({ payload: { i }, topic: 'devices/' + EUI + '/heartbeat' });
      await sleep(150);
    }
  };
  const waitConnected = async (timeoutMs) => waitFor(() => {
    const node = RED.nodes.getNode(BROKER_ID);
    return !!(node && node.connected);
  }, timeoutMs);
  // A refusal is proven, not assumed: the server must see TLS attempts and
  // the in-process TLS probe must report a trust failure for them.
  const waitRefused = async () => waitFor(
    () => seen.tlsClientErrors.length >= 2,
    10000,
  );

  let connectedDuringRun = false;
  if (kase === 'trusted-ca' || kase === 'placeholder') {
    connectedDuringRun = await waitConnected(10000);
    await publishAll();
    await sleep(1500);
  } else if (kase === 'recover') {
    await waitRefused(); // refused attempts only, before the swap
    const node = RED.nodes.getNode(BROKER_ID);
    connectedDuringRun = !!(node && node.connected);
    await publishAll(); // dropped while not connected
    await sleep(500);
    swapCertificate();
    connectedDuringRun = await waitConnected(10000);
    await publishAll();
    await sleep(1500);
  } else {
    await waitRefused(); // the same 10 s window the success paths get
    const node = RED.nodes.getNode(BROKER_ID);
    connectedDuringRun = !!(node && node.connected);
    await publishAll(); // must all be dropped, never queued
    await sleep(1500);
  }
  const brokerNode = RED.nodes.getNode(BROKER_ID);
  const result = {
    nodeRed: fixtureRequire('node-red/package.json').version,
    kase, profile,
    verifyservercert: broker && broker.verifyservercert,
    rejectUnauthorized: brokerNode && brokerNode.options ? brokerNode.options.rejectUnauthorized : undefined,
    connected: connectedDuringRun,
    authenticates: seen.authenticates,
    publishes: seen.publishes.length,
    connectsBeforeSwap: seen.connectsBeforeSwap,
    tlsClientErrors: seen.tlsClientErrors.slice(0, 5),
    clientErrors: seen.clientErrors.slice(0, 5),
    tlsProbe: probe,
  };
  await RED.stop();
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => aedes.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

function runChild(profile, kase, extraCa, certDir) {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.OSI_CLOUD_BROKER_AUTOCONNECT;
  delete env.OSI_CLOUD_BROKER_URL;
  delete env.OSI_UNSET_VERIFY;
  // A proxy in the environment would route the loopback dial through it.
  for (const key of PROXY_ENV_KEYS) delete env[key];
  env.DEVICE_EUI = EUI;
  env.DEVICE_MQTT_PASSWORD = 'fixture-mqtt';
  env.OSI_BROKER_TLS_CERTDIR = certDir;
  if (extraCa) env.NODE_EXTRA_CA_CERTS = extraCa;
  const result = spawnSync(process.execPath, [__filename, '--child', profile, kase], { encoding: 'utf8', timeout: 90000, env });
  const line = (result.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `${profile} ${kase}: child produced no result (status ${result.status})\n${result.stderr}`);
  return JSON.parse(line.slice(7));
}

// A trust-failure signature, from the client-side TLS probe's error: either
// a Node TLS error code or the OpenSSL reason string in the message.
const TRUST_FAILURE = /SELF_SIGNED|self-signed|UNABLE_TO_VERIFY|unable to verify|unable to get local issuer|ALTNAME/i;

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4]).then(
    (out) => {
      out.extraCA = !!process.env.NODE_EXTRA_CA_CERTS;
      process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
      process.exit(0);
    },
    (error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exit(1); },
  );
} else {
  assert.equal(fixtureRequire('node-red/package.json').version, '3.1.15', 'the image Node-RED runtime is pinned');
  // Per-run certificate scratch (mkdtemp), removed even when an assertion
  // fails; the child only receives the directory through the environment.
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-broker-tls-'));
  try {
    makeCertificates(certDir);
    const caPem = path.join(certDir, 'ca.pem');

    for (const profile of PROFILES) {
      const selfSigned = runChild(profile, 'self-signed', null, certDir);
      assert.equal(selfSigned.nodeRed, '3.1.15');
      assert.equal(selfSigned.rejectUnauthorized, true, `${profile} self-signed: the client runs with certificate verification on`);
      assert.ok(!selfSigned.tlsProbe.ok && TRUST_FAILURE.test(selfSigned.tlsProbe.error), `${profile} self-signed: the in-process TLS probe reports a trust failure ${JSON.stringify(selfSigned.tlsProbe)}`);
      assert.ok(selfSigned.tlsClientErrors.length >= 2, `${profile} self-signed: the server saw repeated TLS attempts ${JSON.stringify(selfSigned)}`);
      assert.equal(selfSigned.connected, false, `${profile} self-signed: the client never completes a connection`);
      assert.deepEqual(selfSigned.authenticates, [], `${profile} self-signed: no MQTT CONNECT, so no credentials reach the broker`);
      assert.equal(selfSigned.publishes, 0, `${profile} self-signed: nothing is published`);

      const untrusted = runChild(profile, 'untrusted-ca', null, certDir);
      assert.equal(untrusted.rejectUnauthorized, true, `${profile} untrusted CA: the client runs with certificate verification on`);
      assert.ok(!untrusted.tlsProbe.ok && TRUST_FAILURE.test(untrusted.tlsProbe.error), `${profile} untrusted CA: the in-process TLS probe reports a trust failure ${JSON.stringify(untrusted.tlsProbe)}`);
      assert.ok(untrusted.tlsClientErrors.length >= 2, `${profile} untrusted CA: the server saw repeated TLS attempts ${JSON.stringify(untrusted)}`);
      assert.equal(untrusted.connected, false, `${profile} untrusted CA: the client never completes a connection`);
      assert.deepEqual(untrusted.authenticates, [], `${profile} untrusted CA: no credentials reach the broker`);
      assert.equal(untrusted.publishes, 0, `${profile} untrusted CA: nothing is published`);

      const trusted = runChild(profile, 'trusted-ca', caPem, certDir);
      assert.ok(trusted.tlsProbe.ok, `${profile} trusted CA: the in-process TLS probe completes the handshake ${JSON.stringify(trusted.tlsProbe)}`);
      assert.equal(trusted.connected, true, `${profile} trusted CA: connects when the CA is injected into the child process`);
      assert.ok(trusted.authenticates.includes(EUI), `${profile} trusted CA: connects with the gateway credentials ${JSON.stringify(trusted)}`);
      assert.equal(trusted.publishes, MESSAGES, `${profile} trusted CA: every publish arrives`);

      const recover = runChild(profile, 'recover', caPem, certDir);
      assert.ok(!recover.tlsProbe.ok && TRUST_FAILURE.test(recover.tlsProbe.error), `${profile} recover: the pre-swap certificate fails the in-process TLS probe ${JSON.stringify(recover.tlsProbe)}`);
      assert.equal(recover.connectsBeforeSwap, 0, `${profile} recover: the unverified certificate is refused first`);
      assert.equal(recover.connected, true, `${profile} recover: reconnects after the certificate swap without a restart`);
      assert.equal(recover.publishes, MESSAGES, `${profile} recover: publishes after recovery`);

      const placeholder = runChild(profile, 'placeholder', null, certDir);
      assert.ok(!placeholder.tlsProbe.ok && TRUST_FAILURE.test(placeholder.tlsProbe.error), `${profile} placeholder: the certificate still fails the in-process TLS probe ${JSON.stringify(placeholder.tlsProbe)}`);
      assert.equal(placeholder.rejectUnauthorized, false, `${profile} placeholder: an unresolved env value does not turn verification on (the shipped property must stay the literal boolean)`);
      assert.equal(placeholder.connected, true, `${profile} placeholder: the client connects as if verification were off`);
      assert.equal(placeholder.publishes, MESSAGES, `${profile} placeholder: the client behaves as if verification were off`);
      console.log(`${profile}: self-signed refused (probe ${JSON.stringify(selfSigned.tlsProbe)}); untrusted CA refused (probe ${JSON.stringify(untrusted.tlsProbe)}); trusted CA ${trusted.publishes} publishes; recovered ${recover.publishes} after swap; placeholder connects ${placeholder.connected}`);
    }
  } finally {
    fs.rmSync(certDir, { recursive: true, force: true });
  }
  console.log('PASS: the cloud broker refuses a certificate that does not verify and recovers after a trusted swap (Node-RED 3.1.15)');
}
