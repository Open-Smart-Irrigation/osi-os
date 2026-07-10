'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanFunctionNodes } = require('./flows-bare-require-scan');

const fn = (name, func) => ({ id: name, type: 'function', name, func });

test('migrated node body (osiLib.require) PASSES — the false-positive class stays pinned', () => {
  const flows = [fn('Build History Batch',
    "return (async()=>{\nconst helperLoad = osiLib.require('history-sync');\nif (!helperLoad.ok) { node.error('x: ' + helperLoad.error, msg); return null; }\nconst helper = helperLoad.value;\n})();")];
  assert.deepEqual(scanFunctionNodes(flows), []);
});

test('synthetic bare-require body FAILS', () => {
  const flows = [fn('Bad Node', "const helper = require('/srv/node-red/x');\nreturn msg;")];
  assert.deepEqual(scanFunctionNodes(flows), [{ node: 'Bad Node', spec: '/srv/node-red/x' }]);
});

test('Node builtins are exempt', () => {
  const flows = [fn('Crypto Node', "const crypto = require('crypto');\nconst path = require('node:path');\nreturn msg;")];
  assert.deepEqual(scanFunctionNodes(flows), []);
});

test('member-access and identifier-suffix calls never match', () => {
  const flows = [fn('Edge Cases', "module.require('x'); myrequire('y'); a.b.require('z');")];
  assert.deepEqual(scanFunctionNodes(flows), []);
});

test('non-function nodes and empty funcs are skipped', () => {
  assert.deepEqual(scanFunctionNodes([{ id: 't', type: 'tab' }, fn('Empty', '')]), []);
});

test('multiple offenders in one body are all reported', () => {
  const flows = [fn('Two Bads', "require('/a'); require('/b');")];
  assert.equal(scanFunctionNodes(flows).length, 2);
});

test('template-literal bare require FAILS too', () => {
  const flows = [fn('Backtick Node', "const helper = require(`/srv/node-red/x`);\nreturn msg;")];
  assert.deepEqual(scanFunctionNodes(flows), [{ node: 'Backtick Node', spec: '/srv/node-red/x' }]);
});
