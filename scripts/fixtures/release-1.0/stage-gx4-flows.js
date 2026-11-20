'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
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

function applyGx4Cut(root) {
  const candidateFlows = ['bcm2712', 'bcm2709'].map((profile) => {
    const file = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
    const source = fs.readFileSync(file, 'utf8');
    return { file, bytes: JSON.stringify(stageGx4Flows(source), null, 2) + '\n' };
  });
  assert.equal(candidateFlows[0].bytes, candidateFlows[1].bytes, 'staged profiles must match byte-for-byte');

  // Check both flow inputs and the gate changes before writing any output.
  const patch = path.join(__dirname, 'gx4-gates.patch');
  execFileSync('git', ['apply', '--check', patch], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['apply', patch], { cwd: root, stdio: 'inherit' });
  for (const { file, bytes } of candidateFlows) fs.writeFileSync(file, bytes);
}

if (require.main === module) {
  const [input, root] = process.argv.slice(2);
  if (input === '--apply') {
    assert.ok(root, '--apply requires an explicit target checkout');
    applyGx4Cut(path.resolve(root));
  } else {
    const source = fs.readFileSync(input, 'utf8');
    process.stdout.write(JSON.stringify(stageGx4Flows(source), null, 2) + '\n');
  }
}

module.exports = { stageGx4Flows };
