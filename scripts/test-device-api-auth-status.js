#!/usr/bin/env node
'use strict';
// scripts/test-device-api-auth-status.js
//
// Reproduces, then guards against, the Device API auth-status regression:
// commit e100c796 changed device-api-http500 to read msg.error.statusCode.
// A Node-RED `catch` node never preserves a thrown Error's custom
// properties on the synthetic message it builds (only `error.message` and
// `error.source`), so every one of the 41 verifyBearer copies whose auth
// failure propagates to the shared device-api-catch -> device-api-http500
// -> device-response chain came back as HTTP 500 instead of 401. A gateway
// dashboard treats *any* non-401 as "still logged in" or a hard failure,
// so this looked like flaky backend errors rather than a broken login.
//
// The fix (implemented by scripts/dev/apply-device-api-auth-tags.js)
// replaces that trust boundary: verifyBearer itself now clears, then sets,
// a private `msg._osiAuthFailure = { format, code, sourceId }` tag
// immediately before each of its own throws, and device-api-http500 trusts
// only that tag (exact keys, format===1, a reviewed source, tag/catch
// sourceId equality, one recognized code) -- never msg.error.statusCode,
// never raw message text.
//
// This file is both the reproducer (red against the unmodified flows.json)
// and the permanent regression guard (green after the repair): it
// re-derives the protected-route/verifier inventory from the live graph on
// every run and requires it to agree with the reviewed fixture, so a new
// route landing without fixture review fails closed.
//
// Coverage:
//   1. Fixture self-consistency (exact keys, no dup/cross-listed routes).
//   2. Discovered http-in / verifyBearer nodes on device-api-tab agree
//      exactly with the fixture (protected + unprotected + distinct
//      sources), for both maintained profiles.
//   3. Full graph reachability: every route enters its declared auth
//      source before any domain-mutating (sqlite) or response node; every
//      auth outcome reaches a bounded terminal (a local http response, or
//      device-api-catch -> device-api-http500 -> device-response).
//   4. Every one of the 41 verifyBearer sources, invoked with no header
//      plus five deterministic invalid-token variants, produces the
//      expected bounded classification -- through the shared responder
//      for throwing sources, or directly on msg for the local handlers
//      that already classify correctly today.
//   5. device-api-http500 unit coverage of every pin: exact tag shape,
//      allowlisted+matching source, recognized code, and every negative
//      case (untagged, unknown source, missing source, request-injected
//      tag, unknown code, extra field, wrong format, wrong source id,
//      stale tag after success, tag/message disagreement, non-auth source
//      with auth-like text, configuration/secret errors) staying 500.
//   6. Mutation controls: remove a fixture route/source, redirect a wire
//      around auth, inject a pre-auth response, detach the catch chain,
//      add an undeclared or unlisted http-in node, add an unused
//      allowlisted source, and independently strip each inserted tag
//      assignment -- each must fail closed with a traceable reason.
//   7. The committed size-ratchet allowance for every touched node is
//      exact (zero slack): one more character fails without an explicit
//      ceiling edit.
//
// Run: node --test scripts/test-device-api-auth-status.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const TAB_ID = 'device-api-tab';
const HTTP500_ID = 'device-api-http500';
const CATCH_ID = 'device-api-catch';
const RESPONSE_ID = 'device-response';
const BASE_SHA = 'f50950b1767a1aa6302ef2553d68a4e379b5b142';

const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'device-api-auth-routes.json');
const ALLOWANCES_PATH = path.join(__dirname, 'verify-flows-size-ratchet-allowances.json');

const TEST_SECRET = 'test-only-device-api-auth-secret-do-not-use';

// s2120-zones-get-fn and s2120-zones-put-auth-fn ship a shorter verifyBearer
// (no try/catch around JSON.parse, no userId/username claims validation) --
// a pre-existing gap independent of the auth-status bug this plan fixes.
// Both are already "local handler" sources (their own outer try/catch
// classifies via error.statusCode, never through device-api-http500), so an
// unclassified error from these two specific gaps still comes back bounded
// (500 via their own handler), just not classified as a 401. Documented in
// the execution report as a follow-up candidate; out of scope here because
// fixing it would add new validation logic, not the mechanical tag-only
// transform this repair is scoped to.
const NARROW_VERIFIERS = new Set(['s2120-zones-get-fn', 's2120-zones-put-auth-fn']);

const EXPECTED_CODE_BY_VARIANT = {
  'missing-header': 'MISSING_BEARER',
  'malformed-parts': 'INVALID_TOKEN',
  'bad-signature': 'INVALID_TOKEN',
  'malformed-json': 'INVALID_TOKEN',
  'invalid-claims': 'INVALID_TOKEN',
  expired: 'TOKEN_EXPIRED',
};
const VARIANT_ORDER = ['missing-header', 'malformed-parts', 'bad-signature', 'malformed-json', 'invalid-claims', 'expired'];
const PUBLIC_MESSAGE_BY_CODE = {
  MISSING_BEARER: 'Unauthorized',
  INVALID_TOKEN: 'Invalid token',
  TOKEN_EXPIRED: 'Token expired',
};

// ---------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------

function loadFlows(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

function cloneFlows(flows) {
  return JSON.parse(JSON.stringify(flows));
}

function indexById(flows) {
  return new Map(flows.map((n) => [n.id, n]));
}

function loadFixtureRaw() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

// ---------------------------------------------------------------------
// Fixture shape validation
// ---------------------------------------------------------------------

const ROUTE_KEYS = ['method', 'url', 'httpNodeId', 'authNodeId'].sort().join(',');
const UNPROTECTED_KEYS = ['method', 'url', 'httpNodeId'].sort().join(',');

function validateFixtureShape(fixture) {
  const problems = [];
  if (!fixture || typeof fixture !== 'object') return ['fixture is not an object'];
  if (!Array.isArray(fixture.routes)) problems.push('fixture.routes is not an array');
  if (!Array.isArray(fixture.unprotectedRoutes)) problems.push('fixture.unprotectedRoutes is not an array');
  if (problems.length) return problems;

  const seenRoutes = new Set();
  for (const r of fixture.routes) {
    const keys = Object.keys(r).sort().join(',');
    if (keys !== ROUTE_KEYS) problems.push('route entry has unexpected keys: ' + JSON.stringify(r));
    const key = r.method + ' ' + r.url;
    if (seenRoutes.has(key)) problems.push('duplicate route entry: ' + key);
    seenRoutes.add(key);
  }
  const seenUnprotected = new Set();
  for (const r of fixture.unprotectedRoutes) {
    const keys = Object.keys(r).sort().join(',');
    if (keys !== UNPROTECTED_KEYS) problems.push('unprotectedRoutes entry has unexpected keys: ' + JSON.stringify(r));
    const key = r.method + ' ' + r.url;
    if (seenUnprotected.has(key)) problems.push('duplicate unprotectedRoutes entry: ' + key);
    seenUnprotected.add(key);
  }
  for (const key of seenRoutes) {
    if (seenUnprotected.has(key)) problems.push('route declared both protected and unprotected: ' + key);
  }
  return problems;
}

// ---------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------

function outputsOf(node) {
  if (!node) return [];
  if (node.type === 'link out') return Array.isArray(node.links) ? node.links.slice() : [];
  if (Array.isArray(node.wires)) return node.wires.flat().filter(Boolean);
  return [];
}

function findHttpInNodes(flows) {
  return flows.filter((n) => n.z === TAB_ID && n.type === 'http in');
}

function findVerifierNodes(flows) {
  return flows.filter((n) => n.z === TAB_ID && n.type === 'function' && /function\s+verifyBearer/.test(n.func || ''));
}

// ---------------------------------------------------------------------
// Discovery <-> fixture equality (Task 1 Step 2, para 1)
// ---------------------------------------------------------------------

function checkDiscoveryEquality(flows, fixture) {
  const failures = [];
  const byId = indexById(flows);
  const httpIns = findHttpInNodes(flows);
  const verifiers = findVerifierNodes(flows);
  const verifierIds = new Set(verifiers.map((n) => n.id));

  const fixtureRouteKeys = new Set();
  for (const r of fixture.routes || []) {
    const key = r.method + ' ' + r.url;
    if (fixtureRouteKeys.has(key)) failures.push('duplicate fixture route: ' + key);
    fixtureRouteKeys.add(key);
    const httpNode = byId.get(r.httpNodeId);
    if (!httpNode) { failures.push('fixture route ' + key + ': httpNodeId ' + r.httpNodeId + ' does not exist'); continue; }
    if (httpNode.type !== 'http in') failures.push('fixture route ' + key + ': httpNodeId ' + r.httpNodeId + ' is not an http in node');
    if (httpNode.z !== TAB_ID) failures.push('fixture route ' + key + ': httpNodeId ' + r.httpNodeId + ' is not on ' + TAB_ID);
    if (httpNode.method && httpNode.method.toUpperCase() !== r.method) failures.push('fixture route ' + key + ': method mismatch (node has ' + httpNode.method + ')');
    if (httpNode.url !== r.url) failures.push('fixture route ' + key + ': url mismatch (node has ' + httpNode.url + ')');
    const authNode = byId.get(r.authNodeId);
    if (!authNode) { failures.push('fixture route ' + key + ': authNodeId ' + r.authNodeId + ' does not exist'); continue; }
    if (authNode.type !== 'function') failures.push('fixture route ' + key + ': authNodeId ' + r.authNodeId + ' is not a function node');
    if (authNode.z !== TAB_ID) failures.push('fixture route ' + key + ': authNodeId ' + r.authNodeId + ' is not on ' + TAB_ID);
    if (!/function\s+verifyBearer/.test(authNode.func || '')) failures.push('fixture route ' + key + ': authNodeId ' + r.authNodeId + ' has no function verifyBearer');
  }

  const fixtureUnprotectedKeys = new Set();
  for (const r of fixture.unprotectedRoutes || []) {
    const key = r.method + ' ' + r.url;
    if (fixtureUnprotectedKeys.has(key)) failures.push('duplicate fixture unprotected route: ' + key);
    fixtureUnprotectedKeys.add(key);
    const httpNode = byId.get(r.httpNodeId);
    if (!httpNode) { failures.push('fixture unprotected route ' + key + ': httpNodeId ' + r.httpNodeId + ' does not exist'); continue; }
    if (httpNode.type !== 'http in') failures.push('fixture unprotected route ' + key + ': httpNodeId ' + r.httpNodeId + ' is not an http in node');
    if (httpNode.z !== TAB_ID) failures.push('fixture unprotected route ' + key + ': httpNodeId ' + r.httpNodeId + ' is not on ' + TAB_ID);
  }

  const discoveredKeys = new Set();
  for (const h of httpIns) {
    const key = h.method.toUpperCase() + ' ' + h.url;
    if (discoveredKeys.has(key)) failures.push('duplicate discovered http-in route (same method+url twice): ' + key);
    discoveredKeys.add(key);
    const inProtected = fixtureRouteKeys.has(key);
    const inUnprotected = fixtureUnprotectedKeys.has(key);
    if (inProtected && inUnprotected) failures.push('route declared in both fixture lists: ' + key);
    if (!inProtected && !inUnprotected) failures.push('discovered http-in route missing from fixture (neither protected nor unprotected): ' + key + ' (node ' + h.id + ')');
  }
  for (const key of fixtureRouteKeys) if (!discoveredKeys.has(key)) failures.push('fixture protected route not found among discovered http-in nodes: ' + key);
  for (const key of fixtureUnprotectedKeys) if (!discoveredKeys.has(key)) failures.push('fixture unprotected route not found among discovered http-in nodes: ' + key);

  const fixtureSources = new Set((fixture.routes || []).map((r) => r.authNodeId));
  for (const id of fixtureSources) if (!verifierIds.has(id)) failures.push('fixture source ' + id + ' is not a discovered verifyBearer node on ' + TAB_ID);
  for (const id of verifierIds) if (!fixtureSources.has(id)) failures.push('discovered verifyBearer node not declared as a fixture source: ' + id);

  return failures;
}

// ---------------------------------------------------------------------
// Graph reachability
// ---------------------------------------------------------------------

function checkAuthEntry(route, byId) {
  const failures = [];
  const label = route.method + ' ' + route.url;
  const httpNode = byId.get(route.httpNodeId);
  if (!httpNode) { failures.push('route ' + label + ': httpNodeId missing'); return failures; }
  const start = outputsOf(httpNode);
  if (start.length === 0) failures.push('route ' + label + ': http-in node has no outbound wire');

  let foundAuth = false;
  const queue = start.map((id) => ({ id, path: [route.httpNodeId] }));
  let steps = 0;
  while (queue.length) {
    steps += 1;
    if (steps > 5000) { failures.push('route ' + label + ': auth-entry traversal exceeded step bound (possible cycle)'); break; }
    const { id, path } = queue.shift();
    if (path.includes(id)) { failures.push('route ' + label + ': cycle without a bounded terminal at ' + id); continue; }
    const node = byId.get(id);
    if (!node) { failures.push('route ' + label + ': dangling wire to missing node ' + id); continue; }
    if (id === route.authNodeId) { foundAuth = true; continue; }
    if (node.type === 'debug' || node.type === 'status') continue;
    if (node.type === 'http response') { failures.push('route ' + label + ': response reachable before auth via ' + [...path, id].join('->')); continue; }
    if (node.type === 'sqlite') { failures.push('route ' + label + ': domain mutation before auth via ' + [...path, id].join('->')); continue; }
    if (node.type === 'function' && /function\s+verifyBearer/.test(node.func || '')) {
      failures.push('route ' + label + ': reaches undeclared auth source ' + id + ' before declared ' + route.authNodeId);
      continue;
    }
    const next = outputsOf(node);
    if (next.length === 0) { failures.push('route ' + label + ': dangling branch ends at ' + id + ' without reaching auth'); continue; }
    for (const n of next) queue.push({ id: n, path: [...path, id] });
  }
  if (!foundAuth) failures.push('route ' + label + ': never reaches declared auth source ' + route.authNodeId);
  return failures;
}

function checkPostAuthReachability(authNodeId, byId) {
  const failures = [];
  const node = byId.get(authNodeId);
  if (!node) return ['auth node missing: ' + authNodeId];
  const start = outputsOf(node);
  const queue = start.map((id) => ({ id, path: [authNodeId] }));
  let steps = 0;
  let anyTerminal = false;
  while (queue.length) {
    steps += 1;
    if (steps > 5000) { failures.push(authNodeId + ': post-auth traversal exceeded step bound (possible cycle)'); break; }
    const { id, path } = queue.shift();
    if (path.includes(id)) { failures.push(authNodeId + ': cycle without a bounded terminal at ' + id); continue; }
    const n = byId.get(id);
    if (!n) { failures.push(authNodeId + ': dangling wire to missing node ' + id); continue; }
    if (n.type === 'http response') { anyTerminal = true; continue; }
    // Inert side branches: a debug/status tap, or a fire-and-forget
    // downlink publish (mqtt out has no output port at all in Node-RED).
    // Neither is the HTTP response terminal, but neither is a dangling bug
    // either -- the *other* output port still carries the response.
    if (n.type === 'debug' || n.type === 'status' || n.type === 'mqtt out') continue;
    const next = outputsOf(n);
    if (next.length === 0) { failures.push(authNodeId + ': dangling branch ends at ' + id + ' (' + n.type + ') without a bounded HTTP response'); continue; }
    for (const m of next) queue.push({ id: m, path: [...path, id] });
  }
  if (!anyTerminal && start.length > 0) failures.push(authNodeId + ': no branch from auth success reaches a bounded HTTP response');
  return failures;
}

function checkCatchChain(flows) {
  // device-api-tab carries two tab-wide (scope:null) catch nodes: the
  // auth-status responder chain (device-api-catch) and an independent
  // error-logging tap (record-error-catch-device-api, wired to a link out
  // that forwards to a logging flow on another tab). Node-RED fans an
  // error out to every matching catch node on the tab, so both legitimately
  // fire; only device-api-catch's chain matters for auth status.
  const failures = [];
  const byId = indexById(flows);
  const catchNode = flows.find((n) => n.z === TAB_ID && n.type === 'catch' && n.id === CATCH_ID);
  if (!catchNode) failures.push('expected a catch node ' + CATCH_ID + ' on ' + TAB_ID);
  if (catchNode) {
    if (catchNode.scope !== null && !Array.isArray(catchNode.scope)) failures.push('catch node scope is neither null (tab-wide) nor an array');
    const wires = outputsOf(catchNode);
    if (wires.length !== 1 || wires[0] !== HTTP500_ID) failures.push('catch node does not wire directly to ' + HTTP500_ID + ' (wires: ' + JSON.stringify(wires) + ')');
  }
  const http500 = byId.get(HTTP500_ID);
  if (!http500) failures.push(HTTP500_ID + ' missing');
  else {
    const wires = outputsOf(http500);
    if (wires.length !== 1 || wires[0] !== RESPONSE_ID) failures.push(HTTP500_ID + ' does not wire directly to ' + RESPONSE_ID + ' (wires: ' + JSON.stringify(wires) + ')');
  }
  const response = byId.get(RESPONSE_ID);
  if (!response || response.type !== 'http response') failures.push(RESPONSE_ID + ' missing or not an http response node');
  return failures;
}

// ---------------------------------------------------------------------
// Function-node executor (per brief: node:vm, not source rewriting)
// ---------------------------------------------------------------------

function executeFunction(node, msg, options = {}) {
  const warnings = options.warnings || [];
  const envValues = options.env || {};
  const globalValues = options.global || {};
  const src = `(async function(msg, node, env, global, crypto, Buffer) {${node.func}\n})`;
  const fn = new vm.Script(src, { filename: (node.id || 'node') + '.func.js' }).runInNewContext({
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
  });
  const nodeApi = {
    id: node.id,
    warn: (m) => warnings.push({ level: 'warn', message: String(m) }),
    error: (m) => warnings.push({ level: 'error', message: String(m) }),
    status: () => {},
  };
  const envApi = { get: (key) => (Object.prototype.hasOwnProperty.call(envValues, key) ? envValues[key] : undefined) };
  const globalApi = { get: (key) => (Object.prototype.hasOwnProperty.call(globalValues, key) ? globalValues[key] : undefined) };
  return fn(msg, nodeApi, envApi, globalApi, crypto, Buffer);
}

function asCatchMessage(msg, error, sourceId) {
  return {
    ...msg,
    error: {
      message: `Error: ${String((error && error.message) || error)}`,
      source: { id: sourceId, type: 'function' },
    },
  };
}

// ---------------------------------------------------------------------
// Deterministic token construction (test-only JWT_SECRET)
// ---------------------------------------------------------------------

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signPayload(payloadB64, secret) {
  return base64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

const FUTURE_EXP = Date.now() + 3600_000;
const PAST_EXP = 1;

function reqMsg(authorizationHeader) {
  return {
    req: {
      headers: authorizationHeader ? { authorization: authorizationHeader } : {},
      params: { deveui: 'TESTDEVEUI01' },
      query: {},
      body: {},
    },
    res: {},
  };
}

function buildVariant(name, secret = TEST_SECRET) {
  switch (name) {
    case 'missing-header':
      return reqMsg(undefined);
    case 'malformed-parts':
      return reqMsg('Bearer not-a-valid-token-with-no-dot-separator');
    case 'bad-signature': {
      const payloadB64 = base64url(JSON.stringify({ userId: 7, username: 'tester', exp: FUTURE_EXP }));
      const badSig = signPayload(payloadB64, 'a-completely-different-secret');
      return reqMsg('Bearer ' + payloadB64 + '.' + badSig);
    }
    case 'malformed-json': {
      const payloadB64 = base64url('not-json-at-all{{{');
      const sig = signPayload(payloadB64, secret);
      return reqMsg('Bearer ' + payloadB64 + '.' + sig);
    }
    case 'invalid-claims': {
      const payloadB64 = base64url(JSON.stringify({ userId: 'not-a-number', username: '' }));
      const sig = signPayload(payloadB64, secret);
      return reqMsg('Bearer ' + payloadB64 + '.' + sig);
    }
    case 'expired': {
      const payloadB64 = base64url(JSON.stringify({ userId: 7, username: 'tester', exp: PAST_EXP }));
      const sig = signPayload(payloadB64, secret);
      return reqMsg('Bearer ' + payloadB64 + '.' + sig);
    }
    case 'valid': {
      const payloadB64 = base64url(JSON.stringify({ userId: 7, username: 'tester', exp: FUTURE_EXP }));
      const sig = signPayload(payloadB64, secret);
      return reqMsg('Bearer ' + payloadB64 + '.' + sig);
    }
    default:
      throw new Error('unknown token variant ' + name);
  }
}

const TEST_ENV = { JWT_SECRET: TEST_SECRET };

async function invokeAuthNode(node, msg) {
  const warnings = [];
  try {
    const ret = await executeFunction(node, msg, { env: TEST_ENV, warnings });
    return { msg, warnings, threw: false, ret };
  } catch (error) {
    return { msg, warnings, threw: true, error };
  }
}

function extractAuthSourcesFromHttp500(func) {
  const m = func.match(/const\s+authSources\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
}

// ---------------------------------------------------------------------
// Per-profile test suites
// ---------------------------------------------------------------------

test('fixture is self-consistent', () => {
  const fixture = loadFixtureRaw();
  const problems = validateFixtureShape(fixture);
  assert.deepEqual(problems, []);
  assert.equal(fixture.routes.length, 43, 'expected 43 reviewed protected routes');
  assert.equal(fixture.unprotectedRoutes.length, 3, 'expected 3 reviewed unprotected routes');
  const distinctSources = new Set(fixture.routes.map((r) => r.authNodeId));
  assert.equal(distinctSources.size, 41, 'expected 41 distinct reviewed auth sources');
  const expectedUnprotected = new Set(['GET /api/catalog', 'GET /api/v1/devices/:deveui/today-liters', 'OPTIONS /api/*']);
  const actualUnprotected = new Set(fixture.unprotectedRoutes.map((r) => r.method + ' ' + r.url));
  assert.deepEqual(actualUnprotected, expectedUnprotected);
});

for (const rel of PROFILES) {
  test('profile ' + rel, async (t) => {
    const flows = loadFlows(rel);
    const byId = indexById(flows);
    const fixture = loadFixtureRaw();
    const http500Node = byId.get(HTTP500_ID);
    const distinctSourceIds = [...new Set(fixture.routes.map((r) => r.authNodeId))].sort();

    await t.test('discovered routes/verifiers match the fixture exactly', () => {
      const failures = checkDiscoveryEquality(flows, fixture);
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    await t.test('fixture sources match the device-api-http500 allowlist exactly', () => {
      assert.ok(http500Node, HTTP500_ID + ' missing');
      const allowlisted = extractAuthSourcesFromHttp500(http500Node.func);
      assert.ok(allowlisted, 'could not find an authSources Set literal in ' + HTTP500_ID + ' - responder does not classify from a reviewed source allowlist yet');
      assert.deepEqual([...allowlisted].sort(), distinctSourceIds);
    });

    await t.test('device-api-catch -> device-api-http500 -> device-response chain is intact', () => {
      const failures = checkCatchChain(flows);
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    await t.test('every protected route enters its declared auth source before any domain mutation or response', () => {
      const failures = [];
      for (const route of fixture.routes) failures.push(...checkAuthEntry(route, byId));
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    await t.test('every auth source reaches a bounded HTTP response after success', () => {
      const failures = [];
      for (const id of distinctSourceIds) failures.push(...checkPostAuthReachability(id, byId));
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    await t.test('every verifier clears the tag at entry and tags only inside verifyBearer', () => {
      const failures = [];
      for (const id of distinctSourceIds) {
        const node = byId.get(id);
        const bodyMatch = node.func.match(/function\s+verifyBearer\s*\([^)]*\)\s*\{/);
        assert.ok(bodyMatch, id + ': no verifyBearer body found');
        const bodyStart = bodyMatch.index + bodyMatch[0].length;
        let depth = 1;
        let i = bodyStart;
        for (; i < node.func.length && depth > 0; i += 1) {
          if (node.func[i] === '{') depth += 1;
          else if (node.func[i] === '}') depth -= 1;
        }
        const body = node.func.slice(bodyStart, i - 1);
        const outsideBody = node.func.slice(0, bodyMatch.index) + node.func.slice(i);
        if (!/^\s*delete\s+msg\._osiAuthFailure\s*;/.test(body)) {
          failures.push(id + ': verifyBearer body does not delete msg._osiAuthFailure as its first statement');
        }
        if (/_osiAuthFailure/.test(outsideBody)) {
          failures.push(id + ': msg._osiAuthFailure is referenced outside the lexical verifyBearer body');
        }
        const tagCount = (body.match(/msg\._osiAuthFailure\s*=\s*\{/g) || []).length;
        const minExpected = NARROW_VERIFIERS.has(id) ? 4 : 6;
        if (tagCount < minExpected) failures.push(id + ': expected at least ' + minExpected + ' tag assignments inside verifyBearer, found ' + tagCount);
      }
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    await t.test('every auth source classifies all six token variants correctly', async () => {
      const failures = [];
      for (const id of distinctSourceIds) {
        const node = byId.get(id);
        for (const variant of VARIANT_ORDER) {
          const isNarrowGap = NARROW_VERIFIERS.has(id) && (variant === 'malformed-json' || variant === 'invalid-claims');
          const msg = buildVariant(variant);
          const { threw, error } = await invokeAuthNode(node, msg);
          if (threw) {
            const catchMsg = asCatchMessage(msg, error, id);
            const result = await executeFunction(http500Node, catchMsg, { env: TEST_ENV, warnings: [] });
            if (isNarrowGap) {
              // Not expected to throw for these two nodes/variants; if it
              // somehow does, it must still come back bounded.
              if (result.statusCode !== 401 && result.statusCode !== 500) {
                failures.push(id + '/' + variant + ': unbounded statusCode ' + result.statusCode);
              }
              continue;
            }
            const expectedCode = EXPECTED_CODE_BY_VARIANT[variant];
            const expectedMessage = PUBLIC_MESSAGE_BY_CODE[expectedCode];
            if (result.statusCode !== 401) failures.push(id + '/' + variant + ': expected 401 via shared responder, got ' + result.statusCode + ' (payload ' + JSON.stringify(result.payload) + ')');
            else if (result.payload.error !== 'Unauthorized' || result.payload.message !== expectedMessage) {
              failures.push(id + '/' + variant + ': expected {error:"Unauthorized",message:"' + expectedMessage + '"}, got ' + JSON.stringify(result.payload));
            }
          } else {
            const statusCode = msg.statusCode;
            if (statusCode === undefined) { failures.push(id + '/' + variant + ': neither threw nor returned a statusCode'); continue; }
            if (isNarrowGap) {
              // These two nodes have no JSON.parse try/catch and no claims
              // validation, so malformed-json/invalid-claims are not
              // classified as auth failures at all; the exact resulting
              // status depends on whatever downstream domain code runs
              // next (a body-shape 400, a missing-module 500, etc.). The
              // only invariant worth pinning is that it is NOT misreported
              // as a 401 auth failure.
              if (statusCode === 401) failures.push(id + '/' + variant + ': expected the documented narrow-gap to stay non-auth, got 401');
              continue;
            }
            const expectedCode = EXPECTED_CODE_BY_VARIANT[variant];
            const expectedMessage = PUBLIC_MESSAGE_BY_CODE[expectedCode];
            const payloadMessage = msg.payload && (msg.payload.message || msg.payload.error);
            if (statusCode !== 401) failures.push(id + '/' + variant + ': expected local 401, got ' + statusCode + ' (payload ' + JSON.stringify(msg.payload) + ')');
            else if (payloadMessage !== expectedMessage) failures.push(id + '/' + variant + ': expected local message "' + expectedMessage + '", got ' + JSON.stringify(msg.payload));
          }
        }
      }
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    await t.test('a successful call clears a stale tag and leaves no tag behind', async () => {
      const failures = [];
      for (const id of distinctSourceIds) {
        const node = byId.get(id);
        const msg = buildVariant('valid');
        msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: 'someone-elses-node' };
        await invokeAuthNode(node, msg); // outcome (throw or resolve) irrelevant; only the tag matters here
        if (msg._osiAuthFailure !== undefined) failures.push(id + ': msg._osiAuthFailure is still present after a successful verifyBearer call: ' + JSON.stringify(msg._osiAuthFailure));
      }
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    await t.test('removing any single tag assignment flips that variant to untagged/500 (or is provably inert for local handlers)', async () => {
      // Not every one of the 41 sources propagates its auth throw out to
      // device-api-catch: some (dendro-history-fn, sensor-history-fn,
      // rain-history-fn, settings-disable-schedules-fn, s2120-zones-*,
      // put-chameleon-enabled-auth-fn, cancel-strega-actuation-fn,
      // 44e7d74ff3668e01, 8b93fa005d78e25f, get-actuations-auth) already
      // catch their own verifyBearer throw locally -- some via a lexical
      // try/catch, at least one (cancel-strega-actuation-fn) via a
      // promise-level `.catch()` on the whole async IIFE -- and classify
      // from the real Error object's own .statusCode/.message, never
      // consulting msg._osiAuthFailure. For those, the tag is mechanically
      // present (uniform transform, per the plan) but inert: removing it
      // must change nothing about their output. For sources whose auth
      // throw genuinely escapes the node uncaught, removing the tag must
      // flip the shared responder's classification from 401 to 500. Which
      // category a source falls into is determined empirically here, not
      // assumed, so this test cannot silently stop covering a source that
      // changes shape later.
      const failures = [];
      for (const id of distinctSourceIds) {
        const node = byId.get(id);
        const bodyMatch = node.func.match(/function\s+verifyBearer\s*\([^)]*\)\s*\{/);
        const bodyStart = bodyMatch.index + bodyMatch[0].length;
        let depth = 1;
        let i = bodyStart;
        for (; i < node.func.length && depth > 0; i += 1) {
          if (node.func[i] === '{') depth += 1;
          else if (node.func[i] === '}') depth -= 1;
        }
        const bodyEnd = i - 1;
        const tagRe = /msg\._osiAuthFailure\s*=\s*\{[^}]*\}\s*;\s*/g;
        const spans = [];
        let mm;
        const body = node.func.slice(bodyStart, bodyEnd);
        while ((mm = tagRe.exec(body))) spans.push([mm.index, mm.index + mm[0].length]);
        const variants = NARROW_VERIFIERS.has(id) ? ['missing-header', 'malformed-parts', 'bad-signature', 'expired'] : VARIANT_ORDER;
        assert.equal(spans.length, variants.length, id + ': expected ' + variants.length + ' tag spans, found ' + spans.length);

        for (let siteIndex = 0; siteIndex < spans.length; siteIndex += 1) {
          const variant = variants[siteIndex];

          // Baseline: how does the UNMODIFIED node behave for this variant?
          const baselineMsg = buildVariant(variant);
          const baseline = await invokeAuthNode(node, baselineMsg);

          const [s, e] = spans[siteIndex];
          const strippedBody = body.slice(0, s) + body.slice(e);
          const mutatedFunc = node.func.slice(0, bodyStart) + strippedBody + node.func.slice(bodyEnd);
          const mutatedNode = { ...node, func: mutatedFunc };
          const msg = buildVariant(variant);
          const { threw, error } = await invokeAuthNode(mutatedNode, msg);

          if (baseline.threw) {
            // Propagating source: stripping the tag must still throw the
            // same way (the JS control flow is untouched, only the tag
            // assignment was removed) and the shared responder must now
            // fall back to 500 because the tag never got attached.
            if (!threw) { failures.push(id + '/' + variant + ' (site ' + siteIndex + ' stripped): expected the node to still throw'); continue; }
            if (msg._osiAuthFailure !== undefined) { failures.push(id + '/' + variant + ' (site ' + siteIndex + ' stripped): tag still present after stripping its assignment'); continue; }
            const catchMsg = asCatchMessage(msg, error, id);
            const result = await executeFunction(http500Node, catchMsg, { env: TEST_ENV, warnings: [] });
            if (result.statusCode !== 500) failures.push(id + '/' + variant + ' (site ' + siteIndex + ' stripped): expected 500 once untagged, got ' + result.statusCode);
          } else {
            // Local handler: the tag is mechanically present but inert.
            // Stripping it must not change the node's own classification.
            if (threw) { failures.push(id + '/' + variant + ' (site ' + siteIndex + ' stripped): local handler unexpectedly started throwing once the tag assignment was removed'); continue; }
            if (msg._osiAuthFailure !== undefined) { failures.push(id + '/' + variant + ' (site ' + siteIndex + ' stripped): tag still present after stripping its assignment'); continue; }
            if (msg.statusCode !== baselineMsg.statusCode) {
              failures.push(id + '/' + variant + ' (site ' + siteIndex + ' stripped): local statusCode changed from ' + baselineMsg.statusCode + ' to ' + msg.statusCode + ' -- the tag was not actually inert here');
            }
          }
        }
      }
      assert.deepEqual(failures, [], failures.join('\n'));
    });

    // -----------------------------------------------------------------
    // device-api-http500 direct unit coverage
    // -----------------------------------------------------------------

    await t.test('device-api-http500 direct unit coverage', async (t2) => {
      const referenceSource = distinctSourceIds[0];

      function catchMsg({ tag, sourceId = referenceSource, message = 'Unauthorized', res = {} } = {}) {
        const msg = { res, error: { message: 'Error: ' + message, source: { id: sourceId, type: 'function' } } };
        if (tag !== undefined) msg._osiAuthFailure = tag;
        return msg;
      }

      async function run(msg) {
        return executeFunction(http500Node, msg, { env: TEST_ENV, warnings: [] });
      }

      await t2.test('no msg.res short-circuits to null (not an HTTP response)', async () => {
        const result = await run({ error: { message: 'Error: Unauthorized', source: { id: referenceSource, type: 'function' } } });
        assert.equal(result, null);
      });

      await t2.test('recognized tag from an allowlisted, matching source yields 401 for each code', async () => {
        for (const [code, message] of Object.entries(PUBLIC_MESSAGE_BY_CODE)) {
          const result = await run(catchMsg({ tag: { format: 1, code, sourceId: referenceSource }, message }));
          assert.equal(result.statusCode, 401);
          // result.payload was created inside a fresh vm context, so its
          // Object.prototype is a different realm than this file's -- compare
          // fields, not the object identity/prototype chain (deepStrictEqual
          // would otherwise report "same structure but not reference-equal").
          assert.equal(result.payload.error, 'Unauthorized');
          assert.equal(result.payload.message, message);
        }
      });

      await t2.test('the tag code, never the raw message text, decides the public message (no raw-message classification)', async () => {
        // Deliberately disagree: tag says TOKEN_EXPIRED, error.message says
        // something else entirely. The response must reflect the tag only.
        const result = await run(catchMsg({ tag: { format: 1, code: 'TOKEN_EXPIRED', sourceId: referenceSource }, message: 'this text is irrelevant to classification' }));
        assert.equal(result.statusCode, 401);
        assert.equal(result.payload.message, 'Token expired');
      });

      const negativeCases = [
        ['missing tag entirely', catchMsg({})],
        ['tag from an unknown source', catchMsg({ tag: { format: 1, code: 'MISSING_BEARER', sourceId: 'not-a-reviewed-source' }, sourceId: 'not-a-reviewed-source' })],
        ['tag sourceId does not match catch sourceId', catchMsg({ tag: { format: 1, code: 'MISSING_BEARER', sourceId: referenceSource }, sourceId: distinctSourceIds[1] })],
        ['missing sourceId on the catch message', catchMsg({ tag: { format: 1, code: 'MISSING_BEARER', sourceId: '' }, sourceId: '' })],
        ['unknown code', catchMsg({ tag: { format: 1, code: 'SOMETHING_ELSE', sourceId: referenceSource } })],
        ['extra tag field', catchMsg({ tag: { format: 1, code: 'MISSING_BEARER', sourceId: referenceSource, extra: 'x' } })],
        ['wrong format version', catchMsg({ tag: { format: 2, code: 'MISSING_BEARER', sourceId: referenceSource } })],
        ['non-auth source with auth-like message text and no tag', catchMsg({ message: 'Unauthorized', sourceId: 'not-a-reviewed-source' })],
        ['declared auth source, auth-like message, but no tag (post-auth domain throw)', catchMsg({ message: 'Unauthorized' })],
        ['configuration/secret-sentinel error stays 500', catchMsg({ message: 'AUTH_TOKEN_SECRET or JWT_SECRET must be configured' })],
        ['request-injected tag nested under payload is ignored', (() => { const m = catchMsg({}); m.payload = { _osiAuthFailure: { format: 1, code: 'MISSING_BEARER', sourceId: referenceSource } }; return m; })()],
      ];
      for (const [label, msg] of negativeCases) {
        await t2.test(label + ' => 500', async () => {
          const result = await run(msg);
          assert.equal(result.statusCode, 500, label + ': expected 500, got ' + result.statusCode + ' payload=' + JSON.stringify(result.payload));
          assert.equal(result.payload.error, 'device-api failed');
          assert.equal(result.payload.message, 'Internal server error');
        });
      }

      await t2.test('deletes the tag from the outgoing msg regardless of outcome', async () => {
        const msg = catchMsg({ tag: { format: 1, code: 'MISSING_BEARER', sourceId: referenceSource } });
        const result = await run(msg);
        assert.equal(Object.prototype.hasOwnProperty.call(result, '_osiAuthFailure'), false);
      });

      await t2.test('warns with only a bounded source id on 500', async () => {
        const warnings = [];
        await executeFunction(http500Node, catchMsg({ sourceId: 'weird"id/with\\bad<chars>' + 'x'.repeat(200) }), { env: TEST_ENV, warnings });
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].message, /^Device API handler failed at node [A-Za-z0-9_.:-]{1,64}$/);
      });
    });

    // -----------------------------------------------------------------
    // Mutation controls
    // -----------------------------------------------------------------

    await t.test('mutation: removing a fixture route fails discovery equality', () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      mutated.routes.splice(0, 1);
      const failures = checkDiscoveryEquality(flows, mutated);
      assert.ok(failures.length > 0);
    });

    await t.test('mutation: removing all routes for one distinct source fails discovery equality', () => {
      const mutated = JSON.parse(JSON.stringify(fixture));
      const victim = distinctSourceIds[0];
      mutated.routes = mutated.routes.filter((r) => r.authNodeId !== victim);
      const failures = checkDiscoveryEquality(flows, mutated);
      assert.ok(failures.some((f) => f.includes(victim)), failures.join('\n'));
    });

    await t.test('mutation: redirecting the first wire to a response bypasses auth', () => {
      const clone = cloneFlows(flows);
      const cloneById = indexById(clone);
      const route = fixture.routes[0];
      const httpNode = cloneById.get(route.httpNodeId);
      httpNode.wires = [[RESPONSE_ID]];
      const failures = checkAuthEntry(route, cloneById);
      assert.ok(failures.some((f) => f.includes('response reachable before auth')), failures.join('\n'));
    });

    await t.test('mutation: redirecting the first wire to a sqlite node bypasses auth', () => {
      const clone = cloneFlows(flows);
      const cloneById = indexById(clone);
      const anySqlite = clone.find((n) => n.z === TAB_ID && n.type === 'sqlite');
      assert.ok(anySqlite, 'no sqlite node found on ' + TAB_ID + ' to use for this mutation');
      const route = fixture.routes[0];
      const httpNode = cloneById.get(route.httpNodeId);
      httpNode.wires = [[anySqlite.id]];
      const failures = checkAuthEntry(route, cloneById);
      assert.ok(failures.some((f) => f.includes('domain mutation before auth')), failures.join('\n'));
    });

    await t.test('mutation: an intermediate link hop that bypasses auth is caught', () => {
      const clone = cloneFlows(flows);
      const route = fixture.routes[1];
      const cloneById = indexById(clone);
      const httpNode = cloneById.get(route.httpNodeId);

      // First prove a *legitimate* intermediate hop still resolves (a
      // synthetic pass-through link out/in pair routed at the real auth
      // node) -- the traversal is genuinely multi-hop, not a first-wire-only check.
      const linkOutId = '__test_link_out__';
      const linkInId = '__test_link_in__';
      clone.push({ id: linkOutId, type: 'link out', z: TAB_ID, links: [linkInId] });
      clone.push({ id: linkInId, type: 'link in', z: TAB_ID, wires: [[route.authNodeId]] });
      const cloneById2 = indexById(clone);
      const originalWires = httpNode.wires;
      httpNode.wires = [[linkOutId]];
      const okFailures = checkAuthEntry(route, cloneById2);
      assert.deepEqual(okFailures, [], 'expected the legitimate link hop to still reach auth: ' + okFailures.join('\n'));

      // Now redirect the intermediate link so it bypasses auth entirely.
      const linkIn = cloneById2.get(linkInId);
      linkIn.wires = [[RESPONSE_ID]];
      const bypassFailures = checkAuthEntry(route, cloneById2);
      assert.ok(bypassFailures.length > 0, 'expected the redirected link hop to fail');
      httpNode.wires = originalWires;
    });

    await t.test('mutation: detaching the catch response breaks the chain', () => {
      const clone = cloneFlows(flows);
      const catchNode = clone.find((n) => n.id === CATCH_ID);
      catchNode.wires = [[]];
      const failures = checkCatchChain(clone);
      assert.ok(failures.some((f) => f.includes(HTTP500_ID)), failures.join('\n'));
    });

    await t.test('mutation: an undeclared route wired to an existing verifier fails closed', () => {
      const clone = cloneFlows(flows);
      clone.push({
        id: '__test_undeclared_http_in__',
        type: 'http in',
        z: TAB_ID,
        method: 'get',
        url: '/api/__test_undeclared__',
        wires: [[distinctSourceIds[0]]],
      });
      const failures = checkDiscoveryEquality(clone, fixture);
      assert.ok(failures.some((f) => f.includes('__test_undeclared__')), failures.join('\n'));
    });

    await t.test('mutation: a bare new http-in node absent from both lists fails closed', () => {
      const clone = cloneFlows(flows);
      clone.push({
        id: '__test_bare_http_in__',
        type: 'http in',
        z: TAB_ID,
        method: 'get',
        url: '/api/__test_bare__',
        wires: [[]],
      });
      const failures = checkDiscoveryEquality(clone, fixture);
      assert.ok(failures.some((f) => f.includes('__test_bare__')), failures.join('\n'));
    });

    await t.test('mutation: an unused allowlisted source in device-api-http500 fails the allowlist equality check', () => {
      const clone = cloneFlows(flows);
      const cloneHttp500 = clone.find((n) => n.id === HTTP500_ID);
      cloneHttp500.func = cloneHttp500.func.replace(
        /const\s+authSources\s*=\s*new\s+Set\(\s*\[/,
        (m) => m + "\n  '__unused_allowlisted_source__',"
      );
      const allowlisted = extractAuthSourcesFromHttp500(cloneHttp500.func);
      assert.notDeepEqual([...allowlisted].sort(), distinctSourceIds);
    });

    // -----------------------------------------------------------------
    // Size ratchet exactness (Task 2 Step 4)
    // -----------------------------------------------------------------

    await t.test('the committed size-ratchet allowance for every touched node is exact (no slack)', () => {
      // eslint-disable-next-line global-require
      const sizeRatchet = require('./verify-flows-size-ratchet');
      const baseRaw = execFileSync('git', ['-C', REPO_ROOT, 'show', BASE_SHA + ':' + rel], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const baseFlows = JSON.parse(baseRaw);
      const allowances = sizeRatchet.loadAllowances(ALLOWANCES_PATH);
      const clean = sizeRatchet.checkSurface(rel, flows, allowances);
      assert.deepEqual(clean.failures, [], 'expected the committed allowance to already be exact for every touched node: ' + clean.failures.join('\n'));

      const mutated = cloneFlows(flows);
      const target = mutated.find((n) => n.id === HTTP500_ID);
      target.func += '/*x*/';
      const dirty = sizeRatchet.checkSurface(rel, mutated, allowances);
      assert.ok(
        dirty.failures.some((f) => f.includes(HTTP500_ID) && f.includes('exceeding its committed ceiling')),
        'expected one extra character on ' + HTTP500_ID + ' to fail size-ratchet without an explicit ceiling edit: ' + dirty.failures.join('\n')
      );
    });
  });
}
