#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

const originals = flowPaths.map((flowPath) => fs.readFileSync(flowPath, 'utf8'));
if (originals[0] !== originals[1]) throw new Error('maintained flow profiles differ');
const flows = JSON.parse(originals[0]);
const node = flows.find((candidate) => candidate.id === 'strega-today-liters-fn');
if (!node || node.type !== 'function') throw new Error('today-liters function is missing');
const escapedTicks = (node.func.match(/\\`/g) || []).length;
if (escapedTicks !== 2) {
  throw new Error(`expected two escaped template delimiters, found ${escapedTicks}`);
}
node.func = node.func.replace(/\\`/g, '`');
const output = JSON.stringify(flows, null, 2) + '\n';
for (const flowPath of flowPaths) fs.writeFileSync(flowPath, output);
console.log('Repaired today-liters template delimiters in both maintained profiles.');
