#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { scanFunctionNodes } = require('./flows-bare-require-scan');
const { applyTo } = require('./x3-zone-env-adapters');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertNewEvidencePath, writeEvidence } = require('./lib/x3-evidence-writer');
const { compare, assertFrozenInput, assertOriginalBlobs } = require('./lib/x3-parity-contract');
const { execute, scenarios, LEGACY, PROFILES, FIXTURES, share } = require('./lib/x3-zone-env-harness');
async function main() {
  const mode = process.argv[2] || '--verify';
  assert.ok(['--capture', '--legacy', '--verify'].includes(mode));
  assertOriginalBlobs();
  assertNewEvidencePath(process.env.X3_EVIDENCE);
  if (mode === '--capture') {
    for (const profile of PROFILES) assertFrozenInput(JSON.parse(fs.readFileSync(path.join(share(profile), 'flows.json'))));
    throw new Error('Original oracle is immutable; use the additive capture command with a new output path');
  }
  const expectedFile = path.join(FIXTURES, 'expected.json');
  const casesFile = path.join(FIXTURES, 'cases.json');
  const cases = JSON.parse(fs.readFileSync(casesFile));
  const expected = mode === '--capture' ? null : JSON.parse(fs.readFileSync(expectedFile));
  const nonUtc = process.env.TZ && process.env.TZ !== 'UTC';
  let count = 0;
  const evidence = [];
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const profile of PROFILES) {
    const current = JSON.parse(fs.readFileSync(path.join(share(profile), 'flows.json')));
    const adapters = applyTo(current);
    assert.deepEqual(scanFunctionNodes(adapters), [], profile + ' bare-require scan');
    assert.equal(scanFunctionNodes([{ type: 'function', func: "require('osi-zone-env')" }]).length, 1, 'bare-require negative control');
    for (const old of LEGACY) {
      const next = adapters.find(n => n.id === old.id);
      assert.deepEqual(next.wires, old.wires);
      assert.equal(next.outputs, old.outputs);
      assert.deepEqual(next.libs, old.libs.some(lib => lib.var === 'osiLib') ? old.libs : [...old.libs, { var: 'osiLib', module: 'osi-lib' }]);
    }
    for (const c of cases) {
      const node = mode === '--verify'
        ? require('./x3-zone-env-adapters').adaptNode(current.find(n => n.id === c.node))
        : mode === '--capture' ? current.find(n => n.id === c.node) : LEGACY.find(n => n.id === c.node);
      const result = await execute(profile, node, c);
      assert.equal(!!result.thrown, !!c.expectThrown, `${profile} ${c.name}: ${JSON.stringify(result.thrown)}`);
      assert.equal(result.closes, c.expectedCloses ?? (c.openError ? 0 : result.trace.filter(t => t.kind === 'open').length), `${c.name} close count`);
      if (expected) {
        const before = nonUtc ? await execute(profile, LEGACY.find(n => n.id === c.node), c) : expected[c.name];
        compare(before,result,`${profile} ${c.name}`);
        const message = value => Array.isArray(value.result) ? value.result.find(Boolean) : value.result;
        const brief = value => {
          const msg = message(value);
          return { statusCode: msg?.statusCode ?? null, outputPorts: Array.isArray(value.result) ? value.result.map(Boolean) : [!!value.result], closes: value.closes, rainTodayMm: msg?.payload?.water?.rainTodayMm, measuredLiters: msg?.payload?.water?.irrigationTodayMeasuredLiters, estimatedLiters: msg?.payload?.water?.irrigationTodayEstimatedLiters, liters: msg?.payload?.liters, error: msg?.payload?.error || msg?.payload?.message };
        };
        evidence.push({ profile, case: c.name, before: brief(before), after: brief(result), beforeTraceSha256: digest(before), afterTraceSha256: digest(result) });
      }
      count++;
    }
  }
  if (mode !== '--capture') {
    if (mode === '--verify') {
      const api = require(path.join(share(PROFILES[0]), 'node-red/osi-zone-env'));
      const { implementationSource } = require('./lib/x3-implementation-source');
      const adapter = require('./x3-zone-env-adapters').adaptNode(LEGACY.find(n => n.id === 'strega-today-liters-fn'));
      const original = api.todayLiters;
      try {
        api.todayLiters = function removedExclusion() { return null; };
        assert.equal(implementationSource(adapter, path.join(share(PROFILES[0]), 'node-red')).includes('STALE_NO_OBSERVATION'), false, 'guard must inspect the called export, not an unrelated function');
      } finally { api.todayLiters = original; }
    }
    const c = cases.find(c => c.name === 'liters/zero-only');
    const source = LEGACY.find(n => n.id === c.node);
    const changed = { ...source, func: source.func.replace('      liters,', '      liters: liters || null,') };
    assert.notEqual(changed.func, source.func, 'zero/null negative control must mutate code');
    const bad = await execute(PROFILES[0], changed, c);
    assert.equal(bad.result.payload.liters, null);
    assert.notDeepEqual(bad.result, expected[c.name].result, 'oracle rejects a real zero changed to null');
  }
  writeEvidence(process.env.X3_EVIDENCE, { node: process.versions.node, timezone: process.env.TZ, cases: evidence });
  console.log(`X3 ${mode}: ${count} exact traces, ${cases.length} cases x both profiles; Node ${process.versions.node}, TZ=${process.env.TZ || 'host'}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
