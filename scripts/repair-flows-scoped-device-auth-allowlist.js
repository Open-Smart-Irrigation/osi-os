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
const node = flows.find((candidate) => candidate.id === 'device-api-http500');
if (!node || node.type !== 'function') throw new Error('device-api-http500 is missing');
const oldEntry = "  'settings-disable-schedules-fn',\n  'strega-today-liters-fn',\n  'unassign-device-auth',";
const oldCount = node.func.split(oldEntry).length - 1;
if (oldCount !== 1) throw new Error(`expected one stale today-liters allowlist entry, found ${oldCount}`);
node.func = node.func.replace(
  oldEntry,
  "  'api-me-auth',\n  'settings-disable-schedules-fn',\n  'unassign-device-auth',"
);
const output = JSON.stringify(flows, null, 2) + '\n';
for (const flowPath of flowPaths) fs.writeFileSync(flowPath, output);
console.log('Reconciled the device auth allowlist with /api/me.');
