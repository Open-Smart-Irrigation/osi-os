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
//   self-signed   a self-signed server certificate is refused: no TLS
//                 session completes, no MQTT CONNECT, no credentials leave
//                 the client, no publish reaches the broker.
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
//                 enable verification (the client connects to the
//                 self-signed broker), which is why the shipped property
//                 must stay the literal boolean true.
//
// Throwaway certificates are generated with openssl at run time; nothing
// here is a real credential.
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

  const certDir = path.join(os.tmpdir(), 'osi-broker-tls-certs');
  const aedes = fixtureRequire('aedes')();
  const seen = { authenticates: [], publishes: [], tlsClientErrors: [], connectsBeforeSwap: 0, swapped: false };
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
  const publishAll = async () => {
    for (let i = 0; i < MESSAGES; i++) {
      RED.nodes.getNode('test-inject').receive({ payload: { i }, topic: 'devices/' + EUI + '/heartbeat' });
      await sleep(150);
    }
  };
  const waitConnected = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const node = RED.nodes.getNode(BROKER_ID);
      if (node && node.connected) return true;
      await sleep(250);
    }
    return false;
  };

  let connectedDuringRun = false;
  if (kase === 'trusted-ca' || kase === 'placeholder') {
    connectedDuringRun = await waitConnected(10000);
    await publishAll();
    await sleep(1500);
  } else if (kase === 'recover') {
    await sleep(4000); // a few refused attempts on the unverified certificate
    const node = RED.nodes.getNode(BROKER_ID);
    connectedDuringRun = !!(node && node.connected);
    await publishAll(); // dropped while not connected
    await sleep(500);
    swapCertificate();
    connectedDuringRun = await waitConnected(10000);
    await publishAll();
    await sleep(1500);
  } else {
    await sleep(5000); // refused attempts only
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

function runChild(profile, kase, extraCa) {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.OSI_CLOUD_BROKER_AUTOCONNECT;
  delete env.OSI_CLOUD_BROKER_URL;
  delete env.OSI_UNSET_VERIFY;
  env.DEVICE_EUI = EUI;
  env.DEVICE_MQTT_PASSWORD = 'fixture-mqtt';
  if (extraCa) env.NODE_EXTRA_CA_CERTS = extraCa;
  const result = spawnSync(process.execPath, [__filename, '--child', profile, kase], { encoding: 'utf8', timeout: 90000, env });
  const line = (result.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `${profile} ${kase}: child produced no result (status ${result.status})\n${result.stderr}`);
  return JSON.parse(line.slice(7));
}

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
  const certDir = path.join(os.tmpdir(), 'osi-broker-tls-certs');
  fs.rmSync(certDir, { recursive: true, force: true });
  fs.mkdirSync(certDir, { recursive: true });
  makeCertificates(certDir);
  const caPem = path.join(certDir, 'ca.pem');

  for (const profile of PROFILES) {
    const selfSigned = runChild(profile, 'self-signed', null);
    assert.equal(selfSigned.nodeRed, '3.1.15');
    assert.equal(selfSigned.connected, false, `${profile} self-signed: the client never completes a connection`);
    assert.deepEqual(selfSigned.authenticates, [], `${profile} self-signed: no MQTT CONNECT, so no credentials reach the broker`);
    assert.equal(selfSigned.publishes, 0, `${profile} self-signed: nothing is published`);

    const untrusted = runChild(profile, 'untrusted-ca', null);
    assert.equal(untrusted.connected, false, `${profile} untrusted CA: the client never completes a connection`);
    assert.deepEqual(untrusted.authenticates, [], `${profile} untrusted CA: no credentials reach the broker`);
    assert.equal(untrusted.publishes, 0, `${profile} untrusted CA: nothing is published`);

    const trusted = runChild(profile, 'trusted-ca', caPem);
    assert.equal(trusted.connected, true, `${profile} trusted CA: connects when the CA is injected into the child process`);
    assert.ok(trusted.authenticates.includes(EUI), `${profile} trusted CA: connects with the gateway credentials ${JSON.stringify(trusted)}`);
    assert.equal(trusted.publishes, MESSAGES, `${profile} trusted CA: every publish arrives`);

    const recover = runChild(profile, 'recover', caPem);
    assert.equal(recover.connectsBeforeSwap, 0, `${profile} recover: the unverified certificate is refused first`);
    assert.equal(recover.connected, true, `${profile} recover: reconnects after the certificate swap without a restart`);
    assert.equal(recover.publishes, MESSAGES, `${profile} recover: publishes after recovery`);

    const placeholder = runChild(profile, 'placeholder', null);
    assert.equal(placeholder.connected, true, `${profile} placeholder: an unresolved env value does not enable verification (the shipped property must stay the literal boolean)`);
    assert.equal(placeholder.publishes, MESSAGES, `${profile} placeholder: the client behaves as if verification were off`);
    console.log(`${profile}: self-signed refused (tls errors ${JSON.stringify(selfSigned.tlsClientErrors)}); untrusted CA refused; trusted CA ${trusted.publishes} publishes; recovered ${recover.publishes} after swap; placeholder connects ${placeholder.connected}`);
  }
  fs.rmSync(certDir, { recursive: true, force: true });
  console.log('PASS: the cloud broker refuses a certificate that does not verify and recovers after a trusted swap (Node-RED 3.1.15)');
}
