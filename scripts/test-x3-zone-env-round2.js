#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, LEGACY, PROFILES } = require('./lib/x3-zone-env-harness');
const { adaptNode } = require('./x3-zone-env-adapters');
const { compare, assertOriginalBlobs } = require('./lib/x3-parity-contract');
const { cases, assertCase } = require('./lib/x3-zone-env-extra-cases');
const { assertLoaderReply, assertNativeLoaderReply } = require('./lib/x3-loader-replies');
async function main() {
  assertOriginalBlobs();
  const marker = 'SYNTHETIC_AUTH_RESPONSE_SECRET_MUST_NOT_BE_LOGGED';
  const faults = [
    ['/auth/token', true, 'OpenAgri current', 'status', 401, 'http_error'],
    ['/weather/', true, 'OpenAgri current', 'status', 503, 'http_error'],
    ['/forecast5/', true, 'OpenAgri forecast', 'status', 502, 'http_error'],
    ['current=', false, 'Open-Meteo current', 'status', 503, 'http_error'],
    ['hourly=', false, 'Open-Meteo forecast', 'status', 503, 'http_error'],
    ['/auth/token', true, 'OpenAgri current', 'malformed', undefined, 'invalid_response'],
    ['/weather/', true, 'OpenAgri current', 'network', undefined, 'request_failed'],
    ['/weather/', true, 'OpenAgri current', 'timeout', undefined, 'timeout'],
  ];
  for (const profile of PROFILES) {
    const legacy = LEGACY.find(n => n.id === 'zone-env-fn');
    for (const [match, openagri, operation, failure, statusCode, reason] of faults) test(profile + ' ' + operation + ' ' + match + ' ' + failure, async () => {
      const c = { name: operation + '/' + failure, node: legacy.id, extended: true, openagri, captureProviderResponse: true,
        httpFaults: [{ match, failure, statusCode, responseBody: failure === 'malformed' ? '{' + marker : marker, failureMessage: marker }] };
      const before = await execute(profile, legacy, c);
      const after = await execute(profile, adaptNode(legacy), c);
      compare(before, after, profile + ' provider fallback and cache parity');
      assert.equal(after.result.statusCode, 200);
      const warnings = after.diagnostics.filter(d => d.kind === 'warn').map(d => String(d.value));
      assert.ok(warnings.includes('zone-env ' + operation + ' failed: status=' + (statusCode || 'none') + ' reason=' + reason), c.name);
      assert.ok(warnings.every(message => !message.includes(marker)), 'provider warning disclosed response/error text');
      if (failure === 'status' || failure === 'malformed') assert.ok(after.trace.some(t => t.responseBody?.includes(marker)), 'marker must actually be delivered');
    });
    test(profile + ' loader failure rejects wrong success port', async () => {
    const c = cases.find(c => c.node === 'get-actuations-query' && c.loaderChange);
    const legacyQuery = LEGACY.find(n => n.id === c.node);
    const adapter = adaptNode(legacyQuery);
    const good = await execute(profile, adapter, c);
    assertLoaderReply(c.node, good.result);
    assert.deepEqual(good.result, [null, good.msg]);
    const mutated = { ...adapter, func: adapter.func.replace('return [null, msg];\n}\nreturn loaded.value.', 'return [msg, null];\n}\nreturn loaded.value.') };
    assert.notEqual(mutated.func, adapter.func);
    const wrong = await execute(profile, mutated, c);
    assert.throws(() => assertCase(c, wrong, true), /port|message/, 'additive assertion must reject success-port 503');
    assert.throws(() => assertLoaderReply(c.node, wrong.result), /port|message/);
    assert.throws(() => assertNativeLoaderReply(c.node, [[good.result[1]], []], good.result), /cardinality/);
    });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
