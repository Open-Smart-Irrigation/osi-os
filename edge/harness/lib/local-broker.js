'use strict';

const net = require('node:net');
const { once } = require('node:events');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.resolve(__dirname, '../../../scripts/fixtures/release-smoke/package.json'));

// Aedes with in-memory persistence stays up while either backend is offline.
async function startLocalBroker(options) {
  const broker = load('aedes')(options);
  const server = net.createServer(broker.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    broker,
    port: server.address().port,
    async close() {
      await new Promise((resolve) => broker.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startLocalBroker };
