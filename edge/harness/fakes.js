'use strict';
// Outer boundaries for a backend under test that is not Node-RED: the same
// aedes broker (local ChirpStack MQTT) and the same gRPC DeviceService
// stand-in the release-smoke oracle uses (scripts/fixtures/release-smoke/radio.js),
// plus the control endpoints the recorder reads (/radio, /mqtt).
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const Module = require('node:module');
const fixture = path.resolve(__dirname, '../../scripts/fixtures/release-smoke');
const load = Module.createRequire(path.join(fixture, 'package.json'));
const READY = process.env.OSI_FAKES_READY_FILE;
const { startCloud } = require('./lib/cloud');
let cloud;
(async () => {
  if (process.env.OSI_HARNESS_CLOUD === '1') cloud = await startCloud(path.dirname(READY), { connectDetails: process.env.OSI_HARNESS_CONNECT_DETAILS === '1' });
  const state = { cs: { queue: {}, calls: [] }, mqtt: [] };
  const { broker, port: mqtt } = await require('./lib/local-broker').startLocalBroker();
  broker.on('publish', (packet, client) => { if (client) state.mqtt.push({ topic: packet.topic, payload: packet.payload.toString() }); });
  // Same contract as radio.js (url/stop) so this stays a one-line swap, but
  // the fuller stand-in also carries the device claim/rename RPCs.
  const radio = await require('./chirpstack-standin').start(state, load);
  const control = http.createServer(async (req, res) => {
    const send = (b, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/radio') return send(state.cs.calls);
    if (req.url === '/mqtt') return send(state.mqtt);
    if (req.url === '/stop') {
      res.once('finish', () => process.exit(res.statusCode === 200 ? 0 : 2));
      try { await cloud?.close(); return send({ ok: true }); }
      catch (error) { return send({ error: String(error) }, 500); }
    }
    try {
      if (cloud && req.url === '/cloud') {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (body) await cloud.control(JSON.parse(body).action);
        return send(cloud.packets());
      }
    } catch (error) { return send({ error: String(error) }, 500); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));
  fs.writeFileSync(READY, JSON.stringify({ mqtt, radio: radio.url, control: control.address().port, cloud: cloud?.url, pid: process.pid }) + '\n');
})().catch(async (e) => {
  console.error('FAKES FAILED', e && e.stack || e);
  try { await cloud?.close(); } finally { process.exit(2); }
});
