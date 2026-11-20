#!/usr/bin/env node
'use strict';
// Write complete patched profiles to a scratch directory. No in-place mode:
// the dispatcher applies the generated patch only after granting the reservation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ROOT, PROFILES } = require('./lib/daily-scheduler-harness');
const originals = require('./fixtures/daily-scheduler/legacy-nodes.json');
const adapters = require('./fixtures/daily-scheduler/adapters.json');
const { writeExclusive } = require('./lib/daily-scheduler-oracles');
function adaptFlows(flows) {
  const result = structuredClone(flows);
  for (const adapter of adapters) {
    const node = result.find(n => n.id === adapter.id);
    const original = originals.find(n => n.id === adapter.id);
    assert.ok(node, 'missing node ' + adapter.id);
    assert.ok(node.func === original.func || node.func === adapter.func, 'source drift: re-characterize ' + adapter.name);
    assert.deepStrictEqual(node.wires, adapter.wires, 'wiring drift: ' + adapter.name);
    assert.equal(node.outputs, adapter.outputs);
    node.func = adapter.func;
    node.libs = structuredClone(adapter.libs);
  }
  return result;
}
function main() {
  assert.equal(process.argv[2], '--output-dir');
  assert.equal(process.argv.length, 4);
  const output = path.resolve(process.argv[3]);
  assert.ok(output !== ROOT && !ROOT.startsWith(output + path.sep), 'output must be a scratch directory');
  const blobs = PROFILES.map(profile => {
    const relative = path.join('conf', profile, 'files/usr/share/flows.json');
    const file = path.join(ROOT, relative);
    assert.notEqual(path.join(output, relative), file);
    const source = fs.readFileSync(file, 'utf8');
    const flows = JSON.parse(source);
    assert.equal(JSON.stringify(flows, null, 2) + '\n', source, 'roundtrip: ' + profile);
    console.log('byte-identical: true (input ' + profile + ')');
    return { relative, source, flows };
  });
  assert.equal(blobs[0].source, blobs[1].source, 'profile drift');
  for (const { relative, flows } of blobs) {
    const file = path.join(output, relative);
    const source = JSON.stringify(adaptFlows(flows), null, 2) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeExclusive(file, source);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file)), null, 2) + '\n', source);
    console.log('byte-identical: true (output ' + relative + ')');
  }
}
if(require.main === module) main();
module.exports = { adaptFlows };
