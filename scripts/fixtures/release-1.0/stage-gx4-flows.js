'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { removeRoutes, editFunction } = require('./gx4-flows.patch.json');

function stageGx4Flows(source) {
  const flows = JSON.parse(source);
  assert.equal(JSON.stringify(flows, null, 2) + '\n', source, 'flows must round-trip byte-for-byte');

  for (const route of removeRoutes) {
    const node = flows.find(({ id }) => id === route.id);
    assert.equal(node?.type, 'http in', route.id);
    assert.deepEqual({ id: node.id, method: node.method, url: node.url, wires: node.wires }, route);
  }
  const router = flows.find(({ id }) => id === editFunction.id);
  const original = router.func;
  for (const { before, after } of editFunction.replacements) {
    assert.ok(router.func.includes(before), 'History router patch context changed');
    assert.equal(router.func.indexOf(before), router.func.lastIndexOf(before), 'patch context must be unique');
    router.func = router.func.replace(before, () => after);
  }
  assert.ok(router.func.length < original.length, 'History router must shrink');
  const removedIds = new Set(removeRoutes.map(({ id }) => id));
  const staged = flows.filter(({ id }) => !removedIds.has(id));
  for (const node of staged) {
    assert.ok(!node.wires?.flat().some((id) => removedIds.has(id)), `stale inbound wire from ${node.id}`);
  }
  return staged;
}

if (require.main === module) {
  const source = fs.readFileSync(process.argv[2], 'utf8');
  // The lead can render a proposed flow to a scratch file, then review and
  // activate it after the reservation is granted.
  process.stdout.write(JSON.stringify(stageGx4Flows(source), null, 2) + '\n');
}

module.exports = { stageGx4Flows };
