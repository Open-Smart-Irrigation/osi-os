'use strict';
// Bare-require ratchet for flows.json function nodes (refactor-program 1.A1, spec §D).
// osi-lib (libs-declared) is the only sanctioned path to an in-repo module; a bare
// require() of anything but a Node.js builtin is the #99 failure class and fails CI.
// The (?<![\w$.]) lookbehind is load-bearing: without it, the substring
// require('history-sync') inside osiLib.require('history-sync') would match and the
// ratchet would fail the very nodes item 1.A1 migrated. Pinned by the co-located tests.
// Invoked from verify-sync-flow.js (part of that gate — deliberately not a separate
// baseline-file verifier; spec §D). Baseline at introduction: zero offenders.
const { builtinModules } = require('module');

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => 'node:' + m)]);
const BARE_REQUIRE_PATTERN = /(?<![\w$.])require\(\s*['"]([^'"]+)['"]\s*\)/g;

function scanFunctionNodes(flows) {
  const findings = [];
  for (const node of flows) {
    if (!node || node.type !== 'function') continue;
    for (const m of String(node.func || '').matchAll(BARE_REQUIRE_PATTERN)) {
      if (NODE_BUILTINS.has(m[1])) continue;
      findings.push({ node: node.name || node.id, spec: m[1] });
    }
  }
  return findings;
}

module.exports = { scanFunctionNodes };
