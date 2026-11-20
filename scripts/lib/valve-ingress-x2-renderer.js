'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const baseline = require('../fixtures/valve-ingress-x2/baseline.json');
const ENTRIES = [
  ['934bf2bc19a8ce22','routeCommand','command-ingress.js'],
  ['83bb4a452dd9ae37','authenticateValveCommand','manual-ingress.js'],
  ['9ad895844533fb35','checkValveOwnership','manual-ingress.js'],
  ['dde8e1ef265e96d7','buildValveCommand','manual-ingress.js'],
  ['cancel-strega-actuation-fn','cancelValveRequest','cancel-ingress.js'],
  ...['interval','model','timed','magnet','partial','flush'].map(kind => ['put-strega-'+kind+'-auth-fn','parseStrega'+kind[0].toUpperCase()+kind.slice(1)+'Request','service-'+kind+'-ingress.js']),
  ['put-strega-advanced-format','formatStregaResponse','run-log-adapters.js'],
  ['5c45136f382d501c','buildActuatorLog','run-log-adapters.js'],
];
function replacement(id) {
  const original = baseline.nodes.find(n => n.id === id);
  const entry = ENTRIES.find(n => n[0] === id);
  assert.ok(original && entry, 'unknown X2 node');
  const libs = original.libs.some(lib => lib.var === 'osiLib') ? original.libs : [...original.libs, { var:'osiLib', module:'osi-lib' }];
  const args = [...new Set(['env','global','node','Date','Buffer','setTimeout',...libs.map(lib => lib.var)])];
  const injected = '{ '+args.join(', ')+' }';
  const func = "const x2Load = osiLib.require('command-ingress');\nif (!x2Load.ok) return osiLib.invokeCommandIngress('"+entry[1]+"', msg, "+injected+");\nreturn x2Load.value."+entry[1]+'(msg, '+injected+');';
  return { func, libs };
}
function validateManifest() {
  const manifest = require('../fixtures/valve-ingress-x2/adapters.json');
  assert.equal(manifest.source, baseline.source);
  assert.equal(manifest.nodes.length, ENTRIES.length);
  assert.equal(new Set(manifest.nodes.map(n => n.id)).size, ENTRIES.length);
  for (const [id,entry,file] of ENTRIES) {
    const patch = manifest.nodes.find(n => n.id === id);
    assert.deepEqual(Object.keys(patch).sort(), ['entry','file','id','replacement']);
    assert.equal(patch.entry, entry); assert.equal(patch.file, file);
    assert.deepEqual(Object.keys(patch.replacement).sort(), ['func','libs']);
    assert.deepEqual(patch.replacement, replacement(id), 'handoff manifest differs from canonical renderer: '+id);
  }
}
function stateOf(node) {
  const original = baseline.nodes.find(n => n.id === node.id);
  if (!original) return null;
  const expected = replacement(node.id);
  const legacy = createHash('sha256').update(node.func).digest('hex') === original.originalFuncSha256;
  const rendered = node.func === expected.func;
  assert.ok(legacy || rendered, 'X2 original body changed or unverified rendered adapter: '+node.id);
  for (const key of ['type','z','outputs','wires','initialize','finalize']) assert.deepEqual(node[key], original[key], 'X2 node contract changed: '+node.id+'/'+key);
  assert.deepEqual(node.libs, legacy ? original.libs : expected.libs, 'X2 bindings changed: '+node.id);
  return legacy ? 'legacy' : 'rendered';
}
function adaptFlows(flows) {
  validateManifest();
  const found = new Set();
  const states = new Set();
  const result = flows.map(node => {
    const state = stateOf(node);
    if (!state) return node;
    assert.ok(!found.has(node.id), 'duplicate X2 node'); found.add(node.id); states.add(state);
    return { ...node, ...replacement(node.id) };
  });
  assert.equal(found.size, ENTRIES.length, 'not every X2 node exists');
  assert.equal(states.size, 1, 'partial X2 application refused');
  return result;
}
module.exports = { ENTRIES, replacement, stateOf, adaptFlows, validateManifest };
