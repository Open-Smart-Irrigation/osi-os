#!/usr/bin/env node
'use strict';

// Runs the shipped 60-second conditional-due Function node twice. The worker
// result is completed before projection reconciliation; a first publication
// failure is warned and the second tick retries it without replaying the due
// operation. The API module's real post-commit failure test covers the paired
// mutation guarantee.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const flow = JSON.parse(fs.readFileSync(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
), 'utf8'));
const dueNode = flow.find((node) => node.id === 'conditional-due-fn');
assert.ok(dueNode, 'conditional-due-fn must be shipped');

for (const profile of ['bcm2712', 'bcm2709']) {
  test(`${profile}: due tick retries failed projection publication after completed work`, async () => {
    const calls = { runDue: 0, reconcile: 0, close: 0 };
    const warnings = [];
    const statuses = [];
    const policy = {
      async runDue(options) {
        calls.runDue += 1;
        assert.ok(options.db);
        assert.ok(options.transport);
        return { dispatched: 1, skipped: 0, unknown: 0, errors: [] };
      },
      async reconcileProjections(options) {
        calls.reconcile += 1;
        assert.ok(options.db);
        if (calls.reconcile === 1) throw new Error('projection_fixture_failure');
        return [{ changed: true, projection_revision: 2 }];
      },
      runtimeClockStatus() {
        return { trusted: true, reason: 'fixture_trusted' };
      },
    };
    const osiLib = {
      require(name) {
        if (name === 'osi-irrigation-policy') return { ok: true, value: policy };
        if (name === 'osi-db-helper') return { ok: true, value: { Database: class {
          async close() { calls.close += 1; }
        } } };
        if (name === 'chirpstack') return { ok: true, value: {
          createProvisioningClientFromEnv() {
            return { async enqueueDownlink() {}, close() { calls.close += 1; } };
          },
        } };
        return { ok: false, error: name };
      },
    };
    const node = {
      warn(value) { warnings.push(String(value)); },
      error(value) { throw new Error(String(value)); },
      status(value) { statuses.push(value); },
    };
    const env = { get() { return null; } };
    const execute = new Function('msg', 'node', 'env', 'osiLib', dueNode.func);
    await execute({}, node, env, osiLib);
    await execute({}, node, env, osiLib);
    assert.equal(calls.runDue, 2, 'both ticks complete the due worker');
    assert.equal(calls.reconcile, 2, 'the later tick retries projection publication');
    assert.equal(calls.close, 4, 'each tick closes the DB and transport');
    assert.equal(warnings.filter((value) => /projection reconciliation failed/.test(value)).length, 1);
    assert.equal(statuses.length, 2);
  });
}
