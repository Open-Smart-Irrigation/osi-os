#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { scanFunctionNodes } = require('./flows-bare-require-scan');
const { applyTo } = require('./x3-zone-env-adapters');
const path = require('node:path');
const crypto = require('node:crypto');
const { execute, scenarios, LEGACY, PROFILES, FIXTURES, share } = require('./lib/x3-zone-env-harness');
async function main() {
  const mode = process.argv[2] || '--verify';
  assert.ok(['--capture', '--legacy', '--verify'].includes(mode));
  const expectedFile = path.join(FIXTURES, 'expected.json');
  const casesFile = path.join(FIXTURES, 'cases.json');
  let cases = scenarios;
  const actual = {};
  if (mode === '--capture') {
    // Fail each statement in the three DB-owning paths, including DDL and
    // writes. This freezes the current swallowed failures as well as replies.
    for (const id of ['zone-env-fn', 'strega-today-liters-fn', 'get-actuations-query']) {
      const c = { name: id + '/fault-probe', node: id };
      const result = await execute(PROFILES[0], LEGACY.find(n => n.id === id), c);
      assert.equal(result.thrown, undefined, JSON.stringify(result));
      const count = result.trace.filter(t => ['all', 'get', 'run'].includes(t.kind)).length;
      for (let i = 1; i <= count; i++) cases = [...cases, { name: id + '/sql-failure-' + i, node: id, faultSql: i }];
    }
    fs.writeFileSync(casesFile, JSON.stringify(cases, null, 2) + '\n');
  } else cases = JSON.parse(fs.readFileSync(casesFile));
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
        assert.deepEqual(result, before, `${profile} ${c.name}`);
        const message = value => Array.isArray(value.result) ? value.result.find(Boolean) : value.result;
        const brief = value => {
          const msg = message(value);
          return { statusCode: msg?.statusCode ?? null, outputPorts: Array.isArray(value.result) ? value.result.map(Boolean) : [!!value.result], closes: value.closes, rainTodayMm: msg?.payload?.water?.rainTodayMm, measuredLiters: msg?.payload?.water?.irrigationTodayMeasuredLiters, estimatedLiters: msg?.payload?.water?.irrigationTodayEstimatedLiters, liters: msg?.payload?.liters, error: msg?.payload?.error || msg?.payload?.message };
        };
        evidence.push({ profile, case: c.name, before: brief(before), after: brief(result), beforeTraceSha256: digest(before), afterTraceSha256: digest(result) });
      }
      if (mode === '--capture' && profile === PROFILES[0]) actual[c.name] = result;
      if (mode === '--capture' && profile === PROFILES[1]) assert.deepEqual(result, actual[c.name], c.name);
      count++;
    }
  }
  if (mode === '--capture') {
    for (const name of ['environment/local-zero', 'environment/local-no-samples', 'environment/openagri-token', 'environment/shared-fresh', 'environment/current-forecast-cache']) {
      assert.equal(actual[name].result.statusCode, 200, name + ': must reach full read path');
    }
    assert.equal(actual['environment/local-zero'].result.payload.online.current.airTemperatureC, 0);
    assert.equal(actual['environment/local-zero'].result.payload.water.rainTodayMm, 0);
    assert.equal(actual['environment/local-zero'].result.payload.water.irrigationTodayMeasuredLiters, 12);
    assert.equal(actual['environment/local-no-samples'].result.payload.water.rainTodayMm, null);
    assert.equal(actual['environment/openagri-token'].result.payload.online.source, 'openagri');
    assert.equal(actual['environment/openagri-token'].result.payload.forecast.source, 'openagri');
    assert.equal(actual['environment/local-zero'].state.zone_weather_cache.length, 2);
    assert.ok(actual['actuations/normal'].result[0].payload.length > 0);
    assert.equal(actual['liters/zero-only'].result.payload.liters, 0);
    assert.equal(actual['liters/null-only'].result.payload.liters, null);
    assert.equal(actual['response/status-matrix'].result.payload.actuations[0].estimatedGrossLiters, 0);
    assert.equal(actual['response/status-matrix'].result.payload.actuations[8].estimatedGrossLiters, null);
    fs.writeFileSync(expectedFile, JSON.stringify(actual) + '\n');
  }
  if (mode !== '--capture') {
    for (const id of ['strega-today-liters-fn', 'get-actuations-query', 'get-actuations-response']) {
      const current = JSON.parse(fs.readFileSync(path.join(share(PROFILES[0]), 'flows.json')));
      const adapter = require('./x3-zone-env-adapters').adaptNode(current.find(n => n.id === id));
      const unavailable = await execute(PROFILES[0], adapter, { name: id + '/facade-unavailable', node: id, missingModule: 'zone-env' });
      const reply = Array.isArray(unavailable.result) ? unavailable.result[1] : unavailable.result;
      assert.equal(reply.statusCode, 503);
      assert.deepEqual(reply.payload, { message: 'Internal error' });
      assert.equal(unavailable.closes, 0);
      assert.equal(unavailable.diagnostics.filter(d => d.kind === 'error').length, 1);
    }
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
  if (process.env.X3_EVIDENCE) fs.writeFileSync(process.env.X3_EVIDENCE, JSON.stringify({ node: process.versions.node, timezone: process.env.TZ, cases: evidence }, null, 2) + '\n');
  console.log(`X3 ${mode}: ${count} exact traces, ${cases.length} cases x both profiles; Node ${process.versions.node}, TZ=${process.env.TZ || 'host'}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
