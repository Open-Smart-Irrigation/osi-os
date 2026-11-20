'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const baseline = require('../fixtures/valve-ingress-x2/baseline.json');
function adaptFlows(flows) {
  const manifest = require('../fixtures/valve-ingress-x2/adapters.json');
  const byId = new Map(manifest.nodes.map(node => [node.id, node]));
  const found = new Set();
  const result = flows.map(node => {
    const patch = byId.get(node.id);
    if (!patch) return node;
    assert.ok(!found.has(node.id), 'duplicate X2 node: ' + node.id);
    found.add(node.id);
    const original = baseline.nodes.find(candidate => candidate.id === node.id);
    // Any intervening change needs a new characterization and reviewed handoff.
    assert.equal(createHash('sha256').update(node.func).digest('hex'), original.originalFuncSha256, 'X2 original body changed: ' + node.id);
    for (const key of ['type','z','outputs','wires','libs','initialize','finalize']) assert.deepEqual(node[key], original[key], 'X2 node contract changed: ' + node.id + '/' + key);
    return { ...node, ...patch.replacement };
  });
  assert.equal(found.size, byId.size, 'not every X2 node exists');
  return result;
}
function entryBridge(vc, original) {
  // Only the new adapter's outer package lookup differs from the baseline.
  // Restore its supplied dependency loader when entering the copied body.
  return { require(name) {
    if (name !== 'osi-valve-control') return original.require(name);
    return { ok: true, value: new Proxy(vc, { get(target, key) {
      const value = target[key];
      return typeof value === 'function' ? (msg, deps) => value(msg, { ...deps, osiLib: original }) : value;
    } }) };
  } };
}
module.exports = { adaptFlows, entryBridge };
