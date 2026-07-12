#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const channelsPath = path.join(repoRoot, 'web', 'react-gui', 'src', 'channels', 'channels.json');

const outputPaths = [
  path.join(repoRoot, 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'edge-channels.json'),
  path.join(repoRoot, 'conf', 'full_raspberrypi_bcm27xx_bcm2709', 'files', 'usr', 'share', 'node-red', 'edge-channels.json'),
];

const channels = JSON.parse(fs.readFileSync(channelsPath, 'utf8'));

const edgeChannels = channels
  .filter((ch) => ch.edgeField != null)
  .map((ch) => ({ key: ch.key, edgeField: ch.edgeField, unit: ch.unit }));

const output = JSON.stringify(edgeChannels, null, 2) + '\n';

for (const dest of outputPaths) {
  fs.writeFileSync(dest, output);
}

console.log(`edge-channels.json: ${edgeChannels.length} entries written to ${outputPaths.length} profiles`);
