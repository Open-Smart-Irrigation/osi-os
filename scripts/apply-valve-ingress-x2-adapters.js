#!/usr/bin/env node
'use strict';
// Dry-run by default. Only the dispatcher may grant the flows reservation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { adaptFlows } = require('./lib/valve-ingress-x2-adapters');
const args = process.argv.slice(2);
const allowed = ['--write-with-dispatcher-reservation'];
assert.ok(args.every(arg => allowed.includes(arg)) && args.length <= 1, 'usage: node scripts/apply-valve-ingress-x2-adapters.js [--write-with-dispatcher-reservation]');
const results = ['bcm2712', 'bcm2709'].map(profile => {
  const file = path.resolve(__dirname, '..', `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const original = fs.readFileSync(file, 'utf8');
  const flows = JSON.parse(original);
  assert.equal(JSON.stringify(flows, null, 2) + '\n', original, profile + ': no-op roundtrip changed bytes');
  return { file, original, next: JSON.stringify(adaptFlows(flows), null, 2) + '\n' };
});
assert.equal(results[0].original, results[1].original, 'original profile flows differ');
assert.equal(results[0].next, results[1].next, 'proposed profile flows differ');
for (const { file, original, next } of results) {
  if (args.length) fs.writeFileSync(file, next);
  console.log(`${args.length ? 'APPLIED' : 'DRY RUN'} ${file}: ${Buffer.byteLength(original)} -> ${Buffer.byteLength(next)} bytes`);
}
