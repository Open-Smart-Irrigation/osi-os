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
const source = flows.find((candidate) => candidate.id === 'get-zones-auth');
const target = flows.find((candidate) => candidate.id === 'api-me-auth');
if (!source || source.type !== 'function' || !target || target.type !== 'function') {
  throw new Error('reviewed auth nodes are missing');
}
const endMarker = '  return { userId, username };\n}';
const endIndex = source.func.indexOf(endMarker);
if (endIndex === -1 || source.func.indexOf(endMarker, endIndex + 1) !== -1) {
  throw new Error('get-zones-auth verifier boundary drifted');
}
let verifier = source.func.slice(0, endIndex + endMarker.length);
verifier = verifier.replace(/get-zones-auth/g, 'api-me-auth');
verifier = verifier.replace(
  /catch \(_\) \{\}/g,
  "catch (error) { node.warn('api-me-auth: ' + (error && error.message ? error.message : error)); }"
);
target.func = verifier + String.raw`
const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);
msg.username = auth.username;
return msg;`;
const output = JSON.stringify(flows, null, 2) + '\n';
for (const flowPath of flowPaths) fs.writeFileSync(flowPath, output);
console.log('Aligned /api/me authentication with the device auth ratchet.');
