#!/usr/bin/env node
'use strict';

// verify-auth-flag-off-hermetic - regression guard for the class of bug fixed
// on port/wave3-auth-flaggate (fix(auth): flag-gate the shared scope resolver
// across all auth nodes, follow-up to PR #200 / commit 2c4fa9a5f).
//
// Contract under guard: with OSI_SCOPED_ACCESS unset (the default-off state),
// NO function-node code path may resolve osiLib's scope helper
// (osiLib.require('scope')). A lost/broken osi-scope-helper file at deploy
// time must never turn into a 500 on an auth endpoint when the gateway isn't
// even running in scoped mode. history-api-router-fn and zone-env-fn's own
// getAuthSecret() violated this unconditionally (PR #200 CI reds); 59 more
// nodes shared the exact same broken pattern, plus 2 structural variants
// (api-me-fn, sdi12-profiles-scope-fn) -- all 61 are fixed as of this
// verifier landing. This script exists so the class can't regrow: it doesn't
// hardcode that node list, it dynamically discovers every function node that
// references the scope helper at all and hermetically drives each one.
//
// Note this is narrower than "never touch osiLib at all": several of these
// same nodes legitimately call osiLib.require() for wholly unrelated,
// always-on modules (zone-env-fn needs 'zone-env' for its actual business
// logic; journal-api-router-fn needs 'osi-db-helper' and 'osi-journal') --
// that is correct, pre-existing behavior with nothing to do with scoped
// access, and flagging it would be a false positive against a real
// contract. The one call that must never be reachable on the flag-off path
// is specifically osiLib.require('scope').
//
// Technique (per the capture-history-router-vectors.js / verify-strega-gen1.js
// harness convention already used in this repo): build each node's `func`
// text into a real `new Function(...)` with every one of its own declared
// `libs` bound to a permissive auto-mocking stub. osiLib itself IS bound --
// to a name-aware stub whose require('scope') specifically throws a marker
// error (proving the flag-off path reached the one call under guard) while
// require() of anything else returns a benign { ok: true, value: <stub> },
// matching the real osiLib.require contract shape and leaving every other
// dependency free to resolve normally. Invoke each node with
// OSI_SCOPED_ACCESS unset and a syntactically-valid-but-wrong bearer token
// (driving execution into the getAuthSecret()/scope-check code, exactly the
// code this bug lived in, without needing a real signature or a real
// database). The marker error proves the flag-off path still touches the
// scope helper -- the exact defect class this guards against. A
// ReferenceError for anything this harness hasn't stubbed is fail-closed
// too: an unscannable node body is a failure, not a skip, per this
// verifier's design brief. Any other outcome (a deliberately-rejected bad
// token, a thrown business-logic error, or a clean return) proves the
// flag-off path completed without ever resolving the scope helper, which is
// exactly what "hermetic" means here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

// Sanity floor, not a ceiling: if the discovery scan below ever finds
// suspiciously few nodes (e.g. the scope helper is renamed and this file's
// literal match silently stops matching anything), fail loudly instead of
// quietly verifying nothing. Currently measures 86 per profile; floor is set
// with headroom below that so ordinary future editing doesn't need to bump it,
// while a scan that regresses to near-zero still trips it.
const MIN_EXPECTED_NODES = 60;

const SCOPE_CALL_RE = /osiLib\.require\(\s*['"]scope['"]\s*\)/;

function findAuthGatedNodes(flows) {
  return flows.filter(
    (n) => n && n.type === 'function' && typeof n.func === 'string' && SCOPE_CALL_RE.test(n.func)
  );
}

// A Proxy that is simultaneously readable, callable, and constructable, and
// always yields another instance of itself. Stands in for every declared
// `libs` binding except crypto (bound to the real module) and osiLib (bound
// to its own smarter stub below): this verifier does not care whether
// osiDb/HR/osiHistory/chameleon/dendro/etc. behave correctly -- only that
// they never throw a ReferenceError, so that a node's flag-off path can run
// far enough to prove the scope helper specifically was never resolved.
// `.then` is special-cased to `undefined` so `await`ing a stub value
// resolves immediately instead of the runtime mistaking it for a thenable.
//
// Callback-shaped calls need one more accommodation: the whole codebase's
// db-facade convention is Node-style callbacks (`db.close(cb)`,
// `db.all(sql, params, (err, rows) => ...)`, `db.run(sql, params, function
// (err) { ... this.changes ... })`), almost always wrapped in
// `new Promise((resolve, reject) => stub.method(..., cb))`. A stub that
// never invokes a trailing callback leaves that promise permanently pending
// -- not a ReferenceError, just a silent hang, which would make this
// verifier itself unusable. So: if the last argument to a stubbed call is a
// function, invoke it asynchronously as a permissive callback -- both the
// error-first `cb(null, [])` shape and the `cb.call({changes:0,lastID:0},
// null)` shape a bound `run()` callback expects.
function makeAutoStub(label) {
  const target = function autoStub() {};
  const handler = {
    get(_t, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
      if (prop === 'toString') return () => `[auto-stub ${label}]`;
      return makeAutoStub(`${label}.${String(prop)}`);
    },
    apply(_t, _thisArg, args) {
      const lastArg = args.length ? args[args.length - 1] : undefined;
      if (typeof lastArg === 'function') {
        setImmediate(() => {
          try {
            lastArg.call({ changes: 0, lastID: 0 }, null, []);
          } catch {
            // A stub-fed callback throwing is the caller's own bug, not
            // this harness's -- swallow it, it isn't a ReferenceError and
            // isn't osiLib, so it can't hide the one signal we check for.
          }
        });
        return undefined;
      }
      return makeAutoStub(`${label}()`);
    },
    construct() {
      return makeAutoStub(`new ${label}`);
    },
  };
  return new Proxy(target, handler);
}

const HERMETIC_TEST_SECRET = 'hermetic-flag-off-test-secret-do-not-use';
const NODE_TIMEOUT_MS = 2000;
class HermeticTimeoutError extends Error {}
class ScopeHelperTouchedError extends Error {}

// osiLib is bound, not omitted: several in-scope nodes legitimately load
// OTHER osi-lib modules unconditionally (zone-env-fn needs 'zone-env' for
// its actual business logic regardless of scoped mode; journal-api-router-fn
// needs 'osi-db-helper'/'osi-journal') and that is correct, pre-existing
// behavior with nothing to do with this contract. Only require('scope') is
// the call under guard, so only it is made to fail -- with a distinguishing
// marker error, not a ReferenceError, since osiLib itself is genuinely
// present. Every other module name resolves to a benign
// { ok: true, value: <auto-stub> }, matching osiLib.require's real
// { ok, value | error } contract shape.
function makeOsiLibStub() {
  return {
    require(name) {
      if (name === 'scope') {
        throw new ScopeHelperTouchedError(
          `osiLib.require('scope') was reached on the flag-off (OSI_SCOPED_ACCESS unset) code path`
        );
      }
      return { ok: true, value: makeAutoStub(`osiLib.require(${JSON.stringify(name)}).value`) };
    },
  };
}

function makeEnv(configuredSecret) {
  return {
    get(key) {
      if (key === 'OSI_SCOPED_ACCESS') return ''; // unset: the default-off state under guard
      if (key === 'AUTH_TOKEN_SECRET' || key === 'JWT_SECRET') return configuredSecret;
      if (key === 'DEVICE_EUI' || key === 'GATEWAY_DEVICE_EUI') return '0016C001F1000001';
      return '';
    },
  };
}

// Variant A: AUTH_TOKEN_SECRET configured, so getAuthSecret's flag-off
// fallback returns immediately without touching the filesystem at all.
// Variant B: no configured secret, forcing the flag-off fallback's
// file-based read/generate/write branch (ENOENT-quiet read, harmless write).
// Both are real code paths inside the flag-off branch of every fixed node
// and both must independently avoid osiLib.
function makeGlobalStub(variant) {
  const store = new Map();
  const fsStub = {
    readFileSync() {
      const err = new Error('ENOENT: no such file or directory (hermetic verifier stub)');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync() {
      if (variant === 'fs-write-fails') {
        throw new Error('EROFS: read-only filesystem (hermetic verifier stub)');
      }
      return undefined;
    },
  };
  return {
    get(key) {
      if (key === 'fs') return fsStub;
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
    },
  };
}

function makeMsg() {
  // Syntactically valid (two non-empty dot-separated segments) but
  // cryptographically wrong bearer token: drives execution into
  // getAuthSecret()/the HMAC comparison (the exact code this bug lived in)
  // without needing a real, correctly-signed token. authUserId/authUsername
  // are pre-populated too, for the one node (api-me-fn) whose own auth check
  // reads those fields directly rather than decoding a bearer token itself.
  return {
    req: {
      method: 'GET',
      path: '/hermetic-verifier-probe',
      url: '/hermetic-verifier-probe',
      params: {},
      query: {},
      headers: { authorization: 'Bearer aGVybWV0aWM.d3JvbmdzaWc' },
      body: {},
    },
    payload: null,
    authUserId: 1,
    authUsername: 'hermetic-test-user',
  };
}

function makeNodeStub() {
  const log = [];
  return {
    _log: log,
    log(m) { log.push(['log', m]); },
    warn(m) { log.push(['warn', m]); },
    error(m) { log.push(['error', m]); },
    status() {},
  };
}

// Reserved/standard bindings every function node gets from Node-RED itself
// (never via `libs`).
const RESERVED_PARAM_NAMES = new Set(['msg', 'node', 'env', 'global', 'context', 'flow', 'RED']);

function buildSandboxParams(libs, envStub, globalStub, msgStub, nodeStub) {
  const paramNames = ['msg', 'node', 'env', 'global', 'context', 'flow', 'RED', 'osiLib'];
  const paramValues = [
    msgStub, nodeStub, envStub, globalStub,
    makeAutoStub('context'), makeAutoStub('flow'), makeAutoStub('RED'),
    makeOsiLibStub(), // bound (not omitted): see makeOsiLibStub for why
  ];
  for (const lib of libs || []) {
    if (!lib || typeof lib.var !== 'string') continue;
    if (lib.var === 'osiLib') continue; // already bound above, to the scope-aware stub
    if (RESERVED_PARAM_NAMES.has(lib.var)) continue; // already bound above
    if (paramNames.includes(lib.var)) continue; // don't double-declare a Function param
    paramNames.push(lib.var);
    paramValues.push(lib.module === 'crypto' ? crypto : makeAutoStub(lib.var));
  }
  return { paramNames, paramValues };
}

// Runs one (node, env/global variant) combination. Returns
// { outcome: 'pass' | 'scope-helper-touched' | 'unscannable', detail }.
async function runOnce(node, envStub, globalStub) {
  const msgStub = makeMsg();
  const nodeStub = makeNodeStub();
  const { paramNames, paramValues } = buildSandboxParams(node.libs, envStub, globalStub, msgStub, nodeStub);

  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(...paramNames, node.func);
  } catch (error) {
    return { outcome: 'unscannable', detail: `cannot parse function body: ${error && error.message ? error.message : error}` };
  }

  try {
    const result = fn(...paramValues);
    if (result && typeof result.then === 'function') {
      // Defense-in-depth beyond the callback-invoking auto-stub above: if
      // some node's flag-off path hits a wait pattern this harness didn't
      // anticipate (a retry loop, a timer, anything else that never
      // settles), fail closed with a clear timeout report instead of
      // hanging this verifier -- and CI -- forever.
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new HermeticTimeoutError('did not settle within ' + NODE_TIMEOUT_MS + 'ms')), NODE_TIMEOUT_MS);
      });
      try {
        await Promise.race([result, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
    return { outcome: 'pass', detail: 'completed without resolving the scope helper' };
  } catch (error) {
    if (error instanceof ScopeHelperTouchedError) {
      return { outcome: 'scope-helper-touched', detail: error.message };
    }
    if (error instanceof HermeticTimeoutError) {
      return { outcome: 'unscannable', detail: error.message };
    }
    if (error instanceof ReferenceError) {
      // Any undeclared identifier this harness hasn't stubbed. osiLib
      // itself is always bound (to the scope-aware stub above), so a
      // ReferenceError can never legitimately name it -- this branch is
      // strictly "this harness's own stub set is incomplete for this node",
      // which is exactly the unscannable case: fail closed rather than
      // silently pass a node this verifier couldn't actually exercise.
      return { outcome: 'unscannable', detail: `unstubbed identifier: ${String((error && error.message) || '')}` };
    }
    // Any other error (a deliberately-thrown 401/500 auth error, a
    // business-logic TypeError past the auth gate, etc.) proves the flag-off
    // path ran to a point that never resolved the scope helper -- a pass.
    return { outcome: 'pass', detail: `rejected as expected: ${error && error.constructor && error.constructor.name}: ${error && error.message}` };
  }
}

async function checkNode(node) {
  const secretVariant = await runOnce(node, makeEnv(HERMETIC_TEST_SECRET), makeGlobalStub('fs-configured'));
  if (secretVariant.outcome !== 'pass') {
    return { id: node.id, name: node.name, ...secretVariant, variant: 'AUTH_TOKEN_SECRET configured' };
  }
  const fsFallbackVariant = await runOnce(node, makeEnv(''), makeGlobalStub('fs-fallback'));
  if (fsFallbackVariant.outcome !== 'pass') {
    return { id: node.id, name: node.name, ...fsFallbackVariant, variant: 'AUTH_TOKEN_SECRET unset (fs fallback)' };
  }
  return { id: node.id, name: node.name, outcome: 'pass', detail: 'both env variants hermetic', variant: 'both' };
}

async function verifyProfile(relativePath) {
  const flows = JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
  const targets = findAuthGatedNodes(flows);
  const failures = [];

  if (targets.length < MIN_EXPECTED_NODES) {
    failures.push(
      `${relativePath}: only found ${targets.length} auth/scope-gated function nodes (expected >= ${MIN_EXPECTED_NODES}) -- ` +
      `the discovery scan (osiLib.require('scope')) may have silently stopped matching; fail closed rather than verify nothing`
    );
  }

  for (const node of targets) {
    const result = await checkNode(node);
    if (result.outcome !== 'pass') {
      failures.push(
        `${relativePath}: ${node.id} (${node.name || 'unnamed'}) [${result.variant}] -- ${result.outcome}: ${result.detail}`
      );
    }
  }

  return { targetCount: targets.length, failures };
}

async function verifyAll(profiles = PROFILES) {
  const failures = [];
  let totalTargets = 0;
  for (const relativePath of profiles) {
    const { targetCount, failures: profileFailures } = await verifyProfile(relativePath);
    totalTargets += targetCount;
    failures.push(...profileFailures);
  }
  return { totalTargets, failures };
}

async function main() {
  const { totalTargets, failures } = await verifyAll();
  if (failures.length) {
    console.error(`FAIL: ${failures.length} auth-flag-off-hermetic violation(s):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(
    `verify-auth-flag-off-hermetic: OK (${totalTargets} auth/scope-gated function node instances across both maintained profiles, ` +
    `each driven hermetically with OSI_SCOPED_ACCESS unset -- zero reached osiLib.require('scope'))`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('verify-auth-flag-off-hermetic: fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  PROFILES,
  MIN_EXPECTED_NODES,
  SCOPE_CALL_RE,
  findAuthGatedNodes,
  makeAutoStub,
  makeOsiLibStub,
  ScopeHelperTouchedError,
  HermeticTimeoutError,
  makeEnv,
  makeGlobalStub,
  makeMsg,
  buildSandboxParams,
  runOnce,
  checkNode,
  verifyProfile,
  verifyAll,
};
