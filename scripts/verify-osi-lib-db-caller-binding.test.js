'use strict';
// Negative cases for the delegated-caller checks in
// verify-osi-lib-db-caller-binding.js: every call in a listed file must be
// awaited, the count must match the reviewed count, and an unlisted module
// file that calls the writer fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODULE_DB_CALLER_POLICIES, delegatedCallProblem, unlistedDelegatedCallers } = require('./verify-osi-lib-db-caller-binding');

const policy = MODULE_DB_CALLER_POLICIES['device-writer'];

test('an awaited call matching the reviewed count passes', () => {
  assert.equal(delegatedCallProblem('const r = await writer.writeDeviceData(tx, m);', { calls: 1 }, policy), null);
  assert.equal(delegatedCallProblem('x = await writerRes.value.writeDeviceData(\n db);', { calls: 1 }, policy), null);
});

test('one awaited call cannot hide an unawaited second call', () => {
  const source = 'await writer.writeDeviceData(tx, a);\nwriter.writeDeviceData(tx, b);';
  assert.match(delegatedCallProblem(source, { calls: 2 }, policy), /awaits 1 of 2/);
});

test('a changed call count needs review', () => {
  const source = 'await writer.writeDeviceData(tx, a);\nawait writer.writeDeviceData(tx, b);';
  assert.match(delegatedCallProblem(source, { calls: 1 }, policy), /has 2 call\(s\), reviewed 1/);
});

test('a call quoted in a comment does not count', () => {
  const source = '// deps.writeDeviceData(tx, result) writes the row\n/* writer.writeDeviceData(x) */\nawait deps.writeDeviceData(tx, r);';
  assert.equal(delegatedCallProblem(source, { calls: 1 }, policy), null);
});

test('an unlisted module file that calls the writer is reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-binding-'));
  try {
    fs.mkdirSync(path.join(root, 'osi-new-helper'));
    fs.mkdirSync(path.join(root, policy.moduleDir));
    fs.writeFileSync(path.join(root, 'osi-new-helper', 'index.js'), 'module.exports = async (w, tx) => w.writeDeviceData(tx);');
    fs.writeFileSync(path.join(root, 'osi-new-helper', 'index.test.js'), 'w.writeDeviceData(tx);');
    fs.writeFileSync(path.join(root, policy.moduleDir, 'index.js'), 'function x(w) { return w.writeDeviceData(1); }');
    assert.deepEqual(unlistedDelegatedCallers(root, policy), ['osi-new-helper/index.js']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
