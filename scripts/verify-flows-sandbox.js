#!/usr/bin/env node
'use strict';
// Node-RED 3.1.15 scope, not the host Node.js global object. Source:
// https://github.com/node-red/node-red/blob/3.1.15/packages/node_modules/@node-red/nodes/core/function/10-function.js
// sandbox: lines 149-286; libs: 288-310; wrappers: 106-125, 334-380.
// vm.createContext(sandbox) at line 330 also supplies V8's intrinsic globals.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Linter } = require('eslint');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX = [
  'console', 'util', 'Buffer', 'Date', 'RED', '__node__', 'context',
  'flow', 'global', 'env', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'promisify',
];
const WRAPPERS = {
  func: ['results', 'msg', '__send__', '__done__', '__msgid__', 'node'],
  initialize: ['__send__', '__initSend__', 'node'],
  finalize: ['node'],
};
// Do not use globalThis here: Node's host realm adds crypto, URL, fetch,
// process, require, etc., none of which Node-RED injects into the VM.
const INTRINSICS = vm.runInNewContext('Object.getOwnPropertyNames(globalThis)');
const RESERVED_LIB_NAMES = new Set([...SANDBOX, ...INTRINSICS, ...Object.values(WRAPPERS).flat()]);
const linter = new Linter();
const EXCEPTIONS = require('./flows-sandbox-exceptions.json');

function sourceHash(source) {
  return createHash('sha256').update(source).digest('hex');
}

function checkSource(source, field, libs = []) {
  const globals = Object.fromEntries([
    ...INTRINSICS, ...SANDBOX, ...WRAPPERS[field],
    ...libs.map((lib) => lib.var).filter(Boolean),
  ].map((name) => [name, 'readonly']));
  // Like Node-RED: message/setup are async bodies; close is synchronous.
  // Keep the wrapper on its own line so diagnostics map back to flow code.
  const wrapped = (field === 'finalize' ? '(function(){\n' : '(async function(){\n') + source + '\n})();';
  return linter.verify(wrapped, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals },
    linterOptions: { noInlineConfig: true },
    rules: { 'no-undef': ['error', { typeof: false }], 'no-with': 'error' },
  }).map((finding) => ({ ...finding, line: finding.line - 1 }));
}

function checkFlows(flows, exceptions = EXCEPTIONS) {
  if (!Array.isArray(flows)) throw new Error('flows must be a JSON array');
  const failures = [];
  const waived = [];
  let functionNodes = 0;
  let sourcesChecked = 0;
  for (const node of flows) {
    if (!node || node.type !== 'function') continue;
    functionNodes++;
    const libraryNames = new Set();
    for (const lib of node.libs || []) {
      if (!lib.var) continue;
      if (RESERVED_LIB_NAMES.has(lib.var) || libraryNames.has(lib.var)) {
        failures.push({ id: node.id, name: node.name, field: 'libs',
          message: 'library variable ' + lib.var + ' conflicts with a sandbox/wrapper name or another library variable' });
      }
      libraryNames.add(lib.var);
    }
    for (const field of Object.keys(WRAPPERS)) {
      const source = node[field] || '';
      const applicable = exceptions.filter((entry) => entry.id === node.id && entry.field === field);
      if (!source.trim() && !applicable.length) continue;
      sourcesChecked++;
      let findings = checkSource(source, field, node.libs || []);
      for (const entry of applicable) {
        const matches = findings.filter((finding) => finding.ruleId === 'no-undef' &&
          finding.message === `'${entry.identifier}' is not defined.` &&
          entry.locations.some(([line, column]) => finding.line === line && finding.column === column));
        if (sourceHash(source) !== entry.sha256 || matches.length !== entry.locations.length) {
          failures.push({ id: node.id, name: node.name, field,
            message: 'stale sandbox exception for ' + entry.identifier + '; re-review or remove it' });
          continue;
        }
        waived.push({ id: node.id, field, identifier: entry.identifier, reason: entry.reason });
        findings = findings.filter((finding) => !matches.includes(finding));
      }
      failures.push(...findings.map((finding) => ({ id: node.id, name: node.name, field, ...finding })));
    }
  }
  return { failures, waived, functionNodes, sourcesChecked };
}

function discoverFlowFiles(root = ROOT) {
  // Git's inventory includes every repository variant, including new ones.
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z',
    '--', 'flows.json', '**/flows.json'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((file) => path.join(root, file));
}

function run(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--flows' || !argv[i + 1]) throw new Error('usage: verify-flows-sandbox.js [--flows <path>]');
    files.push(path.resolve(argv[++i]));
  }
  if (!files.length) files.push(...discoverFlowFiles());
  if (!files.length) throw new Error('no flows.json files found');
  let failed = false;
  for (const file of files) {
    const result = checkFlows(JSON.parse(fs.readFileSync(file, 'utf8')));
    const label = path.relative(ROOT, file);
    for (const waiver of result.waived) {
      console.log(`EXCEPTION ${label}: ${waiver.id} ${waiver.field} ${waiver.identifier}: ${waiver.reason}`);
    }
    for (const failure of result.failures) {
      failed = true;
      console.error(`FAIL ${label}: ${failure.id} (${JSON.stringify(failure.name)}) ${failure.field}` +
        `${failure.line ? ':' + failure.line + ':' + failure.column : ''}: ${failure.message}`);
    }
    console.log(`Scanned ${label}: ${result.functionNodes} function nodes, ${result.sourcesChecked} sources`);
  }
  console.log('verify-flows-sandbox: ' + (failed ? 'FAIL' : 'OK'));
  return failed ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error('verify-flows-sandbox: FAIL - ' + error.message); process.exitCode = 1; }
}

module.exports = { checkSource, checkFlows, discoverFlowFiles, sourceHash, SANDBOX, WRAPPERS, INTRINSICS };
