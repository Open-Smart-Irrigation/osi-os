'use strict';
// Real MQTT 5 broker behind a loopback, packet-recording TCP relay.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { Transform } = require('node:stream');
const load = createRequire(path.resolve(__dirname, '../../../scripts/fixtures/release-smoke/package.json'));
const podman = (...args) => promisify(execFile)('podman', args, {
  timeout: 60000,
  env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    HOME: process.env.OSI_HARNESS_PODMAN_HOME || process.env.HOME },
});
const IMAGE = 'docker.io/library/eclipse-mosquitto@sha256:09b62ff32c2e7b64d4b431b9a89236073289b68db273de2b089edeb9b0d92b5c'; // 2.0.22

function observation(p, direction, connectDetails) {
  const fields = { direction, cmd: p.cmd };
  if (p.messageId !== undefined) fields.messageId = p.messageId;
  if (p.reasonCode !== undefined || p.returnCode !== undefined) fields.reasonCode = p.reasonCode ?? p.returnCode;
  if (p.properties !== undefined) fields.properties = p.properties;
  switch (p.cmd) {
    case 'connect':
      return { ...fields, protocolVersion: p.protocolVersion, cleanStart: p.clean, keepalive: p.keepalive,
        clientId: p.clientId, usernamePresent: p.username !== undefined, passwordPresent: p.password !== undefined,
        ...(connectDetails && p.username !== undefined && { username: p.username }),
        ...(connectDetails && p.password !== undefined && { passwordSha256: createHash('sha256').update(p.password).digest('hex') }) };
    case 'connack':
      return { ...fields, sessionPresent: p.sessionPresent };
    case 'publish':
      return { ...fields, topic: p.topic, qos: p.qos, retain: p.retain, dup: p.dup, payload: p.payload.toString('base64') };
    case 'subscribe': return { ...fields, subscriptions: p.subscriptions };
    case 'unsubscribe': return { ...fields, unsubscriptions: p.unsubscriptions };
    case 'suback':
    case 'unsuback': return { ...fields, granted: p.granted };
    default: return fields;
  }
}

// Use the parser for framing and observation, then forward the original bytes.
function tap(parser, observe) {
  let pending = Buffer.alloc(0), offset = 0, parseError;
  const stream = new Transform({
    transform(chunk, _, done) {
      pending = Buffer.concat([pending, chunk]);
      parser.parse(chunk);
      pending = pending.subarray(offset);
      offset = 0;
      done(parseError);
    },
  });
  parser.on('error', (e) => { parseError = e; });
  parser.on('packet', (p) => {
    let headerEnd = offset + 1;
    while (pending[headerEnd++] & 0x80) { /* Remaining Length encoding */ }
    const frame = pending.subarray(offset, headerEnd + p.length);
    offset = headerEnd + p.length;
    if (observe(p)) stream.push(frame);
  });
  return stream;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('cloud timeout waiting for ' + label);
    await pause(25);
  }
}

async function startCloud(run, options = {}) {
  const mqttPacket = load('mqtt-packet');
  const config = path.join(run, 'cloud-mosquitto.conf');
  fs.writeFileSync(config, 'listener 1883\nallow_anonymous true\nlog_type all\nconnection_messages true\npersistence true\npersistence_location /mosquitto/data/\n');
  const { stdout } = await podman('run', '-d', '--pull=missing', '-p', '127.0.0.1::1883',
    '-v', config + ':/mosquitto/config/mosquitto.conf:ro,Z', IMAGE);
  const container = stdout.trim();
  const packets = [], connections = new Set(), errors = [];
  let server, online = false, hold = false, held = 0, successfulConnections = 0;

  function observe(p, direction) {
    const rec = observation(p, direction, options.connectDetails);
    packets.push(rec);
    options.observe?.(rec);
    if (direction === 'broker' && p.cmd === 'connack' && rec.reasonCode === 0) successfulConnections++;
    if (direction === 'broker' && p.cmd === 'puback' && hold) {
      hold = false;
      held++;
      rec.forwarded = false;
      return false;
    }
    return true;
  }

  try {
    const portLine = (await podman('port', container, '1883/tcp')).stdout.trim();
    const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(portLine)?.[1]);
    if (!port) throw new Error('unexpected Mosquitto port mapping: ' + portLine);
    server = net.createServer((inbound) => {
      if (!online) { inbound.destroy(); return; }
      const upstream = net.connect(port, '127.0.0.1');
      const brokerParser = mqttPacket.parser({ protocolVersion: 5 });
      const clientTap = tap(mqttPacket.parser({ protocolVersion: 5 }), (p) => {
        if (p.cmd === 'connect') brokerParser.settings.protocolVersion = p.protocolVersion;
        return observe(p, 'client');
      });
      const brokerTap = tap(brokerParser, (p) => observe(p, 'broker'));
      function close() { inbound.destroy(); upstream.destroy(); connections.delete(close); }
      connections.add(close);
      for (const socket of [inbound, upstream]) {
        socket.on('error', close);
        socket.on('close', close);
      }
      for (const stream of [clientTap, brokerTap]) stream.on('error', (e) => { errors.push(e); close(); });
      inbound.pipe(clientTap).pipe(upstream);
      upstream.pipe(brokerTap).pipe(inbound);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    async function ready() {
      let listening = false;
      const deadline = Date.now() + 5000;
      while (!listening && Date.now() < deadline) {
        listening = await new Promise((resolve) => {
          const socket = net.connect(port, '127.0.0.1');
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => resolve(false));
        });
        if (!listening) await pause(25);
      }
      if (!listening) throw new Error('Mosquitto did not open its listener');
      online = true;
    }

    await ready();
    let beforeRestart, beforeHold;
    return {
      url: 'mqtt://127.0.0.1:' + server.address().port,
      async logs() {
        const { stdout, stderr } = await podman('logs', container);
        return stdout + stderr;
      },
      packets() {
        if (errors.length) throw errors[0];
        return packets;
      },
      async control(action) {
        switch (action) {
          case 'connected': await waitFor(() => successfulConnections > 0, 'initial CONNACK'); break;
          case 'hold-puback': hold = true; beforeHold = held; break;
          case 'puback-held': await waitFor(() => held > beforeHold, 'held PUBACK', 5000); break;
          case 'stop':
            beforeRestart = successfulConnections;
            online = false;
            await podman('stop', '--time', '3', container);
            for (const close of connections) close();
            break;
          case 'start':
            await podman('start', container);
            await ready();
            await waitFor(() => successfulConnections > beforeRestart, 'reconnect CONNACK');
            // Allow processing of the QoS 1 retry after CONNACK before taking the step snapshot.
            await pause(250);
            break;
          default: throw new Error('unknown cloud broker action: ' + action);
        }
      },
      async close() {
        online = false;
        for (const close of connections) close();
        server.close();
        await podman('rm', '-fv', container);
      },
    };
  } catch (error) {
    server?.close();
    await podman('rm', '-fv', container);
    throw error;
  }
}

module.exports = { startCloud };
