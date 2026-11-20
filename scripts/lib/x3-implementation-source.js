'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { METHODS, body } = require('../x3-zone-env-adapters');
// Resolve only an exact reviewed adapter, never arbitrary text near a module
// name. Each guard sees the exported function actually invoked by that adapter.
function implementationSource(node, nodeRedRoot) {
  if (!node || !METHODS[node.id]) return String(node?.func || '');
  if (node.func !== body(node.id)) return String(node.func || '');
  assert.ok(node.libs.some(lib => lib.var === 'osiLib' && lib.module === 'osi-lib'), node.id + ': missing loader binding');
  const api = require(path.join(nodeRedRoot, 'osi-zone-env'));
  const method = METHODS[node.id];
  assert.equal(typeof api[method], 'function', node.id + ': missing facade entry point');
  const source = String(api[method]);
  if (node.id !== 'zone-env-fn') return node.func + '\n' + source;
  assert.ok(source.includes('runProjection.loadEstimatedIrrigationByLocalDate('));
  return source + '\n' + String(api.loadEstimatedIrrigationByLocalDate);
}
module.exports = { implementationSource };
