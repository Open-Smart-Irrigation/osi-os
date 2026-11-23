#!/usr/bin/env node
'use strict';
// Issue #766 in the shipped Node-RED runtime (3.1.15, the release-smoke
// fixture). The shipped cloud broker node reads auto-connect from
// "${OSI_CLOUD_BROKER_AUTOCONNECT}"; node-red.init exports "false" on an
// unlinked gateway, removes the credentials from flows_cred.json and leaves
// DEVICE_MQTT_PASSWORD empty. Node-RED substitutes the variable into the
// config node, so nothing reaches the broker: no CONNECT and no PUBLISH. The
// linked case ("true") is the positive control.
//
// The broker node, the heartbeat guard and its MQTT output are the shipped
// nodes of each profile. Two test-only changes: the broker URL points at a
// local aedes broker, and the protocol is MQTT 3.1.1, which aedes speaks.
//
// Run: node scripts/test-cloud-broker-unlinked-node-red.js
// (needs npm ci --prefix scripts/fixtures/release-smoke)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = process.env.OSI_RELEASE_SMOKE_FIXTURE || path.join(ROOT, 'scripts/fixtures/release-smoke');
const fixtureRequire = Module.createRequire(path.join(FIXTURE, 'package.json'));
const BROKER_ID = 'ec43625ea99685a6';
const GUARD_ID = 'account-cloud-guard-d769e9face3844d5';
const OUT_ID = 'd769e9face3844d5';
const EUI = '0016C001F1000001';
const MESSAGES = 5;

const AUTOCONNECT_PLACEHOLDER = '${OSI_CLOUD_BROKER_AUTOCONNECT}';
const CASES = {
  // What node-red.init leaves on an unlinked gateway.
  unlinked: { password: '', autoConnect: 'false', creds: false },
  // An unlinked gateway on an init that exports no auto-connect value and
  // keeps the credentials: the placeholder stays unresolved, which the broker
  // node reads as true. The guard alone still keeps every message off.
  'unlinked-old-init': { password: '', autoConnect: undefined, creds: true },
  linked: { password: 'fixture-mqtt', autoConnect: 'true', creds: true },
};

async function child(profile, name) {
  const scenario = CASES[name];
  const share = path.join(ROOT, 'conf', profile, 'files/usr/share');
  const shipped = JSON.parse(fs.readFileSync(path.join(share, 'flows.json'), 'utf8'));
  const pick = (id) => { const n = shipped.find((x) => x.id === id); assert.ok(n, 'missing shipped node ' + id); return structuredClone(n); };

  const aedes = fixtureRequire('aedes')();
  const seen = { connects: [], publishes: [] };
  aedes.on('client', (client) => seen.connects.push(client.id));
  aedes.authenticate = (client, username, password, done) => {
    seen.connects.push('auth:' + (username || '<none>'));
    done(null, true);
  };
  aedes.on('publish', (packet, client) => { if (client) seen.publishes.push(packet.topic); });
  const brokerServer = net.createServer(aedes.handle);
  await new Promise((resolve) => brokerServer.listen(0, '127.0.0.1', resolve));
  const brokerUrl = 'mqtt://127.0.0.1:' + brokerServer.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-766-runtime-'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(path.join(share, 'node-red/osi-lib'), path.join(dir, 'node_modules/osi-lib'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'osi-lib': 'file:osi-lib' } }));

  const broker = pick(BROKER_ID);
  assert.equal(broker.autoConnect, AUTOCONNECT_PLACEHOLDER, 'shipped flows.json reads auto-connect from the environment');
  Object.assign(broker, { broker: brokerUrl, port: '', protocolVersion: '4', clientid: 'device_' + EUI });
  delete broker.credentials;
  const tab = pick(pick(OUT_ID).z);
  const inject = { id: 'test-inject', type: 'inject', z: tab.id, name: 'test', props: [{ p: 'payload' }], repeat: '', once: false, topic: '', payload: '', payloadType: 'date', wires: [[GUARD_ID]] };
  const flows = [tab, broker, pick(GUARD_ID), pick(OUT_ID), inject];
  fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows));
  fs.writeFileSync(path.join(dir, 'flows_cred.json'), JSON.stringify(scenario.creds ? { [BROKER_ID]: { user: EUI, password: 'old-secret' } } : {}));

  process.env.DEVICE_MQTT_PASSWORD = scenario.password;
  if (scenario.autoConnect === undefined) delete process.env.OSI_CLOUD_BROKER_AUTOCONNECT;
  else process.env.OSI_CLOUD_BROKER_AUTOCONNECT = scenario.autoConnect;
  process.env.DEVICE_EUI = EUI;
  process.env.OSI_LIB_BASE = path.join(share, 'node-red');
  const RED = fixtureRequire('node-red');
  const express = fixtureRequire('express');
  const app = express();
  const server = http.createServer(app);
  const cleanFs = { existsSync: () => false, readdirSync: () => [], readFileSync: fs.readFileSync };
  RED.init(server, {
    userDir: dir, flowFile: path.join(dir, 'flows.json'), credentialSecret: false,
    httpAdminRoot: false, functionExternalModules: true,
    externalModules: { modules: { allowInstall: false } },
    functionGlobalContext: { fs: cleanFs },
    logging: { console: { level: 'off', metrics: false, audit: false } },
  });
  app.use('/', RED.httpNode);
  await RED.start();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(1500);
  for (let i = 0; i < MESSAGES; i++) {
    RED.nodes.getNode('test-inject').receive({ payload: { heartbeat: i }, topic: 'devices/' + EUI + '/heartbeat' });
    await sleep(200);
  }
  await sleep(2000);
  const brokerNode = RED.nodes.getNode(BROKER_ID);
  const resolved = String(brokerNode && brokerNode.autoConnect);
  await RED.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => aedes.close(resolve));
  await new Promise((resolve) => brokerServer.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  return { nodeRed: fixtureRequire('node-red/package.json').version, autoConnect: resolved, connects: seen.connects, publishes: seen.publishes };
}

function runChild(profile, name) {
  const result = spawnSync(process.execPath, [__filename, '--child', profile, name], { encoding: 'utf8', timeout: 60000 });
  const line = (result.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `${profile} ${name}: child produced no result (status ${result.status})\n${result.stderr}`);
  return JSON.parse(line.slice(7));
}

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4]).then(
    (out) => { process.stdout.write('RESULT ' + JSON.stringify(out) + '\n'); process.exit(0); },
    (error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exit(1); },
  );
} else {
  for (const profile of ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709']) {
    const linked = runChild(profile, 'linked');
    assert.equal(linked.nodeRed, '3.1.15');
    assert.ok(linked.connects.includes('auth:' + EUI), `${profile} linked: connects with the gateway credentials ${JSON.stringify(linked)}`);
    assert.equal(linked.publishes.filter((t) => t.endsWith('/heartbeat')).length, MESSAGES, `${profile} linked: every heartbeat arrives`);

    assert.equal(linked.autoConnect, 'true', `${profile} linked: the broker node resolved auto-connect to true`);
    const unlinked = runChild(profile, 'unlinked');
    assert.equal(unlinked.autoConnect, 'false', `${profile} unlinked: Node-RED substituted "false" into the config node`);
    assert.deepEqual(unlinked.connects, [], `${profile} unlinked: autoConnect false opens no connection`);
    assert.deepEqual(unlinked.publishes, [], `${profile} unlinked: no message reaches the broker`);

    const oldInit = runChild(profile, 'unlinked-old-init');
    assert.equal(oldInit.autoConnect, 'true', `${profile} unresolved placeholder reads as auto-connect on`);
    assert.deepEqual(oldInit.publishes, [], `${profile} unlinked, old init: the guard drops every message`);
    console.log(`${profile}: linked ${linked.connects.length} connect events / ${linked.publishes.length} publishes; unlinked 0 / 0; old init ${oldInit.connects.length} connect events / 0 publishes`);
  }
  console.log('PASS: an unlinked gateway opens no cloud broker connection and publishes nothing (Node-RED 3.1.15)');
}
