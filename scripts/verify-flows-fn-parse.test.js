'use strict';
// Tests for scripts/verify-flows-fn-parse.js (issue #6 follow-up).
// Fixture models the real defect class: dendro-raw-fn shipped with
// `replace(/+/g, '-')` (invalid regex) and `replace(///g, '_')` (parses as a
// line comment), so Node-RED never compiled the node and its HTTP route hung.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

const { checkFlows, checkFunctionSource } = require('./verify-flows-fn-parse');

const GOOD_NODE = {
  id: 'fixture-good-fn',
  type: 'function',
  name: 'Fixture Good',
  // Exercises the shapes real nodes use: async IIFE, top-level await inside
  // it, `return msg`, shadowing a sandbox name (`const flow`), and the
  // CORRECT base64url helper regexes.
  func: [
    "function toBase64Url(input) { return Buffer.from(input).toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, ''); }",
    'return (async () => {',
    "  const flow = 'shadowing the sandbox name is legal';",
    '  await Promise.resolve(flow);',
    "  msg.payload = toBase64Url('ok');",
    '  return msg;',
    '})();',
  ].join('\n'),
  initialize: "node.status({ text: 'ready' });",
  finalize: '',
  wires: [[]],
};

const BROKEN_NODE = {
  id: 'fixture-broken-fn',
  type: 'function',
  name: 'Fixture Broken',
  // The real corruption shipped in dendro-raw-fn: missing regex escapes.
  func: "function toBase64Url(input) { return Buffer.from(input).toString('base64').replace(/+/g, '-').replace(///g, '_').replace(/=+$/g, ''); }\nreturn msg;",
  wires: [[]],
};

const NON_FUNCTION_NODE = {
  id: 'fixture-http-in',
  type: 'http in',
  name: 'Fixture Route',
  url: '/api/fixture',
  method: 'get',
  wires: [['fixture-good-fn']],
};

test('checkFunctionSource accepts top-level await and sandbox-name shadowing', () => {
  assert.strictEqual(checkFunctionSource('const x = await Promise.resolve(1);\nreturn msg;'), null);
  assert.strictEqual(checkFunctionSource("const flow = 1; const env = 2; return msg;"), null);
});

test('checkFunctionSource rejects the real corrupted-regex defect', () => {
  const err = checkFunctionSource(BROKEN_NODE.func);
  assert.ok(err instanceof SyntaxError, 'expected a SyntaxError, got ' + err);
});

test('checkFlows passes a clean fixture and skips non-function nodes', () => {
  const { failures, functionNodes, sourcesChecked } = checkFlows([GOOD_NODE, NON_FUNCTION_NODE]);
  assert.deepStrictEqual(failures, []);
  assert.strictEqual(functionNodes, 1);
  // func + initialize checked; empty finalize skipped.
  assert.strictEqual(sourcesChecked, 2);
});

test('checkFlows reports the broken node with id, name, field, and SyntaxError', () => {
  const { failures } = checkFlows([GOOD_NODE, BROKEN_NODE, NON_FUNCTION_NODE]);
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].id, 'fixture-broken-fn');
  assert.strictEqual(failures[0].name, 'Fixture Broken');
  assert.strictEqual(failures[0].field, 'func');
  assert.match(failures[0].error, /^SyntaxError:/);
});

test('CLI exits 1 on a fixture flows.json with one good and one broken node, naming the broken node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnparse-'));
  const fixture = path.join(dir, 'flows.json');
  fs.writeFileSync(fixture, JSON.stringify([GOOD_NODE, BROKEN_NODE, NON_FUNCTION_NODE], null, 2) + '\n');
  let out = '', code = 0;
  try {
    out = execFileSync('node', [path.join(__dirname, 'verify-flows-fn-parse.js'), '--flows', fixture], { encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status || 1;
  }
  assert.strictEqual(code, 1, out);
  assert.match(out, /fixture-broken-fn/);
  assert.match(out, /Fixture Broken/);
  assert.match(out, /SyntaxError/);
});

test('CLI exits 0 on a fixture flows.json with only parseable nodes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnparse-'));
  const fixture = path.join(dir, 'flows.json');
  fs.writeFileSync(fixture, JSON.stringify([GOOD_NODE, NON_FUNCTION_NODE], null, 2) + '\n');
  const out = execFileSync('node', [path.join(__dirname, 'verify-flows-fn-parse.js'), '--flows', fixture], { encoding: 'utf8' });
  assert.match(out, /verify-flows-fn-parse: OK/);
});
