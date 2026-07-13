#!/usr/bin/env node
'use strict';
// verify-flows-fn-parse - syntax-checks every Node-RED function node in the
// shipped flows.json profiles (issue #6 follow-up).
//
// Why: Node-RED compiles each function node's `func` at deploy time. A node
// whose source does not parse (e.g. dendro-raw-fn's corrupted
// `replace(/+/g, '-')` regex, found on a live Pi 2026-07-13) never loads, and
// any HTTP-in route wired through it accepts requests and never responds
// (curl exit 28). No existing verifier parse-checked all function nodes, so
// the corruption shipped invisibly.
//
// Model: Node-RED wraps the `func` source in an ASYNC function whose enclosing
// sandbox scope provides `msg`, `node`, `context`, `flow`, `global`, `env`,
// `RED`, plus `libs` vars (`osiDb`, `osiLib`, ...). Top-level `await` is legal
// and a local `const flow = ...` is legal shadowing, so the check compiles the
// source as an async body under those names-as-parameters (same model as
// compileAsyncBody in scripts/verify-heartbeat-health.js; parameter list per
// scripts/capture-zone-env-vectors.js). `initialize`/`finalize` get the same
// async wrapper (Node-RED runs them async, without msg; extra names are
// harmless for a parse check).
//
// Usage:
//   node scripts/verify-flows-fn-parse.js              # all shipped profiles
//   node scripts/verify-flows-fn-parse.js --flows <path> [--flows <path> ...]
//
// Exit 0 when every function-node source parses; exit 1 listing
// profile/node id/name/field + the SyntaxError otherwise.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SURFACES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json',
];

// Names in scope around a function node's body: the message plus the sandbox
// globals Node-RED provides, and osiLib (the repo's shared-helper loader).
// Parse-only check: undeclared identifiers never fail, so `libs` vars beyond
// osiLib (osiDb, crypto, ...) need no entry here.
const SANDBOX_PARAMS = ['msg', 'node', 'context', 'flow', 'global', 'env', 'RED', 'osiLib'];

const SOURCE_FIELDS = ['func', 'initialize', 'finalize'];

function checkFunctionSource(src) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(...SANDBOX_PARAMS, 'return (async () => {\n' + String(src) + '\n})();');
    return null;
  } catch (err) {
    return err;
  }
}

function checkFlows(flows) {
  const failures = [];
  let functionNodes = 0;
  let sourcesChecked = 0;
  for (const n of flows) {
    if (!n || n.type !== 'function') continue;
    functionNodes += 1;
    for (const field of SOURCE_FIELDS) {
      const src = n[field];
      if (typeof src !== 'string' || !src.trim()) continue;
      sourcesChecked += 1;
      const err = checkFunctionSource(src);
      if (err) {
        failures.push({
          id: n.id,
          name: n.name || '(unnamed)',
          field,
          error: (err.constructor ? err.constructor.name : 'Error') + ': ' + err.message,
        });
      }
    }
  }
  return { failures, functionNodes, sourcesChecked };
}

function checkFlowsFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const flows = JSON.parse(raw);
  if (!Array.isArray(flows)) throw new Error(filePath + ': flows.json is not a JSON array');
  return checkFlows(flows);
}

function parseArgs(argv) {
  const surfaces = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--flows') {
      const p = argv[++i];
      if (!p) throw new Error('--flows requires a path');
      surfaces.push(path.resolve(p));
    } else {
      throw new Error('unknown argument: ' + argv[i]);
    }
  }
  if (surfaces.length) return surfaces;
  return DEFAULT_SURFACES
    .map((rel) => path.join(REPO_ROOT, rel))
    .filter((p) => fs.existsSync(p));
}

function run() {
  const surfaces = parseArgs(process.argv.slice(2));
  if (!surfaces.length) {
    console.error('verify-flows-fn-parse: FAIL - no flows.json surfaces found');
    process.exit(1);
  }
  let failed = false;
  for (const filePath of surfaces) {
    const rel = path.relative(REPO_ROOT, filePath);
    const { failures, functionNodes, sourcesChecked } = checkFlowsFile(filePath);
    if (failures.length) {
      failed = true;
      for (const f of failures) {
        console.error('FAIL ' + rel + ': node ' + f.id + ' ("' + f.name + '") ' + f.field + ' does not parse: ' + f.error);
      }
    } else {
      console.log('OK ' + rel + ' (' + functionNodes + ' function nodes, ' + sourcesChecked + ' sources parsed)');
    }
  }
  if (failed) {
    console.error('verify-flows-fn-parse: FAIL');
    process.exit(1);
  }
  console.log('verify-flows-fn-parse: OK');
}

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error('verify-flows-fn-parse: FAIL - ' + e.message);
    process.exit(1);
  }
}

module.exports = { checkFlows, checkFlowsFile, checkFunctionSource, SANDBOX_PARAMS };
