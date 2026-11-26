'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { startCommand, startNodeRed, oracleExecutable, SHARED_ENV } = require('../lib/backend');
const { startCloud } = require('../lib/cloud');
const { startLocalBroker } = require('../lib/local-broker');
const scenario = require('../scenarios/080-cloud-mqtt.json');

const repo = path.resolve(__dirname, '../../..');
const load = createRequire(path.join(repo, 'scripts/fixtures/release-smoke/package.json'));
const binary = process.env.OSI_FALLBACK_TEST_BINARY;
const scratch = process.env.OSI_FALLBACK_TEST_SCRATCH;
const localId = 'nodered';
const cloudId = 'device_' + SHARED_ENV.DEVICE_EUI;
const filter = 'application/+/device/+/event/up';
const { topic, payload } = scenario.steps[3].uplink;

async function waitFor(probe, label, timeout = 10000) {
  const until = performance.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    await delay(25);
  } while (performance.now() < until);
  throw new Error('Timed out waiting for ' + label);
}

async function publish(client, seq) {
  const body = JSON.stringify({
    ...payload, fCnt: seq, deduplicationId: 'fallback-' + seq,
    time: new Date(Date.UTC(2026, 10, 20, 0, seq)).toISOString(),
    object: { ...payload.object, light_intensity: seq },
  });
  await new Promise((resolve, reject) => client.publish(topic, body, { qos: 1 },
    (error) => error ? reject(error) : resolve()));
}

function seed(run) {
  const dbFile = path.join(run, 'data/db/farming.db');
  execFileSync(process.execPath, ['scripts/build-seed-db.js', '--out', dbFile], { cwd: repo, env: { ...process.env, TMPDIR: run } });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES (1,'synthetic','unused','2026-11-20','2026-11-20')");
    db.exec(scenario.steps[2].sql);
  } finally {
    db.close();
  }
  return dbFile;
}

test('persistent MQTT sessions survive Go → Node-RED → Go without overlap', {
  skip: !binary || !scratch ? 'set OSI_FALLBACK_TEST_BINARY and OSI_FALLBACK_TEST_SCRATCH' : false,
}, async (t) => {
  const { oracleNode } = oracleExecutable();
  for (const file of [binary, oracleNode]) {
    try { fs.accessSync(file, fs.constants.X_OK); }
    catch (error) {
      if (error.code === 'ENOENT') return t.skip('missing executable ' + file);
      throw error;
    }
  }
  const podman = spawnSync('podman', ['--version']);
  if (podman.error?.code === 'ENOENT') return t.skip('podman is unavailable');
  if (podman.status !== 0) throw podman.error || new Error(podman.stderr.toString());

  const run = fs.mkdtempSync(path.join(scratch, 'handoff-'));
  t.diagnostic('runtime logs in ' + run);
  const dbFile = seed(run);
  const localConnects = [], localAcks = [], localDisconnects = [], overlaps = [];
  const received = [];
  const local = await startLocalBroker({
    preConnect(client, packet, done) {
      if (packet.clientId === localId) {
        if (local.broker.clients[localId]) overlaps.push(localId);
        localConnects.push({
          clientId: packet.clientId, protocolVersion: packet.protocolVersion,
          cleanStart: packet.clean, at: performance.now(),
        });
      }
      done(null, true);
    },
  });
  local.broker.on('connackSent', (p, client) => {
    if (client.id === localId) localAcks.push(p);
  });
  local.broker.on('clientDisconnect', (client) => {
    if (client.id === localId) localDisconnects.push(performance.now());
  });
  local.broker.on('ack', (p, client) => {
    if (client.id === localId && p?.topic === topic) {
      received.push({ qos: p.qos, seq: JSON.parse(p.payload).fCnt });
    }
  });
  let subscribed = false;
  local.broker.on('subscribe', (subscriptions, client) => {
    if (client.id === localId && subscriptions.some((p) => p.topic === filter && p.qos === 1)) subscribed = true;
  });

  let cloud, publisher, backend;
  const failures = [];
  function check(fn) {
    try { fn(); } catch (error) { failures.push(error.message); }
  }
  try {
    const cloudConnectTimes = [];
    cloud = await startCloud(run, { observe: (p) => {
      if (p.cmd === 'connect') cloudConnectTimes.push(performance.now());
    } });
    const brokers = { local: local.port, cloud: cloud.url };
    const go = () => startCommand({ run, command: [path.resolve(binary)], reuseDb: true, brokers });
    publisher = load('mqtt').connect('mqtt://127.0.0.1:' + local.port, { reconnectPeriod: 0 });
    await once(publisher, 'connect');

    let previousDisconnect;
    const cloudConnects = [];
    async function start(which, index) {
      backend = await (which === 'Go' ? go() : startNodeRed({ run, reuseDb: true, brokers }));
      assert.equal(backend.db, dbFile);
      const cloudAck = await waitFor(() => cloud.packets().filter((p) => p.cmd === 'connack')[index], which + ' cloud CONNACK');
      const localAck = await waitFor(() => localAcks[index], which + ' local CONNACK');
      const localConnect = localConnects[index];
      const cloudConnect = cloud.packets().filter((p) => p.cmd === 'connect')[index];
      const expiry = cloudConnect.properties?.sessionExpiryInterval ?? 0;
      t.diagnostic(JSON.stringify({
        backend: which, local: { ...localConnect, sessionPresent: localAck.sessionPresent },
        cloud: { ...cloudConnect, expiry, sessionPresent: cloudAck.sessionPresent },
        msAfterDisconnect: previousDisconnect && {
          local: localConnect.at - previousDisconnect.local,
          cloud: cloudConnectTimes[index] - previousDisconnect.cloud,
        },
      }));
      assert.equal(localAck.returnCode, 0);
      assert.equal(cloudAck.reasonCode, 0);
      assert.equal(localConnect.clientId, localId);
      assert.equal(localConnect.protocolVersion, 4);
      assert.equal(localConnect.cleanStart, false);
      assert.equal(cloudConnect.clientId, cloudId);
      assert.equal(cloudConnect.protocolVersion, 5);
      assert.equal(cloudConnect.cleanStart, false);
      check(() => assert.equal(localAck.sessionPresent, index !== 0, which + ' local sessionPresent'));
      // Parity, not the charter's premise: the shipped Node-RED cloud client sends
      // MQTT 5 clean start off WITHOUT a Session Expiry Interval, so the broker
      // drops the session at disconnect (sessionPresent 0 after every switch).
      // Go must match that, never do more. Finding F-MQTT-1 (lead ledger), a
      // Node-RED item. Both backends' CONNECTs are compared below.
      cloudConnects.push({ which, expiry, sessionPresent: cloudAck.sessionPresent });
      check(() => assert.equal(cloudAck.sessionPresent, expiry > 0 && index !== 0, which + ' cloud sessionPresent follows the sent expiry'));
      if (previousDisconnect) {
        assert(localConnect.at > previousDisconnect.local);
        assert(cloudConnectTimes[index] > previousDisconnect.cloud);
      }
    }

    async function disconnect(count) {
      // SIGTERM for Go, graceful RED.stop() for the oracle. Verify the old
      // process and both broker sessions are gone before starting its successor.
      await backend.stop();
      assert(backend.child.exitCode !== null || backend.child.signalCode !== null);
      backend = undefined;
      await waitFor(() => localDisconnects.length === count, 'Aedes clientDisconnect');
      await waitFor(async () => (await cloud.logs()).split('\n').filter((line) =>
        line.includes('Client ' + cloudId + ' disconnected') ||
        line.includes('Client ' + cloudId + ' closed its connection')).length === count,
      'Mosquitto disconnect for ' + cloudId);
      previousDisconnect = { local: localDisconnects.at(-1), cloud: performance.now() };
      assert.equal(localConnects.length, count);
      assert.equal(cloudConnectTimes.length, count);
    }

    async function delivered(seqs) {
      const rows = await waitFor(() => {
        const db = new DatabaseSync(dbFile, { readOnly: true });
        try {
          const rows = db.prepare('SELECT light_lux FROM device_data WHERE light_lux BETWEEN ? AND ? ORDER BY light_lux')
            .all(seqs[0], seqs.at(-1)).map((row) => row.light_lux);
          return rows.length >= seqs.length ? rows : null;
        } finally {
          db.close();
        }
      }, 'SQLite rows for offline uplinks');
      assert.deepEqual(rows, seqs);
      const acked = received.filter(({ seq }) => seqs.includes(seq));
      assert.deepEqual(acked, seqs.map((seq) => ({ qos: 1, seq })));
      t.diagnostic('QoS 1 uplinks acknowledged and stored: ' + seqs.join(', '));
    }

    await start('Go', 0);
    await waitFor(() => subscribed, 'Go subscription at QoS 1');
    await cloud.control('hold-puback');
    await publish(publisher, 1);
    await cloud.control('puback-held');
    const held = cloud.packets().find((p) => p.cmd === 'puback' && p.forwarded === false);
    assert(cloud.packets().some((p) => p.cmd === 'publish' && p.qos === 1 && p.messageId === held.messageId));
    await delivered([1]);
    t.diagnostic('Mosquitto accepted Go QoS 1 publish with packet ID ' + held.messageId);

    await disconnect(1);
    for (const seq of [2, 3]) await publish(publisher, seq);
    await start('Node-RED', 1);
    await delivered([2, 3]);
    await disconnect(2);
    for (const seq of [4, 5]) await publish(publisher, seq);
    await start('Go', 2);
    await delivered([4, 5]);
    await disconnect(3);
    assert.deepEqual(overlaps, []);
    const cloudLog = await cloud.logs();
    fs.writeFileSync(path.join(run, 'mosquitto.log'), cloudLog);
    assert.doesNotMatch(cloudLog, /already connected|session taken over/i);
    // Both backends send the same cloud session expiry (parity of the CONNECT).
    check(() => assert.equal(new Set(cloudConnects.map((c) => c.expiry)).size, 1, 'cloud session expiry differs between backends: ' + JSON.stringify(cloudConnects)));
    assert.deepEqual(failures, []);
  } finally {
    try {
      if (backend) await backend.stop();
    } finally {
      publisher?.end(true);
      try { await cloud?.close(); } finally { await local.close(); }
    }
  }
});
