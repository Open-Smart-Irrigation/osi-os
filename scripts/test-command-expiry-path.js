'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const profiles = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files',
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function flowNode(profile, id) {
  const nodes = readJson(path.join(profile, 'usr/share/flows.json'));
  const node = nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `${profile} must contain ${id}`);
  return node;
}

const canonical = flowNode(profiles[0], 'command-dedupe-dispatch');
const mirror = flowNode(profiles[1], 'command-dedupe-dispatch');
assert.deepEqual(mirror, canonical, 'maintained profiles must use the same command safety gate');
assert.equal(canonical.outputs, 1, 'the safety gate has only the normal effect output');
assert.deepEqual(
  canonical.wires,
  [['journal-command-apply-fn']],
  'terminal and replay ACKs remain in the durable REST outbox instead of a side channel'
);
assert.match(canonical.func, /deduplicatePendingCommand/);
assert.match(canonical.func, /if \(!result\.handled\) return msg;/);
assert.match(canonical.func, /return null;/);
assert.doesNotMatch(canonical.func, /command_ack/);

for (const profile of profiles) {
  const ledgerPath = path.join(
    repoRoot,
    profile,
    'usr/share/node-red/osi-command-ledger/index.js'
  );
  const source = fs.readFileSync(ledgerPath, 'utf8');
  assert.match(source, /physicalActionExpiry/);
  assert.match(source, /parsed\[0\]\.millis <= nowMillis/);
  assert.match(source, /INSERT INTO command_ack_outbox/);
  assert.match(source, /INSERT INTO applied_commands/);
}

console.log('command expiry path: OK');
