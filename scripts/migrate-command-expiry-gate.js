#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const canonicalRoot = path.join(
  repoRoot,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files'
);
const mirrorRoot = path.join(
  repoRoot,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files'
);
const relativeFlow = 'usr/share/flows.json';
const runtimeFiles = [
  'usr/share/node-red/osi-command-ledger/index.js',
  'usr/share/node-red/osi-command-ledger/index.test.js',
];

const canonicalFlowPath = path.join(canonicalRoot, relativeFlow);
const original = fs.readFileSync(canonicalFlowPath, 'utf8');
const nodes = JSON.parse(original);
const roundTrip = JSON.stringify(nodes, null, 2) + '\n';
if (roundTrip !== original) {
  throw new Error('flows.json no-op parse/stringify changed bytes');
}

const gate = nodes.find((node) => node.id === 'command-dedupe-dispatch');
if (!gate) throw new Error('Deduplicate Pending Command node is missing');

if (gate.outputs === 2) {
  const handledBlock = [
    "    node.status({ fill: 'blue', shape: 'ring', text: 'duplicate command ' + String(result.ack.commandId) });",
    '    return [null, {',
    "      topic: 'devices/' + gatewayEui + '/command_ack',",
    '      payload: JSON.stringify(result.ack),',
    '      qos: 1',
    '    }];',
  ].join('\n');
  if (!gate.func.includes(handledBlock)) {
    throw new Error('Deduplicate Pending Command handled block drifted');
  }
  gate.func = gate.func
    .replace(/\n  const gatewayEui = runtime\.gateway_device_eui;/, '')
    .replaceAll('return [null, null];', 'return null;')
    .replace(
      'if (!result.handled) return [msg, null];',
      'if (!result.handled) return msg;'
    )
    .replace(
      handledBlock,
      [
        "    node.status({ fill: 'blue', shape: 'ring', text: 'terminal/replayed command ' + String(result.ack.commandId) });",
        '    return null;',
      ].join('\n')
    );
  gate.outputs = 1;
  gate.wires = [['journal-command-apply-fn']];
}

if (gate.outputs !== 1 ||
    JSON.stringify(gate.wires) !== JSON.stringify([['journal-command-apply-fn']]) ||
    !gate.func.includes('if (!result.handled) return msg;') ||
    !gate.func.includes('return null;') ||
    gate.func.includes('command_ack')) {
  throw new Error('Deduplicate Pending Command did not reach the guarded shape');
}

const updated = JSON.stringify(nodes, null, 2) + '\n';
fs.writeFileSync(canonicalFlowPath, updated);
fs.writeFileSync(path.join(mirrorRoot, relativeFlow), updated);

for (const relativePath of runtimeFiles) {
  const contents = fs.readFileSync(path.join(canonicalRoot, relativePath));
  fs.writeFileSync(path.join(mirrorRoot, relativePath), contents);
}

console.log('command expiry gate migration: OK');
