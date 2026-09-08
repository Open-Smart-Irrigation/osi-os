'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PROFILES,
  MIN_EXPECTED_NODES,
  SCOPE_CALL_RE,
  findAuthGatedNodes,
  makeOsiLibStub,
  ScopeHelperTouchedError,
  checkNode,
  verifyProfile,
  verifyAll,
} = require('./verify-auth-flag-off-hermetic');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = PROFILES[0];

function loadFlows() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, PROFILE), 'utf8'));
}

test('maintained profiles are hermetic (no auth/scope-gated node resolves osiLib.require(\'scope\') with OSI_SCOPED_ACCESS unset)', async () => {
  const { failures } = await verifyAll();
  assert.deepEqual(failures, []);
});

test('discovery finds a healthy population of auth/scope-gated nodes (regression guard for the scan criterion itself)', () => {
  const flows = loadFlows();
  const targets = findAuthGatedNodes(flows);
  assert.ok(
    targets.length >= MIN_EXPECTED_NODES,
    `expected >= ${MIN_EXPECTED_NODES} auth/scope-gated nodes, found ${targets.length} -- ` +
    `either the fixture drifted or SCOPE_CALL_RE stopped matching`
  );
  // Every discovered node really does reference the literal call this
  // verifier is built around -- pins the regex against silent rot.
  for (const node of targets) {
    assert.match(node.func, SCOPE_CALL_RE, `${node.id} matched discovery but not SCOPE_CALL_RE on re-check`);
  }
});

test('makeOsiLibStub: require(\'scope\') throws the marker error; any other module resolves benignly', () => {
  const stub = makeOsiLibStub();
  assert.throws(() => stub.require('scope'), ScopeHelperTouchedError);
  const other = stub.require('zone-env');
  assert.equal(other.ok, true);
  assert.ok(other.value, 'unrelated module resolves to a truthy stub value');
});

test('regression: reintroducing the classic unconditional getAuthSecret() pattern is caught', async () => {
  const flows = loadFlows();
  const node = flows.find((n) => n.id === 'get-devices-auth');
  assert.ok(node, 'fixture node get-devices-auth exists');

  // Revert to the exact broken shape this whole port fixed: getAuthSecret()
  // calling osiLib.require('scope') as its very first, unconditional line.
  const broken = {
    ...node,
    func: node.func.replace(
      /function getAuthSecret\(\) \{[\s\S]*?\n\}(?=function toBase64Url)/,
      "function getAuthSecret() {\n  const scopeLoad = osiLib.require('scope');\n  if (!scopeLoad.ok) {\n    const error = new Error('Authentication scope helper unavailable');\n    error.statusCode = 500;\n    throw error;\n  }\n  return scopeLoad.value.resolveAuthSecret({\n    configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),\n    fs: global.get('fs'),\n    warn: (message) => node.warn(message),\n  });\n}"
    ),
  };
  assert.notEqual(broken.func, node.func, 'mutation actually changed the function body');
  assert.doesNotMatch(broken.func, /scopedForSecret/, 'the flag check was really removed, not just renamed');

  const result = await checkNode(broken);
  assert.equal(result.outcome, 'scope-helper-touched');
  assert.match(result.detail, /osiLib\.require\('scope'\) was reached/);
});

test('regression: a wrap-style guard that never actually gates the call is still caught', async () => {
  const flows = loadFlows();
  const node = flows.find((n) => n.id === 'get-devices-auth');
  assert.ok(node);

  // A subtler regression than a flat revert: the flag is checked, but the
  // condition is inverted (or a stray `true ||` shorthand for it) so
  // osiLib.require('scope') runs on the FLAG-OFF path instead of flag-on.
  const broken = {
    ...node,
    func: node.func.replace(
      "const scopedForSecret = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';\n  if (scopedForSecret) {",
      "const scopedForSecret = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';\n  if (!scopedForSecret) {"
    ),
  };
  assert.notEqual(broken.func, node.func, 'mutation actually changed the function body');

  const result = await checkNode(broken);
  assert.equal(result.outcome, 'scope-helper-touched');
});

test('fail-closed: a node body this harness cannot parse is reported unscannable, not silently skipped', async () => {
  const brokenSyntaxNode = {
    id: 'hermetic-test-syntax-error',
    name: 'Hermetic Test Syntax Error',
    func: "osiLib.require('scope'); this is not valid javascript )))",
    libs: [{ var: 'osiLib', module: 'osi-lib' }],
  };
  const result = await checkNode(brokenSyntaxNode);
  assert.equal(result.outcome, 'unscannable');
});

test('fail-closed: an identifier this harness has not stubbed is reported unscannable, not passed', async () => {
  const unstubbedNode = {
    id: 'hermetic-test-unstubbed-identifier',
    name: 'Hermetic Test Unstubbed Identifier',
    func: "return someTotallyUnstubbedGlobalHelper.doSomething();",
    libs: [],
  };
  const result = await checkNode(unstubbedNode);
  assert.equal(result.outcome, 'unscannable');
  assert.match(result.detail, /someTotallyUnstubbedGlobalHelper/);
});

test('a node whose scope call is legitimately unreachable on the flag-off path passes both env variants', async () => {
  const flows = loadFlows();
  const node = flows.find((n) => n.id === 'zone-env-fn');
  assert.ok(node, 'fixture node zone-env-fn exists');
  const result = await checkNode(node);
  assert.equal(result.outcome, 'pass');
  assert.equal(result.variant, 'both');
});

test('a node with unrelated, always-on osiLib usage (zone-env-fn) is not a false positive', async () => {
  // zone-env-fn calls osiLib.require('zone-env') unconditionally for its
  // actual business logic, entirely apart from the scope-flag contract --
  // this must never be mistaken for the violation under guard.
  const flows = loadFlows();
  const node = flows.find((n) => n.id === 'zone-env-fn');
  assert.ok(node);
  assert.match(node.func, /osiLib\.require\('zone-env'\)/);
  const result = await checkNode(node);
  assert.equal(result.outcome, 'pass');
});

test('verifyProfile reports the target count alongside failures', async () => {
  const { targetCount, failures } = await verifyProfile(PROFILE);
  assert.ok(targetCount >= MIN_EXPECTED_NODES);
  assert.deepEqual(failures, []);
});
