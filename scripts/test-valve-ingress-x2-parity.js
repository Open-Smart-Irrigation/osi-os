#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { cases } = require('./lib/valve-ingress-x2-cases');
const { execute } = require('./lib/valve-ingress-x2-harness');
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures/valve-ingress-x2');
const baseline = require('./fixtures/valve-ingress-x2/baseline.json');
const allCases = cases();
assert.equal(new Set(allCases.map(tc => tc.name)).size, allCases.length, 'every characterization case needs a unique name');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  const allowed = ['--baseline-only','--negative-control'];
  assert.ok(process.argv.slice(2).every(arg => allowed.includes(arg)), 'unknown X2 parity option');
  require('./lib/valve-ingress-x2-frozen').pinnedSource();
  const baselineOnly = process.argv.includes('--baseline-only');
  const evidence = [];
  for (const profile of ['bcm2712', 'bcm2709']) {
    const root = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
    const moduleRoot = path.join(root, 'node-red/osi-valve-control');
    const flows = JSON.parse(fs.readFileSync(path.join(root, 'flows.json')));
    let adapterFlows = flows;
    if (!baselineOnly) adapterFlows = require('./lib/valve-ingress-x2-adapters').adaptFlows(flows);
    for (const tc of allCases) {
      const original = baseline.nodes.find(node => node.id === tc.id);
      const before = await execute(original, tc, moduleRoot);
      const hash = digest(before);
      const key = profile + '/' + tc.name;
      assert.equal(hash, require('./fixtures/valve-ingress-x2/hashes.json')[key], key + ': frozen baseline changed');
      const runAdapter = (node, deps) => {
        const ingress = require(path.join(moduleRoot, '../osi-command-ingress'));
        const bridge = require('./lib/valve-ingress-x2-adapters').entryBridge(ingress, deps.osiLib);
        const names = Object.keys(deps);
        return new Function(...names, node.func)(...names.map(name=>name==='osiLib'?bridge:deps[name]));
      };
      const { stateOf } = require('./lib/valve-ingress-x2-renderer');
      const mode=stateOf(flows.find(n=>n.id===tc.id));
      const shipped=await execute(flows.find(n=>n.id===tc.id),tc,moduleRoot,mode==='rendered'?runAdapter:undefined);
      const { comparable } = require('./lib/valve-ingress-x2-adapters');
      assert.deepEqual(comparable(shipped),comparable(before),key+': shipped implementation differs');
      let after = before;
      if (!baselineOnly) {
        let adapter = adapterFlows.find(node => node.id === tc.id);
        if (process.argv.includes('--negative-control') && tc.name === 'route/open') {
          adapter = { ...adapter, func: adapter.func.replace('return x2Load.value.routeCommand', 'const out = x2Load.value.routeCommand') + '\nout[0].payload.data.duration_minutes = 999; return out;' };
        }
        after = await execute(adapter,tc,moduleRoot,runAdapter);
        const { comparable } = require('./lib/valve-ingress-x2-adapters');
        assert.deepEqual(comparable(after), comparable(before), key + ': extracted adapter differs');
      }
      evidence.push({ profile, case: tc.name, before, after, identical: digest(after) === hash });
    }
  }

  if (process.env.X2_EVIDENCE) fs.writeFileSync(process.env.X2_EVIDENCE, JSON.stringify({ node: process.version, source: baseline.source, cases: evidence }, null, 2) + '\n');
  console.log(`X2 ${baselineOnly ? 'baseline' : 'differential'}: ${allCases.length} cases x 2 profiles, all identical (Node ${process.versions.node})`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { baseline, allCases, digest, ROOT, FIXTURE };
