#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
const node = flows.find((candidate) => candidate.id === 'history-api-router-fn');
if (!node) throw new Error('history-api-router-fn not found');
if (!node.func.includes("osiLib.require('scope')")) {
  throw new Error('history scope migration has not been applied');
}
if (!node.libs.some((lib) => lib.var === 'osiLib' && lib.module === 'osi-lib')) {
  node.libs.push({ var: 'osiLib', module: 'osi-lib' });
}
const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
