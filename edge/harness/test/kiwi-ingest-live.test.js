'use strict';

// Run against an amd64 backend and a synthetic T1 fixture:
// OSI_KIWI_TEST_BINARY=... OSI_KIWI_TEST_FIXTURE=... node --test edge/harness/test/kiwi-ingest-live.test.js
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');
const { request, startCommand } = require('../lib/backend');
const { runScenario } = require('../lib/run');
const cloudScenario = require('../scenarios/080-cloud-mqtt.json');

const load = createRequire(path.resolve(__dirname, '../../../scripts/fixtures/release-smoke/package.json'));
const packet = load('mqtt-packet');
const mqtt = load('mqtt');
const binary = process.env.OSI_KIWI_TEST_BINARY;
const fixture = process.env.OSI_KIWI_TEST_FIXTURE;
const topic = 'application/synthetic-sensors-app/device/a840410000000001/event/up';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'kiwi-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function until(condition, description, ms = 3000) {
  const limit = Date.now() + ms;
  do {
    if (await condition()) return;
    await delay(10);
  } while (Date.now() < limit);
  assert.fail(description);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// A single persistent MQTT 3.1.1 session. Queue while it is offline and
// send all pending QoS 1 frames in the same write as CONNACK on reconnect.
async function persistentBroker() {
  const pending = new Map();
  const sockets = new Set();
  let subscribed = false;
  let connections = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const parser = packet.parser();
    socket.on('data', (buffer) => parser.parse(buffer));
    parser.on('packet', (p) => {
      if (p.cmd === 'connect') {
        assert.equal(p.clientId, 'nodered');
        assert.equal(p.protocolVersion, 4);
        assert.equal(p.clean, false);
        connections++;
        const ack = packet.generate({ cmd: 'connack', returnCode: 0, sessionPresent: subscribed });
        socket.write(Buffer.concat([ack, ...pending.values()]));
      } else if (p.cmd === 'subscribe') {
        assert.equal(p.subscriptions[0].topic, 'application/+/device/+/event/up');
        assert.equal(p.subscriptions[0].qos, 1);
        subscribed = true;
        socket.write(packet.generate({ cmd: 'suback', messageId: p.messageId, granted: [1] }));
      } else if (p.cmd === 'puback') {
        assert(pending.delete(p.messageId), 'unexpected PUBACK ' + p.messageId);
      } else if (p.cmd === 'pingreq') {
        socket.write(packet.generate({ cmd: 'pingresp' }));
      } else if (p.cmd === 'disconnect') {
        socket.end();
      }
    });
  });
  const port = await listen(server);
  const disconnect = () => { for (const socket of sockets) socket.destroy(); };
  return {
    port,
    connected: () => sockets.size,
    connections: () => connections,
    remaining: () => [...pending.keys()],
    queue(frame) {
      assert(subscribed && sockets.size === 0, 'expected an offline persistent session');
      const payload = JSON.stringify({
        deduplicationId: 'cold-resume-' + frame,
        time: '2026-11-20T00:00:00.000Z',
        deviceInfo: { devEui: 'a840410000000001', deviceProfileName: 'KIWI' },
        object: { light_intensity: frame },
      });
      pending.set(frame, packet.generate({ cmd: 'publish', topic, payload, qos: 1, messageId: frame }));
    },
    disconnect,
    async close() { disconnect(); await new Promise((resolve) => server.close(resolve)); },
  };
}

function seed(root) {
  const file = path.join(root, 'farming.db');
  fs.copyFileSync(fixture, file);
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at)
        VALUES (88,'test-user','unused','2026-11-20','2026-11-20');
      INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,claimed_at)
        VALUES ('A840410000000001','kiwi','KIWI_SENSOR',88,'2026-11-20','2026-11-20','2026-11-20');
    `);
  } finally {
    db.close();
  }
  return file;
}

async function start(root, file, broker, env = {}) {
  const reserve = net.createServer();
  const port = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve));
  const logFile = path.join(root, 'backend.log');
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(binary, [], {
    cwd: root, stdio: ['ignore', fd, fd],
    env: {
      PATH: process.env.PATH, TZ: 'UTC', OSI_EDGE_DB: file, OSI_EDGE_DATA_ROOT: root,
      OSI_EDGE_HTTP_ADDR: '127.0.0.1:' + port, OSI_EDGE_MQTT_URL: 'tcp://127.0.0.1:' + broker.port,
      OSI_EDGE_TEST_HOOKS: '1', OSI_EDGE_TEST_NONCE: 'kiwi-test', ...env,
    },
  });
  fs.closeSync(fd);
  const exited = once(child, 'exit');
  const stop = async () => { child.kill('SIGTERM'); await exited; };
  const ready = async () => {
    if (child.exitCode !== null) assert.fail(fs.readFileSync(logFile, 'utf8'));
    const r = await request(port, 'GET', '/__test/ready', undefined, {}, 200).catch(() => null);
    return r?.status === 200 && JSON.parse(r.raw).nonce === 'kiwi-test';
  };
  try {
    await until(ready, 'backend did not reach readiness');
    return { child, ready, stop, log: () => fs.readFileSync(logFile, 'utf8') };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('cold backend resumes an offline session and handles and ACKs every queued frame', { skip: !binary || !fixture }, async (t) => {
  const root = scratch(t);
  const file = seed(root);
  const broker = await persistentBroker();
  try {
    await (await start(root, file, broker)).stop();
    const runs = Number(process.env.OSI_KIWI_COLD_RUNS ?? 100);
    for (let run = 0; run < runs; run++) {
      await until(() => broker.connected() === 0, 'old connection stayed open');
      for (let i = 1; i <= 8; i++) broker.queue(run * 8 + i);
      const edge = await start(root, file, broker);
      try {
        try {
          await until(() => broker.remaining().length === 0, 'PUBACK deadline');
        } catch {
          assert.fail(`cold start ${run + 1}: unacknowledged packets ${broker.remaining().join(', ')}\n${edge.log()}`);
        }
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const rows = db.prepare('SELECT light_lux FROM device_data WHERE light_lux > ? ORDER BY light_lux').all(run * 8);
          assert.deepEqual(rows.map((row) => row.light_lux), Array.from({ length: 8 }, (_, i) => run * 8 + i + 1));
        } finally {
          db.close();
        }
      } finally {
        await edge.stop();
      }
    }
    t.diagnostic(`${runs} cold starts, ${runs * 8} rows and PUBACKs, zero missing`);
  } finally {
    await broker.close();
  }
});

test('edge yields both before reconnect and on its five-second process check', { skip: !binary || !fixture }, async (t) => {
  const root = scratch(t);
  const file = seed(root);
  const choice = path.join(root, 'etc', 'osi-backend');
  const procRoot = path.join(root, 'proc');
  const processDir = path.join(procRoot, '42');
  const cmdline = path.join(processDir, 'cmdline');
  fs.mkdirSync(path.dirname(choice));
  fs.mkdirSync(procRoot);
  fs.writeFileSync(choice, 'edge\n');
  const broker = await persistentBroker();
  try {
    const edge = await start(root, file, broker, { OSI_EDGE_PROC_ROOT: procRoot });
    try {
      const dbOpen = () => {
        const dir = '/proc/' + edge.child.pid + '/fd';
        return fs.readdirSync(dir).some((fd) => {
          try { return fs.readlinkSync(path.join(dir, fd)).startsWith(file); } catch { return false; }
        });
      };
      const idle = async () => !dbOpen() && broker.connected() === 0 && !(await edge.ready());
      assert(dbOpen(), 'edge never opened SQLite');
      fs.mkdirSync(processDir);
      fs.writeFileSync(cmdline, 'node\0/usr/lib/node/node-red/red.js\0--userDir\0/srv/node-red\0');
      broker.disconnect();
      await until(idle, 'edge reconnected or held SQLite with Node-RED present', 2800);
      assert.equal(broker.connections(), 1);

      fs.writeFileSync(choice, 'node-red\n');
      fs.rmSync(processDir, { recursive: true });
      await delay(5200);
      assert(await idle(), 'edge resumed while Node-RED was selected');
      assert.equal(broker.connections(), 1);

      fs.writeFileSync(choice, 'edge\n');
      await until(edge.ready, 'edge did not resume when selected', 6000);
      assert(dbOpen(), 'edge did not reopen SQLite');
      assert.equal(broker.connections(), 2);

      fs.mkdirSync(processDir);
      fs.writeFileSync(cmdline, 'node-red\0\0');
      await until(idle, 'edge did not yield during the five-second check', 6000);
      assert.equal(broker.connections(), 2);
      assert.equal(edge.log().match(/edge idle: Node-RED is running/g)?.length, 2);
    } finally {
      await edge.stop();
    }
  } finally {
    await broker.close();
  }
});

test('two telemetry frames are PUBACKed before SQLite releases its writer lock', { skip: !binary || !fixture }, async (t) => {
  const root = scratch(t);
  const backend = await startCommand({ run: root, command: [binary], fixtureDb: fixture, cloud: true });
  try {
    await backend.control.cloud('connected');
    const setup = await runScenario(backend, { steps: cloudScenario.steps.slice(0, 3) });
    assert(setup.steps.every((step) => !step.error), JSON.stringify(setup.steps));
    const before = (await backend.control.cloud()).length;
    const client = mqtt.connect('mqtt://127.0.0.1:' + backend.mqtt, { clientId: 'kiwi-lock-test' });
    try {
      await once(client, 'connect');
      const db = new DatabaseSync(backend.db);
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          const uplink = cloudScenario.steps[3].uplink;
          for (const seq of [1, 2]) {
            const payload = JSON.stringify({ ...uplink.payload, deduplicationId: 'writer-lock-' + seq });
            await new Promise((resolve, reject) => client.publish(
              uplink.topic, payload, { qos: 1 }, (error) => error ? reject(error) : resolve()));
          }
          await until(async () => {
            const captured = (await backend.control.cloud()).slice(before);
            const pubs = captured.filter((p) => p.direction === 'client' && p.cmd === 'publish');
            return pubs.length === 2 && pubs.every(({ messageId }) => captured.some((p) =>
              p.direction === 'broker' && p.cmd === 'puback' && p.messageId === messageId));
          }, 'telemetry waited for SQLite', 2000);
          assert.equal(db.prepare('SELECT count(*) AS count FROM device_data').get().count, 0);
        } finally {
          db.exec('ROLLBACK');
        }
        await backend.control.settle();
        assert.equal(db.prepare('SELECT count(*) AS count FROM device_data').get().count, 2);
      } finally {
        db.close();
      }
    } finally {
      client.end(true);
    }
  } finally {
    await backend.stop();
  }
});
