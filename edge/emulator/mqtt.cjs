'use strict';

const fs = require('node:fs');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { startCloud } = require('../harness/lib/cloud');

const load = createRequire(require.resolve('../../scripts/fixtures/release-smoke/package.json'));

async function publish(port, file, pressure) {
  const uplinks = JSON.parse(fs.readFileSync(file));
  const mqtt = load('mqtt');
  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
    protocolVersion: 4, reconnectPeriod: 0, connectTimeout: 5000,
  });
  try {
    await once(client, 'connect');
    const disconnected = once(client, 'close').then(() => {
      throw new Error('lost guest MQTT connection before PUBACK');
    });
    let count = 0;
    do {
      // Submit the whole batch before awaiting any PUBACK.
      const acknowledgements = uplinks.map(({ topic, payload }) => new Promise((resolve, reject) => {
        client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }));
      await Promise.race([Promise.all(acknowledgements), disconnected]);
      count += uplinks.length;
      console.log(JSON.stringify({ acknowledged: count }));
      if (pressure) await delay(25);
    } while (pressure);
  } finally {
    await new Promise((resolve) => client.end(true, resolve));
  }
}

async function cloud() {
  const broker = await startCloud(process.argv[3]);
  const commands = createInterface({ input: process.stdin });
  console.log(JSON.stringify({ url: broker.url }));
  try {
    for await (const action of commands) {
      try {
        if (action !== 'packets') await broker.control(action);
        console.log(JSON.stringify({ packets: broker.packets() }));
      } catch (error) {
        console.log(JSON.stringify({ error: error.message }));
      }
    }
  } finally {
    await broker.close();
  }
}

const [, , mode, port, file, pressure] = process.argv;
const operation = mode === 'cloud' ? cloud() : publish(port, file, pressure === 'repeat');
operation.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
