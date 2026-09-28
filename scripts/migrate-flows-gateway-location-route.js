#!/usr/bin/env node
'use strict';

// One-off migration: registers PUT /api/gateway/location as an http-in node
// next to the other network-api routes, wired to the existing generic
// "Authorized Network API" handler (which already forwards any msg.req
// path/method/body to osi-network-api's handleRequest -- no function-node
// change needed). Run once per maintained profile so both stay byte-identical.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

const NEW_NODE_ID = 'network-api-http-7';
const AFTER_NODE_ID = 'network-api-http-6';

function migrate(flowPath) {
  const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  if (flows.some((node) => node.id === NEW_NODE_ID)) {
    console.log('already present, skipping: ' + flowPath);
    return;
  }
  const afterIndex = flows.findIndex((node) => node.id === AFTER_NODE_ID);
  if (afterIndex === -1) {
    throw new Error('anchor node ' + AFTER_NODE_ID + ' not found in ' + flowPath);
  }
  const anchor = flows[afterIndex];
  const node = {
    id: NEW_NODE_ID,
    type: 'http in',
    z: anchor.z,
    name: 'PUT /api/gateway/location',
    url: '/api/gateway/location',
    method: 'put',
    upload: false,
    swaggerDoc: '',
    x: anchor.x,
    y: anchor.y + 50,
    wires: [['network-api-handler']],
  };
  flows.splice(afterIndex + 1, 0, node);
  fs.writeFileSync(flowPath, JSON.stringify(flows, null, 2) + '\n');
  console.log('added ' + NEW_NODE_ID + ' to ' + flowPath);
}

for (const flowPath of flowPaths) migrate(flowPath);
