#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profilePaths = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((relativePath) => path.join(root, relativePath));

for (const flowPath of profilePaths) {
  const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const guard = flows.find((node) => node.id === 'scoped-zone-config-guard');
  if (!guard) throw new Error(`${flowPath}: scoped-zone-config-guard not found`);

  const oldPropertyCount = (guard.func.match(/"url":/g) || []).length;
  const oldAccessCount = (guard.func.match(/candidate\.url/g) || []).length;
  if (oldPropertyCount !== 4 || oldAccessCount !== 1) {
    throw new Error(
      `${flowPath}: expected 4 url properties and 1 candidate.url access; ` +
      `found ${oldPropertyCount} and ${oldAccessCount}`
    );
  }
  guard.func = guard.func
    .replaceAll('"url":', '"routePath":')
    .replace('candidate.url', 'candidate.routePath');
  fs.writeFileSync(flowPath, JSON.stringify(flows, null, 2) + '\n');
}

console.log('renamed scoped zone route metadata in both maintained profiles');
