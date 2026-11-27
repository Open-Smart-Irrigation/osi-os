'use strict';
// T1 oracle: boots the shipped flows through the release-smoke runtime,
// unmodified (scripts/fixtures/release-smoke/runtime.js), and exposes the
// boundaries a backend-neutral recorder needs:
//   - the product HTTP listener (the :1880 equivalent),
//   - a TCP relay to the in-process broker (local ChirpStack MQTT stand-in),
//   - a control listener: inject a timer node, read radio calls and MQTT
//     publications, wait for the flows to settle, back up the database.
// The recorder reads the database from its own process; this process never
// loads a second SQLite library (release-smoke README, "What runs").
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net'), Module = require('node:module');
const RUN = process.env.OSI_SMOKE_RUN;
const READY = process.env.OSI_ORACLE_READY_FILE;
if (!READY) throw new Error('OSI_ORACLE_READY_FILE is required');
const { startCloud } = require('./lib/cloud');
const runtime = require('../../scripts/fixtures/release-smoke/runtime');
const fixtureLoad = Module.createRequire(path.resolve(__dirname, '../../scripts/fixtures/release-smoke/package.json'));

let cloud;
(async () => {
  const externalCloud = process.env.OSI_HARNESS_CLOUD_URL;
  const localPort = process.env.OSI_HARNESS_LOCAL_PORT;
  const connect = JSON.parse(process.env.OSI_HARNESS_CLOUD_CONNECT || 'null');
  if (!externalCloud && process.env.OSI_HARNESS_CLOUD === '1') cloud = await startCloud(RUN, { connectDetails: !!connect });
  if (cloud || externalCloud) {
    // Loading runtime sets the smoke defaults. Override them before RED.start().
    process.env.OSI_CLOUD_BROKER_URL = externalCloud || cloud.url;
    process.env.DEVICE_MQTT_PASSWORD = 'synthetic';
    // Mirror node-red.init provisioning on the disposable runtime copy.
    // Node-RED expands the URL, but needs a literal client ID and a credential store.
    const flowsFile = path.join(RUN, 'flows.json');
    const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
    const broker = flows.find((n) => n.type === 'mqtt-broker' && n.name === 'OSI Cloud Broker');
    if (!broker) throw new Error('OSI Cloud Broker is missing');
    const credentials = {};
    if (connect) {
      process.env.DEVICE_EUI = connect.eui;
      process.env.DEVICE_MQTT_PASSWORD = connect.password;
      if (connect.previous) {
        broker.clientid = 'device_' + connect.previous.eui;
        credentials[broker.id] = { user: connect.previous.eui, password: connect.previous.password };
      }
    }
    const { DEVICE_EUI: eui, DEVICE_MQTT_PASSWORD: password } = process.env;
    if (!connect || eui) broker.clientid = 'device_' + eui;
    if (!connect || (eui && password)) credentials[broker.id] = { user: eui, password };
    fs.writeFileSync(flowsFile, JSON.stringify(flows));
    if (Object.keys(credentials).length) {
      fs.writeFileSync(path.join(RUN, 'flows_cred.json'), JSON.stringify(credentials), { mode: 0o600 });
    }
  }
  if (localPort) {
    // Point the disposable copy at the shared Aedes instance. The smoke
    // runtime redirects port 1883 to its own broker, so use the allocated port.
    const flowsFile = path.join(RUN, 'flows.json');
    const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
    const broker = flows.find((n) => n.type === 'mqtt-broker' && n.clientid === 'nodered');
    if (!broker) throw new Error('local MQTT broker is missing');
    broker.port = localPort;
    fs.writeFileSync(flowsFile, JSON.stringify(flows));
  }
  // The smoke runtime disables httpStatic. Reattach the shipped CLI's
  // Express mount to its app with the image settings and the synthetic root.
  const RED = fixtureLoad('node-red');
  const init = RED.init;
  RED.init = function (server, settings) {
    RED.init = init;
    const result = init.call(this, server, settings);
    if (process.env.OSI_EDGE_GUI_DIR) {
      const app = server.listeners('request')[0];
      app.use(settings.httpStaticRoot, fixtureLoad('express').static(process.env.OSI_EDGE_GUI_DIR));
    }
    return result;
  };
  const h = await runtime.start();
  // The fuller ChirpStack stand-in on the same state object. The helper reads
  // CHIRPSTACK_API_URL per call through env.get, so repointing it after
  // runtime.start() replaces the release-smoke radio.js boundary (still
  // running, now idle) without touching scripts/fixtures/release-smoke.
  const standin = await require('./chirpstack-standin').start(h.state, fixtureLoad);
  process.env.CHIRPSTACK_API_URL = standin.url;
  Object.assign(process.env, standin.env);
  // Scoped access is read through env.get at call time; the runtime sets 0.
  if (process.env.OSI_ORACLE_SCOPED === '1') process.env.OSI_SCOPED_ACCESS = '1';
  const productPort = h.RED.server.address().port;
  // Relay: connections to 127.0.0.1:1883 are redirected by the runtime's
  // socket belt to the in-process broker; this listener lets another process in.
  const relay = net.createServer((inbound) => {
    const out = net.connect(1883, '127.0.0.1');
    inbound.pipe(out); out.pipe(inbound);
    const end = () => { inbound.destroy(); out.destroy(); };
    inbound.on('error', end); out.on('error', end); inbound.on('close', end); out.on('close', end);
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const control = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const input = body ? JSON.parse(body) : {};
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/settle') { await h.settle(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/inject') {
        h.inject(input.id, input.msg || { payload: Date.now() });
        await h.settle();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/radio') return json(res, 200, h.state.cs.calls);
      if (url.pathname === '/mqtt') return json(res, 200, h.state.mqtt);
      if (cloud && url.pathname === '/cloud') {
        if (input.action) await cloud.control(input.action);
        return json(res, 200, cloud.packets());
      }
      if (url.pathname === '/logs') return json(res, 200, h.state.logs);
      if (url.pathname === '/backup') {
        // VACUUM INTO through the runtime's own SQLite binding: a consistent copy.
        if (!input.to || !path.isAbsolute(input.to)) throw new Error('backup needs an absolute target');
        await h.sql('VACUUM INTO ?', input.to);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/stop') {
        res.once('finish', () => process.exit(res.statusCode === 200 ? 0 : 2));
        try { await h.stop(); } finally { try { await standin.stop(); } catch { /* exiting */ } await cloud?.close(); }
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'unknown control ' + url.pathname });
    } catch (e) { json(res, 500, { error: String(e && e.stack || e) }); }
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));
  const sqliteVersion = (await h.sql('SELECT sqlite_version() AS v'))[0].v;
  fs.writeFileSync(READY, JSON.stringify({ sqliteVersion, nodeVersion: process.versions.node,
    backend: 'node-red', http: productPort, mqtt: localPort ? Number(localPort) : relay.address().port, control: control.address().port,
    db: h.DBFILE, run: RUN, metadata: h.metadata, pid: process.pid,
  }) + '\n');
  console.log('ORACLE READY', productPort);
})().catch(async (e) => {
  console.error('ORACLE FAILED', e && e.stack || e);
  try { await cloud?.close(); } finally { process.exit(2); }
});
