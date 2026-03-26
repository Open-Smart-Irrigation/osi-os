#!/usr/bin/env node

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const flowPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'flows.json');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));

const requiredHttpRoutes = [
  '/api/sync/state'
];

const requiredFunctionNodes = [
  'Sync Init Schema + Triggers',
  'Build Cloud Bootstrap',
  'Mark Bootstrap Synced',
  'Build Edge Event Batch',
  'Mark Synced Events Delivered',
  'Build Pending Command Pull',
  'Replay Pending Commands'
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function findNodeByName(name) {
  return flows.find((node) => node.name === name);
}

for (const route of requiredHttpRoutes) {
  const node = flows.find((candidate) => candidate.type === 'http in' && candidate.url === route);
  if (!node) {
    fail(`missing HTTP route ${route}`);
  } else {
    console.log(`OK route ${route}`);
  }
}

for (const name of requiredFunctionNodes) {
  const node = findNodeByName(name);
  if (!node) {
    fail(`missing function node ${name}`);
    continue;
  }
  try {
    new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${node.func}\n})`);
    console.log(`OK compile ${name}`);
  } catch (error) {
    fail(`function node ${name} does not compile: ${error.message}`);
  }
}

const bootstrapInject = flows.find((node) => node.id === 'sync-bootstrap-inject');
if (!bootstrapInject) {
  fail('missing sync-bootstrap-inject node');
} else if (bootstrapInject.repeat !== '21600') {
  fail(`unexpected sync bootstrap repeat interval: ${bootstrapInject.repeat}`);
} else {
  console.log('OK bootstrap repeat 21600');
}

const bootstrapNode = findNodeByName('Build Cloud Bootstrap');
if (bootstrapNode) {
  for (const key of ['sensorData', 'dendroReadings', 'dendroDaily', 'zoneRecommendations', 'zoneEnvironments', 'irrigationEvents']) {
    if (!bootstrapNode.func.includes(`${key}:`)) {
      fail(`bootstrap payload missing ${key}`);
    } else {
      console.log(`OK bootstrap includes ${key}`);
    }
  }
}

if (!process.exitCode) {
  console.log('Sync flow verification passed');
}
