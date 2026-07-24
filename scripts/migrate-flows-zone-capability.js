#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

const beforeSource =
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1'];";
const afterSource =
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1'];";

const nodeContracts = {
  'al-link-build-req': {
    name: 'Build server auth request',
    type: 'function',
    preimageHash: 'e693daf66313d0a911ee5502273d47df142c6897e2f0b0c411321fdf748c3672',
    postimageHash: 'e84a66627ad5c0e90a7fc0d6b48d2668eaf586f712b368404686b61f38ff7612',
  },
  'sync-bootstrap-build': {
    name: 'Build Cloud Bootstrap',
    type: 'function',
    preimageHash: '057267e15a9a8ae09589251d2913dcaeaaddd9a58158e310890d4fb4737c96d0',
    postimageHash: 'a08a6b3bb80c907e603c1b746f3314acb8c8e0f504bd59bfe6521091199b1b9b',
  },
  'sync-force-build': {
    name: 'Run Force Sync',
    type: 'function',
    preimageHash: '4885c838e944c7609d64522b9533c4365963b40693a48356dd6d067fe791b06f',
    postimageHash: 'af899e4f76182dfdf7d97b0420d0e7124ec571aaaa2a9d49d961cf6c1b519cbc',
  },
};

function digest(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function indexNodes(flows) {
  const byId = new Map();
  for (const node of flows) {
    if (node && node.id) byId.set(node.id, node);
  }
  return byId;
}

function hashesMatch(byId, key) {
  return Object.entries(nodeContracts).every(([id, contract]) => {
    const node = byId.get(id);
    return node && node.name === contract.name && node.type === contract.type &&
      digest(node.func) === contract[key];
  });
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('Expected exactly one ' + label + ' seam');
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  const byId = indexNodes(flows);

  if (hashesMatch(byId, 'postimageHash')) return buffer;
  if (!hashesMatch(byId, 'preimageHash')) {
    const actual = Object.fromEntries(Object.keys(nodeContracts).map((id) => {
      const node = byId.get(id);
      return [id, node && typeof node.func === 'string' ? digest(node.func) : null];
    }));
    throw new Error('Refusing unexpected zone capability source: ' + JSON.stringify(actual));
  }

  for (const id of Object.keys(nodeContracts)) {
    const node = byId.get(id);
    node.func = replaceOnce(node.func, beforeSource, afterSource, id + ' capability');
  }

  if (!hashesMatch(byId, 'postimageHash')) {
    throw new Error('Zone capability postimage hashes do not match pins');
  }
  return serialize(flows);
}

function main() {
  const before = flowPaths.map((file) => fs.readFileSync(file));
  if (!before[0].equals(before[1])) {
    throw new Error('Maintained flows are not byte-identical before zone capability migration');
  }
  for (let index = 0; index < before.length; index += 1) {
    if (!before[index].equals(serialize(JSON.parse(before[index].toString('utf8'))))) {
      throw new Error('Flow input is not a byte-stable JSON roundtrip: ' + flowPaths[index]);
    }
  }

  const after = migrate(before[0]);
  if (!after.equals(migrate(after))) {
    throw new Error('Zone capability migration is not idempotent');
  }
  if (!after.equals(serialize(JSON.parse(after.toString('utf8'))))) {
    throw new Error('Zone capability output is not a byte-stable JSON roundtrip');
  }
  if (after.equals(before[0])) {
    process.stdout.write('migrate-flows-zone-capability: already current\n');
    return;
  }

  for (const file of flowPaths) fs.writeFileSync(file, after);
  if (!fs.readFileSync(flowPaths[0]).equals(fs.readFileSync(flowPaths[1]))) {
    throw new Error('Maintained flows lost byte parity after zone capability migration');
  }
  process.stdout.write('migrate-flows-zone-capability: activated zone_desired_state_v1\n');
}

if (require.main === module) main();

module.exports = { migrate };
