'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nodeSizes, totalChars, isThinNewNode,
  NEW_NODE_CEILING, THIN_NODE_FLOOR, SQL_LITERAL_MAX,
} = require('./flows-size-scan');

const fn = (id, func, extra = {}) => ({ id, type: 'function', name: id, func, ...extra });
const bigSql = (n) => "const q = `SELECT " + 'a,'.repeat(n) + "b FROM device_data`;";

test('nodeSizes: only function nodes, keyed by id, chars = func length', () => {
  const sizes = nodeSizes([fn('a', 'return msg;'), { id: 't', type: 'tab' }, fn('b', 'x'.repeat(50))]);
  assert.deepEqual([...sizes.keys()].sort(), ['a', 'b']);
  assert.equal(sizes.get('a').chars, 'return msg;'.length);
  assert.equal(sizes.get('b').chars, 50);
});

test('nodeSizes: two function nodes with the SAME name keep distinct ids', () => {
  const sizes = nodeSizes([
    { id: 'id1', type: 'function', name: 'dup', func: 'a' },
    { id: 'id2', type: 'function', name: 'dup', func: 'bb' },
  ]);
  assert.equal(sizes.size, 2);
  assert.equal(sizes.get('id1').chars, 1);
  assert.equal(sizes.get('id2').chars, 2);
});

test('totalChars: sums func length across function nodes only', () => {
  assert.equal(totalChars([fn('a', 'abc'), { id: 't', type: 'tab' }, fn('b', 'de')]), 5);
  assert.equal(totalChars([fn('e', '')]), 0);
});

test('isThinNewNode: small new node passes without SQL or osiLib (below floor)', () => {
  assert.deepEqual(
    isThinNewNode(fn('small', 'return {payload: msg.payload};'),
      { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }),
    { ok: true });
});

test('isThinNewNode: large new node with a fat SQL literal and NO osiLib FAILS', () => {
  const node = fn('fat', 'x'.repeat(THIN_NODE_FLOOR) + '\n' + bigSql(SQL_LITERAL_MAX));
  const r = isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX });
  assert.equal(r.ok, false);
  assert.match(r.reason, /oversized SQL literal/);
});

test('isThinNewNode: large new node that loads via osiLib.require PASSES even with a fat SQL literal', () => {
  const node = fn('adapter',
    "const h = osiLib.require('zone-env');\nif(!h.ok){return null;}\n" + bigSql(SQL_LITERAL_MAX),
    { libs: [{ var: 'osiLib', module: 'osi-lib' }] });
  assert.deepEqual(isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }), { ok: true });
});

test('isThinNewNode: large new node with NO fat SQL literal PASSES (assembly logic is fine)', () => {
  const node = fn('assembly', 'const parts=[];\n' + 'parts.push(x);\n'.repeat(600));
  assert.deepEqual(isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }), { ok: true });
});

test('exported constants have the documented values', () => {
  assert.equal(NEW_NODE_CEILING, 4096);
  assert.equal(THIN_NODE_FLOOR, 4096);
  assert.equal(SQL_LITERAL_MAX, 400);
});
