#!/usr/bin/env node
'use strict';

// Regression tests for F56 (2026-09-17 overnight, T16d): before this fix,
// scripts/verify-flows-output-arity.js searched raw, unmasked function-node
// source text for the `return`/`node.send(` keywords, so a *literal*
// occurrence of that text inside a comment, a string, or a template literal
// was indistinguishable from a real return-array-literal statement and could
// false-positive the arity check. The fix (`maskNonCode`) blanks out every
// string/template-literal/comment/regex-literal span before the keyword
// search runs, while leaving the original source intact for the actual
// bracket/element parsing that follows a real match.
//
// Run: node --test scripts/test-verify-flows-output-arity.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkFlows, maskNonCode } = require('./verify-flows-output-arity');

function fnNode(id, func, wiresCount) {
  return {
    id,
    name: id,
    type: 'function',
    func,
    wires: Array.from({ length: wiresCount }, () => []),
  };
}

test('F56: a "return [...]" mentioned only in a line comment is not flagged (was a false positive)', () => {
  const node = fnNode(
    'comment-case',
    [
      'function fn() {',
      '  // legacy code used to return [msg, null, extra]',
      '  return msg;',
      '}',
    ].join('\n'),
    1
  );
  const { arityFailures } = checkFlows([node]);
  assert.deepEqual(arityFailures, [], 'a return-shaped comment must not be scanned as a real array literal');
});

test('F56: a "return [...]" mentioned only inside a string literal is not flagged (was a false positive)', () => {
  const node = fnNode(
    'string-case',
    [
      'function fn() {',
      '  var explanation = "the old code used to return [msg, null, extra]";',
      '  return msg;',
      '}',
    ].join('\n'),
    1
  );
  const { arityFailures } = checkFlows([node]);
  assert.deepEqual(arityFailures, [], 'a return-shaped string literal must not be scanned as a real array literal');
});

test('F56: a "return [...]" mentioned only inside a template literal is not flagged (was a false positive)', () => {
  const node = fnNode(
    'template-case',
    [
      'function fn() {',
      '  const debugText = `debug: this used to return [a, b, c]`;',
      '  return msg;',
      '}',
    ].join('\n'),
    1
  );
  const { arityFailures } = checkFlows([node]);
  assert.deepEqual(arityFailures, [], 'a return-shaped template literal must not be scanned as a real array literal');
});

test('F56: a real node.send([...]) nested inside a conditional block is still caught (masking must not swallow real code)', () => {
  const node = fnNode(
    'nested-send-case',
    [
      'function fn() {',
      '  if (cond) {',
      '    // an unrelated comment mentioning return [x] must not distract from the real call below',
      "    node.send([msg1, msg2, msg3]);",
      '  }',
      '}',
    ].join('\n'),
    1
  );
  const { arityFailures } = checkFlows([node]);
  assert.equal(arityFailures.length, 1, 'a genuinely oversized node.send([...]) array must still be flagged');
  assert.equal(arityFailures[0].id, 'nested-send-case');
  assert.equal(arityFailures[0].arrayLength, 3);
  assert.equal(arityFailures[0].wiresLen, 1);
});

test('F56: a real return [...] array literal exceeding wiring is still caught after masking (no regression on the F28 case)', () => {
  const node = fnNode(
    'real-arity-case',
    [
      'function fn() {',
      '  if (!found) {',
      '    return [null, msg];',
      '  }',
      '  return msg;',
      '}',
    ].join('\n'),
    1
  );
  const { arityFailures } = checkFlows([node]);
  assert.equal(arityFailures.length, 1);
  assert.equal(arityFailures[0].arrayLength, 2);
  assert.equal(arityFailures[0].wiresLen, 1);
});

test('F56: a plain literal-only array (e.g. a data list) inside a comment or string is still excluded either way', () => {
  const node = fnNode(
    'literal-array-in-comment',
    [
      'function fn() {',
      "  // valid fields: return ['swt_1', 'swt_2', 'swt_3']",
      '  return msg;',
      '}',
    ].join('\n'),
    1
  );
  const { arityFailures } = checkFlows([node]);
  assert.deepEqual(arityFailures, []);
});

test('maskNonCode: preserves length and code, blanks strings/comments/templates', () => {
  const src = [
    'const a = "return [1,2,3]"; // return [4,5,6]',
    'const b = `return [7,8,9]`;',
    'return [null, msg];',
  ].join('\n');
  const masked = maskNonCode(src);
  assert.equal(masked.length, src.length, 'masking must not change the string length');
  assert.ok(!/return/.test(masked.split('\n')[0]), 'line 1 (string + comment) must have no surviving "return" text');
  assert.ok(!/return/.test(masked.split('\n')[1]), 'line 2 (template literal) must have no surviving "return" text');
  assert.ok(/return \[null, msg\]/.test(masked.split('\n')[2]), 'line 3 (real code) must survive masking untouched');
});

console.log('verify-flows-output-arity masking (F56) tests defined; run with `node --test` to execute.');
