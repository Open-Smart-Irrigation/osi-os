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

test('isThinNewNode: new node over the floor without osiLib FAILS', () => {
  const node = fn('logic', 'const parts=[];\n' + 'parts.push(x);\n'.repeat(40));
  const r = isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must load its logic through osiLib.require/);
});

test('isThinNewNode: new node over the floor that loads via osiLib.require PASSES', () => {
  const node = fn('adapter',
    "const h = osiLib.require('zone-env');\nif(!h.ok){return null;}\n" + 'const v = h.value.run(msg);\n'.repeat(20),
    { libs: [{ var: 'osiLib', module: 'osi-lib' }] });
  assert.deepEqual(isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }), { ok: true });
});

test('isThinNewNode: osiLib node with a fat SQL literal FAILS', () => {
  const node = fn('adapter',
    "const h = osiLib.require('zone-env');\nif(!h.ok){return null;}\n" + bigSql(SQL_LITERAL_MAX),
    { libs: [{ var: 'osiLib', module: 'osi-lib' }] });
  const r = isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX });
  assert.equal(r.ok, false);
  assert.match(r.reason, /oversized SQL literal/);
});

test('isThinNewNode: osiLib.require without the libs declaration does not count', () => {
  const node = fn('undeclared', "const h = osiLib.require('zone-env');\n" + 'x;\n'.repeat(300));
  assert.equal(isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }).ok, false);
});

test('isThinNewNode: osiLib.require in On Start code counts as loading via osiLib', () => {
  const node = fn('adapter', 'const v = context.get("h").run(msg);\n'.repeat(8),
    { initialize: "context.set('h', osiLib.require('zone-env').value);", libs: [{ var: 'osiLib', module: 'osi-lib' }] });
  assert.deepEqual(isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }), { ok: true });
});

test('exported constants have the documented values', () => {
  assert.equal(NEW_NODE_CEILING, 1536);
  assert.equal(THIN_NODE_FLOOR, 400);
  assert.equal(SQL_LITERAL_MAX, 400);
});
